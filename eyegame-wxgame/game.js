// ============================================================================
// 脖动圈 · 纵轴卷轴 MVP (mvp-1)
// ============================================================================
//
// 设计依据：脖动圈_垂直切片设计规格v1.0_纵轴_2026-10-07.md
// 技术依据：POC v16 真机实测（VisionKit 链路已跑通，默认 ÷3 档 17/s）
//
// ── 这一版的目标 ──────────────────────────────────────────────
// 「可玩」优先：能在真机上跑起来，转头能控制飞船、世界在流动、有速度感。
// 手感参数（死区/EMA/外推）都是初值，真机试完再调。
//
// ── 核心设计（照规格实现）──────────────────────────────────────
//   · 纵轴卷轴：飞船在 y=0.78H，世界迎面涌来（伪 3D，尺寸 ∝ 1/z）
//   · yaw 左右转 → 飞船横向位移（已实测：左转↗右转↘，不做方向反转）
//   · pitch 抬头 → Boost 氮气（短促动作 + 冷却，不是"保持角度=保持速度"）
//   · roll 仅作机身倾斜装饰（σ≈4°，不参与操作）
//   · ★ 速度感与可玩性解耦：世界流动速度受可反应时间约束（≤1.3 H/s），
//     而视觉速度（星场/速度线/尾迹）自由拉高到 4~6 倍 —— 爽感靠视觉层
//   · 5 泳道防挫败：每波**至少留 1 条空泳道**，且与上一波空泳道相邻可达
//
// ── 三种姿态源（自动降级）──────────────────────────────────────
//   visionkit（主）→ gyro（陀螺仪兜底）→ touch（触摸，开发/演示用）
//   点右下角按钮可手动循环切换，方便在没有摄像头的环境里验证玩法
//
// ── 相机隐藏 ──────────────────────────────────────────────────
//   wx.createCamera 支持 x/y/width/height，所以把预览**丢到屏幕外**（1×1），
//   这样正式游戏画面里不会出现摄像头预览（规格 §11.1 的技术前置风险）。
//   若真机上发现藏起来后取不到帧 → 点按钮切到"传感器窗口"模式（可见小窗）。
//
// ⚠️ 合规：全程仅本机实时处理，人脸数据不落盘、不上传。
// ============================================================================

const canvas = wx.createCanvas()
const ctx = canvas.getContext('2d')
let W = 1, H = 1
function resize() { W = canvas.width; H = canvas.height; layout() }
wx.onWindowResize(resize)

let sys = {}
try { sys = wx.getSystemInfoSync() || {} } catch (e) { /* ignore */ }
let menu = null
try { menu = wx.getMenuButtonBoundingClientRect() } catch (e) { /* ignore */ }

const C = {
  bg0: '#05070f', bg1: '#0a0f22',
  ship: '#5b8cff', shipDark: '#2a4bb0', shipLite: '#cfe0ff',
  obs: '#ff5a4a', obsEdge: '#ff9d8a',
  star: '#cfe0ff', speed: '#7fd8ff',
  trail: '#ffb066',
  lane: '#1b2545',
  fg: '#e6ecff', dim: '#7f8fc4',
  ok: '#4ade80', bad: '#ff6b6b', warn: '#fbbf24', accent: '#7aa2ff',
  panel: '#0f1630', line: '#243060'
}

// ---------------------------------------------------------------- 配置
const CFG = {
  // 布局比例
  HORIZON_R: 0.22,        // 地平线位置（占屏高）
  SHIP_Y_R: 0.78,         // 飞船位置（占屏高）
  SHIP_Z: 8,              // 飞船纵深（世界单位）
  Z_FAR: 30,              // 障碍生成纵深
  Z_NEAR: 5.5,            // 纵深远于此则回收（≈刚滑出屏幕下沿）

  LANES: 5,               // 泳道数
  LANE_W: 0.5,            // 泳道宽（世界单位）
  SHIP_HW: 0.10,          // 飞船半宽（世界单位）
  OBS_HW: 0.20,           // 障碍半宽（世界单位）
  X_LIMIT: 1.05,          // 飞船横向软限位

  // 控制
  YAW_GAIN: 2.2,          // yaw(rad) → 世界横向：0.45rad(26°) ≈ 世界单位 1.0
  YAW_DEAD: 0.052,        // 死区 3°
  EMA_A: 0.35,            // 指数平滑
  EXTRAP: 0.55,           // 速率外推（补延迟）
  ROLL_K: 0.30,           // roll 只做装饰
  PITCH_BOOST: 0.14,      // |pitch| > 8° 触发 Boost（方向待真机确认，先用绝对值）
  BOOST_MAX_MS: 3000,
  BOOST_COOL_MS: 4000,
  BOOST_GAIN: 1.6,        // Boost 时视觉速度倍率（机制速度几乎不动）

  // 相机
  SETTLE_MS: 3000,        // 等前置摄像头真正生效（默认后置启动）
  DS: 3,                  // 降采样档：÷3（实测 17/s）

  // 玩法
  LIVES: 3,
  INVULN_MS: 1200,
  SPEED_MIN: 9,           // 世界单位/s
  SPEED_MAX: 20,
  RAMP_SEC: 55,
  GAP_START: 0.95,        // 波间隔（秒）
  GAP_END: 0.50,
}

let L = {}   // 布局缓存（resize 与 render 共用）
function layout() {
  const pad = Math.max(10, Math.round(Math.min(W, H) * 0.04))
  const top = (menu && menu.bottom) ? (menu.bottom + 6) : (pad + 26)
  L = {
    pad: pad, top: top,
    horizon: H * CFG.HORIZON_R,
    shipY: H * CFG.SHIP_Y_R,
    cx: W / 2,
    // 投影系数：sy = horizon + PPY/z ；sx = cx + wx*PPX/z ；尺寸 = r*PPX/z
    PPX: 0.38 * W * CFG.SHIP_Z,
    PPY: (H * CFG.SHIP_Y_R - H * CFG.HORIZON_R) * CFG.SHIP_Z
  }
}
resize()   // 首次布局：必须放在 let L 的声明之后，否则 TDZ 报错

