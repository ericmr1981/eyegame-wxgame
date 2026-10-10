// smoke/mvp-smoke.js — 纵轴 MVP 离线冒烟（v7：居中连乘 + 飞船光球）
// 用假 wx / canvas / worker / VKSession + 可控时钟 + 手动 rAF 驱动完整流程
// 用法：node eyegame-wxgame/smoke/mvp-smoke.js   （期望「共 174 项，失败 0」）
//
// ⚠️ 改了断言或核心常量后**必须跑对照实验**：bash smoke/contrast.sh
//    故意改坏代码重跑，确认对应断言真的 FAIL —— 否则断言可能只是"恒真"。
//    历史教训（都已修）：
//      · O3 曾拿 ORB_OFF_MIN 自身当阈值 → 把常量改小就自动通过（守的是常量而非意图）
//      · O3 曾只检查"视野里现有的几个块" → 样本不足，偶发放过错误
//      · 对照 3 曾同时改两处 → 两道防线互相掩盖，测不出断流 bug（要一起拆才复现）
//      · O7e 曾从 orbs 反推串间间隙 → 混入 gapScale 噪声，比值只有 1.02（测不出差别）
//      · O7 曾用 off×TUN_HW_MAX 当阈值 → 量纲错（跨度 vs 半幅），且没考虑中心线偏移
//      · M2 曾"设完 mult 就断言" → render() 内部会跑 updateWorld→updateMult 重算倍率，
//        断言值被静默改掉（表现是"偶尔通过"）。改成把状态钉在**稳定支**上
//        （贴中线 + multHold 拉满），无论 render 跑几帧结果恒等。
// ⚠️ 音效那部分（iOS 手势解锁）**测不了** —— 离线打桩了 wx，无法复现真机音频限制，
//    只能靠真机验证 + HUD 上的诊断文案。
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const GAME = path.join(__dirname, '..', 'game.js')

const A = []
function ok(name, cond, extra) {
  A.push({ name: name, pass: !!cond, extra: extra === undefined ? '' : String(extra) })
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol) }

/* ---------------- 假时钟 ---------------- */
let clock = 1700000000000
Date.now = function () { return clock }

/* ---------------- mock canvas ---------------- */
const texts = []
const ctx = {}
const noop = function () {}
const methods = ['fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo',
  'lineTo', 'stroke', 'fill', 'arc', 'save', 'restore', 'translate', 'rotate',
  'setTransform', 'putImageData', 'scale', 'bezierCurveTo', 'quadraticCurveTo']
for (let i = 0; i < methods.length; i++) ctx[methods[i]] = noop
ctx.fillText = function (s) { texts.push(String(s)) }
ctx.measureText = function (s) { return { width: String(s).length * 7 } }
ctx.createImageData = function (w, h) {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
}
ctx.textAlign = 'left'
ctx.font = '12px sans-serif'
ctx.fillStyle = '#000'
ctx.strokeStyle = '#000'
ctx.lineWidth = 1
ctx.globalAlpha = 1
ctx.lineCap = 'butt'

// 小游戏主 canvas 尺寸 = 屏幕逻辑像素（与触摸 clientX/clientY 同坐标系）
const canvas = { width: 375, height: 812, getContext: function () { return ctx } }

/* ---------------- mock wx ---------------- */
let rafCbs = []
const H = { touch: [], move: [], end: [], acc: [], resize: [], hide: [], show: [] }
const screenLog = []         // wx.setKeepScreenOn 调用记录（true / false）
const memDb = {}
let camCreateCount = 0
let camOpts = null
let camObj = null
const workerOutbox = []      // 主线程 → worker 的消息（手动排空）
const allWorkerMsgs = []     // 全程消息类型（用于断言协议走通）
let workerCb = null
let vkSess = null
let lastFaceAngle = { pitch: 0.0, yaw: 0.0, roll: 0.0 }
let emitFace = true

// WebAudio 桩：只为验证「音效真的被合成出来了」+「接口缺失时能静默降级」。
// 不校验听感（离线也无法校验），只校验调用图。
const audioLog = { osc: 0, gain: 0, freq: [] }
function makeFakeAC() {
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: function () {},
    createOscillator: function () {
      audioLog.osc++
      return {
        type: 'sine',
        frequency: {
          setValueAtTime: function (v) { audioLog.freq.push(v) },
          exponentialRampToValueAtTime: function () {}
        },
        connect: function () {}, start: function () {}, stop: function () {}
      }
    },
    createGain: function () {
      audioLog.gain++
      return {
        gain: {
          setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {}
        },
        connect: function () {}
      }
    }
  }
}

const WX = {
  createCanvas: function () { return canvas },
  getSystemInfoSync: function () {
    return { platform: 'ios', model: 'iPhone 16', version: '8.0.78', SDKVersion: '3.17.3', windowWidth: 375, windowHeight: 812, pixelRatio: 2 }
  },
  getMenuButtonBoundingClientRect: function () { return { bottom: 96 } },
  onWindowResize: function (f) { H.resize.push(f) },
  onTouchStart: function (f) { H.touch.push(f) },
  onTouchMove: function (f) { H.move.push(f) },
  onTouchEnd: function (f) { H.end.push(f) },
  onTouchCancel: function () {},
  onAccelerometerChange: function (f) { H.acc.push(f) },
  startAccelerometer: function () {},
  stopAccelerometer: function () {},
  // storage 桩改为**真内存 map**：否则"档位落盘/恢复"这类功能测不出来
  // （旧桩恒返回 0，等于永远读空 → 会把"记住设置"的 bug 放过去）
  getStorageSync: function (k) { return memDb[k] === undefined ? '' : memDb[k] },
  setStorageSync: function (k, v) { memDb[k] = v },

  createCamera: function (o) {
    camCreateCount++
    camOpts = o
    camObj = {
      _listen: false,
      listenFrameChange: function () { camObj._listen = true },
      closeFrameChange: function () { camObj._listen = false },
      destroy: function () {}
    }
    if (o && typeof o.success === 'function') o.success()   // 微信会回调 success → camReady
    return camObj
  },

  createWorker: function () {
    return {
      onMessage: function (f) { workerCb = f },
      onProcessKilled: function () {},
      postMessage: function (m) { workerOutbox.push(m); allWorkerMsgs.push(m && m.t) }
    }
  },

  createVKSession: function () {
    vkSess = {
      _h: {},
      on: function (ev, f) { vkSess._h[ev] = f },
      start: function (cb) { if (cb) cb(null) },
      detectFace: function () {
        const h = vkSess._h.updateAnchors
        if (h) h(emitFace ? [{ angle: lastFaceAngle }] : [])
      }
    }
    return vkSess
  },

  // 音效桩：__noAudio=true 时模拟"基础库不支持 WebAudio"，用于验证降级路径
  createWebAudioContext: function () {
    if (WX.__noAudio) throw new Error('WebAudio unavailable')
    return makeFakeAC()
  },
  vibrateShort: function () {},
  // 屏幕常亮（2026-10-10）：记录调用序列，验证"开局开 / 结算&退后台还原 / 回前台补开"
  setKeepScreenOn: function (o) { screenLog.push(o && o.keepScreenOn) },
  onHide: function (f) { H.hide.push(f) },
  onShow: function (f) { H.show.push(f) },
  __noAudio: false
}

/* ---------------- 执行 game.js ---------------- */
const src = fs.readFileSync(GAME, 'utf8')
const injected = src + `
;globalThis.__api = {
  S: S, CFG: CFG, ctl: ctl,
  get L() { return L },
  project: project, updateWorld: updateWorld,
  updateControl: updateControl, updateBoost: updateBoost, updateFx: updateFx,
  applyAngle: applyAngle, startRun: startRun, trackNeck: trackNeck,
  diffRatio: diffRatio, initStars: initStars,
  camRect: camRect, resolveSource: resolveSource, startGyro: startGyro,
  initTunnel: initTunnel, pushTunnelPt: pushTunnelPt, tunnelAt: tunnelAt,
  tunnelSamples: tunnelSamples, tunSlope: tunSlope, tunHalfW: tunHalfW,
  drawTunnel: drawTunnel, render: render,
  CTRL_MODES: CTRL_MODES, ctrlMode: ctrlMode, axisSign: axisSign,
  RANGES: RANGES, curRange: curRange, saveRange: saveRange,
  axisMap: axisMap, resetCtl: resetCtl,
  // ---- v5 新增：P0 能量块 / P2 视听 / 暂停 ----
  ORB_PATTERNS: ORB_PATTERNS, pickOrbPattern: pickOrbPattern, orbGapUnits: orbGapUnits,
  spawnOrbWave: spawnOrbWave, refillOrbs: refillOrbs, updateOrbs: updateOrbs,
  takeOrb: takeOrb, burst: burst, updateParts: updateParts,
  drawOrbs: drawOrbs, drawComboPop: drawComboPop, drawHud: drawHud,
  pauseRun: pauseRun, resumeRun: resumeRun, endByUser: endByUser,
  drawPaused: drawPaused, hitUI: hitUI, inRect: inRect, gameOver: gameOver,
  initAudio: initAudio, tone: tone, sfxOrb: sfxOrb, sfxHit: sfxHit, toggleAudio: toggleAudio,
  resetAudio: function () { AC = null },
  get audioCtx() { return AC },
  // ---- v7 新增：居中连乘 ----
  updateMult: updateMult, multColor: multColor,
  // ---- v8 新增：金龟子翅膀（倍率驱动）/ 尾焰喷流 / 屏幕常亮 ----
  drawShip: drawShip, drawTrail: drawTrail, setKeepScreen: setKeepScreen,
  get wingOpen() { return wingOpen },
  C: C
};`

const sandbox = {
  wx: WX, console: console, Math: Math, Date: Date, JSON: JSON,
  Array: Array, Object: Object, String: String, Number: Number,
  isFinite: isFinite, NaN: NaN, Infinity: Infinity,
  Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray,
  ArrayBuffer: ArrayBuffer, Error: Error, Boolean: Boolean, Function: Function,
  requestAnimationFrame: function (f) { rafCbs.push(f) },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  __api: null
}
sandbox.globalThis = sandbox

let bootErr = ''
try {
  vm.createContext(sandbox)
  vm.runInContext(injected, sandbox, { filename: 'game.js' })
} catch (e) { bootErr = e && e.message ? e.message : String(e) }

const api = sandbox.__api

/* ---------------- 驱动器 ---------------- */
function tick(dtMs) {
  clock += (dtMs === undefined ? 16 : dtMs)
  const cbs = rafCbs
  rafCbs = []
  for (let i = 0; i < cbs.length; i++) cbs[i]()
}

// 排空主线程 → worker 的消息，worker 立刻回一帧
// ⚠️ 必须用"快照"而不是 while(outbox.length)：帧回调会同步触发下一次 need，
//    用 while 会永远排不空 → 死循环
function drain(ds) {
  const k = ds === undefined ? 3 : ds
  const w = Math.floor(288 / k), h = Math.floor(512 / k)
  const batch = workerOutbox.splice(0, workerOutbox.length)
  for (let i = 0; i < batch.length; i++) {
    const m = batch[i]
    if (m.t === 'need' && workerCb) {
      workerCb({ t: 'frame', buf: new ArrayBuffer(w * h * 4), w: w, h: h, len: w * h * 4 })
    }
  }
}

function run(frames, dtMs) {
  for (let i = 0; i < frames; i++) { tick(dtMs); drain() }
}

/* ============================ A. 启动 ============================ */
ok('A1 game.js 执行无异常', bootErr === '', bootErr)
ok('A2 __api 暴露成功', !!api)
ok('A3 初始 mode=boot', api.S.mode === 'boot', api.S.mode)
ok('A4 星空已初始化', api.S.g.stars.length > 0, api.S.g.stars.length)
ok('A5 初始速度线已初始化', api.S.g.streaks.length > 0, api.S.g.streaks.length)
ok('A6 旧的障碍系统已彻底移除', api.S.g.obs === undefined && api.S.g.dodged === undefined)

