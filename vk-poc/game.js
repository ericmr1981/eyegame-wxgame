// vk-poc/game.js (v16 · 拆掉我自己埋的三处限速)
//
// ── v15 真机结果（iPhone 16 / 8.0.78 / SDK 3.17.3）──────────────
//   把 479ms 往返拆成 4 段并做多档降采样 A/B 后，**第 4 档（÷4）暴露了
//   一处我自己埋进代码的限速** —— 瓶颈已经不是平台，而是 v13 为「防抖」
//   留下的那条常量。
//
// ── v16 改什么（三处全是我自己写进去的上限）────────────────────
//   1. **`PACE_MIN = 80` → `0`**：这条下限把检测闭环硬顶在 **12.5/s**。
//      拉取式本身严格串行（没拿到帧就不会派发），根本不需要防抖下限；
//      ÷4 档把搬运压下去之后，自然周期小于 80ms，撞到的墙就是它。
//   2. **`检测超时 600ms` → `DET_TIMEOUT = 140ms`**（并按实测 detect 耗时自适应）：
//      detectFace 实测只要 6~7ms，给它 600ms 的「死等」窗口毫无道理；
//      无脸/漏事件时必须等满 600ms 才解锁 → 那一档的帧率就被这个常量吃掉。
//   3. **派发改成事件驱动**：`onFrame()` 里直接调 `stepDetect()`。
//      原来只由 `render()` 每帧带一次 → **rAF 慢就等于检测慢**（v14 实测渲染 5/s）。
//      现在帧一到就派发，不再被渲染帧率卡脖子。
//
// ── 仍然成立的上游结论 ─────────────────────────────────────────
//   · `抓1ms`（相机 API 不慢）· `检6ms`（算法免费）· 卡在 `need→frame` 的往返
//   · yaw 范围 0.905rad ≈ 51.8°，**左转↗ 右转↘ → 不做方向反转**
//   · 信号侧没问题（脸几乎每帧检出），唯一变量是**帧率**
//
// ── 已固化的技术事实（不再重复踩）──────────────────────────────
//   · iOS 取帧唯一路径：wx.createWorker(...,{useExperimentalWorker:true})
//     + camera.listenFrameChange(worker) + worker.getCameraFrameData()
//   · 帧 = 裸 ArrayBuffer（RGBA，每 4 字节 1 像素），**不含宽高** → 原始 288×512
//   · 微信原生相机**默认后置启动**，devicePosition:'front' 要 ~1s 才生效
//     → 取帧前必须等 SETTLE_MS，否则抓到的是后置帧
//   · VK mode:1（摄像头实时）在 iOS 上**零事件**，已判死 → 用 mode:2 + detectFace
//   · 官方：静态模式必须先 start，再 detectFace；**每调一次触发一次 updateAnchors**
//   · anchor.angle = (pitch, yaw, roll)，**单位为弧度**（实测 yaw 左转↗ 右转↘）
//   · wx.createOffscreenCanvas 在小游戏里不存在（那是小程序 API）
//
// ⚠️ 合规：全程仅本机实时处理，不落盘、不上传任何人脸数据。

const canvas = wx.createCanvas()
const ctx = canvas.getContext('2d')
let W = 1, H = 1
function resize() { W = canvas.width; H = canvas.height }
resize()
wx.onWindowResize(resize)

let sys = {}
try { sys = wx.getSystemInfoSync() || {} } catch (e) { /* ignore */ }
let menu = null
try { menu = wx.getMenuButtonBoundingClientRect() } catch (e) { /* ignore */ }

const C = {
  bg: '#0a0e1f', panel: '#131a35', fg: '#e2e9ff', dim: '#7f8fc4',
  ok: '#4ade80', bad: '#ff6b6b', warn: '#fbbf24', accent: '#7aa2ff', line: '#26305a'
}

function msgOf(e) { return (e && e.message) ? e.message : String(e) }

// ---- 已证实常量 ----
const SRC_W = 288         // 相机原始帧宽（v9/v11 12宫格证实）
const SRC_H = 512         // 相机原始帧高
const SETTLE_MS = 3000    // 相机创建后等前置就绪，再开始取帧
const PACE_MIN = 0        // v16：不再设防抖下限（拉取式严格串行，不需要；80ms 曾把上限顶在 12.5/s）
const DET_TIMEOUT = 140   // v16：单次 detectFace 的死等上限（实测耗时 ~7ms；原 600ms 会吃掉帧率）
const REQ_TIMEOUT = 1200  // 要帧后多久没回来就再要一次
const THUMB_MS = 300      // 帧缩略图重建间隔