// ---------------------------------------------------------------- 状态
const S = {
  mode: 'boot',           // boot | play | over
  srcKind: 'auto',        // auto | visionkit | gyro | touch
  srcActive: 'none',      // 实际生效：visionkit | gyro | touch
  err: '', msg: '',

  // 摄像头 / 姿态链路
  hasCam: typeof wx.createCamera === 'function',
  hasWorker: typeof wx.createWorker === 'function',
  hasVK: typeof wx.createVKSession === 'function',
  hasAcc: typeof wx.startAccelerometer === 'function',
  camReady: false, camReadyAt: 0, listening: false, settleLeft: 0,
  camVisible: false,      // 相机预览是否可见（false = 丢到屏幕外）
  srcSince: 0,            // 当前输入源的启动时刻（用于超时降级）
  vk: { sess: null, ready: false, startErr: '' },

  // 取帧
  fr: {
    buf: null, fresh: false, w: 288, h: 512,
    frames: 0, pending: false, reqAt: 0,
    stamps: [], fps: 0, err: ''
  },

  // 检测
  det: {
    inflight: false, at: 0, nextAt: 0,
    calls: 0, events: 0, faces: 0, noFace: 0, timeouts: 0,
    lastLat: NaN, avgLat: NaN, latHist: [], latHit: 0, fps: 0,
    stamps: []
  },

  // 姿态（弧度）
  pose: {
    yaw: 0, pitch: 0, roll: 0, hasFace: false,
    nYaw: 0, nPitch: 0, calibrated: false, samples: 0
  },

  // 玩法
  g: {
    wx: 0,            // 飞船横向（世界单位）
    tgt: 0, tilt: 0,
    score: 0, best: 0, lives: CFG.LIVES,
    invulnUntil: 0, dead: false,
    t: 0,                       // 本局时间（秒）
    speed: CFG.SPEED_MIN,
    nextSpawn: 0,
    obs: [], stars: [], streaks: [],
    shake: 0, flash: 0,
    boostUntil: 0, boostCoolAt: 0, boosting: false,
    dodged: 0
  },

  // 颈椎记账
  neck: { left: 0, right: 0, activity: 0, side: 0 },

  // 调试
  perf: { renderStamps: [], renderFps: 0 },
  btn: { y: 0, h: 0, x: 0, w: 0 },
}

try { S.g.best = wx.getStorageSync('bd_best') || 0 } catch (e) { S.g.best = 0 }

let camObj = null
let workerObj = null

function msgOf(e) { return (e && e.message) ? e.message : String(e) }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }
function lerp(a, b, t) { return a + (b - a) * t }
function rnd(a, b) { return a + Math.random() * (b - a) }

// ---------------------------------------------------------------- 投影
function project(wx, wz) {
  const z = Math.max(0.9, wz)
  return {
    x: L.cx + wx * L.PPX / z,
    y: L.horizon + L.PPY / z,
    s: L.PPX / z,
    z: z
  }
}

// ---------------------------------------------------------------- Worker
function ensureWorker() {
  if (workerObj) return workerObj
  if (!S.hasWorker) { S.err = 'wx.createWorker 不存在'; return null }
  try {
    workerObj = wx.createWorker('workers/index.js', { useExperimentalWorker: true })
    workerObj.onMessage(function (m) {
      if (!m || !m.t) return
      if (m.t === 'frame' && m.buf) { onFrame(m); return }
      if (m.t === 'stat' && m.err && m.err !== 'empty') { S.fr.err = 'worker:' + m.err }
    })
    try { workerObj.onProcessKilled && workerObj.onProcessKilled(function () { workerObj = null }) } catch (e) { /* ignore */ }
    workerObj.postMessage({ t: 'probe' })
    workerObj.postMessage({ t: 'mode', ds: CFG.DS })
  } catch (e) {
    S.err = 'createWorker:' + msgOf(e)
    workerObj = null
  }
  return workerObj
}

function requestFrame() {
  const f = S.fr
  if (!workerObj || !S.listening) return
  const now = Date.now()
  if (f.pending && (now - f.reqAt) < 1200) return
  f.pending = true
  f.reqAt = now
  try { workerObj.postMessage({ t: 'need', sentAt: now }) } catch (e) { f.err = 'need:' + msgOf(e) }
}

function onFrame(m) {
  const f = S.fr
  f.pending = false
  f.frames++
  const now = Date.now()
  f.stamps.push(now)
  if (f.stamps.length > 90) f.stamps.shift()
  let n = 0
  try { n = (typeof m.buf.byteLength === 'number') ? m.buf.byteLength : (m.buf.length || 0) } catch (e) { /* ignore */ }
  if (!n) return
  f.buf = m.buf                                     // worker 每次 postMessage 都是新副本，持有安全
  f.w = (typeof m.w === 'number' && m.w > 0) ? m.w : 288
  f.h = (typeof m.h === 'number' && m.h > 0) ? m.h : 512
  f.fresh = true
  stepDetect()                                      // 事件驱动：帧一到就派发，不等 render
}

// ---------------------------------------------------------------- VKSession
function startVK() {
  if (typeof wx.createVKSession !== 'function') { S.vk.startErr = '无 wx.createVKSession'; return }
  try {
    const sess = wx.createVKSession({ track: { face: { mode: 2 } } })   // mode:2 静态图检测（mode:1 在 iOS 零事件）
    sess.on('updateAnchors', onAnchors)
    sess.on('removeAnchors', function () { S.det.noFace++ })
    S.vk.sess = sess
    sess.start(function (errno) {
      if (errno) { S.vk.startErr = JSON.stringify(errno); return }
      S.vk.ready = true
      S.det.nextAt = Date.now() + 200
    })
  } catch (e) {
    S.vk.startErr = msgOf(e)
  }
}

