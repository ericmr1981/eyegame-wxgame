// workers/index.js — iOS 取帧专用 worker（v15 · 拉取式 + 分段打点 + 多档降采样）
//
// 官方依据（Worker.getCameraFrameData，基础库 2.17.0）：
//   · 接口仅在 iOS 上可用 ／ 仅在 worker 线程中可用 ／ 仅在 useExperimentalWorker 时可用
//   · 使用前需先在主线程调用 Camera.listenFrameChange(worker)
//   · 返回值为「裸 ArrayBuffer」（RGBA，每 4 字节一个像素），不含宽高
//
// ── v14 → v15 ────────────────────────────────────────────────
// v14 真机结果：`抓1ms · 传479ms · 检6ms`。
//   → getCameraFrameData 只要 1ms（相机 API 不慢）、detectFace 6ms（算法免费），
//     但「发出 need → 收到 frame」的往返高达 479ms，取帧被压到 3/s。
//   → 问题：`传` 是把**三段**混在一起量的（worker 唤醒 + 搬运 + 主线程收消息），
//     不知道钱花在哪一段，就没法对症下药。
//
// v15 三件事：
//   1. **分段打点**：把往返拆成 4 段独立上报 ——
//        `wakeMs` = 主线程发出 need → 我(worker)真正收到（= worker 调度/唤醒延迟）
//        `grabMs` = getCameraFrameData 本身
//        `dsMs`   = 降采样
//        `postAt` = 我 postMessage 的时刻（主线程据此算「回」= 搬运 + 收消息延迟）
//   2. **去掉 setTimeout(grab,0) 的“让一拍”**：拉取式下不需要，而且 **iOS 上 worker 的
//      定时器可能被节流**，白白给每帧加几十~几百毫秒。改为 onMessage 内**同步**取帧。
//   3. **多档降采样**：ds ∈ {1,2,3,4} → 288×512 / 144×256 / 96×170 / 72×128，
//      搬运量按 ds² 递减（589824B → 147456 → 65280 → 36864）。
//
// 主线程 → worker：{t:'probe'} ／ {t:'go'} ／ {t:'need',sentAt} ／ {t:'mode',ds} ／ {t:'stop'}
// worker → 主线程：{t:'probe',...} ／ {t:'frame',buf,w,h,len,wakeMs,grabMs,dsMs,postAt} ／ {t:'stat',...}

var SRC_W = 288      // 相机原始帧宽（v9/v11 12宫格证实）
var SRC_H = 512      // 相机原始帧高
var SRC_BYTES = SRC_W * SRC_H * 4   // 589824

var ds = 1           // 1=原图；2=÷2；3=÷3；4=÷4
var sent = 0         // 成功回传的帧数
var empty = 0        // 取到空帧的次数
var lastLen = 0
var pendingSentAt = 0   // 主线程发 need 时的墙钟（用于算 wakeMs）

function msg(e) { return (e && e.message) ? e.message : String(e) }
function nowMs() { return Date.now() }

// 箱式平均降采样：RGBA in → RGBA out（比最近邻抗锯齿好，检脸更稳）
function downsample(src, sw, sh, k) {
  const dw = Math.floor(sw / k)
  const dh = Math.floor(sh / k)
  const out = new Uint8Array(dw * dh * 4)
  const kk = k * k
  let d = 0
  for (let y = 0; y < dh; y++) {
    const sy0 = y * k
    for (let x = 0; x < dw; x++) {
      const sx0 = x * k
      let r = 0, g = 0, b = 0
      for (let j = 0; j < k; j++) {
        let o = ((sy0 + j) * sw + sx0) * 4
        for (let i = 0; i < k; i++) { r += src[o]; g += src[o + 1]; b += src[o + 2]; o += 4 }
      }
      out[d] = r / kk; out[d + 1] = g / kk; out[d + 2] = b / kk; out[d + 3] = 255
      d += 4
    }
  }
  return out
}

// 同步取帧（由 onMessage('need') 直接调用，不再 setTimeout）
function grab() {
  const t0 = nowMs()
  const wakeMs = (pendingSentAt > 0) ? (t0 - pendingSentAt) : -1

  let buf = null
  let err = ''
  try {
    buf = worker.getCameraFrameData()
  } catch (e) {
    err = msg(e)
  }
  const t1 = nowMs()

  if (!buf) {
    empty++
    try {
      worker.postMessage({ t: 'stat', n: sent, empty: empty, len: lastLen, wakeMs: wakeMs, grabMs: t1 - t0, err: err || 'empty' })
    } catch (e2) { /* ignore */ }
    return
  }

  let len = 0
  try { len = (typeof buf.byteLength === 'number') ? buf.byteLength : (buf.length || 0) } catch (e) { /* ignore */ }

  let outBuf = buf
  let w = SRC_W
  let h = SRC_H

  if (ds > 1 && len === SRC_BYTES) {
    try {
      const src = new Uint8Array(buf)     // iOS 上必须包一层才读得到（社区坑）
      const small = downsample(src, SRC_W, SRC_H, ds)
      outBuf = small.buffer
      w = Math.floor(SRC_W / ds)
      h = Math.floor(SRC_H / ds)
      len = small.length
    } catch (e) {
      // 降采样失败 → 退回原图，别把链路打断
      outBuf = buf; w = SRC_W; h = SRC_H; len = SRC_BYTES
    }
  }
  const t2 = nowMs()

  if (len > 0) { sent++; lastLen = len }
  try {
    worker.postMessage({
      t: 'frame', buf: outBuf, w: w, h: h, len: len,
      wakeMs: wakeMs, grabMs: t1 - t0, dsMs: t2 - t1, postAt: t2, ds: ds
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
    let hasFn = false
    let err = ''
    try { hasFn = typeof worker.getCameraFrameData === 'function' } catch (e) { err = msg(e) }
    worker.postMessage({ t: 'probe', hasFn: hasFn, err: err })
    return
  }

  if (m.t === 'mode') {
    const k = Math.round(m.ds)
    ds = (k >= 1 && k <= 4) ? k : 1
    try { worker.postMessage({ t: 'stat', n: sent, len: lastLen, ds: ds, err: '' }) } catch (e) { /* ignore */ }
    return
  }

  if (m.t === 'go') {
    sent = 0; empty = 0; lastLen = 0
    pendingSentAt = 0
    return
  }

  if (m.t === 'need') {
    pendingSentAt = (typeof m.sentAt === 'number') ? m.sentAt : 0
    grab()          // ★ 同步取帧：去掉 setTimeout，避免 iOS worker 定时器节流
    return
  }

  if (m.t === 'stop') {
    pendingSentAt = 0
    try { worker.postMessage({ t: 'stat', n: sent, len: lastLen, err: '' }) } catch (e) { /* ignore */ }
  }
})