/* ============================ B. 投影 ============================ */
const L = api.L
const CFG = api.CFG
const pShip = api.project(0, CFG.SHIP_Z)
ok('B1 z=SHIP_Z 时投影落在 shipY', near(pShip.y, L.shipY, 0.5), 'y=' + pShip.y.toFixed(1) + ' shipY=' + L.shipY.toFixed(1))
const pFar = api.project(0, CFG.Z_FAR)
ok('B2 远处物体在屏幕上方（y 更小）', pFar.y < pShip.y, pFar.y.toFixed(1) + ' < ' + pShip.y.toFixed(1))
ok('B3 尺寸与 1/z 成正比', near(api.project(0, 8).s, api.project(0, 16).s * 2, 1e-6),
  api.project(0, 8).s.toFixed(2) + ' vs ' + (api.project(0, 16).s * 2).toFixed(2))
ok('B4 横向偏移向右为正', api.project(1, CFG.SHIP_Z).x > L.cx, api.project(1, CFG.SHIP_Z).x.toFixed(1) + ' > ' + L.cx.toFixed(1))
ok('B5 地平线在地平线上', near(api.project(0, 1e6).y, L.horizon, 1), api.project(0, 1e6).y.toFixed(1))

/* ============================ C. 隧道几何 ============================ */
api.startRun()
const TUN = api.S.g.tunnel
ok('C1 隧道控制点已生成', TUN.pts.length > 5, 'pts=' + TUN.pts.length)

let monoOk = true
for (let i = 1; i < TUN.pts.length; i++) if (!(TUN.pts[i].zt > TUN.pts[i - 1].zt)) monoOk = false
ok('C2 控制点世界坐标单调递增', monoOk)

const farZt = TUN.pts[TUN.pts.length - 1].zt - TUN.scroll
ok('C3 前方生成纵深足够', farZt >= CFG.TUN_FWD - 1e-6, 'far=' + farZt.toFixed(1))

// ★ 可玩性红线：相邻控制点横向变化 ≤ 斜率上限 × 间距（保证飞船一定跟得上）
let slopeOk = true, worstSlope = 0
const lim = api.tunSlope() * CFG.TUN_STEP
for (let i = 1; i < TUN.pts.length; i++) {
  const dc = Math.abs(TUN.pts[i].cx - TUN.pts[i - 1].cx)
  if (dc > worstSlope) worstSlope = dc
  if (dc > lim + 1e-6) slopeOk = false
}
ok('C4 ★ 中心线斜率不超上限（保证跟得上）', slopeOk,
  '最差=' + worstSlope.toFixed(3) + ' 上限=' + lim.toFixed(3))

let xOk = true, hwOk = true
for (let i = 0; i < TUN.pts.length; i++) {
  if (Math.abs(TUN.pts[i].cx) > CFG.TUN_X_LIMIT + 1e-6) xOk = false
  if (TUN.pts[i].hw < api.tunHalfW() - 1e-6) hwOk = false
}
ok('C5 中心线不越界', xOk)
ok('C6 隧道半宽不低于当前难度下限', hwOk)

ok('C7 开局有平直段（不会一上来就拐）', near(TUN.pts[0].cx, 0, 1e-9) && near(TUN.pts[4].cx, 0, 1e-9))

// 硬编码两点验证插值
TUN.pts = [{ zt: 0, cx: -0.5, hw: 0.4 }, { zt: 10, cx: 0.5, hw: 0.6 }]
TUN.scroll = 0
const m2 = api.tunnelAt(5)
ok('C8 tunnelAt 线性插值正确', near(m2.cx, 0, 1e-6) && near(m2.hw, 0.5, 1e-6),
  'cx=' + m2.cx.toFixed(3) + ' hw=' + m2.hw.toFixed(3))
const m3 = api.tunnelAt(-5)
ok('C9 超出左端 → 取端点值', near(m3.cx, -0.5, 1e-6) && near(m3.hw, 0.4, 1e-6))
const m4 = api.tunnelAt(99)
ok('C10 超出右端 → 取端点值', near(m4.cx, 0.5, 1e-6) && near(m4.hw, 0.6, 1e-6))

api.initTunnel()
const ss = api.tunnelSamples(20)
ok('C11 采样点数 = n+1', ss.length === 21, 'n=' + ss.length)
ok('C12 采样近密远疏（z 间距递增）', (ss[1].z - ss[0].z) < (ss[20].z - ss[19].z),
  'near=' + (ss[1].z - ss[0].z).toFixed(3) + ' far=' + (ss[20].z - ss[19].z).toFixed(3))
let sampOk = true
for (let i = 0; i < ss.length; i++) if (!isFinite(ss[i].x) || !isFinite(ss[i].y) || ss[i].hw <= 0 || ss[i].hh <= 0) sampOk = false
ok('C13 采样值全部有限且为正', sampOk)

// 长跑后控制点不泄漏
api.startRun()
for (let i = 0; i < 3000; i++) api.updateWorld(1 / 60)
ok('C14 ★ 长跑后控制点数量有界（不泄漏）', TUN.pts.length < 60, 'pts=' + TUN.pts.length)

/* ============================ D. 贴壁判定 ============================ */
function setTunnel(cx, hw) {
  const T = api.S.g.tunnel
  T.pts = [{ zt: 0, cx: cx, hw: hw }, { zt: 200, cx: cx, hw: hw }]
  T.scroll = 0
}
function resetRun() {
  api.startRun()
  api.S.g.speed = 10
  clock += 5000                // 让无敌期归零
  api.S.g.invulnUntil = 0
}

resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0
api.updateWorld(1 / 60)
ok('D1 居中 → 不扣血且 cent=1', api.S.g.lives === CFG.LIVES && near(api.S.g.cent, 1, 1e-6),
  'lives=' + api.S.g.lives + ' cent=' + api.S.g.cent.toFixed(3))

resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0.6               // gap = 0.5 - 0.10 = 0.40 → 0.6 > 0.40
api.updateWorld(1 / 60)
ok('D2 偏离超过 gap → 扣血', api.S.g.lives === CFG.LIVES - 1, 'lives=' + api.S.g.lives)
ok('D3 蹭壁计入贴壁次数', api.S.g.hits === 1, 'hits=' + api.S.g.hits)
ok('D4 撞击后进入无敌期', api.S.g.invulnUntil > clock, 'invuln=' + (api.S.g.invulnUntil - clock) + 'ms')

resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0.6
api.updateWorld(1 / 60)
const lv1 = api.S.g.lives
api.S.g.wx = 0.6               // 再偏一次，但仍处无敌期
api.updateWorld(1 / 60)
ok('D5 无敌期内不重复扣血', api.S.g.lives === lv1, 'lives=' + api.S.g.lives)

resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0.6
api.updateWorld(1 / 60)
ok('D6 蹭壁后被推回管内', Math.abs(api.S.g.wx) <= (0.5 - CFG.SHIP_HW) + 1e-6, 'wx=' + api.S.g.wx.toFixed(3))

resetRun()
setTunnel(0, 0.5)
let guard = 0
while (api.S.g.lives > 0 && guard < 20) {
  api.S.g.invulnUntil = 0
  api.S.g.wx = 0.9
  api.updateWorld(1 / 60)
  guard++
}
ok('D7 生命归零 → mode=over', api.S.mode === 'over' && api.S.g.lives <= 0,
  'lives=' + api.S.g.lives + ' mode=' + api.S.mode)

// 居中加成：越靠中心得分越快
resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0
const s0 = api.S.g.score
api.updateWorld(0.5)
const gainCenter = api.S.g.score - s0
resetRun()
setTunnel(0, 0.5)
api.S.g.wx = 0.35              // 靠边但仍在管内
const s1 = api.S.g.score
api.updateWorld(0.5)
const gainEdge = api.S.g.score - s1
ok('D8 ★ 越靠中心得分越快（引导稳住）', gainCenter > gainEdge,
  'center=' + gainCenter.toFixed(2) + ' edge=' + gainEdge.toFixed(2))

/* ============================ E. 控制映射（★ 歪头主控） ============================ */
// 默认档 = 歪头·位置（ctrlIdx 0）
// 这里把 srcActive 设成非 visionkit，绕过"丢脸 400ms 回中"——
// 否则没跑取帧链路时 latHit=0，输入会被强制归零，测不到控制律本身
resetRun()
api.S.ctrlIdx = 0
api.S.srcActive = 'gyro'
const POSE = api.S.pose
function clearCtl() {
  api.ctl.f = 0; api.ctl.prev = 0; api.ctl.vel = 0; api.ctl.smooth = 0
  api.S.g.tgt = 0; api.S.g.wx = 0
}
function settleRoll(roll, n) {
  POSE.roll = roll; POSE.nRoll = 0
  for (let i = 0; i < (n || 120); i++) api.updateControl(1 / 60)
}
function settleYaw(yaw, n) {
  POSE.yaw = yaw; POSE.nYaw = 0
  for (let i = 0; i < (n || 120); i++) api.updateControl(1 / 60)
}

// --- axisMap 归一化（死区 + 满量程）---
ok('E1 死区内 → 归一化输出 0',
  api.axisMap(CFG.ROLL_DEAD * 0.9, CFG.ROLL_DEAD, CFG.ROLL_FULL) === 0)
ok('E2 满量程 → ±1',
  near(api.axisMap(CFG.ROLL_FULL, CFG.ROLL_DEAD, CFG.ROLL_FULL), 1, 1e-9) &&
  near(api.axisMap(-CFG.ROLL_FULL, CFG.ROLL_DEAD, CFG.ROLL_FULL), -1, 1e-9))
ok('E3 超量程 → 截到 ±1', near(api.axisMap(3, CFG.ROLL_DEAD, CFG.ROLL_FULL), 1, 1e-9))
ok('E4 归一化单调递增',
  api.axisMap(0.20, CFG.ROLL_DEAD, CFG.ROLL_FULL) > api.axisMap(0.12, CFG.ROLL_DEAD, CFG.ROLL_FULL))

// --- ★ 死区必须挡住 roll 噪声（σ≈4.2°，这是本轴最大的工程风险）---
clearCtl()
settleRoll(0.035, 120)                 // 2°，在死区 4° 内
ok('E5 ★ 死区内不动（挡住 roll 噪声）', near(api.S.g.tgt, 0, 0.02), 'tgt=' + api.S.g.tgt.toFixed(4))

// --- 大角度触满量程（roll 档满倾角 → ±ROLL_XRANGE，且必须在软限位内）---
clearCtl()
settleRoll(1.0, 200)
ok('E6 大角度 → 触到满量程且不越限位',
  near(Math.abs(api.S.g.tgt), CFG.ROLL_XRANGE, 0.02) && CFG.ROLL_XRANGE <= CFG.X_LIMIT,
  'tgt=' + api.S.g.tgt.toFixed(3) + ' range=' + CFG.ROLL_XRANGE + ' limit=' + CFG.X_LIMIT)

// --- EMA 平滑：一次调用不能一步到位 ---
clearCtl()
POSE.roll = 0.30; POSE.nRoll = 0
api.updateControl(1 / 60)
const oneStep = api.S.g.tgt
for (let i = 0; i < 120; i++) api.updateControl(1 / 60)
ok('E7 EMA 平滑：一次调用不会一步到位', Math.abs(oneStep) < Math.abs(api.S.g.tgt) - 0.05,
  'one=' + oneStep.toFixed(3) + ' final=' + api.S.g.tgt.toFixed(3))