function onAnchors(anchors) {
  const d = S.det
  d.events++
  const now = Date.now()
  d.stamps.push(now)
  if (d.stamps.length > 90) d.stamps.shift()
  concludeDetect(now, true)

  let n = 0
  try { n = (anchors && anchors.length) ? anchors.length : 0 } catch (e) { n = 0 }
  if (n > 0) {
    d.faces++
    d.latHit = now
    const a = anchors[0]
    if (a && a.angle) applyAngle(a.angle)
  } else {
    d.noFace++
  }
}

function concludeDetect(now, gotEvent) {
  const d = S.det
  if (!d.inflight) return
  d.inflight = false
  if (gotEvent) {
    const lat = now - d.at
    if (lat > 0 && lat < 5000) {
      d.lastLat = lat
      d.latHist.push(lat)
      if (d.latHist.length > 8) d.latHist.shift()
      let s = 0
      for (let i = 0; i < d.latHist.length; i++) s += d.latHist[i]
      d.avgLat = s / d.latHist.length
    }
  }
  requestFrame()
}

function stepDetect() {
  const d = S.det
  if (!S.vk.ready || !S.vk.sess || !S.listening) return
  const now = Date.now()
  if (d.inflight) {
    // 超时上限按实测耗时自适应（detectFace 实测 6~7ms，不需要长等窗口）
    const lim = Math.max(140, Math.round((isFinite(d.avgLat) ? d.avgLat : 0) * 8))
    if (now - d.at < lim) return
    d.timeouts++
    concludeDetect(now, false)
    return
  }
  if (now < d.nextAt) return
  if (!S.fr.buf || !S.fr.fresh) { requestFrame(); return }
  S.fr.fresh = false
  d.inflight = true
  d.at = now
  d.calls++
  try {
    const p = S.vk.sess.detectFace({
      frameBuffer: S.fr.buf,
      width: S.fr.w,
      height: S.fr.h,
      sourceType: 0,        // 0 = 连续视频帧
      scoreThreshold: 0.5
    })
    if (p && typeof p.then === 'function') {
      p.then(function () {}, function (e) { d.err = 'df:' + msgOf(e); concludeDetect(Date.now(), false) })
    }
  } catch (e) {
    d.err = 'df:' + msgOf(e)
    concludeDetect(Date.now(), false)
  }
}

// ---------------------------------------------------------------- 角度解析
// anchor.angle = (pitch, yaw, roll)，单位弧度。真实类型文档未写死 → 多路兼容。
function applyAngle(ang) {
  const p = S.pose
  let v = null
  if (Array.isArray(ang)) v = [ang[0], ang[1], ang[2]]
  else if (typeof ang === 'object' && ang) {
    if ('pitch' in ang || 'yaw' in ang || 'roll' in ang) v = [ang.pitch, ang.yaw, ang.roll]
    else { const k = Object.keys(ang); v = [ang[k[0]], ang[k[1]], ang[k[2]]] }
  } else if (typeof ang === 'number') v = [ang, NaN, NaN]
  if (!v) return
  if (typeof v[0] === 'number' && isFinite(v[0])) p.pitch = v[0]
  if (typeof v[1] === 'number' && isFinite(v[1])) p.yaw = v[1]
  if (typeof v[2] === 'number' && isFinite(v[2])) p.roll = v[2]
  p.hasFace = true
  p.samples++
}

// ---------------------------------------------------------------- 姿态源：陀螺仪
const gyro = { y: 0, p: 0, ny: 0, np: 0, n: 0 }
function startGyro() {
  if (!S.hasAcc) { S.err = '无 startAccelerometer'; return false }
  try {
    wx.startAccelerometer({ interval: 'game' })
    wx.onAccelerometerChange(function (r) {
      const g = Math.hypot(r.x, r.y, r.z) || 1
      const yaw = -r.y / g
      const pitch = r.x / g
      gyro.n++
      if (gyro.n === 1) { gyro.ny = yaw; gyro.np = pitch }
      const dy = Math.abs(yaw - gyro.ny) > 0.03 ? (yaw - gyro.ny) : 0
      const dp = Math.abs(pitch - gyro.np) > 0.03 ? (pitch - gyro.np) : 0
      gyro.y += (dy - gyro.y) * 0.25
      gyro.p += (dp - gyro.p) * 0.25
      // 陀螺仪的量纲与 VisionKit 弧度不同，等比放大到可比区间
      const p = S.pose
      p.yaw = gyro.y * 1.6
      p.pitch = gyro.p * 1.6
      p.roll = 0
      p.hasFace = true
      p.samples++
    })
    S.srcActive = 'gyro'
    return true
  } catch (e) {
    S.err = 'gyro:' + msgOf(e)
    return false
  }
}

// ---------------------------------------------------------------- 姿态源：触摸
const touch = { active: false, x: 0, down: false }
function startTouch() {
  S.srcActive = 'touch'
  return true
}

// ---------------------------------------------------------------- 相机
function camRect() {
  // 不可见模式：丢到屏幕外 1×1（正式游戏不能显示摄像头预览）
  if (!S.camVisible) return { x: -4, y: -4, w: 2, h: 2 }
  const s = Math.round(Math.min(W, H) * 0.20)
  return { x: W - L.pad - s, y: L.top + s * 0.2, w: s, h: s }
}