const S = {
  hasCam: typeof wx.createCamera === 'function',
  hasWorker: typeof wx.createWorker === 'function',
  hasVK: typeof wx.createVKSession === 'function',
  privacyState: '未处理',
  workerProbe: '',
  workerErr: '',

  camPos: 'front',
  camReady: false, camReadyAt: 0, settleLeft: 0, listening: false,
  err: '',

  ds: 1,                    // 降采样开关：1 = 原图 288×512；2/3/4 = ÷2/÷3/÷4
  log: {},                  // A/B 记录：每个档位自动记住自己的 回/取帧/脸（切档不清，方便一张图对比）
  btn: { y: 0, h: 0, w: 0, xs: [] },

  rt: {
    // 取帧（拉取式）
    frames: 0, bytes: 0, bytesStr: '', latestBuf: null, fresh: false,
    pendingReq: false, reqAt: 0, reqSent: 0,
    frameW: SRC_W, frameH: SRC_H,
    frameStamps: [], frameFps: 0,

    // 分段打点：唤 / 抓 / 回 / 检
    lastWake: NaN, lastGrab: NaN, lastDs: NaN, lastBack: NaN, lastXfer: NaN,
    wakeHist: [], grabHist: [], backHist: [],
    avgWake: NaN, avgGrab: NaN, avgBack: NaN,
    renderStamps: [], renderFps: 0, renders: 0,

    // VK 会话
    sess: null, ready: false, startErr: '',

    // 检测闭环
    inflight: false, inflightAt: 0, nextAt: 0,
    calls: 0, events: 0, faces: 0, noFace: 0, timeouts: 0,
    callStamps: [], evStamps: [], detFps: 0, callFps: 0,

    // 耗时
    lastLat: NaN, avgLat: NaN, latHist: [], pace: PACE_MIN,
    lastHitAt: 0, err: '',

    // 解析结果
    angleStruct: '', angleRaw: '',
    stats: {}, order: [],

    // yaw 曲线
    yawHist: [],

    thumb: null, thumbAt: 0
  }
}

let camObj = null
let workerObj = null

// ---------------- 布局（render 与相机视图共用）----------------
function layout() {
  const pad = Math.max(8, Math.round(Math.min(W, H) * 0.035))
  const top = (menu && menu.bottom) ? (menu.bottom + 6) : (pad + 6)
  const pw = Math.round(W * 0.37)
  const ph = Math.round(pw * 4 / 3)
  const camRect = { x: W - pad - pw, y: top, w: pw, h: ph }
  const capRect = { x: camRect.x, y: top + ph + 8, w: pw, h: ph }
  return { pad: pad, top: top, pw: pw, ph: ph, camRect: camRect, capRect: capRect }
}

// ---------------- 统计 ----------------
function updStat(k, v) {
  const r = S.rt
  let st = r.stats[k]
  if (!st) {
    st = r.stats[k] = { n: 0, cur: NaN, min: Infinity, max: -Infinity, sum: 0, sq: 0 }
    r.order.push(k)
  }
  st.n++
  st.cur = v
  if (v < st.min) st.min = v
  if (v > st.max) st.max = v
  st.sum += v
  st.sq += v * v
}
function sigmaOf(st) {
  if (!st || st.n < 2) return NaN
  const m = st.sum / st.n
  const v = st.sq / st.n - m * m
  return v > 0 ? Math.sqrt(v) : 0
}
function fmt(v) {
  if (v === undefined || v === null || !isFinite(v)) return '-'
  const a = Math.abs(v)
  return v.toFixed(a >= 100 ? 0 : (a >= 10 ? 1 : 3))
}
function rateIn(stamps, now) {
  let c = 0
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (now - stamps[i] <= 1000) c++
    else break
  }
  return c
}
function avgOf(arr) {
  if (!arr || !arr.length) return NaN
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i]
  return s / arr.length
}

// ---------------- 解析 anchor.angle ----------------
// 官方：angle = 人脸角度信息 (pitch, yaw, roll)
// 真实类型文档没写死 → 同时兼容 数组 / {pitch,yaw,roll} / {x,y,z} / 标量
const AX = ['pitch', 'yaw', 'roll']
function parseAngle(ang) {
  if (ang === undefined || ang === null) return
  const r = S.rt
  let vals = null
  let struct = ''
  if (Array.isArray(ang)) {
    vals = [ang[0], ang[1], ang[2]]
    struct = 'array[' + ang.length + ']'
  } else if (typeof ang === 'object') {
    if (('pitch' in ang) || ('yaw' in ang) || ('roll' in ang)) {
      vals = [ang.pitch, ang.yaw, ang.roll]
      struct = 'obj{pitch,yaw,roll}'
    } else {
      const ks = Object.keys(ang)
      vals = [ang[ks[0]], ang[ks[1]], ang[ks[2]]]
      struct = 'obj{' + ks.join(',') + '}'
    }
  } else if (typeof ang === 'number') {
    vals = [ang, NaN, NaN]
    struct = 'number'
  }
  if (struct && !r.angleStruct) r.angleStruct = struct
  if (!r.angleRaw) { try { r.angleRaw = JSON.stringify(ang) } catch (e) { r.angleRaw = String(ang) } }
  if (!vals) return
  for (let i = 0; i < 3; i++) {
    const v = vals[i]
    if (typeof v === 'number' && isFinite(v)) {
      updStat(AX[i], v)
      if (AX[i] === 'yaw') {
        r.yawHist.push(v)
        if (r.yawHist.length > 90) r.yawHist.shift()
      }
    }
  }
}

// ---------------- 清理 ----------------
function stopCam() {
  try { camObj && camObj.closeFrameChange && camObj.closeFrameChange() } catch (e) { /* ignore */ }
  try { camObj && camObj.destroy && camObj.destroy() } catch (e) { /* ignore */ }
  try { workerObj && workerObj.postMessage({ t: 'stop' }) } catch (e) { /* ignore */ }
  camObj = null
}