// --- ★★ 方向映射（v4：ROLL_SIGN=+1「头向右肩歪 → 飞船右移」，与头部方向一致）---
clearCtl()
settleRoll(0.50, 200)                  // 轴值增大
const dirPlus = api.S.g.tgt
ok('E8 ★ 轴值增大 → 飞船右移（v4 与头部方向一致）', dirPlus > 0.5, 'tgt=' + dirPlus.toFixed(3))
clearCtl()
settleRoll(-0.50, 200)
ok('E9 ★ 轴值减小 → 飞船左移', api.S.g.tgt < -0.5, 'tgt=' + api.S.g.tgt.toFixed(3))

// ★★ 真机若发现左右反了：只翻 ROLL_SIGN 一个常量，整体就该反向（"一处收口"的证明）
const savedSign = CFG.ROLL_SIGN
CFG.ROLL_SIGN = -savedSign
clearCtl()
settleRoll(0.50, 200)
ok('E10 ★★ 翻转 ROLL_SIGN → 方向整体反向（一处收口）', api.S.g.tgt < -0.5,
  'sign=' + CFG.ROLL_SIGN + ' tgt=' + api.S.g.tgt.toFixed(3))
CFG.ROLL_SIGN = savedSign

// --- ★ 噪声抑制：把 ±4.2° 噪声喂进去，平均位移应被压得很小 ---
clearCtl()
let nsum = 0, ncnt = 0
for (let i = 0; i < 800; i++) {
  POSE.nRoll = 0
  POSE.roll = (Math.random() * 2 - 1) * 0.074       // 等效 σ≈4.2°
  api.updateControl(1 / 60)
  if (i > 300) { nsum += Math.abs(api.S.g.tgt); ncnt++ }
}
const avgTgt = nsum / Math.max(1, ncnt)
ok('E11 ★ 4.2° 噪声 → 平均位移被压住（<0.01）', avgTgt < 0.01, 'avg|tgt|=' + avgTgt.toFixed(4))

// --- 机身压倾（纯视觉）：必须与舵向**同号**（往哪边转就往哪边压）---
clearCtl()
settleRoll(0.40, 120)
ok('E12 机身压倾与舵向同向且有界',
  api.S.g.tilt * api.S.g.tgt > 0 && Math.abs(api.S.g.tilt) <= 0.45,
  'tilt=' + api.S.g.tilt.toFixed(3) + ' tgt=' + api.S.g.tgt.toFixed(3))

// --- 「歪头·位置反」档：同一个 roll 得到相反位移 ---
api.S.ctrlIdx = 1
clearCtl()
settleRoll(0.50, 200)
ok('E13 「歪头·位置反」档翻转方向', api.S.g.tgt < -0.5, 'tgt=' + api.S.g.tgt.toFixed(3))

// --- 「歪头·速度」档：持续倾斜 → 持续移动（不是停在一个位置）---
api.S.ctrlIdx = 2
clearCtl()
POSE.roll = 0.09; POSE.nRoll = 0            // 刚过死区一点点，避免撞限位
for (let i = 0; i < 30; i++) api.updateControl(1 / 60)
const v1 = api.S.g.tgt
for (let i = 0; i < 90; i++) api.updateControl(1 / 60)
const v2 = api.S.g.tgt
ok('E14 ★ 速度律：持续歪头 → 持续移动', Math.abs(v2) > Math.abs(v1) + 0.15,
  't=0.5s →' + v1.toFixed(3) + '  t=2s →' + v2.toFixed(3))
POSE.roll = 0; POSE.nRoll = 0
for (let i = 0; i < 180; i++) api.updateControl(1 / 60)
const v3 = api.S.g.tgt
for (let i = 0; i < 90; i++) api.updateControl(1 / 60)
ok('E15 速度律：回正即停（不再漂）', Math.abs(api.S.g.tgt - v3) < 0.02,
  'drift=' + (api.S.g.tgt - v3).toFixed(4))

// --- yaw 档回归：原方向约定不能被改坏 ---
api.S.ctrlIdx = 3
clearCtl()
settleYaw(0.50, 200)
ok('E16 yaw 档回归：左转(yaw+) → 飞船左移', api.S.g.tgt < -0.5, 'tgt=' + api.S.g.tgt.toFixed(3))
clearCtl()
settleYaw(-0.50, 200)
ok('E17 yaw 档回归：右转(yaw−) → 飞船右移', api.S.g.tgt > 0.5, 'tgt=' + api.S.g.tgt.toFixed(3))
api.S.ctrlIdx = 0

// --- ★ 丢脸兜底：>400ms 没脸 → 输入回中（不能带着最后一帧跑偏）---
api.S.srcActive = 'visionkit'
api.S.det.latHit = clock
clearCtl()
POSE.roll = 0.50; POSE.nRoll = 0
for (let i = 0; i < 120; i++) api.updateControl(1 / 60)
const heldTgt = api.S.g.tgt
clock += 600
for (let i = 0; i < 120; i++) api.updateControl(1 / 60)
ok('E18 ★ 丢脸 >400ms → 输入回中', Math.abs(heldTgt) > 0.5 && Math.abs(api.S.g.tgt) < 0.1,
  'held=' + heldTgt.toFixed(3) + ' now=' + api.S.g.tgt.toFixed(3))

// --- 零点慢速校正 ---
api.S.srcActive = 'gyro'
clearCtl()
POSE.roll = 0.05; POSE.nRoll = 0.0         // 静息带内的小偏置
const nb0 = POSE.nRoll
for (let i = 0; i < 600; i++) api.updateControl(1 / 60)
ok('E19 静息带内慢速吃掉零漂', POSE.nRoll > nb0 + 0.005 && POSE.nRoll <= 0.05 + 1e-9,
  'n0=' + nb0.toFixed(4) + ' n1=' + POSE.nRoll.toFixed(4))
clearCtl()
POSE.roll = 0.40; POSE.nRoll = 0.0         // 静息带外（真在操作）
const nb1 = POSE.nRoll
for (let i = 0; i < 600; i++) api.updateControl(1 / 60)
ok('E20 操作中（超静息带）零点不被吃', near(POSE.nRoll, nb1, 1e-9),
  'n0=' + nb1.toFixed(4) + ' n1=' + POSE.nRoll.toFixed(4))

// --- 可玩性红线的量化校验 ---
const slopeRate = CFG.TUN_SLOPE_MAX * CFG.SPEED_MAX       // 世界单位/s（最难档）
const shipRate = CFG.X_LIMIT * 2 * 14                     // 飞船一阶滞后时间常数 1/14s
ok('E21 ★ 中心线变化率远低于飞船横移能力', slopeRate < shipRate * 0.5,
  'needed=' + slopeRate.toFixed(2) + '/s vs able=' + shipRate.toFixed(1) + '/s')

/* ============================ F. Boost ============================ */
resetRun()
POSE.nPitch = 0; POSE.pitch = 0.05; POSE.hasFace = true
api.updateBoost(1 / 60)
ok('F1 阈值内不触发 Boost', api.S.g.boosting === false, 'boosting=' + api.S.g.boosting)

POSE.pitch = 0.20             // 11.5° > 8°
api.updateBoost(1 / 60)
ok('F2 超过阈值 → 触发 Boost', api.S.g.boosting === true)

clock += CFG.BOOST_MAX_MS + 100
api.updateBoost(1 / 60)
ok('F3 超过 3s → Boost 结束', api.S.g.boosting === false)
ok('F4 结束后进入冷却', api.S.g.boostCoolAt > clock, 'cool=' + (api.S.g.boostCoolAt - clock) + 'ms')

api.updateBoost(1 / 60)
ok('F5 冷却期内不再触发', api.S.g.boosting === false)

clock += CFG.BOOST_COOL_MS + 100
api.updateBoost(1 / 60)
ok('F6 冷却结束 → 可再次触发', api.S.g.boosting === true)

/* ============================ G. 角度解析 ============================ */
resetRun()
POSE.yaw = 0; POSE.pitch = 0; POSE.roll = 0
api.applyAngle([0.11, 0.22, 0.33])
ok('G1 数组形式解析', near(POSE.pitch, 0.11) && near(POSE.yaw, 0.22) && near(POSE.roll, 0.33))

POSE.yaw = 0
api.applyAngle({ pitch: 0.4, yaw: -0.5, roll: 0.6 })
ok('G2 具名对象解析', near(POSE.pitch, 0.4) && near(POSE.yaw, -0.5) && near(POSE.roll, 0.6))

POSE.yaw = 0
api.applyAngle({ x: 0.7, y: 0.8, z: 0.9 })
ok('G3 未知键名按顺序兜底', near(POSE.pitch, 0.7) && near(POSE.yaw, 0.8) && near(POSE.roll, 0.9))

POSE.yaw = 1
api.applyAngle(null)
ok('G4 空值不抛异常且不改状态', POSE.yaw === 1)

/* ============================ H. 颈椎记账 ============================ */
// 记账必须跟随主控轴，且**左右与舵向一致**。
// （上一版就踩过"标反"：平衡率是产品核心卖点，标反等于卖点失效）
resetRun()
api.S.ctrlIdx = 0                      // 歪头档
api.S.srcActive = 'gyro'
POSE.nRoll = 0
POSE.roll = 0.00; api.trackNeck()
POSE.roll = 0.40; api.trackNeck()      // 轴值增大（v4：飞船右移）
POSE.roll = 0.10; api.trackNeck()
POSE.roll = -0.40; api.trackNeck()     // 轴值减小（v4：飞船左移）
POSE.roll = -0.10; api.trackNeck()
ok('H1 左右各计一次', api.S.neck.left === 1 && api.S.neck.right === 1,
  'L=' + api.S.neck.left + ' R=' + api.S.neck.right)
ok('H2 ★ 与舵向一致：roll 增大（右移）计入 right', api.S.neck.right === 1)

// 停留同侧不重复计数：进同侧只记 1 次，之后一直停在那侧总计数不再涨
resetRun()
api.S.ctrlIdx = 0
api.S.srcActive = 'gyro'
POSE.nRoll = 0
POSE.roll = 0.00; api.trackNeck()
POSE.roll = 0.50; api.trackNeck()
const totBefore = api.S.neck.left + api.S.neck.right
for (let i = 0; i < 10; i++) { POSE.roll = 0.50; api.trackNeck() }
ok('H3 停留在同侧不重复计数', api.S.neck.left + api.S.neck.right === totBefore,
  'before=' + totBefore + ' after=' + (api.S.neck.left + api.S.neck.right))

// ★ 从左直接切到右 → 那一次也必须记上（滞回顺序 bug 的回归）
resetRun()
api.S.ctrlIdx = 0
api.S.srcActive = 'gyro'
POSE.nRoll = 0
POSE.roll = 0.40; api.trackNeck()
POSE.roll = -0.40; api.trackNeck()     // 不回中立，直接切另一侧
ok('H4 ★ 从左直接切到右也不吞计数',
  api.S.neck.left === 1 && api.S.neck.right === 1,
  'L=' + api.S.neck.left + ' R=' + api.S.neck.right)

// 转头档回归：左转（POC：yaw 增大）仍应计入 left
api.S.ctrlIdx = 3
api.S.neck.left = 0; api.S.neck.right = 0; api.S.neck.side = 0
POSE.nYaw = 0
POSE.yaw = 0.40; api.trackNeck()
ok('H5 转头档：左转仍计入 left', api.S.neck.left === 1, 'L=' + api.S.neck.left)
api.S.ctrlIdx = 0

/* ============================ I. Worker / 取帧链路 ============================ */
resetRun()
run(40)
const sawListen = camObj && camObj._listen
ok('I1 等前置就绪后才 listenFrameChange', sawListen === true, 'listen=' + sawListen)
ok('I2 listening 已置位', api.S.listening === true, 'listening=' + api.S.listening)
ok('I3 已向 worker 下发 probe/mode/go',
  allWorkerMsgs.indexOf('probe') >= 0 && allWorkerMsgs.indexOf('mode') >= 0 && allWorkerMsgs.indexOf('go') >= 0,
  allWorkerMsgs.slice(0, 6).join(','))