function stopCam() {
  try { camObj && camObj.closeFrameChange && camObj.closeFrameChange() } catch (e) { /* ignore */ }
  try { camObj && camObj.destroy && camObj.destroy() } catch (e) { /* ignore */ }
  try { workerObj && workerObj.postMessage({ t: 'stop' }) } catch (e) { /* ignore */ }
  camObj = null
  S.listening = false
  S.camReady = false
}

function startVisionKit() {
  if (!S.hasCam) { S.err = 'wx.createCamera 不存在'; return false }
  if (!ensureWorker()) return false
  if (!S.vk.sess) startVK()

  const r = camRect()
  try {
    camObj = wx.createCamera({
      devicePosition: 'front',      // 官方合法值；注意默认是 back，前置要等 SETTLE_MS
      size: 'small',
      x: r.x, y: r.y, width: r.w, height: r.h,
      success: function () {
        S.camReady = true
        S.camReadyAt = Date.now()
      },
      fail: function (e) {
        S.err = 'createCamera:' + (e && e.errMsg ? e.errMsg : JSON.stringify(e))
      }
    })
  } catch (e) {
    S.err = 'createCamera:' + msgOf(e)
    return false
  }
  S.srcActive = 'visionkit'
  S.srcSince = Date.now()
  return true
}

// 解析输入源：'auto' 时按 visionkit → gyro → touch 逐级降级
function resolveSource() {
  const want = S.srcKind
  if (want === 'touch') return startTouch()
  if (want === 'gyro') return startGyro()

  // auto / visionkit
  if (startVisionKit()) return true
  if (startGyro()) return true
  return startTouch()
}

function switchSource() {
  const order = ['auto', 'gyro', 'touch']
  const i = order.indexOf(S.srcKind)
  const next = order[(i + 1) % order.length]
  stopCam()
  try { wx.stopAccelerometer && wx.stopAccelerometer() } catch (e) { /* ignore */ }
  S.srcKind = next
  S.srcActive = 'none'
  S.err = ''
}

// ---------------------------------------------------------------- 控制器
// yaw(rad) → 飞船目标横向位置；死区 + EMA + 速率外推
const ctl = { f: 0, prev: 0 }
function updateControl(dt) {
  const p = S.pose
  const raw = p.yaw - p.nYaw

  // 死区
  const dead = Math.abs(raw) < CFG.YAW_DEAD ? 0 : raw

  // EMA 平滑
  ctl.f = ctl.f + (dead - ctl.f) * CFG.EMA_A

  // 速率外推（用当前速度预测一帧后，补 44~58ms 的链路延迟）
  const vel = ctl.f - ctl.prev
  ctl.prev = ctl.f
  const pred = ctl.f + vel * CFG.EXTRAP

  const tgt = clamp(pred * CFG.YAW_GAIN, -CFG.X_LIMIT, CFG.X_LIMIT)
  const g = S.g
  g.tgt = tgt
  // 飞船实际位移略慢于目标，做出"跟手但有质量"的手感
  g.wx += (tgt - g.wx) * Math.min(1, dt * 14)
  g.tilt = clamp(p.roll * CFG.ROLL_K, -0.35, 0.35)
  if (touch.down) {
    g.wx += (clamp(touch.x, -1.05, 1.05) - g.wx) * Math.min(1, dt * 16)
    g.tgt = g.wx
  }
}

// 颈椎活动记账：带滞回的左右转头计数
// ⚠️ 必须"先退出滞回、再重新判定"，否则从左直接切到右时那一次会被吞掉
//    （冒烟 H1 抓到的 bug：旧写法一次调用只能退回到中立，要等下一帧才计数）
function trackNeck() {
  const y = S.pose.yaw - S.pose.nYaw
  const th = 0.17           // 触发阈值 ≈10°
  const nk = S.neck
  if (nk.side === 1 && y < th * 0.5) nk.side = 0
  else if (nk.side === -1 && y > -th * 0.5) nk.side = 0
  if (nk.side === 0) {
    if (y > th) { nk.side = 1; nk.right++; nk.activity++ }
    else if (y < -th) { nk.side = -1; nk.left++; nk.activity++ }
  }
}

// ---------------------------------------------------------------- Boost
function updateBoost(dt) {
  const g = S.g
  const now = Date.now()
  const p = S.pose
  const over = Math.abs(p.pitch - p.nPitch) > CFG.PITCH_BOOST && p.hasFace

  if (g.boosting) {
    if (!over || now > g.boostUntil) {
      g.boosting = false
      g.boostCoolAt = now + CFG.BOOST_COOL_MS
    }
  } else if (over && now > g.boostCoolAt) {
    g.boosting = true
    g.boostUntil = now + CFG.BOOST_MAX_MS
  }
}

// ---------------------------------------------------------------- 世界
function diffRatio() { return clamp(S.g.t / CFG.RAMP_SEC, 0, 1) }

function laneToWx(lane) { return (lane - (CFG.LANES - 1) / 2) * CFG.LANE_W }

let lastOpen = []
function spawnWave() {
  const g = S.g
  const n = CFG.LANES
  const d = diffRatio()

  // 1) 先保一条"可达空泳道"：优先取上一波空泳道本身或其邻居
  let keepOpen = -1
  if (lastOpen.length) {
    const pri = []
    for (let i = 0; i < lastOpen.length; i++) {
      const p = lastOpen[i]
      if (p - 1 >= 0) pri.push(p - 1)
      pri.push(p)
      if (p + 1 <= n - 1) pri.push(p + 1)
    }
    keepOpen = pri[Math.floor(Math.random() * pri.length)]
  }

  // 2) 从剩余泳道里随机占用（占用数随难度 1→3，永远给"可通行"留位置）
  const pool = []
  for (let i = 0; i < n; i++) if (i !== keepOpen) pool.push(i)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t
  }
  const maxOcc = Math.min(pool.length, 1 + Math.round(d * 2))
  const occ = 1 + Math.floor(Math.random() * maxOcc)

  const open = []
  for (let i = 0; i < n; i++) open.push(i)
  for (let i = 0; i < occ; i++) {
    const lane = pool[i]
    open[lane] = -1
    g.obs.push({ lane: lane, wx: laneToWx(lane), z: CFG.Z_FAR, hit: false, counted: false })
  }
  lastOpen = open.filter(function (v) { return v >= 0 })
}