// ---------------- Worker（iOS 取帧唯一合法姿势）----------------
function ensureWorker() {
  if (workerObj) return workerObj
  if (!S.hasWorker) { S.workerErr = 'wx.createWorker 不存在'; return null }
  try {
    workerObj = wx.createWorker('workers/index.js', { useExperimentalWorker: true })
    workerObj.onMessage(function (m) {
      if (!m || !m.t) return
      if (m.t === 'probe') {
        S.workerProbe = 'getCameraFrameData:' + (m.hasFn ? '有' : '无') + (m.err ? (' err:' + m.err) : '')
        return
      }
      if (m.t === 'frame' && m.buf) { onFrame(m); return }
      if (m.t === 'stat' && m.err && m.err !== 'empty') { S.rt.err = 'worker:' + m.err }
    })
    try { workerObj.onProcessKilled && workerObj.onProcessKilled(function () { workerObj = null }) } catch (e) { /* ignore */ }
    workerObj.postMessage({ t: 'probe' })
  } catch (e) {
    S.workerErr = msgOf(e)
    workerObj = null
  }
  return workerObj
}

// 拉取式：向 worker 要一帧（未回则不重复要，超时兜底）
function requestFrame() {
  const r = S.rt
  if (!workerObj || !S.listening) return
  const now = Date.now()
  if (r.pendingReq && (now - r.reqAt) < REQ_TIMEOUT) return
  r.pendingReq = true
  r.reqAt = now
  r.reqSent++
  // 带上发出时刻，worker 用它算「唤醒」延迟（同一进程，Date.now() 同源）
  try { workerObj.postMessage({ t: 'need', sentAt: now }) } catch (e) { r.err = 'need:' + msgOf(e) }
}

// 滚动窗口（8 帧）→ 屏上显示均值，比单帧抗噪；切档位时会清空重算
function pushHist(arr, v) {
  if (!isFinite(v) || v < 0) return
  arr.push(v)
  if (arr.length > 8) arr.shift()
}

// 把当前降采样档位告诉 worker
function pushMode() {
  if (!workerObj) return
  try { workerObj.postMessage({ t: 'mode', ds: S.ds }) } catch (e) { /* ignore */ }
}

function onFrame(m) {
  const r = S.rt
  const now = Date.now()
  r.pendingReq = false
  r.frames++
  r.frameStamps.push(now)
  if (r.frameStamps.length > 120) r.frameStamps.shift()

  // 分段打点：
  //   唤 = 主线程发出 need → worker 收到（worker 唤醒延迟，由 worker 算）
  //   抓 = getCameraFrameData（worker 内）
  //   回 = worker postMessage → 主线程收到（搬运 + 主线程事件循环延迟）
  //   总 = 发出 need → 收到 frame 的完整往返
  r.lastXfer = now - r.reqAt
  if (typeof m.wakeMs === 'number' && m.wakeMs >= 0) r.lastWake = m.wakeMs
  if (typeof m.grabMs === 'number') r.lastGrab = m.grabMs
  if (typeof m.dsMs === 'number') r.lastDs = m.dsMs
  if (typeof m.postAt === 'number' && m.postAt > 0) r.lastBack = now - m.postAt
  pushHist(r.wakeHist, r.lastWake)
  pushHist(r.grabHist, r.lastGrab)
  pushHist(r.backHist, r.lastBack)
  r.avgWake = avgOf(r.wakeHist)
  r.avgGrab = avgOf(r.grabHist)
  r.avgBack = avgOf(r.backHist)

  let n = 0
  try { n = (typeof m.buf.byteLength === 'number') ? m.buf.byteLength : (m.buf.length || 0) } catch (e) { /* ignore */ }
  if (!n) return
  r.bytes = n
  r.bytesStr = n + 'B'
  r.frameW = (typeof m.w === 'number' && m.w > 0) ? m.w : SRC_W
  r.frameH = (typeof m.h === 'number' && m.h > 0) ? m.h : SRC_H
  r.latestBuf = m.buf      // worker 每次 postMessage 都是新副本 → 持有安全
  r.fresh = true
  // v16：帧一到就直接派发检测（事件驱动），不再只等 render 每帧带一次
  //     —— 否则 rAF 一慢就等于检测一慢（v14 实测渲染只有 5/s）
  stepDetect()
}

// ---------------- VKSession（mode:2 静态检测）----------------
function startVK() {
  const r = S.rt
  if (typeof wx.createVKSession !== 'function') { r.startErr = '无 wx.createVKSession'; return }
  try {
    const sess = wx.createVKSession({ track: { face: { mode: 2 } } })
    sess.on('updateAnchors', onAnchors)
    sess.on('removeAnchors', function () { r.noFace++ })
    r.sess = sess
    sess.start(function (errno) {
      if (errno) { r.startErr = 'errno=' + JSON.stringify(errno); return }
      r.ready = true
      r.nextAt = Date.now() + 200
    })
  } catch (e) {
    r.startErr = msgOf(e)
  }
}

