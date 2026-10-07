// game.js — v14 v10 基线 + 极简敌人
const canvas = wx.createCanvas()
const ctx = canvas.getContext('2d')
let W = 1, H = 1
function resize() { W = canvas.width; H = canvas.height }
resize()
wx.onWindowResize(resize)

const gyro = { ax: 0, ay: 0, az: 0, rawYaw: 0, rawPitch: 0, yaw: 0, pitch: 0, neutralYaw: 0, neutralPitch: 0, calibrated: false, frames: 0 }

wx.onAccelerometerChange(res => {
  gyro.ax = res.x; gyro.ay = res.y; gyro.az = res.z
  const g = Math.hypot(res.x, res.y, res.z) || 1
  // 横屏下：用户头左转 → 手机右倾 → ay 增大 → 但玩家视角期望飞船向左 → 取负
  gyro.rawYaw = -res.y / g
  gyro.rawPitch = res.x / g
  // 死区（避免微小抖动）
  const dx = Math.abs(gyro.rawYaw - gyro.neutralYaw) > 0.03 ? gyro.rawYaw - gyro.neutralYaw : 0
  const dy = Math.abs(gyro.rawPitch - gyro.neutralPitch) > 0.03 ? gyro.rawPitch - gyro.neutralPitch : 0
  gyro.yaw += (dx - gyro.yaw) * 0.25
  gyro.pitch += (dy - gyro.pitch) * 0.25
  gyro.frames++
})

let touchT = 0, touchActive = false
wx.onTouchStart(() => { touchT = Date.now(); touchActive = true })
wx.onTouchEnd(() => {
  touchActive = false
  if (Date.now() - touchT >= 1500) {
    gyro.neutralYaw = gyro.rawYaw
    gyro.neutralPitch = gyro.rawPitch
    gyro.calibrated = true
  }
})

const ship = { x: 0, y: 0, r: 14 }
ship.x = W / 2; ship.y = H / 2

const MAX_E = 12
const en = []
for (let i = 0; i < MAX_E; i++) {
  en.push({ x: -100, y: -100, vx: 0, vy: 0, r: 8, alive: false })
}
let spawnT = 0
let score = 0
let dead = false
let deadT = 0

function spawn() {
  const e = en.find(x => !x.alive)
  if (!e) return
  const side = Math.floor(Math.random() * 4)
  let x, y
  if (side === 0) { x = Math.random() * W; y = -10 }
  else if (side === 1) { x = W + 10; y = Math.random() * H }
  else if (side === 2) { x = Math.random() * W; y = H + 10 }
  else { x = -10; y = Math.random() * H }
  const dx = ship.x - x, dy = ship.y - y
  const len = Math.hypot(dx, dy) || 1
  const sp = 70 + Math.random() * 40
  e.x = x; e.y = y; e.vx = dx / len * sp; e.vy = dy / len * sp
  e.r = 8 + Math.random() * 4
  e.alive = true
}

// 自动校准：游戏开始 1 秒后，把当前的 yaw/pitch 设为中立位
let autoCalT = 0
const AUTO_CAL_DELAY = 1.0 // 1 秒后自动校准

function loop() {
  // 自动校准计时
  if (!gyro.calibrated && gyro.frames > 30) {
    autoCalT += 1 / 60
    if (autoCalT >= AUTO_CAL_DELAY) {
      gyro.neutralYaw = gyro.rawYaw
      gyro.neutralPitch = gyro.rawPitch
      gyro.calibrated = true
    }
  }

  const tx = W / 2 + gyro.yaw * W * 0.5
  const ty = H / 2 + gyro.pitch * H * 0.4
  ship.x += (tx - ship.x) * 0.18
  ship.y += (ty - ship.y) * 0.18

  if (!dead) {
    spawnT += 1 / 60
    if (spawnT > 1.2) { spawnT = 0; spawn() }
    for (const e of en) {
      if (!e.alive) continue
      e.x += e.vx / 60
      e.y += e.vy / 60
      if (e.x < -50 || e.x > W + 50 || e.y < -50 || e.y > H + 50) e.alive = false
      if (Math.hypot(ship.x - e.x, ship.y - e.y) < ship.r + e.r) {
        dead = true; deadT = 0
        break
      }
    }
  } else {
    deadT += 1 / 60
    if (deadT > 2 || (touchActive && deadT > 0.5)) {
      dead = false; deadT = 0
      score = 0
      autoCalT = 0
      gyro.calibrated = false // 重启时重新校准
      for (const e of en) e.alive = false
    }
  }

  ctx.fillStyle = '#0a0e1f'
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = 'rgba(255,255,255,' + (0.2 + (i % 5) * 0.1) + ')'
    ctx.fillRect((i * 137 + 19) % W, (i * 211 + 47) % H, 2, 2)
  }
  for (const e of en) {
    if (!e.alive) continue
    ctx.fillStyle = '#ff5040'
    ctx.beginPath()
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#4f6df5'
  ctx.beginPath()
  ctx.arc(ship.x, ship.y, ship.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#aabfff'
  ctx.beginPath()
  ctx.arc(ship.x - ship.r * 0.3, ship.y - 2, 3, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#fff'
  ctx.font = '18px sans-serif'
  ctx.fillText('分数 ' + score, 16, 28)
  ctx.fillStyle = '#9ab'
  ctx.font = '12px sans-serif'
  ctx.fillText('v15 躲避 · ' + (gyro.calibrated ? '✓校准' : '校准中') + ' yaw=' + gyro.yaw.toFixed(2) + ' p=' + gyro.pitch.toFixed(2), 16, 48)

  if (dead) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#ff5050'
    ctx.textAlign = 'center'
    ctx.font = 'bold 32px sans-serif'
    ctx.fillText('GAME OVER', W / 2, H / 2 - 20)
    ctx.fillStyle = '#fff'
    ctx.font = '16px sans-serif'
    ctx.fillText('点屏幕重启', W / 2, H / 2 + 20)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)