// workers/index.js — iOS 取帧 worker（拉取式 + 固定 ÷3 降采样）
//
// 官方依据（Worker.getCameraFrameData，基础库 2.17.0）：
//   · 仅 iOS 可用 ／ 仅 worker 线程可用 ／ 仅 useExperimentalWorker 时可用
//   · 使用前主线程必须先调用 Camera.listenFrameChange(worker)
//   · 返回「裸 ArrayBuffer」（RGBA，每 4 字节 1 像素），不含宽高 → 原始 288×512
//
// 实测结论（POC v16，iPhone 16 / 微信 8.0.78）：
//   · getCameraFrameData 本身 ~1ms（相机 API 不慢）
//   · 瓶颈是跨线程搬运：`回 ≈ 13ms + 字节/1536`（≈1.5MB/s），慢在序列化
//   · ÷3（96×170 = 65280B）→ 实测 17/s，人脸检出 162~182/173 帧
//   → 所以 MVP 固定 ÷3：性价比最高的一档
//
// 拉取式协议（主线程要一帧，worker 才给一帧；无洪水、无空转）
//   主线程 → worker：{t:'probe'} / {t:'go'} / {t:'need',sentAt} / {t:'mode',ds} / {t:'stop'}
//   worker → 主线程：{t:'probe',hasFn,err} / {t:'frame',buf,w,h,len,wakeMs,grabMs,postAt} / {t:'stat',...}

var SRC_W = 288
var SRC_H = 512
var SRC_BYTES = SRC_W * SRC_H * 4   // 589824

var ds = 3        // 1=原图 / 2=÷2 / 3=÷3（默认）/ 4=÷4
var sent = 0
var empty = 0
var lastLen = 0
var pendingSentAt = 0

function msg(e) { return (e && e.message) ? e.message : String(e) }
function nowMs() { return Date.now() }

// 箱式平均降采样：比最近邻抗锯齿好，检脸更稳
function downsample(src, sw, sh, k) {
  var dw = Math.floor(sw / k)
  var dh = Math.floor(sh / k)
  var out = new Uint8Array(dw * dh * 4)
  var kk = k * k
  var d = 0
  for (var y = 0; y < dh; y++) {
    var sy0 = y * k
    for (var x = 0; x < dw; x++) {
      var sx0 = x * k
      var r = 0, g = 0, b = 0
      for (var j = 0; j < k; j++) {
        var o = ((sy0 + j) * sw + sx0) * 4
        for (var i = 0; i < k; i++) { r += src[o]; g += src[o + 1]; b += src[o + 2]; o += 4 }
      }
      out[d] = r / kk; out[d + 1] = g / kk; out[d + 2] = b / kk; out[d + 3] = 255
      d += 4
    }
  }
  return out
}

// 同步取帧（onMessage 内直接调用）——
// 不要用 setTimeout(grab,0)：iOS 上 worker 定时器可能被节流，白给每帧加几十~几百毫秒
function grab() {
  var t0 = nowMs()
  var wakeMs = (pendingSentAt > 0) ? (t0 - pendingSentAt) : -1

  var buf = null
  var err = ''
  try {
    buf = worker.getCameraFrameData()
  } catch (e) {
    err = msg(e)
  }
  var t1 = nowMs()

  if (!buf) {
    empty++
    try {
      worker.postMessage({ t: 'stat', n: sent, empty: empty, len: lastLen, wakeMs: wakeMs, grabMs: t1 - t0, err: err || 'empty' })
    } catch (e2) { /* ignore */ }
    return
  }

  var len = 0
  try { len = (typeof buf.byteLength === 'number') ? buf.byteLength : (buf.length || 0) } catch (e) { /* ignore */ }

  var outBuf = buf
  var w = SRC_W
  var h = SRC_H

  if (ds > 1 && len === SRC_BYTES) {
    try {
      var src = new Uint8Array(buf)      // iOS 上必须包一层才读得到
      var small = downsample(src, SRC_W, SRC_H, ds)
      outBuf = small.buffer
      w = Math.floor(SRC_W / ds)
      h = Math.floor(SRC_H / ds)
      len = small.length
    } catch (e) {
      outBuf = buf; w = SRC_W; h = SRC_H; len = SRC_BYTES   // 降采样失败就退回原图，别断链
    }
  }
  var t2 = nowMs()

  if (len > 0) { sent++; lastLen = len }
  try {
    worker.postMessage({
      t: 'frame', buf: outBuf, w: w, h: h, len: len,
      wakeMs: wakeMs, grabMs: t1 - t0, postAt: t2, ds: ds
    })
  } catch (e) {
    try {
      worker.postMessage({ t: 'stat', n: sent, len: len, grabMs: t1 - t0, err: 'postMessage:' + msg(e) })
    } catch (e2) { /* ignore */ }
  }
}

worker.onMessage(function (m) {
  if (!m || !m.t) return

  if (m.t === 'probe') {
    var hasFn = false
    var err = ''
    try { hasFn = typeof worker.getCameraFrameData === 'function' } catch (e) { err = msg(e) }
    try { worker.postMessage({ t: 'probe', hasFn: hasFn, err: err }) } catch (e2) { /* ignore */ }
    return
  }

  if (m.t === 'mode') {
    var k = Math.round(m.ds)
    ds = (k >= 1 && k <= 4) ? k : 3
    try { worker.postMessage({ t: 'stat', n: sent, len: lastLen, ds: ds, err: '' }) } catch (e) { /* ignore */ }
    return
  }

  if (m.t === 'go') {
    sent = 0; empty = 0; lastLen = 0; pendingSentAt = 0
    return
  }

  if (m.t === 'need') {
    pendingSentAt = (typeof m.sentAt === 'number') ? m.sentAt : 0
    grab()
    return
  }

  if (m.t === 'stop') {
    pendingSentAt = 0
    try { worker.postMessage({ t: 'stat', n: sent, len: lastLen, err: '' }) } catch (e) { /* ignore */ }
  }
})