function updateWorld(dt) {
  const g = S.g

  // 速度随难度爬升
  g.speed = lerp(CFG.SPEED_MIN, CFG.SPEED_MAX, diffRatio())

  // 生成
  g.nextSpawn -= dt
  if (g.nextSpawn <= 0) {
    spawnWave()
    g.nextSpawn = lerp(CFG.GAP_START, CFG.GAP_END, diffRatio())
  }

  // 推进 + 碰撞
  const dz = g.speed * dt
  const now = Date.now()
  for (let i = g.obs.length - 1; i >= 0; i--) {
    const o = g.obs[i]
    const zPrev = o.z
    o.z -= dz

    // 穿过飞船平面 → 判定
    if (!o.hit && zPrev > CFG.SHIP_Z && o.z <= CFG.SHIP_Z) {
      const dw = Math.abs(o.wx - g.wx)
      if (dw < CFG.OBS_HW + CFG.SHIP_HW) {
        o.hit = true
        if (now > g.invulnUntil) {
          g.lives--
          g.invulnUntil = now + CFG.INVULN_MS
          g.shake = 1
          g.flash = 1
          if (g.lives <= 0) gameOver()
        }
      } else if (!o.counted) {
        o.counted = true
        g.dodged++
        g.score += 10
      }
    }
    if (o.z < CFG.Z_NEAR) g.obs.splice(i, 1)
  }

  g.t += dt
  g.score += g.speed * dt * 0.6      // 存活即得分
  g.shake = Math.max(0, g.shake - dt * 3)
  g.flash = Math.max(0, g.flash - dt * 2.5)
}

function initStars() {
  const g = S.g
  g.stars = []
  const layers = [0.5, 2.0, 5.0]
  for (let li = 0; li < layers.length; li++) {
    const count = 34 + li * 12
    for (let i = 0; i < count; i++) {
      g.stars.push({ x: Math.random(), y: Math.random(), l: layers[li] })
    }
  }
  g.streaks = []
  for (let i = 0; i < 14; i++) {
    g.streaks.push({ ang: Math.random() * Math.PI * 2, r: rnd(0.1, 0.9), sp: rnd(0.35, 0.9) })
  }
}

function updateFx(dt) {
  const g = S.g
  const vis = (g.speed / CFG.SPEED_MAX) * (g.boosting ? CFG.BOOST_GAIN : 1)

  for (let i = 0; i < g.stars.length; i++) {
    const s = g.stars[i]
    s.y += (0.06 + vis * 0.10) * (s.l / 2) * dt * 3
    if (s.y > 1.08) { s.y = -0.08; s.x = Math.random() }
  }
  for (let i = 0; i < g.streaks.length; i++) {
    const k = g.streaks[i]
    k.r += k.sp * (0.35 + vis) * dt
    if (k.r > 1.15) { k.r = rnd(0.06, 0.25); k.ang = Math.random() * Math.PI * 2; k.sp = rnd(0.35, 0.9) }
  }
}

// ---------------------------------------------------------------- 状态机
function startRun() {
  const g = S.g
  g.wx = 0; g.tgt = 0; g.tilt = 0
  g.score = 0; g.lives = CFG.LIVES; g.invulnUntil = 0
  g.t = 0; g.speed = CFG.SPEED_MIN; g.nextSpawn = 0.9
  g.obs = []; g.shake = 0; g.flash = 0
  g.boostUntil = 0; g.boostCoolAt = 0; g.boosting = false
  g.dodged = 0
  lastOpen = []
  S.neck = { left: 0, right: 0, activity: 0, side: 0 }
  ctl.f = 0; ctl.prev = 0
  S.pose.nYaw = S.pose.yaw
  S.pose.nPitch = S.pose.pitch
  S.pose.calibrated = true
  initStars()
  S.mode = 'play'
}