// 一次检测结束（有事件 / 超时）→ 记录耗时、再拉下一帧
//
// ⚠️ 两条踩坑（v13 冒烟抓出）：
//  1. **超时不能计入耗时统计** —— 否则均耗被 600ms 超时污染，节流一路跑飞。
//  2. **pace 不能 = 均耗×1.2** —— 串行拉取下 lat ≈ pace + 往返，乘 1.2 是正反馈，
//     每轮自我放大直到撞上限（实测掉到 ~800ms/次）。
//     拉取式本身已是串行：没拿到帧就不会派发，所以 pace 只需一个**下限**防抖。
function concludeDetect(now, gotEvent) {
  const r = S.rt
  if (!r.inflight) return
  r.inflight = false
  if (gotEvent) {
    const lat = now - r.inflightAt
    if (lat > 0 && lat < 5000) {
      r.lastLat = lat
      r.latHist.push(lat)
      if (r.latHist.length > 8) r.latHist.shift()
    }
    r.avgLat = avgOf(r.latHist)
  }
  requestFrame()
}

function onAnchors(anchors) {
  const r = S.rt
  r.events++
  const now = Date.now()
  r.evStamps.push(now)
  if (r.evStamps.length > 120) r.evStamps.shift()
  concludeDetect(now, true)
  let n = 0
  try { n = (anchors && anchors.length) ? anchors.length : 0 } catch (e) { n = 0 }
  if (n > 0) {
    r.faces++
    r.lastHitAt = now
    const a = anchors[0]
    if (a) parseAngle(a.angle)
  } else {
    r.noFace++
  }
}

// 节流调用 detectFace：一次只飞一个，超时解锁
function stepDetect() {
  const r = S.rt
  if (!r.ready || !r.sess || !S.listening) return
  const now = Date.now()
  if (r.inflight) {
    // v16：死等上限 140ms（按实测 detect 耗时自适应，最快 140ms）——
    // 原 600ms 是纯浪费：无脸/漏事件时每轮都要等满 600ms 才敢继续。
    const base = isFinite(r.avgLat) ? r.avgLat : 0
    const lim = Math.max(DET_TIMEOUT, Math.round(base * 8))
    if (now - r.inflightAt < lim) return
    r.timeouts++
    concludeDetect(now, false)
    return
  }
  if (now < r.nextAt) return
  if (!r.latestBuf || !r.fresh) { requestFrame(); return }
  r.fresh = false
  r.inflight = true
  r.inflightAt = now
  r.calls++
  r.callStamps.push(now)
  if (r.callStamps.length > 120) r.callStamps.shift()
  try {
    const p = r.sess.detectFace({
      frameBuffer: r.latestBuf,
      width: r.frameW,
      height: r.frameH,
      sourceType: 0,
      scoreThreshold: 0.5,
      modelMode: 1
    })
    if (p && typeof p.then === 'function') {
      p.then(function () {}, function (e) { r.err = 'df:' + msgOf(e); concludeDetect(Date.now(), false) })
    }
  } catch (e) {
    r.err = 'df:' + msgOf(e)
    concludeDetect(Date.now(), false)
  }
  r.nextAt = now + r.pace
}

// ---------------- 缓冲 → Uint8Array（多路兜底）----------------
function toU8(buf) {
  if (!buf) return null
  try { const a = new Uint8Array(buf); if (a.length) return a } catch (e) { /* ignore */ }
  try { const a = new Uint8Array(buf.buffer || buf); if (a.length) return a } catch (e) { /* ignore */ }
  try {
    const len = buf.byteLength || buf.length || 0
    const a = new Uint8Array(len)
    for (let i = 0; i < len; i++) a[i] = buf[i] & 255
    return len ? a : null
  } catch (e) { /* ignore */ }
  return null
}

// ---------------- 帧缩略图（最近邻采样，自绘 RGBA）----------------
function buildThumb(u8, sw, sh, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let oy = 0; oy < outH; oy++) {
    const sy = Math.min(sh - 1, Math.floor(oy * sh / outH))
    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.min(sw - 1, Math.floor(ox * sw / outW))
      const o = (sy * sw + sx) * 4
      const d = (oy * outW + ox) * 4
      out[d] = u8[o]; out[d + 1] = u8[o + 1]; out[d + 2] = u8[o + 2]; out[d + 3] = 255
    }
  }
  return out
}

function putRGBA(buf, w, h, tx, ty) {
  tx = tx | 0; ty = ty | 0
  try {
    if (typeof ctx.createImageData === 'function') {
      const img = ctx.createImageData(w, h)
      img.data.set(buf)
      ctx.putImageData(img, tx, ty)
      return 'ok'
    }
  } catch (e) { return 'e1:' + msgOf(e) }
  try {
    if (typeof ImageData === 'function') {
      ctx.putImageData(new ImageData(buf, w, h), tx, ty)
      return 'ok2'
    }
  } catch (e) { return 'e2:' + msgOf(e) }
  return 'none'
}