ok('I4 取到帧并持有 buffer', !!api.S.fr.buf, 'buf=' + (api.S.fr.buf ? 'yes' : 'no'))
ok('I5 帧尺寸按 ÷3 回传', api.S.fr.w === 96 && api.S.fr.h === 170, api.S.fr.w + 'x' + api.S.fr.h)
ok('I6 检测已派发', api.S.det.calls > 0, 'calls=' + api.S.det.calls)
ok('I7 检出人脸并写入姿态', api.S.pose.hasFace === true && api.S.det.faces > 0, 'faces=' + api.S.det.faces)

/* ============================ J. 相机隐藏 ============================ */
ok('J1 默认把相机丢到屏幕外', camOpts && camOpts.x === -4 && camOpts.y === -4 && camOpts.width === 2 && camOpts.height === 2,
  JSON.stringify({ x: camOpts && camOpts.x, y: camOpts && camOpts.y, w: camOpts && camOpts.width, h: camOpts && camOpts.height }))
ok('J2 使用前置摄像头', camOpts && camOpts.devicePosition === 'front', camOpts && camOpts.devicePosition)
api.S.camVisible = true
const cr = api.camRect()
ok('J3 可见模式返回屏幕内矩形', cr.x > 0 && cr.y > 0 && cr.w > 20, JSON.stringify(cr))
api.S.camVisible = false

/* ============================ K. 触摸与状态机 ============================ */
api.S.mode = 'boot'
api.S.srcKind = 'touch'
H.touch[0]({ touches: [{ clientX: 300, clientY: 700 }] })
ok('K1 点击开始 → mode=play', api.S.mode === 'play', api.S.mode)
ok('K2 新局分数/生命/贴壁已重置', api.S.g.score === 0 && api.S.g.lives === CFG.LIVES && api.S.g.hits === 0)
ok('K3 新局隧道已重建（有控制点）', api.S.g.tunnel.pts.length > 5, 'pts=' + api.S.g.tunnel.pts.length)

// 底部四按钮：控制模式 / 幅度 / 输入源 / 相机
const bwid = api.S.btn.w
const cy = api.S.btn.y + api.S.btn.h / 2
const mid = function (i) { return api.S.btn.xs[i] + bwid / 2 }
ok('K4 底部按钮槽位已布局（4 个）', api.S.btn.xs.length === 4 && api.S.btn.xs[1] > api.S.btn.xs[0],
  api.S.btn.xs.map(function (v) { return v.toFixed(0) }).join(','))

const idBefore = api.CTRL_MODES[api.S.ctrlIdx].id
H.touch[0]({ touches: [{ clientX: mid(0), clientY: cy }] })
ok('K5 「控制」按钮循环控制模式', api.CTRL_MODES[api.S.ctrlIdx].id !== idBefore,
  idBefore + ' → ' + api.CTRL_MODES[api.S.ctrlIdx].id)

for (let i = 0; i < 3; i++) H.touch[0]({ touches: [{ clientX: mid(0), clientY: cy }] })
ok('K6 模式 4 档成环 → 走回原档', api.CTRL_MODES[api.S.ctrlIdx].id === idBefore,
  api.CTRL_MODES[api.S.ctrlIdx].id + '（共 ' + api.CTRL_MODES.length + ' 档）')

const kindBefore = api.S.srcKind
H.touch[0]({ touches: [{ clientX: mid(2), clientY: cy }] })
ok('K7 「输入源」按钮可切换', api.S.srcKind !== kindBefore,
  kindBefore + ' → ' + api.S.srcKind)

const rBefore = api.S.rangeIdx
H.touch[0]({ touches: [{ clientX: mid(1), clientY: cy }] })
ok('K8 ★ 「幅度」按钮循环档位', api.S.rangeIdx !== rBefore,
  'range ' + rBefore + ' → ' + api.S.rangeIdx + '（' + api.RANGES[api.S.rangeIdx].label + '）')

const camBefore = api.S.camVisible
H.touch[0]({ touches: [{ clientX: mid(3), clientY: cy }] })
ok('K9 「相机」按钮切换可见性', api.S.camVisible !== camBefore, 'cam=' + api.S.camVisible)
api.S.camVisible = false

/* ============================ L. 长跑稳定性 ============================ */
let crashed = ''
let wxMin = 1e9, wxMax = -1e9
try {
  api.startRun()
  api.S.srcKind = 'touch'
  // ⚠️ 必须从 lastFaceAngle 走（真实链路）：直接改 S.pose 会被 applyAngle 覆盖
  for (let i = 0; i < 400; i++) {
    lastFaceAngle.roll = Math.sin(i / 20) * 0.5      // 歪头来回摆
    lastFaceAngle.pitch = Math.sin(i / 7) * 0.3
    lastFaceAngle.yaw = Math.cos(i / 13) * 0.2
    tick(16)
    drain()
    if (api.S.g.wx < wxMin) wxMin = api.S.g.wx
    if (api.S.g.wx > wxMax) wxMax = api.S.g.wx
    if (api.S.mode === 'over') api.startRun()
  }
} catch (e) { crashed = e && e.message ? e.message : String(e) }

ok('L1 连续 400 帧无异常', crashed === '', crashed)
ok('L2 关键状态无 NaN',
  isFinite(api.S.g.wx) && isFinite(api.S.g.speed) && isFinite(api.S.g.score) && isFinite(api.S.g.cent),
  'wx=' + api.S.g.wx + ' speed=' + api.S.g.speed + ' score=' + api.S.g.score + ' cent=' + api.S.g.cent)
ok('L3 隧道控制点数量有界（不泄漏）', api.S.g.tunnel.pts.length < 60, 'pts=' + api.S.g.tunnel.pts.length)
ok('L4 星空数量恒定', api.S.g.stars.length === 34 + 46 + 58, 'stars=' + api.S.g.stars.length)
ok('L5 渲染帧率统计在跑', api.S.perf.renderStamps.length > 0, 'stamps=' + api.S.perf.renderStamps.length)
ok('L6 ★ 端到端：歪头确实在驱动飞船（横向摆幅足够）', wxMax - wxMin > 0.6,
  'wx∈[' + wxMin.toFixed(2) + ',' + wxMax.toFixed(2) + ']')

/* ============================ M. 渲染烟测 ============================ */
let drawErr = ''
texts.length = 0
try {
  api.startRun()
  api.S.g.tunnel.scroll = 37
  // ⚠️ render() 内部会跑 updateWorld → updateMult，会重算倍率。
  //    所以不能"设完 mult 就断言"——要把它钉在**稳定支**上：
  //    贴中线（cent 高）+ multHold 拉满 → 无论 render 跑几帧，倍率恒为 MULT_MAX。
  api.S.g.wx = api.tunnelAt(api.CFG.SHIP_Z).cx
  api.S.g.multHold = api.CFG.MULT_RAMP_SEC
  api.S.g.mult = api.CFG.MULT_MAX
  api.drawTunnel()
  api.render()
} catch (e) { drawErr = e && e.message ? e.message : String(e) }
ok('M1 隧道渲染与整帧 render 无异常', drawErr === '', drawErr)
const hud = texts.join('|')
ok('M2 ★ HUD 渲染出倍率读数（v7：倍率取代了原来的「居中 XX%」）',
  hud.indexOf('倍率') >= 0 && hud.indexOf('×5.0') >= 0, texts.slice(0, 10).join(' / '))
ok('M3 HUD 显示控制模式与幅度档',
  hud.indexOf('控制:' + api.ctrlMode().short) >= 0 && hud.indexOf('幅度:' + api.curRange().label) >= 0,
  texts.filter(function (t) { return t.indexOf('控制:') >= 0 || t.indexOf('幅度:') >= 0 }).slice(0, 3).join(' / '))
ok('M4 HUD 显示带正负号的轴读数（真机判左右靠它）',
  /歪头[+\-]\d\.\d\d/.test(hud), texts.filter(function (t) { return t.indexOf('歪头') >= 0 }).slice(0, 2).join(' / '))

/* ======================= N. 幅度档（v4 核心改动） ======================= */
// 需求（用户原话）：「对头部动作过于敏感，需要增大动作幅度，让颈部得到更多运动」
// 验收标准：
//   ① 规则上：满量程角度确实拉大（标准档 30°，原 20°）
//   ② 手感上：同一角度 → 档位越大输出越小（越不敏感，脖子要多动才吃满舵）
//   ③ 边界上：三档满舵机动能力**一致**（切档不会"够不着弯道"）
//   ④ 记账上：颈椎计数阈值随档位抬高（要真歪到位才算一次）
const DEG = Math.PI / 180
const degOf = function (rad) { return rad / DEG }
api.S.ctrlIdx = 0            // 歪头·位置
api.S.srcActive = 'gyro'
api.S.srcKind = 'gyro'

function tgtAt(deg, ri) {
  api.S.rangeIdx = ri
  clearCtl()
  settleRoll(deg * DEG, 200)
  return api.S.g.tgt
}

ok('N1 默认幅度档 = 标准（满量程 25°）',
  api.RANGES[1].label === '标准' && Math.abs(degOf(api.RANGES[1].full) - 25) < 1.5,
  'full=' + degOf(api.RANGES[1].full).toFixed(1) + '° label=' + api.RANGES[1].label)

ok('N2 三档动作量单调递增（紧凑 < 标准 < 舒展）',
  api.RANGES[0].full < api.RANGES[1].full && api.RANGES[1].full < api.RANGES[2].full &&
  api.RANGES[0].dead < api.RANGES[1].dead && api.RANGES[1].dead < api.RANGES[2].dead,
  api.RANGES.map(function (r) { return r.label + ' ' + degOf(r.full).toFixed(0) + '°' }).join(' · '))

const t8 = [tgtAt(8, 0), tgtAt(8, 1), tgtAt(8, 2)]
ok('N3 ★ 同一歪头角度 → 档位越大输出越小（越不敏感）',
  t8[0] > t8[1] && t8[1] > t8[2] && t8[2] > 0,
  '歪 8° 时 tgt = ' + t8.map(function (v) { return v.toFixed(3) }).join(' > '))

const t20old = tgtAt(20, 0)
const t20new = tgtAt(20, 1)
ok('N4 ★ 同一角度(20°)在标准档输出明显低于紧凑档（抬高满量程真的降了敏感度）',
  Math.abs(t20old) > api.CFG.ROLL_XRANGE * 0.95 &&
  Math.abs(t20new) < Math.abs(t20old) * 0.85,
  '紧凑 ' + t20old.toFixed(3) + ' vs 标准 ' + t20new.toFixed(3) +
  '（比值 ' + (Math.abs(t20new) / Math.abs(t20old) * 100).toFixed(0) + '%，满 ' + api.CFG.ROLL_XRANGE + '）')

const tMax = [tgtAt(45, 0), tgtAt(45, 1), tgtAt(45, 2)]
ok('N5 ★ 三档满舵机动能力一致（切档不会够不着弯道）',
  Math.abs(tMax[0] - tMax[1]) < 0.02 && Math.abs(tMax[1] - tMax[2]) < 0.02 &&
  Math.abs(Math.abs(tMax[0]) - api.CFG.ROLL_XRANGE) < 0.02,
  tMax.map(function (v) { return v.toFixed(3) }).join(' / '))

ok('N6 颈椎记账阈值随档位抬高',
  api.RANGES[0].neck < api.RANGES[1].neck && api.RANGES[1].neck < api.RANGES[2].neck,
  api.RANGES.map(function (r) { return degOf(r.neck).toFixed(1) + '°' }).join(' → '))