function gameOver() {
  const g = S.g
  g.dead = true
  S.mode = 'over'
  if (g.score > g.best) {
    g.best = Math.round(g.score)
    try { wx.setStorageSync('bd_best', g.best) } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 渲染
function render() {
  const g = S.g
  const now = Date.now()
  const dt = Math.min(0.05, (now - (render.last || now)) / 1000)
  render.last = now

  // 每帧推进
  S.fr.fps = rateIn(S.fr.stamps, now)
  S.det.fps = rateIn(S.det.stamps, now)
  S.perf.renderStamps.push(now)
  if (S.perf.renderStamps.length > 90) S.perf.renderStamps.shift()
  S.perf.renderFps = rateIn(S.perf.renderStamps, now)

  if (S.mode === 'play') {
    updateControl(dt)
    updateBoost(dt)
    updateWorld(dt)
    updateFx(dt)
    trackNeck()
  } else {
    updateFx(dt * (S.mode === 'boot' ? 0.35 : 0.6))
  }

  // 相机就绪 → 等 SETTLE_MS（让原生从默认后置切到前置）再绑定取帧
  if (S.camReady && !S.listening) {
    const left = CFG.SETTLE_MS - (now - S.camReadyAt)
    S.settleLeft = left > 0 ? Math.ceil(left / 1000) : 0
    if (left <= 0 && camObj && workerObj) {
      try {
        camObj.listenFrameChange(workerObj)
        workerObj.postMessage({ t: 'go' })
        workerObj.postMessage({ t: 'mode', ds: CFG.DS })
        S.listening = true
        S.fr.pending = false
        requestFrame()
      } catch (e) { S.err = 'listenFrameChange:' + msgOf(e) }
    }
  }
  // 摄像头迟迟没就绪（权限 / 设备问题）→ 自动降级，别让玩家卡在黑屏
  if (S.srcActive === 'visionkit' && !S.camReady && !S.listening &&
      S.srcSince && (now - S.srcSince > 6000)) {
    S.err = '摄像头未就绪 → 已降级'
    if (!startGyro()) startTouch()
  }

  stepDetect()

  draw(dt, now)
  requestAnimationFrame(render)
}

function rateIn(stamps, now) {
  let c = 0
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (now - stamps[i] <= 1000) c++
    else break
  }
  return c
}

function draw(dt, now) {
  const g = S.g
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // 震屏
  if (g.shake > 0.01) {
    const m = g.shake * 8
    ctx.translate(rnd(-m, m), rnd(-m, m))
  }

  // 背景（深空渐变：用两条纯色带模拟，不用真渐变以省性能）
  ctx.fillStyle = C.bg0
  ctx.fillRect(-20, -20, W + 40, H + 40)
  ctx.fillStyle = C.bg1
  ctx.fillRect(-20, -20, W + 40, L.horizon)

  drawStars()
  drawLanes()
  drawObstacles()
  drawStreaks()
  drawShip()

  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (g.flash > 0.01) {
    ctx.fillStyle = 'rgba(255,90,74,' + (g.flash * 0.35) + ')'
    ctx.fillRect(0, 0, W, H)
  }

  if (S.mode === 'boot') {
    drawBoot()
  } else {
    drawHud(now)
    if (S.mode === 'over') drawOver()
  }
}

function drawStars() {
  const g = S.g
  for (let i = 0; i < g.stars.length; i++) {
    const s = g.stars[i]
    const r = s.l >= 5 ? 1.8 : (s.l >= 2 ? 1.3 : 0.9)
    const a = s.l >= 5 ? 0.85 : (s.l >= 2 ? 0.5 : 0.28)
    ctx.globalAlpha = a
    ctx.fillStyle = C.star
    ctx.fillRect(s.x * W, s.y * H, r, r)
  }
  ctx.globalAlpha = 1
}

function drawLanes() {
  // 地平线
  ctx.strokeStyle = 'rgba(122,162,255,0.30)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, L.horizon)
  ctx.lineTo(W, L.horizon)
  ctx.stroke()

  // 泳道分隔线（透视收敛，帮忙读通道）
  const half = (CFG.LANES - 1) / 2
  ctx.strokeStyle = 'rgba(36,48,96,0.85)'
  ctx.lineWidth = 1
  for (let i = 0; i <= CFG.LANES; i++) {
    const wx = (i - half - 0.5) * CFG.LANE_W
    const a = project(wx, CFG.Z_FAR)
    const b = project(wx, CFG.Z_NEAR)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
}

function drawObstacles() {
  const g = S.g
  const now = Date.now()
  g.obs.sort(function (a, b) { return b.z - a.z })     // 远的先画
  for (let i = 0; i < g.obs.length; i++) {
    const o = g.obs[i]
    const p = project(o.wx, o.z)
    const half = CFG.OBS_HW * p.s
    const hh = 0.30 * p.s            // 障碍世界高度 0.6（用同一透视系数）
    if (p.y < -20) continue

    // 预告区（屏幕上部 15%）：只画轮廓，提示"前面有东西"
    const inForecast = p.y < L.horizon + (L.shipY - L.horizon) * 0.20
    const alpha = inForecast ? 0.35 : 1

    ctx.globalAlpha = alpha
    ctx.fillStyle = C.obs
    ctx.fillRect(p.x - half, p.y - hh, half * 2, hh * 2)
    ctx.strokeStyle = C.obsEdge
    ctx.lineWidth = 1
    ctx.strokeRect(p.x - half, p.y - hh, half * 2, hh * 2)
    ctx.globalAlpha = 1
  }
}

function drawStreaks() {
  const g = S.g
  const vis = (g.speed / CFG.SPEED_MAX) * (g.boosting ? CFG.BOOST_GAIN : 1)
  const cx = L.cx
  const cy = L.shipY * 0.86
  const R = Math.hypot(W, H) * 0.6
  ctx.lineCap = 'round'
  for (let i = 0; i < g.streaks.length; i++) {
    const k = g.streaks[i]
    const r0 = k.r * R
    const len = (0.06 + vis * 0.16) * R
    const ca = Math.cos(k.ang), sa = Math.sin(k.ang)
    ctx.globalAlpha = clamp(0.10 + vis * 0.42, 0, 0.85)
    ctx.strokeStyle = g.boosting ? '#ffd98a' : C.speed
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(cx + ca * r0, cy + sa * r0)
    ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len))
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'
}

function drawShip() {
  const g = S.g
  const p = project(g.wx, CFG.SHIP_Z)
  const s = clamp(Math.min(W, H) * 0.045, 14, 34)
  const now = Date.now()
  const invuln = now < g.invulnUntil
  const blink = invuln && (Math.floor(now / 110) % 2 === 0)

  // 尾迹（长度 ∝ 速度，Boost 时加长爆亮）
  const vis = (g.speed / CFG.SPEED_MAX) * (g.boosting ? CFG.BOOST_GAIN : 1)
  const tl = s * (1.6 + vis * 3.2)
  ctx.globalAlpha = 0.85
  ctx.strokeStyle = g.boosting ? '#ffe1a8' : C.trail
  ctx.lineWidth = s * 0.28
  ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(p.x - s * 0.30, p.y + s * 0.55); ctx.lineTo(p.x - s * 0.30, p.y + s * 0.55 + tl); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(p.x + s * 0.30, p.y + s * 0.55); ctx.lineTo(p.x + s * 0.30, p.y + s * 0.55 + tl); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(p.x, p.y + s * 0.60); ctx.lineTo(p.x, p.y + s * 0.60 + tl * 1.25); ctx.stroke()
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'

  if (blink) return

  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(g.tilt)

  // 机身
  ctx.fillStyle = C.ship
  ctx.beginPath()
  ctx.moveTo(0, -s * 1.15)
  ctx.lineTo(s * 0.80, s * 0.75)
  ctx.lineTo(0, s * 0.35)
  ctx.lineTo(-s * 0.80, s * 0.75)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = C.shipDark
  ctx.beginPath()
  ctx.moveTo(0, -s * 0.55)
  ctx.lineTo(s * 0.34, s * 0.50)
  ctx.lineTo(0, s * 0.30)
  ctx.lineTo(-s * 0.34, s * 0.50)
  ctx.closePath()
  ctx.fill()

  // 座舱
  ctx.fillStyle = C.shipLite
  ctx.beginPath()
  ctx.arc(0, -s * 0.28, s * 0.22, 0, Math.PI * 2)
  ctx.fill()

  // Boost 光晕
  if (g.boosting) {
    ctx.globalAlpha = 0.5
    ctx.fillStyle = '#ffd98a'
    ctx.beginPath()
    ctx.arc(0, s * 0.9, s * 0.9, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

function fmtScore(v) {
  v = Math.round(v)
  return v >= 10000 ? (Math.round(v / 100) / 10) + 'w' : String(v)
}

function drawHud(now) {
  const g = S.g
  const pad = L.pad
  const fs = Math.max(11, Math.round(Math.min(W, H) * 0.036))
  const fsBig = Math.max(16, Math.round(fs * 1.5))

  // 顶部条
  ctx.fillStyle = 'rgba(5,7,15,0.55)'
  ctx.fillRect(0, 0, W, L.top + fs * 1.2)

  ctx.textAlign = 'left'
  ctx.fillStyle = C.fg
  ctx.font = 'bold ' + fsBig + 'px sans-serif'
  ctx.fillText(fmtScore(g.score), pad, L.top)

  // 生命
  ctx.textAlign = 'right'
  ctx.font = fs + 'px sans-serif'
  let hp = ''
  for (let i = 0; i < CFG.LIVES; i++) hp += (i < g.lives ? '●' : '○')
  ctx.fillStyle = g.lives > 1 ? C.ok : C.bad
  ctx.fillText(hp, W - pad, L.top)

  // 颈椎活动 + 平衡
  ctx.textAlign = 'left'
  ctx.font = fs + 'px sans-serif'
  ctx.fillStyle = C.dim
  const nk = S.neck
  const bal = nk.left + nk.right > 0
    ? Math.round(Math.min(nk.left, nk.right) / Math.max(1, Math.max(nk.left, nk.right)) * 100)
    : 100
  ctx.fillText('转头 ' + nk.activity + ' 次 · 平衡 ' + bal + '%', pad, L.top + fs * 1.5)

  // 速度条（顶部右侧）
  const bw = W * 0.30
  const bx = W - pad - bw
  const by = L.top + fs * 0.9
  ctx.fillStyle = 'rgba(36,48,96,0.9)'
  ctx.fillRect(bx, by, bw, 6)
  const sr = clamp((g.speed - CFG.SPEED_MIN) / (CFG.SPEED_MAX - CFG.SPEED_MIN), 0, 1)
  ctx.fillStyle = g.boosting ? C.warn : C.accent
  ctx.fillRect(bx, by, bw * (0.25 + sr * 0.75), 6)
  if (g.boosting) {
    ctx.fillStyle = C.warn
    ctx.font = fs * 0.9 + 'px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText('BOOST', bx + bw, by - 3)
  }

  // 左上角：调试读数（帧率 / 姿态）—— 真机调参要看
  ctx.textAlign = 'left'
  ctx.font = Math.max(9, Math.round(fs * 0.78)) + 'px sans-serif'
  ctx.fillStyle = 'rgba(127,143,196,0.9)'
  const p = S.pose
  const dbg = '渲染' + S.perf.renderFps + '/s · 取帧' + S.fr.fps + '/s · 检' + S.det.fps + '/s'
  ctx.fillText(dbg, pad, H - L.pad - fs * 0.1)
  const dbg2 = '源:' + S.srcActive + ' · yaw' + (p.yaw - p.nYaw).toFixed(2) + ' pitch' + (p.pitch - p.nPitch).toFixed(2) + ' · 脸' + (now - S.det.latHit < 800 ? '有' : '无')
  ctx.fillText(dbg2, pad, H - L.pad + fs * 1.2)

  // 相机预览位置（可见时才画框；隐藏时画一个装饰性"传感器"标记）
  const cr = camRect()
  if (S.camVisible) {
    ctx.strokeStyle = C.accent
    ctx.lineWidth = 1
    ctx.strokeRect(cr.x, cr.y, cr.w, cr.h)
    ctx.fillStyle = C.dim
    ctx.font = Math.max(9, fs * 0.75) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('相机', cr.x + cr.w / 2, cr.y - 3)
    ctx.textAlign = 'left'
  } else {
    ctx.fillStyle = 'rgba(122,162,255,0.35)'
    ctx.beginPath()
    ctx.arc(W - L.pad - 6, H - L.pad - 30, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(127,143,196,0.55)'
    ctx.font = Math.max(8, fs * 0.7) + 'px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText('传感器·本机处理', W - L.pad, H - L.pad - 36)
    ctx.textAlign = 'left'
  }

  // 底部按钮：切换输入源 + 相机可见性
  const bh = Math.max(30, Math.round(fs * 2.1))
  const bwid = (W - L.pad * 2 - 8) / 2
  S.btn.x = L.pad; S.btn.y = H - L.pad - bh; S.btn.w = bwid; S.btn.h = bh
  const labels = [
    { x: L.pad, w: bwid, t: '输入源: ' + srcLabel(), col: S.srcActive === 'visionkit' ? C.ok : C.warn },
    { x: L.pad + bwid + 8, w: bwid, t: S.camVisible ? '相机: 可见' : '相机: 已隐藏', col: C.dim }
  ]
  for (let i = 0; i < labels.length; i++) {
    const b = labels[i]
    ctx.fillStyle = 'rgba(15,22,48,0.85)'
    ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    ctx.strokeRect(b.x, b.y, b.w, b.h)
    ctx.fillStyle = b.col
    ctx.font = Math.max(10, Math.round(fs * 0.85)) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(b.t, b.x + b.w / 2, b.y + b.h / 2 + fs * 0.32)
  }
  ctx.textAlign = 'left'
}

function srcLabel() {
  if (S.srcKind === 'auto') return '自动(' + S.srcActive + ')'
  return S.srcKind === 'gyro' ? '陀螺仪' : '触摸'
}

function drawBoot() {
  const cx = W / 2
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(5,7,15,0.72)'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = C.accent
  ctx.font = 'bold ' + Math.round(Math.min(W, H) * 0.075) + 'px sans-serif'
  ctx.fillText('脖动圈', cx, H * 0.40)
  ctx.fillStyle = C.fg
  ctx.font = Math.round(Math.min(W, H) * 0.036) + 'px sans-serif'
  ctx.fillText('转头即转向 · 用你的颈椎开飞船', cx, H * 0.46)

  ctx.fillStyle = C.dim
  ctx.font = Math.round(Math.min(W, H) * 0.030) + 'px sans-serif'
  let tip = '点屏幕开始'
  if (!S.hasCam || !S.hasVK) tip = '摄像头不可用 · 点屏幕用触摸开始'
  ctx.fillText(tip, cx, H * 0.56)
  ctx.fillText('坐直、手机立起来，正对屏幕', cx, H * 0.61)

  if (S.err) {
    ctx.fillStyle = C.bad
    ctx.font = Math.round(Math.min(W, H) * 0.026) + 'px sans-serif'
    ctx.fillText(S.err.slice(0, 40), cx, H * 0.68)
  }
  ctx.textAlign = 'left'
}

function drawOver() {
  const cx = W / 2
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(5,7,15,0.78)'
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = C.bad
  ctx.font = 'bold ' + Math.round(Math.min(W, H) * 0.062) + 'px sans-serif'
  ctx.fillText('本局结束', cx, H * 0.34)

  const g = S.g
  ctx.fillStyle = C.fg
  ctx.font = Math.round(Math.min(W, H) * 0.052) + 'px sans-serif'
  ctx.fillText(fmtScore(g.score) + ' 分', cx, H * 0.42)

  ctx.fillStyle = C.dim
  ctx.font = Math.round(Math.min(W, H) * 0.032) + 'px sans-serif'
  ctx.fillText('最高 ' + fmtScore(g.best), cx, H * 0.47)

  const nk = S.neck
  ctx.fillStyle = C.ok
  ctx.fillText('本局活动颈椎 ' + nk.activity + ' 次', cx, H * 0.53)
  ctx.fillStyle = C.dim
  ctx.fillText('左 ' + nk.left + ' · 右 ' + nk.right + '（平衡 ' +
    (nk.left + nk.right > 0 ? Math.round(Math.min(nk.left, nk.right) / Math.max(nk.left, nk.right) * 100) : 100) + '%）', cx, H * 0.57)

  ctx.fillStyle = C.accent
  ctx.font = Math.round(Math.min(W, H) * 0.036) + 'px sans-serif'
  ctx.fillText('点屏幕再来一局', cx, H * 0.68)
  ctx.textAlign = 'left'
}

// ---------------------------------------------------------------- 输入
wx.onTouchStart(function (e) {
  const t = (e.touches && e.touches[0]) || e.changedTouches && e.changedTouches[0]
  if (!t) return
  const tx = t.clientX, ty = t.clientY

  // 底部按钮
  if (ty >= S.btn.y - 8 && ty <= S.btn.y + S.btn.h + 8) {
    if (tx >= S.btn.x && tx <= S.btn.x + S.btn.w) { switchSource(); return }
    if (tx >= S.btn.x + S.btn.w + 8 && tx <= S.btn.x + S.btn.w * 2 + 16) {
      S.camVisible = !S.camVisible
      stopCam()
      S.srcActive = 'none'
      resolveSource()
      return
    }
  }

  if (S.mode === 'boot' || S.mode === 'over') {
    if (S.srcActive === 'none') resolveSource()
    startRun()
    return
  }

  if (S.mode === 'play' && S.srcKind === 'touch') {
    touch.down = true
    touch.x = (tx - L.cx) / (L.PPX / CFG.SHIP_Z)
  }
})

wx.onTouchMove(function (e) {
  if (!touch.down) return
  const t = (e.touches && e.touches[0]) || e.changedTouches && e.changedTouches[0]
  if (!t) return
  touch.x = (t.clientX - L.cx) / (L.PPX / CFG.SHIP_Z)
})

wx.onTouchEnd(function () { touch.down = false })
wx.onTouchCancel(function () { touch.down = false })

// ---------------------------------------------------------------- 启动
function boot() {
  S.mode = 'boot'
  initStars()
  const ok = resolveSource()
  if (!ok && !S.srcActive) S.srcActive = 'none'
  // 请求帧循环（VisionKit 就绪后会自动开始）
  requestAnimationFrame(render)
}
boot()