// ---------------- 渲染 ----------------
function render() {
  const L = layout()
  const pad = L.pad
  const maxW = W - pad * 2
  const rect = L.camRect
  const capRect = L.capRect
  const u = (H - pad * 2) / 34
  const sml = Math.max(9, Math.round(u * 0.44))
  const mid = Math.max(11, Math.round(u * 0.54))
  const big = Math.max(14, Math.round(u * 0.70))
  const huge = Math.max(18, Math.round(u * 0.98))

  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  function shrink(str, size, maxWidth) {
    let s = size
    const floor = Math.max(8, Math.round(size * 0.6))
    const mw = maxWidth || maxW
    ctx.font = s + 'px sans-serif'
    while (s > floor && ctx.measureText(str).width > mw) { s--; ctx.font = s + 'px sans-serif' }
    return s
  }

  const r = S.rt
  const now = Date.now()

  // 左侧状态条：绿=正在检出脸，蓝=有帧但没脸，红=没帧
  const hasRecentFace = r.lastHitAt && (now - r.lastHitAt < 800)
  ctx.fillStyle = hasRecentFace ? C.ok : (r.latestBuf ? C.accent : C.bad)
  ctx.fillRect(0, 0, Math.max(4, pad * 0.4), H)

  // ---- 左列文字（避开右侧两个框）----
  const txtW = rect.x - pad - 8
  let y = L.top + big
  function put(str, color, size, step) {
    const s = shrink(str, size, txtW)
    ctx.font = s + 'px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(str, pad, y)
    y += u * (step === undefined ? 1 : step)
  }

  put('头部姿态 v16 · 拆自设限速', C.accent, big, 1.15)
  put((sys.platform || '?') + ' · ' + (sys.model || '-'), C.dim, sml, 1.0)
  put('微信 ' + (sys.version || '?') + ' · SDK ' + (sys.SDKVersion || '?'), C.dim, sml, 1.0)

  const posZh = (S.camPos === 'front') ? '前置' : '后置'
  put('摄像头：' + posZh, S.camPos === 'front' ? C.ok : C.warn, sml, 1.0)
  put('隐私:' + S.privacyState + ' ' + (S.workerProbe || ''), C.dim, sml, 1.0)

  if (S.camReady && !S.listening && S.settleLeft > 0) {
    put('⏳ 等前置就绪 ' + S.settleLeft + 's…', C.warn, sml, 1.0)
  } else if (r.ready) {
    put('● 运行中 帧' + r.frames + ' 检' + r.calls + ' 事件' + r.events + ' 脸' + r.faces, C.ok, sml, 1.0)
  } else if (r.startErr) {
    put('VK start ' + r.startErr, C.bad, sml, 1.0)
  } else {
    put('初始化…', C.dim, sml, 1.0)
  }

  // ---- 全链路吞吐：取帧 / 检测 / 渲染 ----
  // 取帧慢而检测快 → 瓶颈在「搬运」；渲染也慢 → 主线程被饿死
  put('取帧' + r.frameFps + '/s · 检测' + r.callFps + '/s · 渲染' + r.renderFps + '/s', C.dim, sml, 1.0)

  // ---- 耗时拆解（关键诊断）：唤(worker唤醒) 抓(取帧) 回(搬运+收) 检(检测) ----
  const ms = function (v) { return isFinite(v) ? Math.round(v) + 'ms' : '-' }
  put('拆均 唤' + ms(r.avgWake) + ' 抓' + ms(r.avgGrab) + ' 回' + ms(r.avgBack) + ' 检' + ms(r.avgLat), C.warn, sml, 1.0)

  const rateStr = isFinite(r.avgLat) ? Math.max(1, Math.round(1000 / (r.avgLat + 20))) + '/s' : '-'
  put('总' + ms(r.lastXfer) + ' · 上限' + rateStr + ' · ' + r.frameW + 'x' + r.frameH + ' · ' + (r.bytesStr || '-'), C.dim, sml, 1.0)
  put('超时' + r.timeouts + ' · 节流' + r.pace + 'ms · 无脸' + r.noFace + ' · 降采样' + (S.ds > 1 ? ('÷' + S.ds) : '关'), C.dim, sml, 1.0)
  if (S.err) put('✗ ' + S.err, C.bad, sml, 1.0)
  if (r.err) put('✗ ' + r.err, C.bad, sml, 1.0)

  // ---- A/B 记录（一张图对比四档）：每个档位记住自己的 回 / 取帧 / 脸 ----
  // 只在有检测样本时写入 → 切档瞬间不会把旧数据抹成空
  if (r.calls > 0) {
    S.log[S.ds] = { back: r.avgBack, fps: r.frameFps, faces: r.faces, n: r.calls, bytes: r.bytes }
  }
  function abTag(k) {
    const e = S.log[k]
    const tag = (k === 1) ? '关' : ('÷' + k)
    if (!e || !e.n) return tag + ' 待测'
    const bk = isFinite(e.back) ? Math.round(e.back) : '-'
    return tag + ' 回' + bk + ' 帧' + e.fps + ' 脸' + e.faces + (e.n < 6 ? '…' : '')
  }
  put('A/B ' + abTag(1) + ' ｜ ' + abTag(2), C.accent, sml, 1.0)
  put('    ' + abTag(3) + ' ｜ ' + abTag(4), C.accent, sml, 1.0)

  // ---- 右上：相机原生预览框 ----
  ctx.strokeStyle = S.camPos === 'front' ? C.ok : C.warn
  ctx.lineWidth = 2
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
  ctx.lineWidth = 1
  ctx.textAlign = 'center'
  ctx.font = sml + 'px sans-serif'
  ctx.fillStyle = S.camPos === 'front' ? C.ok : C.warn
  ctx.fillText('相机·' + posZh, rect.x + rect.w / 2, rect.y - 4)

  // ---- 右中：取到的帧缩略图（与相机预览对照）----
  ctx.strokeStyle = C.accent
  ctx.strokeRect(capRect.x, capRect.y, capRect.w, capRect.h)
  ctx.fillStyle = C.accent
  ctx.fillText('取到的帧 ' + r.frameW + 'x' + r.frameH, capRect.x + capRect.w / 2, capRect.y - 4)
  ctx.textAlign = 'left'

  // ---- 帧缩略图重建（每 THUMB_MS）----
  if (r.latestBuf && now - r.thumbAt > THUMB_MS) {
    r.thumbAt = now
    try {
      const u8 = toU8(r.latestBuf)
      if (u8) {
        const ow = Math.max(8, Math.round(capRect.w - 8))
        const oh = Math.max(8, Math.round(capRect.h - 8))
        r.thumb = { buf: buildThumb(u8, r.frameW, r.frameH, ow, oh), w: ow, h: oh }
      }
    } catch (e) { r.err = 'thumb:' + msgOf(e) }
  }
  if (r.thumb) {
    const tx = capRect.x + (capRect.w - r.thumb.w) / 2
    const ty = capRect.y + (capRect.h - r.thumb.h) / 2
    putRGBA(r.thumb.buf, r.thumb.w, r.thumb.h, tx, ty)
  }

  // ---- 量程判断（弧度 or 角度）----
  let maxAbs = 0
  for (let i = 0; i < r.order.length; i++) {
    const st = r.stats[r.order[i]]
    if (st && isFinite(st.max)) maxAbs = Math.max(maxAbs, Math.abs(st.max), Math.abs(st.min))
  }
  const isRad = maxAbs < 6

  // ---- 下方：三个姿态角（超大读数 + 度数换算）----
  ctx.font = sml + 'px sans-serif'
  let sy = Math.max(y, capRect.y + capRect.h) + mid
  const order = r.order
  if (!order.length) {
    ctx.fillStyle = C.dim
    ctx.font = huge + 'px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('等待人脸…', pad, sy + huge * 0.4)
    sy += huge * 1.9
  } else {
    for (let i = 0; i < order.length; i++) {
      const st = r.stats[order[i]]
      ctx.textAlign = 'left'
      ctx.font = mid + 'px sans-serif'
      ctx.fillStyle = (order[i] === 'yaw') ? C.warn : C.accent
      ctx.fillText(order[i] + (order[i] === 'yaw' ? ' ← 左右转头看这个' : ''), pad, sy + mid * 0.5)
      ctx.textAlign = 'right'
      ctx.font = 'bold ' + huge + 'px sans-serif'
      ctx.fillStyle = C.fg
      const cur = st ? st.cur : NaN
      ctx.fillText(fmt(cur), W - pad, sy + huge * 0.62)
      if (isRad && isFinite(cur)) {
        ctx.font = sml + 'px sans-serif'
        ctx.fillStyle = C.dim
        ctx.fillText('≈ ' + (cur * 180 / Math.PI).toFixed(1) + '°', W - pad, sy + huge * 0.62 + sml * 1.25)
      }
      sy += huge * 1.35
    }
    sy += mid * 0.3
  }

  // ---- 统计表 ----
  const heads = ['最小', '最大', '范围', 'σ']
  const tX = pad + (W - pad * 2) * 0.30
  const cw = (W - pad - tX) / 4
  ctx.font = sml + 'px sans-serif'
  ctx.fillStyle = C.dim
  ctx.textAlign = 'left'
  ctx.fillText('分量/样本', pad, sy)
  for (let i = 0; i < 4; i++) {
    ctx.textAlign = 'right'
    ctx.fillText(heads[i], tX + cw * (i + 1) - 4, sy)
  }
  sy += sml * 1.35
  for (let i = 0; i < order.length; i++) {
    const st = r.stats[order[i]]
    ctx.textAlign = 'left'
    ctx.fillStyle = C.fg
    ctx.font = mid + 'px sans-serif'
    ctx.fillText(order[i] + (st ? (' ' + st.n) : ''), pad, sy)
    const vals = st ? [fmt(st.min), fmt(st.max), fmt(st.max - st.min), fmt(sigmaOf(st))] : ['-', '-', '-', '-']
    for (let k = 0; k < 4; k++) {
      ctx.textAlign = 'right'
      ctx.fillStyle = (k === 3) ? C.warn : C.dim
      ctx.fillText(vals[k], tX + cw * (k + 1) - 4, sy)
    }
    sy += mid * 1.15
  }

  // angle 结构 + 单位
  ctx.textAlign = 'left'
  ctx.fillStyle = C.dim
  ctx.font = sml + 'px sans-serif'
  let hy = sy + sml * 0.55
  if (r.angleStruct) {
    ctx.fillText('angle: ' + r.angleStruct + '  ' + (r.angleRaw || '').slice(0, 36), pad, hy)
    hy += sml * 1.1
  }
  if (order.length) {
    ctx.fillText('量程峰值 ' + fmt(maxAbs) + ' → ' + (isRad ? '单位=弧度' : '单位=角度/其它'), pad, hy)
    hy += sml * 1.1
  }

  // ---- yaw 实时曲线（肉眼验证响应性）----
  const sparkH = Math.max(46, Math.round(u * 1.9))
  const sparkY = hy + sml * 1.2
  const sw = W - pad * 2
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1
  ctx.strokeRect(pad, sparkY, sw, sparkH)
  ctx.fillStyle = C.warn
  ctx.font = sml + 'px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('yaw 曲线（最近 ' + r.yawHist.length + ' 采样）', pad + 2, sparkY - 3)
  const arr = r.yawHist
  if (arr.length >= 2) {
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < arr.length; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i] }
    const c0 = (mx + mn) / 2
    const half = Math.max(0.06, (mx - mn) / 2 * 1.25)
    mn = c0 - half; mx = c0 + half
    const range = mx - mn || 1
    ctx.beginPath()
    for (let i = 0; i < arr.length; i++) {
      const px = pad + 2 + (sw - 4) * i / (arr.length - 1)
      const py = sparkY + sparkH - 2 - (sparkH - 4) * ((arr[i] - mn) / range)
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = C.warn
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.lineWidth = 1
    // 0 基准线
    const zy = sparkY + sparkH - 2 - (sparkH - 4) * ((0 - mn) / range)
    if (zy > sparkY && zy < sparkY + sparkH) {
      ctx.strokeStyle = C.line
      ctx.beginPath(); ctx.moveTo(pad, zy); ctx.lineTo(pad + sw, zy); ctx.stroke()
    }
    ctx.fillStyle = C.dim
    ctx.textAlign = 'right'
    ctx.fillText('±' + fmt(half) + ' rad', pad + sw - 2, sparkY - 3)
    ctx.textAlign = 'left'
  } else {
    ctx.fillStyle = C.dim
    ctx.fillText('等待采样…', pad + 6, sparkY + sparkH * 0.6)
  }

  // ---- 按钮区（3 个：切换相机 / 降采样 / 重置统计）----
  const btnH = Math.max(32, Math.round(u * 1.9))
  const btnY = H - pad - btnH
  const gapB = 8
  const bw = (maxW - gapB * 2) / 3
  S.btn.y = btnY; S.btn.h = btnH
  S.btn.w = bw
  S.btn.xs = [pad, pad + bw + gapB, pad + (bw + gapB) * 2]

  function button(x, w, label, fg) {
    ctx.fillStyle = C.panel
    ctx.fillRect(x, btnY, w, btnH)
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    ctx.strokeRect(x, btnY, w, btnH)
    ctx.fillStyle = fg
    ctx.font = shrink(label, sml + 1, w - 10) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(label, x + w / 2, btnY + btnH / 2 + (sml + 1) * 0.36)
    ctx.textAlign = 'left'
  }
  button(S.btn.xs[0], bw, '切换' + (S.camPos === 'front' ? '后置' : '前置'), C.accent)
  button(S.btn.xs[1], bw, S.ds > 1 ? ('降采样 ÷' + S.ds) : '降采样 关', S.ds > 1 ? C.ok : C.dim)
  button(S.btn.xs[2], bw, '重置统计', C.dim)

  // ---- 底部说明 ----
  ctx.textAlign = 'left'
  ctx.fillStyle = C.fg
  ctx.font = sml + 'px sans-serif'
  ctx.fillText('① 看「取帧X/s」能否突破 12/s（v15 被 80ms 节流顶死在这）', pad, btnY - sml * 1.5)
  ctx.fillStyle = C.dim
  ctx.fillText('② 连点「降采样」每档停 10s → 看 A/B 行「回 / 帧」怎么变', pad, btnY - sml * 0.35)

  // ---- 每帧推进 ----
  r.renders++
  r.renderStamps.push(now)
  if (r.renderStamps.length > 120) r.renderStamps.shift()
  r.frameFps = rateIn(r.frameStamps, now)
  r.detFps = rateIn(r.evStamps, now)
  r.callFps = rateIn(r.callStamps, now)
  r.renderFps = rateIn(r.renderStamps, now)

  // 相机就绪 → 等 SETTLE_MS（让原生从默认后置切到前置）再绑定取帧
  if (S.camReady && !S.listening) {
    const left = SETTLE_MS - (now - S.camReadyAt)
    S.settleLeft = left > 0 ? Math.ceil(left / 1000) : 0
    if (left <= 0 && camObj && workerObj) {
      S.listening = true
      S.settleLeft = 0
      try { camObj.listenFrameChange(workerObj); workerObj.postMessage({ t: 'go' }) }
      catch (e) { S.err = 'listenFrameChange:' + msgOf(e) }
      pushMode()
      r.pendingReq = false
      requestFrame()
    }
  }

  stepDetect()

  requestAnimationFrame(render)
}
requestAnimationFrame(render)