resetRun(); api.S.ctrlIdx = 0; api.S.srcActive = 'gyro'
api.S.rangeIdx = 1
POSE.nRoll = 0
POSE.roll = 0; api.trackNeck()
POSE.roll = 12 * DEG; api.trackNeck()
ok('N7 标准档：歪 12° 计入 1 次（阈值 11.5°）',
  api.S.neck.left + api.S.neck.right === 1,
  'L=' + api.S.neck.left + ' R=' + api.S.neck.right)

let savedR = -1
try { api.S.rangeIdx = 2; api.saveRange(); savedR = WX.getStorageSync('bd_range') } catch (e) { savedR = 'err:' + e.message }
ok('N8 幅度档写入 storage（下次启动记住）', savedR === 2, 'bd_range=' + savedR)
api.S.rangeIdx = 1

/* ============================ O. ★ P0 能量块 ============================ */
// 这一版存在的理由：让「游戏收益」和「颈椎运动量」对齐。
// 所以断言分两层 ——
//   ① 机制正确（对准能吃到 / 不准吃不到 / 高速不漏检 / 连击不失控）
//   ② ★ 设计目标达成（块确实偏离中线 + 相邻跨度足够大 = 真的在逼玩家动脖子）
// 第 ② 层才是这版的意义所在，如果只测第 ① 层，把 off 全改成 0 也照样通过。
{
  // --- O1 开局空档 ---
  resetRun()
  const g = api.S.g
  ok('O1 开局留出空档（不会一上来就要够两侧）',
    g.tunnel.nextOrbZ - g.tunnel.scroll > 12,
    'nextOrbZ-scroll=' + (g.tunnel.nextOrbZ - g.tunnel.scroll).toFixed(1))

  // --- O2 铺块 ---
  g.orbs = []
  g.tunnel.nextOrbZ = g.tunnel.scroll + 1
  run(180, 16)
  ok('O2 跑一段时间后视野内有能量块', g.orbs.length > 0, 'orbs=' + g.orbs.length)

  // --- O3/O4 批量取样检查所有 pattern 产出的块 ---
  // ⚠️ 必须批量生成，不能只看"视野里现有的几个块"：视野内可能恰好只抽到一种
  //    pattern，样本不足会让断言偶发放过错误（对照实验里已经踩过一次）。
  const savedO = g.orbs
  g.orbs = []
  let z3 = 0
  for (let i = 0; i < 60; i++) z3 = api.spawnOrbWave(z3)
  const sample = g.orbs
  g.orbs = savedO

  let minAbsOff = 99, wallOk = true
  for (let i = 0; i < sample.length; i++) {
    const o = sample[i]
    minAbsOff = Math.min(minAbsOff, Math.abs(o.off))
    const at = api.tunnelAt(o.zt - g.tunnel.scroll)
    if (Math.abs(o.off) * at.hw + api.CFG.ORB_R >= at.hw) wallOk = false
  }
  // ⚠️ 阈值写"设计下限"（0.25）而不是 api.CFG.ORB_OFF_MIN —— 后者会让断言跟着常量一起动，变成恒真
  ok('O3 ★ 所有块都刻意偏离中线（|off| ≥ 0.25 —— 中线附近必须留空）',
    minAbsOff >= 0.25,
    'min|off|=' + minAbsOff.toFixed(2) + '（设计下限 0.25，实现里 ORB_OFF_MIN=' + api.CFG.ORB_OFF_MIN + '，样本 ' + sample.length + ' 块）')
  ok('O4 块本体不穿出管壁（|off|·hw + r < hw）', wallOk)

  // --- O3b ★★ 距离分档铺开（用户反馈「能量块基本靠边，要随机分布」）---
  // 旧表所有 |off| 都在 0.50~0.85，视觉上块全堆在管壁边。这里把 [0.28, 0.88] 分 4 档，
  // 要求靠中的两档也占到足够比例 —— 否则"块全贴边"的特征会原样回来。
  const LO = 0.28, HI = 0.88, binW = (HI - LO) / 4
  const bins = [0, 0, 0, 0]
  for (let i = 0; i < sample.length; i++) {
    const a = Math.abs(sample[i].off)
    if (a >= LO - 1e-9 && a <= HI + 1e-9) {
      bins[Math.min(3, Math.floor((a - LO) / binW))]++
    }
  }
  const nearShare = (bins[0] + bins[1]) / Math.max(1, sample.length)
  ok('O3b ★★ 距离分档铺开（靠中两档占相当比例，不再「基本靠边」）',
    bins[0] > 0 && bins[1] > 0 && bins[2] > 0 && bins[3] > 0 && nearShare >= 0.30,
    '四档计数 ' + bins.join('/') + '，靠中两档占比 ' + (nearShare * 100).toFixed(0) + '%')

  // --- O3c ★ 位置是连续分布（jitter 真的生效，不是几个固定档位来回切）---
  // 没有 jitter 时，off 只可能取到 pattern 表里那 ~18 个离散值；有 jitter 时几乎个个不同。
  let uniq = {}
  for (let i = 0; i < sample.length; i++) uniq[sample[i].off.toFixed(3)] = 1
  const uniqN = Object.keys(uniq).length
  ok('O3c ★ 块位置连续分布（jitter 生效，不是固定档位循环）',
    uniqN >= sample.length * 0.4,
    '不同 off 值 ' + uniqN + ' / 样本 ' + sample.length + ' 块')
}

{
  // --- O5 ★★ 每个 pattern 的节拍都必须够走完它的最坏跨度 ---
  // timeToCover：飞船用「每帧覆盖 23.3% 差距」的方式追目标位置，算走完 dist 要几秒。
  // 这是**纯机动**下界（不含人的反应）—— 真正卡住的是人的换向速度，
  // 所以下面还有一条「最短节拍 ≥ 0.35s」兜底。
  const CFGX = api.CFG
  function timeToCover(dist) {
    const frac = dist / CFGX.ROLL_XRANGE
    if (frac >= 1) return Infinity
    return Math.log(1 - frac) / Math.log(1 - 14 / 60) / 60
  }
  const rows = []
  let allFit = true, minBeat = Infinity
  const stat = {}
  for (let i = 0; i < api.ORB_PATTERNS.length; i++) {
    const p = api.ORB_PATTERNS[i]
    const beat = CFGX.ORB_GAP_SEC * (p.gapScale || 1)
    let worst = 0
    for (let j = 0; j + 1 < p.offs.length; j++) {
      worst = Math.max(worst, Math.abs(p.offs[j + 1] - p.offs[j]))
    }
    // ★ 把 jitter 也算进最坏跨度：相邻两块抖动方向相反时，差距被放大 2×jitter
    worst += 2 * (p.jitter || 0)
    const world = worst * CFGX.TUN_HW_MAX
    const sec = timeToCover(world)
    stat[p.id] = { worst: worst, beat: beat, sec: sec }
    rows.push(p.id + ' ' + sec.toFixed(2) + '/' + beat.toFixed(2) + 's')
    if (!(sec < beat * 0.6)) allFit = false
    minBeat = Math.min(minBeat, beat)
  }
  ok('O5 ★★ 每个 pattern 都跟得上（走完跨度 < 本串节拍 60%）', allFit, rows.join(' | '))
  ok('O5b ★ 最短节拍 ≥ 0.35s（低于这个，人的换向速度跟不上）',
    minBeat >= 0.35, '最短节拍=' + minBeat.toFixed(2) + 's')

  // --- O5c ★★ gapScale 必须随跨度单调递增（结构性质；缺了它 zigzag 物理上走不完）---
  // 不比具体数值、只比"排序关系"：以后调跨度上限也不会误挂，但把 gapScale 拉平一定挂。
  const multi = []
  for (let i = 0; i < api.ORB_PATTERNS.length; i++) {
    const p = api.ORB_PATTERNS[i]
    if (p.offs.length < 2) continue
    let w = 0
    for (let j = 0; j + 1 < p.offs.length; j++) w = Math.max(w, Math.abs(p.offs[j + 1] - p.offs[j]))
    multi.push({ id: p.id, worst: w, gs: p.gapScale || 1 })
  }
  multi.sort(function (a, b) { return a.worst - b.worst })
  let monotone = true, hiGs = 0
  for (let i = 0; i < multi.length; i++) {
    if (multi[i].gs < hiGs - 1e-9) monotone = false
    hiGs = Math.max(hiGs, multi[i].gs)
  }
  ok('O5c ★★ 跨度越大 → gapScale 越大（单调；缺了它大跨度串走不完）',
    monotone && multi[multi.length - 1].gs > multi[0].gs,
    multi.map(function (r) { return r.id + ' ' + r.worst.toFixed(2) + '×hw→gs' + r.gs.toFixed(2) }).join(' | '))

  // --- O6 ★★ 实测跨度：直接驱动生成器，统计**相邻块**的横向差 ---
  // 这是本次改动最核心的指标：不是"有没有块"，而是"块有没有逼玩家动脖子"。
  // ⚠️ 必须统计相邻块（含串与串之间），只统计串内会把 edge/near 这类单块串漏掉。
  resetRun()
  const gt = api.S.g
  const saved = gt.orbs
  gt.orbs = []
  let z = 0
  for (let i = 0; i < 80; i++) z = api.spawnOrbWave(z)
  const offs = gt.orbs.map(function (o) { return o.off })
  gt.orbs = saved
  let sum = 0, cnt = 0, mx = 0
  for (let i = 1; i < offs.length; i++) {
    const dd = Math.abs(offs[i] - offs[i - 1])
    sum += dd; cnt++; mx = Math.max(mx, dd)
  }
  const avg = cnt ? sum / cnt : 0
  ok('O6 ★★ 相邻块平均跨度足够大（真的需要横移，不是象征性偏移）',
    avg >= 0.35,
    '平均 ' + avg.toFixed(2) + '×hw ≈ ' + (avg * CFGX.TUN_HW_MAX).toFixed(2) + ' 世界单位（' + cnt + ' 次相邻）')
  ok('O7b ★ 最坏相邻跨度不超过飞船总行程（左右极限之差 = 2×ROLL_XRANGE）',
    mx * CFGX.TUN_HW_MAX < CFGX.ROLL_XRANGE * 2 * 0.85,
    '最坏 ' + (mx * CFGX.TUN_HW_MAX).toFixed(2) + ' < ' + (CFGX.ROLL_XRANGE * 2 * 0.85).toFixed(2))

  // --- O7 ★★ 能量块必须落在飞船「够得到」的范围 ---
  // v6 修正：旧断言 `mx×TUN_HW_MAX < ROLL_XRANGE` 有两个毛病 ——
  //   ① 量纲不对：跨度（两端之差）拿去和 XRANGE（中心到边缘）比；
  //   ② 完全没算中心线偏移 cx：cx 荡到 ±TUN_X_LIMIT(0.85) 时，同侧贴边块会落在
  //      cx + off×hw = 0.85 + 0.88×0.66 = 1.43，而飞船软限位只有 X_LIMIT(1.25) → 永远吃不到。
  // 所以改用**真实世界推进**取样（静态生成时 tunnelAt 拿到的 cx 不是真实值）。
  resetRun()
  let maxWx = 0, orbFrames = 0
  for (let i = 0; i < 1500; i++) {
    gt.invulnUntil = clock + 1e9
    gt.wx = api.tunnelAt(api.CFG.SHIP_Z).cx        // 贴中线，避免撞墙干扰
    api.updateWorld(1 / 60); api.updateOrbs(1 / 60)
    clock += 16
    for (let k = 0; k < gt.orbs.length; k++) {
      const a = Math.abs(gt.orbs[k].wx)
      if (a > maxWx) maxWx = a
      orbFrames++
    }
  }
  const reach = CFGX.X_LIMIT - CFGX.ORB_CATCH
  ok('O7 ★★ 能量块都落在飞船可达范围内（够得到，不是摆设）',
    maxWx <= reach + 1e-6,
    '最远 |wx|=' + maxWx.toFixed(2) + ' / 可达上限 ' + reach.toFixed(2) +
    '（X_LIMIT=' + CFGX.X_LIMIT + '，取到 ' + orbFrames + ' 个块帧）')

  // --- O7e ★ 串间换向补偿：跨中线的间隙必须比不跨的更长 ---
  // 上一串收在左壁、下一串开头在右壁时，最坏跨度约 1.05 世界单位（≈45° 头摆）——
  // 半个基拍（0.26s）根本甩不过来，所以 spawnOrbWave 对 cross 情况给 1.4 倍喘息。
  // ⚠️ 直接读生成器暴露的 lastGapUnits（串间**纯间隙**），不从 orbs 反推 ——
  //    后者混入上一串的串内节拍（gapScale 随机），信噪比太低，实测比值只有 1.02。
  resetRun()
  const gt2 = api.S.g
  const tt2 = gt2.tunnel
  const savedOrbs2 = gt2.orbs
  gt2.orbs = []
  const crossGaps = [], sameGaps = []
  let zz2 = 0
  for (let i = 0; i < 500; i++) {
    zz2 = api.spawnOrbWave(zz2)
    if (tt2.lastCross) crossGaps.push(tt2.lastGapUnits); else sameGaps.push(tt2.lastGapUnits)
  }
  gt2.orbs = savedOrbs2
  const avgC = crossGaps.reduce(function (a, b) { return a + b }, 0) / Math.max(1, crossGaps.length)
  const avgS = sameGaps.reduce(function (a, b) { return a + b }, 0) / Math.max(1, sameGaps.length)
  ok('O7e ★ 跨中线时串间留更多换向时间（cross 间隙 ≈ 2.8× 同侧）',
    crossGaps.length > 20 && sameGaps.length > 20 && avgC > avgS * 2.2,
    'cross ' + avgC.toFixed(2) + ' 单位(n=' + crossGaps.length + ') vs 同侧 ' +
    avgS.toFixed(2) + ' 单位(n=' + sameGaps.length + ')，比值 ' + (avgC / avgS).toFixed(2))

  // --- O7b ★ 视野占用：一串不能撑满整个视野（否则屏幕上只会有孤零零一个块）---
  const viewDepth = CFGX.ORB_VIEW - (-6)            // 可见纵深区间
  const beatSec = CFGX.ORB_GAP_SEC
  const viewSec = viewDepth / CFGX.SPEED_MIN        // 低速时视野能看几秒
  const waveSec = 4 * beatSec                       // 最长串（sweep，4 块）
  ok('O7b ★ 视野内能容纳 ≥1.5 串（屏幕不会空得只剩一个块）',
    viewSec / waveSec >= 1.5,
    '视野 ' + viewSec.toFixed(1) + 's / 一串 ' + waveSec.toFixed(1) + 's = ' + (viewSec / waveSec).toFixed(1) + ' 串')

  // --- O7c ★★ 节拍必须短于「块从进视野到抵达飞船」的时间 ---
  // 比"串有多长"更准的红线：只要节拍 < 预见时间，块就总是"先看见再到达"，
  // 玩家不会遇到"块突然蹦到面前"。用最高速（视野最短）作最坏情况。
  let maxBeat = 0
  for (let i = 0; i < api.ORB_PATTERNS.length; i++) {
    maxBeat = Math.max(maxBeat, CFGX.ORB_GAP_SEC * (api.ORB_PATTERNS[i].gapScale || 1))
  }
  const react = CFGX.ORB_VIEW / CFGX.SPEED_MAX
  ok('O7c ★★ 节拍 < 块从进视野到抵达的时间（块总是先看见再到达）',
    maxBeat < react,
    '最长节拍 ' + maxBeat.toFixed(2) + 's < 最高速预见时间 ' + react.toFixed(2) + 's')

  // --- O7d ★★ 生成上限必须与可见纵深对齐 ---
  // 这是 O15b 那个 bug 的**根因断言**：只要生成范围超过可见范围，
  // 新块就会在视野外被裁剪删掉，屏幕周期性断流。
  ok('O7d ★★ 生成上限不超出可见纵深（否则新块会被裁剪删掉）',
    CFGX.ORB_VIEW <= CFGX.Z_FAR - CFGX.SHIP_Z,
    'ORB_VIEW=' + CFGX.ORB_VIEW + ' ≤ Z_FAR−SHIP_Z=' + (CFGX.Z_FAR - CFGX.SHIP_Z))
}