// ---------------- 启动 ----------------
function start() {
  const r = S.rt
  r.frames = 0; r.bytes = 0; r.bytesStr = ''; r.latestBuf = null; r.fresh = false
  r.pendingReq = false; r.reqAt = 0; r.reqSent = 0
  r.frameW = SRC_W; r.frameH = SRC_H
  r.frameStamps = []; r.evStamps = []; r.callStamps = []; r.renderStamps = []
  r.frameFps = 0; r.detFps = 0; r.callFps = 0; r.renderFps = 0
  r.lastGrab = NaN; r.lastDs = NaN; r.lastXfer = NaN
  r.lastWake = NaN; r.lastBack = NaN
  r.wakeHist = []; r.grabHist = []; r.backHist = []
  r.avgWake = NaN; r.avgGrab = NaN; r.avgBack = NaN
  r.calls = 0; r.events = 0; r.faces = 0; r.noFace = 0; r.timeouts = 0
  r.inflight = false; r.inflightAt = 0; r.nextAt = Date.now() + 200
  r.lastLat = NaN; r.avgLat = NaN; r.latHist = []; r.pace = PACE_MIN
  r.lastHitAt = 0; r.err = ''
  r.angleStruct = ''; r.angleRaw = ''
  r.stats = {}; r.order = []
  r.yawHist = []
  r.thumb = null; r.thumbAt = 0
  S.log = {}
  S.err = ''
  S.camReady = false; S.camReadyAt = 0; S.settleLeft = 0; S.listening = false

  if (!S.hasCam) { S.err = 'wx.createCamera 不存在'; return }
  const worker = ensureWorker()
  if (!worker) { S.err = 'createWorker 失败' + (S.workerErr ? (':' + S.workerErr) : ''); return }

  if (!r.sess) startVK()

  const rect = layout().camRect
  try {
    camObj = wx.createCamera({
      devicePosition: S.camPos,     // 'front'/'back'（官方合法值；默认 back）
      size: 'small',
      x: rect.x, y: rect.y, width: rect.w, height: rect.h,   // 可见区域：原生预览画这
      success: function () {
        S.camReady = true
        S.camReadyAt = Date.now()   // 渲染循环里等 SETTLE_MS 再取帧
      },
      fail: function (e) {
        S.err = 'createCamera fail:' + (e && e.errMsg ? e.errMsg : JSON.stringify(e))
      }
    })
  } catch (e) { S.err = msgOf(e) }
}