// 造一个「刚跨过飞船平面」的块（pz=1 假装上一帧还在前方 → 一次调用即触发判定）
function orbCross(orbWx, shipWx) {
  const g = api.S.g
  const o = {
    zt: g.tunnel.scroll + api.CFG.SHIP_Z - 1, wx: orbWx,
    off: 0.7, taken: false, pz: 1, spin: 0
  }
  g.orbs.push(o)
  g.wx = shipWx
  api.updateOrbs(1 / 60)
  return o
}

{
  // --- O8 对准 → 吃到 ---
  resetRun()
  const g = api.S.g
  g.wx = 0; g.combo = 0; g.comboT = 0
  const sc0 = g.score
  const o1 = orbCross(0.30, 0.30)
  ok('O8 ★ 对准 → 吃到（分数增加 + 连击 +1）',
    o1.taken === true && g.combo === 1 && g.score > sc0,
    'taken=' + o1.taken + ' combo=' + g.combo + ' Δscore=' + (g.score - sc0).toFixed(1))

  // --- O9 ★ 没对准 → 错过，但连击不清零 ---
  g.combo = 3; g.comboT = api.CFG.COMBO_SEC
  const missBefore = g.miss
  const o2 = orbCross(0.60, -0.60)
  ok('O9 ★ 没对准 → 错过，但连击**不**清零（惩罚只留给蹭壁）',
    o2.taken === false && g.miss === missBefore + 1 && g.combo === 3,
    'miss=' + g.miss + ' combo=' + g.combo)

  // --- O10 ★ 蹭壁才断连击 ---
  g.combo = 5; g.comboT = api.CFG.COMBO_SEC
  g.invulnUntil = 0
  g.wx = 5
  api.updateWorld(1 / 60)
  ok('O10 ★ 蹭壁 → 连击清零（这是唯一的断连击方式）', g.combo === 0, 'combo=' + g.combo)

  // --- O11 连击超时归零 ---
  g.combo = 4; g.comboT = 0.05
  api.updateOrbs(0.10)
  ok('O11 连击超时 → 归零', g.combo === 0, 'combo=' + g.combo)

  // --- O12 ★ 倍率封顶 ---
  resetRun()
  g.combo = api.CFG.COMBO_CAP + 1
  g.comboT = api.CFG.COMBO_SEC
  const s1 = g.score
  orbCross(0, 0)
  const delta = g.score - s1
  ok('O12 ★ 连击倍率封顶（不会无限滚分）',
    Math.abs(delta - api.CFG.ORB_SCORE * api.CFG.COMBO_CAP) < 1e-6,
    'Δ=' + delta.toFixed(1) + ' 期望=' + (api.CFG.ORB_SCORE * api.CFG.COMBO_CAP))

  // --- O13 已吃过的块不二次计分 ---
  resetRun()
  g.wx = 0
  const o3 = { zt: g.tunnel.scroll + api.CFG.SHIP_Z - 1, wx: 0, off: 0.7, taken: false, pz: 1, spin: 0 }
  g.orbs.push(o3)
  api.updateOrbs(1 / 60)
  const s2 = g.score, c2 = g.combo
  o3.pz = 1; o3.zt = g.tunnel.scroll + api.CFG.SHIP_Z - 1
  api.updateOrbs(1 / 60)
  ok('O13 已吃过的块不二次计分',
    o3.taken === true && g.score === s2 && g.combo === c2,
    'Δscore=' + (g.score - s2).toFixed(2) + ' combo=' + g.combo)

  // --- O14 ★★ 高速跨越不漏检 ---
  // 窗口式判定（"块是否落在 |dz|<0.9 里"）在高速下会漏：一帧能推进 0.5+ 世界单位。
  // 跨越式判定（"上一帧在前、这一帧在后"）永不漏 —— 这条就是为它写的。
  resetRun()
  g.speed = api.CFG.SPEED_MAX
  g.wx = 0
  const o4 = { zt: g.tunnel.scroll + api.CFG.SHIP_Z + 0.30, wx: 0, off: 0.7, taken: false, pz: NaN, spin: 0 }
  g.orbs.push(o4)
  api.updateOrbs(1 / 60)
  const pzA = o4.pz
  g.tunnel.scroll += 0.5          // 一帧推进 0.5：直接越过判定窗口
  api.updateOrbs(1 / 30)
  ok('O14 ★★ 高速跨越不漏检（窗口式会漏，跨越式不会）',
    o4.taken === true, 'pz=' + pzA.toFixed(2) + ' → 0.5 单位后 taken=' + o4.taken)

  // --- O15 视野裁剪（不泄漏）---
  // 用确定性推进（直接调 updateWorld/updateOrbs + 锁死在中线）：
  // 走 render 的话"无人操作 → 撞墙 → gameOver"会把测试搅浑，测的不是裁剪逻辑。
  resetRun()
  g.orbs = []
  g.tunnel.nextOrbZ = g.tunnel.scroll + 1
  let peak = 0, zeroFrames = 0
  for (let i = 0; i < 420; i++) {
    g.invulnUntil = clock + 1e9
    g.wx = api.tunnelAt(api.CFG.SHIP_Z).cx        // 强行贴中线，避免撞墙
    api.updateWorld(1 / 60)
    api.updateOrbs(1 / 60)
    clock += 16
    peak = Math.max(peak, g.orbs.length)
    if (g.orbs.length === 0) zeroFrames++
  }
  ok('O15 能量块数量有界（不泄漏）',
    peak > 0 && peak < 40, '峰值=' + peak + '，当前=' + g.orbs.length)
  // ★ 空窗率：如果 pattern 的串间空档太大，屏幕会周期性地"什么都没有"，
  //   观感像 bug，玩家也会失去目标感。
  ok('O15b ★ 屏幕上不会长时间空无一物（空窗帧占比 < 15%）',
    zeroFrames / 420 < 0.15,
    '空窗 ' + zeroFrames + '/420 = ' + (zeroFrames / 420 * 100).toFixed(1) + '%')
}

{
  // --- O16 ★★ 收益结构：能量块必须是主收益 ---
  // 若能量块收益低于「居中保底」，玩家的最优解就是继续贴中线、无视块 —— P0 直接落空。
  // 这条断言守的是**设计意图**，不是实现细节。
  const CFGY = api.CFG
  const roomFull = 60 * CFGY.ROOM_SCORE                    // 60 秒全程满居中
  const orbTypical = 30 * CFGY.ORB_SCORE * 1.5             // 保守估计：吃 30 个、平均 1.5 倍率
  ok('O16 ★★ 能量块收益显著高于居中保底（否则玩家会理性地无视它）',
    orbTypical > roomFull * 2,
    '能量块 ≈' + Math.round(orbTypical) + ' vs 居中 ≈' + Math.round(roomFull))
  ok('O17 ★ 居中保底分已下调（原 14 → ROOM_SCORE）',
    CFGY.ROOM_SCORE < 14 && CFGY.ROOM_SCORE > 0,
    'ROOM_SCORE=' + CFGY.ROOM_SCORE + '（原 14）')
}