function boot() {
  if (typeof wx.requirePrivacyAuthorize !== 'function') {
    S.privacyState = '不支持(<2.32.3)'
    start()
    return
  }
  wx.requirePrivacyAuthorize({
    success: function () { S.privacyState = '已同意'; start() },
    fail: function () { S.privacyState = '被拒/未开通弹窗'; start() },
    complete: function () {}
  })
}
boot()

// ---------------- 触摸：按钮 ----------------
wx.onTouchStart(function (e) {
  if (S.privacyState !== '已同意' && typeof wx.requirePrivacyAuthorize === 'function') {
    wx.requirePrivacyAuthorize({
      success: function () { S.privacyState = '已同意' },
      fail: function () { /* ignore */ },
      complete: function () {}
    })
  }
  let tx = NaN, ty = NaN
  try {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (t) { tx = t.clientX; ty = t.clientY }
  } catch (e2) { /* ignore */ }

  const b = S.btn
  const inRow = (typeof ty === 'number' && ty >= b.y - 6 && ty <= b.y + b.h + 6)
  if (!inRow || typeof tx !== 'number') return

  // keepLog=true 时保留 A/B 记录（切降采样档用）→ 其它情况（重置统计/换相机）清空
  function clearStats(keepLog) {
    const r = S.rt
    r.stats = {}; r.order = []; r.calls = 0; r.events = 0; r.faces = 0
    r.noFace = 0; r.timeouts = 0
    r.evStamps = []; r.callStamps = []; r.frameStamps = []; r.renderStamps = []
    r.latHist = []; r.lastLat = NaN; r.avgLat = NaN; r.pace = PACE_MIN
    r.lastGrab = NaN; r.lastDs = NaN; r.lastXfer = NaN
    r.lastWake = NaN; r.lastBack = NaN
    r.wakeHist = []; r.grabHist = []; r.backHist = []
    r.avgWake = NaN; r.avgGrab = NaN; r.avgBack = NaN
    r.yawHist = []
    if (!keepLog) S.log = {}
  }

  for (let i = 0; i < b.xs.length; i++) {
    const x0 = b.xs[i]
    if (tx < x0 || tx > x0 + b.w) continue
    if (i === 0) {
      // 切换前置 / 后置（重建相机，重新等前置就绪）→ A/B 记录一并清掉（换了光源，旧数据不可比）
      S.camPos = (S.camPos === 'front') ? 'back' : 'front'
      stopCam()
      start()
    } else if (i === 1) {
      // 降采样一键多档扫描：关 → ÷2 → ÷3 → ÷4 → 关（288×512 → 144×256 → 96×170 → 72×128）
      // 每档搬运量按 ds² 递减，用来判断「那 479ms 是否随数据量缩放」
      S.ds = (S.ds >= 4) ? 1 : (S.ds + 1)
      pushMode()
      clearStats(true)      // ★ 保留 A/B 记录，才能一张图对比四档
    } else {
      // 重置统计（不清帧、不重建相机）→ A/B 记录也清空
      clearStats(false)
    }
    return
  }
})