/* ============================ P. P2 粒子 ============================ */
{
  resetRun()
  const g = api.S.g
  g.parts = []
  api.burst(0, g.tunnel.scroll + api.CFG.SHIP_Z, '#5ef0d8', 9)
  ok('P1 吃块产生粒子', g.parts.length === 9, 'parts=' + g.parts.length)

  g.parts = []
  for (let i = 0; i < 40; i++) api.burst(0, g.tunnel.scroll + 8, '#5ef0d8', 9)
  ok('P2 粒子池有硬上限（长局内存不爬升）',
    g.parts.length <= api.CFG.P_MAX && g.parts.length > 0,
    'parts=' + g.parts.length + ' ≤ P_MAX=' + api.CFG.P_MAX)

  g.parts = []
  api.burst(0, g.tunnel.scroll + 8, '#5ef0d8', 5)
  const n0 = g.parts.length
  for (let i = 0; i < 150; i++) api.updateParts(1 / 30)
  ok('P3 粒子会衰减消失（不留残影）', g.parts.length < n0, n0 + ' → ' + g.parts.length)

  resetRun()
  g.parts = []
  g.wx = 5; g.invulnUntil = 0
  api.updateWorld(1 / 60)
  ok('P4 蹭壁产生粒子（惩罚色 —— 与奖励色明确区分）',
    g.parts.length > 0 && g.parts[0].color === api.C.bad && api.C.bad !== api.C.orb,
    'parts=' + g.parts.length + ' color=' + (g.parts[0] && g.parts[0].color))

  resetRun()
  g.parts = []
  g.wx = 0; g.combo = 0
  const oP = { zt: g.tunnel.scroll + api.CFG.SHIP_Z - 1, wx: 0, off: 0.7, taken: false, pz: 1, spin: 0 }
  g.orbs.push(oP)
  api.updateOrbs(1 / 60)
  ok('P5 吃到块也产生粒子（奖励色 = 花粉金）',
    g.parts.length > 0 && g.parts[0].color === api.C.orb,
    'parts=' + g.parts.length + ' color=' + (g.parts[0] && g.parts[0].color))
}

/* ============================ Q. 暂停 / 主动结束 ============================ */
{
  // --- Q1~Q4 冻结 ---
  resetRun()
  const g = api.S.g
  ok('Q1 初始为 play', api.S.mode === 'play', api.S.mode)

  const scroll0 = g.tunnel.scroll
  const score0 = g.score
  api.pauseRun()
  ok('Q2 pauseRun → mode=paused', api.S.mode === 'paused', api.S.mode)

  const orbN0 = g.orbs.length
  for (let i = 0; i < 180; i++) tick(16)
  ok('Q3 ★ 暂停期间世界完全冻结（scroll 不动）',
    g.tunnel.scroll === scroll0, 'Δscroll=' + (g.tunnel.scroll - scroll0).toFixed(4))
  ok('Q4 ★ 暂停期间分数不涨（不消耗内容）',
    Math.abs(g.score - score0) < 1e-6, 'Δscore=' + (g.score - score0).toFixed(4))
  ok('Q5 暂停期间不生成新块', g.orbs.length === orbN0, orbN0 + ' → ' + g.orbs.length)
}

{
  // --- Q6/Q7 ★★ 时间戳平移：暂停不该「偷走」无敌时间和 Boost 冷却 ---
  // 这是暂停功能最容易出的隐蔽 bug：不修的话，暂停 30 秒回来一进场就被扣血，
  // 玩家完全不知道为什么。绝对时间戳必须整体平移。
  const g = api.S.g
  api.resumeRun()                       // 从上一段的 paused 回到 play
  g.invulnUntil = clock + 1200
  g.boostCoolAt = clock + 4000
  const tBefore = clock
  api.pauseRun()
  for (let i = 0; i < 300; i++) tick(16)      // 暂停 ≈4.8 秒
  const elapsed = clock - tBefore
  api.resumeRun()
  ok('Q6 ★★ 恢复后无敌时间被整体平移（暂停不偷走保护期）',
    Math.abs(g.invulnUntil - (tBefore + 1200 + elapsed)) < 5,
    '偏移=' + (g.invulnUntil - tBefore).toFixed(0) + 'ms，期望≈' + (1200 + elapsed).toFixed(0) + 'ms')
  ok('Q7 ★★ 恢复后 Boost 冷却同样被平移',
    Math.abs(g.boostCoolAt - (tBefore + 4000 + elapsed)) < 5,
    '偏移=' + (g.boostCoolAt - tBefore).toFixed(0) + 'ms，期望≈' + (4000 + elapsed).toFixed(0) + 'ms')

  // --- Q8 ★ 恢复时重标零点 ---
  api.pauseRun()
  POSE.roll = 0.35; POSE.yaw = 0.10
  api.resumeRun()
  ok('Q8 ★ 恢复时重标零点（避免一恢复就带着旧偏移跑偏）',
    near(POSE.nRoll, 0.35) && near(POSE.nYaw, 0.10),
    'nRoll=' + POSE.nRoll + ' nYaw=' + POSE.nYaw)
}

{
  // --- Q9~Q12 暂停层 UI ---
  const g = api.S.g
  api.pauseRun()
  tick(16)
  const pui = api.S.btn.pui
  ok('Q9 暂停层渲染出「继续」「结束本节」两个按钮',
    !!pui && pui.length === 2 && pui[0].act === 'resume' && pui[1].act === 'end',
    pui ? pui.map(function (b) { return b.t }).join(' / ') : 'null')

  const bR = pui[0]
  const cxR = bR.x + bR.w / 2, cyR = bR.y + bR.h / 2
  ok('Q10 hitUI 命中「继续」', api.hitUI(cxR, cyR) === 'resume', api.hitUI(cxR, cyR))
  H.touch[0]({ touches: [{ clientX: cxR, clientY: cyR }] })
  ok('Q11 点「继续」→ 回到 play', api.S.mode === 'play', api.S.mode)

  // --- Q12 ★ 点「结束本节」---
  api.pauseRun()
  tick(16)
  const bE = api.S.btn.pui[1]
  H.touch[0]({ touches: [{ clientX: bE.x + bE.w / 2, clientY: bE.y + bE.h / 2 }] })
  ok('Q12 ★ 点「结束本节」→ over 且标记 endedByUser（结算文案变「本节完成」）',
    api.S.mode === 'over' && g.endedByUser === true,
    'mode=' + api.S.mode + ' byUser=' + g.endedByUser)

  // --- Q13 主动结束后重开要清掉 endedByUser ---
  H.touch[0]({ touches: [{ clientX: 10, clientY: 300 }] })   // over 层：点任意处重开
  ok('Q13 重开一局会清掉 endedByUser（避免下一局又显示「本节完成」）',
    api.S.mode === 'play' && g.endedByUser === false,
    'mode=' + api.S.mode + ' byUser=' + g.endedByUser)
}

{
  // --- Q14~Q16 顶部暂停按钮 ---
  resetRun()
  tick(16)
  const pb = api.S.btn.pause
  ok('Q14 游玩中顶部渲染出暂停按钮', !!pb && pb.w > 0, pb ? JSON.stringify(pb) : 'null')
  ok('Q15 暂停按钮位于顶部正中（避让左上分数 / 右上生命）',
    !!pb && Math.abs((pb.x + pb.w / 2) - canvas.width / 2) < 2,
    pb ? ('中心 x=' + (pb.x + pb.w / 2).toFixed(0) + ' / 屏宽中点 ' + (canvas.width / 2).toFixed(0)) : 'null')

  H.touch[0]({ touches: [{ clientX: pb.x + pb.w / 2, clientY: pb.y + pb.h / 2 }] })
  ok('Q16 点顶部暂停按钮 → 进入暂停', api.S.mode === 'paused', api.S.mode)

  // --- Q17 ★ 暂停层吃掉全部输入 ---
  const ctrlBefore = api.S.ctrlIdx
  const bx = api.S.btn.xs[0] + api.S.btn.w / 2
  H.touch[0]({ touches: [{ clientX: bx, clientY: api.S.btn.y + api.S.btn.h / 2 }] })
  ok('Q17 ★ 暂停层吃掉全部输入（点底部按钮不会误改控制档）',
    api.S.ctrlIdx === ctrlBefore && api.S.mode === 'paused',
    'ctrl=' + api.S.ctrlIdx + ' mode=' + api.S.mode)
}

{
  // --- Q18 音效开关 ---
  const a0 = api.CFG.AUDIO_ON
  api.toggleAudio()
  const a1 = api.CFG.AUDIO_ON
  const savedA = WX.getStorageSync('bd_audio')
  api.toggleAudio()
  ok('Q18 音效开关可切换并落盘',
    a1 !== a0 && api.CFG.AUDIO_ON === a0 && savedA === (a1 ? 1 : 0),
    a0 + ' → ' + a1 + ' → ' + api.CFG.AUDIO_ON + '，bd_audio=' + savedA)
  api.resumeRun()
}

/* ============================ R. P2 音效（合成 / 降级） ============================ */
{
  api.CFG.AUDIO_ON = true
  api.resetAudio()
  const oscBefore = audioLog.osc
  api.sfxOrb(3)
  ok('R1 ★ 音效真的被合成出来了（创建振荡器，零素材）',
    audioLog.osc > oscBefore, 'osc ' + oscBefore + ' → ' + audioLog.osc)

  const lastF = audioLog.freq[audioLog.freq.length - 1]
  api.sfxOrb(8)
  const lastF2 = audioLog.freq[audioLog.freq.length - 1]
  ok('R2 ★ 音高随连击上升（正反馈强度是可听的）',
    lastF2 > lastF && lastF > 520,
    'combo3=' + lastF.toFixed(0) + 'Hz → combo8=' + lastF2.toFixed(0) + 'Hz')

  // --- R3 ★★ 降级：基础库不支持 WebAudio ---
  api.resetAudio()
  WX.__noAudio = true
  let threw = ''
  try { api.sfxOrb(1); api.sfxHit(); api.tone(440, 0.1, 'sine', 0.1) } catch (e) { threw = String(e && e.message) }
  ok('R3 ★★ 无 WebAudio 时静默降级（不抛错、玩法完全不受影响）',
    threw === '' && api.S.audio === 'off' && api.audioCtx === false,
    'audio=' + api.S.audio + ' threw=' + (threw || '无'))

  WX.__noAudio = false
  api.resetAudio()
  api.initAudio()
  ok('R4 环境恢复后能重新启用音效', api.S.audio === 'on', 'audio=' + api.S.audio)
}

/* ==================== S. ★ v7 居中连乘（Center Multiplier） ==================== */
// 需求（用户原话）：「没有感觉到保持在中线的变化」→ 把「居中」升级为得分系数：
//   保持越久系数越高、离开清零、飞机加光球特效。
// 这一段守三条：① 攒升线性且有上限 ② **宽限窗口**真的在保护「短冲吃块」
//              ③ 倍率真的乘到了分（含块分），不是摆设
{
  // 直接把飞船按在中线上（或推离），喂 updateMult
  function driveMult(cent, sec) {
    const g = api.S.g
    const dtM = 1 / 60
    const n = Math.max(1, Math.round(sec / dtM))
    for (let i = 0; i < n; i++) { g.cent = cent; api.updateMult(dtM) }
    return g
  }

  api.startRun()
  const gm = api.S.g
  const CM = api.CFG
  ok('S1 开局倍率 = ×1（不残留上一局）',
    Math.abs(gm.mult - 1) < 1e-6 && gm.multHold === 0,
    'mult=' + gm.mult + ' hold=' + gm.multHold)

  const expect3 = 1 + (3 / CM.MULT_RAMP_SEC) * (CM.MULT_MAX - 1)
  driveMult(0.9, 3.0)
  ok('S2 居中 3 秒 → 倍率线性上升（≈ 一半量程）',
    Math.abs(gm.mult - expect3) < 0.25,
    '3s 后 ×' + gm.mult.toFixed(2) + '（线性预期 ×' + expect3.toFixed(2) + '）')

  driveMult(0.9, 6.0)
  ok('S3 ★ 持续居中 → 倍率封顶于 MULT_MAX（不溢出）',
    Math.abs(gm.mult - CM.MULT_MAX) < 1e-6,
    'mult=×' + gm.mult.toFixed(2) + ' 上限=' + CM.MULT_MAX)

  // ★★ 宽限窗口：短冲不清零（这条直接保护 P0 能量块）
  const beforeGrace = gm.mult
  driveMult(0.20, CM.MULT_GRACE_SEC * 0.6)
  ok('S4 ★★ 短暂脱离（< 宽限）→ 倍率不清零（保护「短冲吃块」）',
    Math.abs(gm.mult - beforeGrace) < 1e-6 && gm.mult > CM.MULT_MAX * 0.9,
    '脱离 ' + (CM.MULT_GRACE_SEC * 0.6).toFixed(2) + 's 仍 ×' + gm.mult.toFixed(2) +
    '（宽限 ' + CM.MULT_GRACE_SEC + 's）')

  driveMult(0.20, CM.MULT_GRACE_SEC * 1.6)
  ok('S5 ★★ 持续脱离（> 宽限）→ 倍率清零回 ×1',
    Math.abs(gm.mult - 1) < 1e-6, 'mult=×' + gm.mult.toFixed(3))

  driveMult(0.9, 1.5)
  ok('S6 清零后重新居中 → 从 ×1 重新攒（不接着旧进度）',
    gm.mult > 1 && gm.mult < 2.2, '×' + gm.mult.toFixed(2))

  // ★ 撞管壁立刻清零（不给宽限）
  api.startRun()
  driveMult(0.9, 6.0)
  const beforeHit = api.S.g.mult
  api.S.g.wx = 99
  api.S.g.invulnUntil = 0
  api.updateWorld(1 / 60)
  ok('S7 ★ 撞管壁 → 倍率立刻清零（不给宽限，惩罚要干脆）',
    beforeHit > CM.MULT_MAX * 0.9 && Math.abs(api.S.g.mult - 1) < 1e-6,
    '撞前 ×' + beforeHit.toFixed(2) + ' → 撞后 ×' + api.S.g.mult.toFixed(3))

  // ★★ 倍率乘到了块分
  api.startRun()
  const g8 = api.S.g
  g8.mult = 1
  const b0 = g8.score
  api.takeOrb({ wx: 0, zt: 0, off: 0.5, taken: false, pz: 1, spin: 0 })
  const addAt1 = g8.score - b0
  api.startRun()
  const g8b = api.S.g
  g8b.mult = 3
  const b1 = g8b.score
  api.takeOrb({ wx: 0, zt: 0, off: 0.5, taken: false, pz: 1, spin: 0 })
  const addAt3 = g8b.score - b1
  ok('S8 ★★ 块分 × 居中倍率（×3 时拿到的分是 ×1 的 3 倍）',
    addAt1 > 0 && Math.abs(addAt3 / addAt1 - 3) < 0.05,
    '×1 → ' + addAt1.toFixed(0) + ' 分 · ×3 → ' + addAt3.toFixed(0) +
    ' 分（比值 ' + (addAt3 / addAt1).toFixed(2) + '）')

  // ★ 存活分同样被倍率放大（每帧钉住 multHold → updateMult 算出稳定倍率，隔离攒升过程）
  api.startRun()
  const g9 = api.S.g
  function scoreRate(hold) {
    let acc = 0
    for (let i = 0; i < 60; i++) {
      g9.invulnUntil = Date.now() + 1e9
      g9.multHold = hold            // ★ 钉住倍率进度
      g9.multTier = 99              // 抑制跨档脉冲（与本次断言无关）
      g9.wx = api.tunnelAt(api.CFG.SHIP_Z).cx
      const a = g9.score
      api.updateWorld(1 / 60)
      acc += g9.score - a
    }
    return acc
  }
  const rate1 = scoreRate(0)
  const rateMax = scoreRate(CM.MULT_RAMP_SEC)
  ok('S9 ★ 存活分同样被倍率放大（满倍率时增速约 5 倍）',
    rate1 > 0 && Math.abs(rateMax / rate1 - CM.MULT_MAX) < 0.35,
    '×1 每秒 ' + rate1.toFixed(1) + ' 分 · ×' + CM.MULT_MAX + ' 每秒 ' + rateMax.toFixed(1) +
    ' 分（比值 ' + (rateMax / rate1).toFixed(2) + '）')

  // ★ 跨档脉冲（只在跨档触发一次，不是每帧都闪）
  api.startRun()
  api.S.g.multPop = 0
  api.S.g.multTier = 1
  driveMult(0.9, 0.01)
  const popIdle = api.S.g.multPop
  driveMult(0.9, CM.MULT_RAMP_SEC / (CM.MULT_MAX - 1) * 1.2)
  ok('S10 ★ 跨档才脉冲（未跨档不闪、跨档闪一次）',
    popIdle <= 0.01 && api.S.g.multPop > 0.9,
    '未跨档 multPop=' + popIdle.toFixed(2) + ' → 跨档 multPop=' + api.S.g.multPop.toFixed(2))

  // ★ 最高倍率被记录（结算展示）
  api.startRun()
  driveMult(0.9, 6.0)
  ok('S11 记录本局最高倍率（结算展示用）',
    Math.abs(api.S.g.multBest - CM.MULT_MAX) < 1e-6,
    'multBest=×' + api.S.g.multBest.toFixed(2))

  // 光球配色：低档冷青 → 满档近纯白
  // ★ 为什么不是"低冷高暖"：金色已被花粉球（P0 主收益物）占用，倍率环若也偏暖 → 玩家
  //   分不清"我在攒倍率"还是"前面有花粉"。所以满档改为**靠亮度**（近纯白）而非色相表达。
  const cLow = api.multColor(1.2)
  const cHi = api.multColor(CM.MULT_MAX)
  const rgb = function (h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] }
  const lo = rgb(cLow), hi = rgb(cHi)
  const sumLo = lo[0] + lo[1] + lo[2], sumHi = hi[0] + hi[1] + hi[2]
  const loCold = lo[0] < lo[1] - 20 && lo[0] < lo[2] - 10      // 低档：R 明显偏低 = 冷
  const hiWhite = Math.min(hi[0], hi[1], hi[2]) >= 235 &&
    (Math.max(hi[0], hi[1], hi[2]) - Math.min(hi[0], hi[1], hi[2])) <= 20   // 满档：近纯白
  ok('S12 光球配色：低档冷青 → 满档近纯白（用亮度而非色相表达充能）',
    cLow !== cHi && loCold && hiWhite && (sumHi > sumLo), '低 ' + cLow + ' → 满 ' + cHi)

  // 开关可整体回退
  const savedOn = CM.MULT_ON
  CM.MULT_ON = false
  driveMult(0.9, 3.0)
  ok('S13 MULT_ON=false → 倍率恒为 ×1（机制可整体回退）',
    Math.abs(api.S.g.mult - 1) < 1e-6, 'mult=×' + api.S.g.mult)
  CM.MULT_ON = savedOn

  // 高倍率下渲染路径无异常（光球 + 碎裂特效）
  api.startRun()
  api.S.g.mult = 4.2
  api.S.g.multPop = 0.5
  api.S.g.multLost = 0.6
  let e14 = ''
  try { api.render() } catch (e) { e14 = String(e && e.message) }
  ok('S14 高倍率下整帧渲染无异常（光球 / 碎裂特效路径）', e14 === '', e14)
}

/* ============ T. ★ v8 金龟子翅膀（倍率驱动）/ 尾焰 / 屏幕常亮 ============ */
// 需求（用户原话 2026-10-10）：
//   ① 「平时飞行就是闭合翅膀的状态，倍率到一定级别翅膀就展开，同时有光晕」
//   ② 「屁股后面三条像尾焰的东西太难看，改成动态好看的」
//   ③ 「玩一段时间屏幕会变暗 → 关掉游戏时的息屏」
{
  const CM2 = api.CFG
  // 把翅膀收敛到某个倍率对应的开合量（drawShip 内部按倍率缓动 wingOpen）
  function wingAt(m) {
    const g2 = api.S.g
    g2.boosting = false
    g2.mult = m
    for (let i = 0; i < 90; i++) api.drawShip(0.05)
    return api.wingOpen
  }

  api.startRun()
  const wClosed = wingAt(1)
  ok('T1 倍率 ×1 → 鞘翅闭合（巡航态；不再像上一版常态就张翅）',
    wClosed < 0.08, 'wingOpen=' + wClosed.toFixed(3))

  const wFull = wingAt(CM2.MULT_MAX)
  ok('T2 满倍率 → 鞘翅全展（充能到位才张开，58° 量级）',
    wFull > 0.95, 'wingOpen=' + wFull.toFixed(3))

  const wBelow = wingAt(CM2.WING_OPEN_MULT - 0.05)
  const wAbove = wingAt(CM2.WING_OPEN_MULT + 0.60)
  ok('T3 只有跨过 WING_OPEN_MULT 才张开（阈值生效且单调：低→闭合，高→渐开）',
    wBelow <= 0.08 && wAbove > wBelow + 0.10,
    '×' + (CM2.WING_OPEN_MULT - 0.05).toFixed(2) + '→' + wBelow.toFixed(3) +
    '  ×' + (CM2.WING_OPEN_MULT + 0.60).toFixed(2) + '→' + wAbove.toFixed(3))

  ok('T4 闭合态仍留壳缝（不把翅膀参数清零 → 中缝对准辅助线还在）',
    wClosed > 0.001, 'wingOpen=' + wClosed.toFixed(4))

  // T5：尾焰喷流路径（锥形填充 + 弧）可跑；Boost / 高倍率分支也过一遍
  let eT = ''
  try {
    api.startRun()
    api.S.g.mult = 3
    api.drawTrail(100, 500, 20, Date.now(), false)
    api.drawTrail(100, 500, 20, Date.now(), true)
  } catch (e) { eT = String(e && e.message) }
  ok('T5 尾迹喷流绘制无异常（分层锥形 + 鳞粉点，Boost 分支同样安全）', eT === '', eT)

  // T6~T8：屏幕常亮
  let n0 = screenLog.length
  api.startRun()
  ok('T6 开局请求保持屏幕常亮（按场景关掉系统自动息屏）',
    screenLog.length > n0 && screenLog[screenLog.length - 1] === true,
    JSON.stringify(screenLog.slice(n0)))

  n0 = screenLog.length
  api.gameOver()
  ok('T7 结算还原屏幕常亮（不在结算页白耗电）',
    screenLog.length > n0 && screenLog[screenLog.length - 1] === false,
    JSON.stringify(screenLog.slice(n0)))

  for (let i = 0; i < H.hide.length; i++) H.hide[i]()
  const afterHide = screenLog[screenLog.length - 1]
  api.startRun()                       // 回前台仍在本局
  for (let i = 0; i < H.show.length; i++) H.show[i]()
  const afterShow = screenLog[screenLog.length - 1]
  ok('T8 退后台还原 / 回前台若在本局则补开常亮',
    afterHide === false && afterShow === true,
    'hide→' + afterHide + '  show→' + afterShow)
}

/* ============================ 汇总 ============================ */
const fail = A.filter(function (a) { return !a.pass })
console.log('--- 纵轴 MVP v8（昆虫主题：金龟子翅膀倍率驱动 / 鳞粉尾焰 / 屏幕常亮）冒烟结果 ---')
for (let i = 0; i < A.length; i++) {
  console.log((A[i].pass ? '  ok  ' : '  FAIL') + '  ' + A[i].name + (A[i].extra ? ('   [' + A[i].extra + ']') : ''))
}
console.log('--- 共 ' + A.length + ' 项，失败 ' + fail.length + ' ---')
