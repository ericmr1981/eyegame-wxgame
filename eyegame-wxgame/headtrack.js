// headtrack.js — 纯 JS 头部姿态检测（不依赖 wasm/库）
// 注意：小游戏 ES module export 不稳，本文件代码会被合并到 game.js，不走 ES module

// 把 HeadTracker 挂到 globalThis
globalThis.HeadTracker = class HeadTracker {
  constructor(smallW = 80, smallH = 60) {
    this.SW = smallW
    this.SH = smallH
    this.skin = new Uint8Array(smallW * smallH)

    this.yaw = 0
    this.pitch = 0
    this.alpha = 0.35

    this.neutralYaw = 0
    this.neutralPitch = 0
    this.calibrated = false

    this.lastFaceBox = null
    this.lastFaceCenter = null
  }

  calibrate() {
    this.neutralYaw = this.yaw
    this.neutralPitch = this.pitch
    this.calibrated = true
  }

  resetCalibration() {
    this.neutralYaw = 0
    this.neutralPitch = 0
    this.calibrated = false
  }

  update(rgba, width, height) {
    const SW = this.SW
    const SH = this.SH
    let count = 0
    let sumX = 0, sumY = 0
    let minX = SW, maxX = 0, minY = SH, maxY = 0

    for (let sy = 0; sy < SH; sy++) {
      const srcY = (sy * height / SH) | 0
      const srcRowStart = srcY * width * 4
      for (let sx = 0; sx < SW; sx++) {
        const srcX = (sx * width / SW) | 0
        const srcIdx = srcRowStart + srcX * 4
        const r = rgba[srcIdx]
        const g = rgba[srcIdx + 1]
        const b = rgba[srcIdx + 2]
        // 简易肤色规则
        if (r > g && r > b && r > 95 && g > 40 && b > 20 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15) {
          this.skin[sy * SW + sx] = 1
          count++
          sumX += sx
          sumY += sy
          if (sx < minX) minX = sx
          if (sx > maxX) maxX = sx
          if (sy < minY) minY = sy
          if (sy > maxY) maxY = sy
        } else {
          this.skin[sy * SW + sx] = 0
        }
      }
    }

    if (count < 80) {
      this.lastFaceBox = null
      this.lastFaceCenter = null
      return { yaw: this.yaw, pitch: this.pitch, faceFound: false }
    }

    const cx = sumX / count
    const cy = sumY / count
    const w = maxX - minX
    const h = maxY - minY
    this.lastFaceBox = { minX, maxX, minY, maxY }
    this.lastFaceCenter = { x: cx, y: cy }

    const rawYaw = -(cx - SW / 2) / (SW / 2)
    const rawPitch = -(cy - SH / 2) / (SH / 2)
    const yaw = this.calibrated ? rawYaw - this.neutralYaw : rawYaw
    const pitch = this.calibrated ? rawPitch - this.neutralPitch : rawPitch
    this.yaw += (yaw - this.yaw) * this.alpha
    this.pitch += (pitch - this.pitch) * this.alpha

    return {
      yaw: this.yaw,
      pitch: this.pitch,
      faceFound: true,
      faceBox: this.lastFaceBox,
      faceCenter: this.lastFaceCenter,
      faceSize: w * h,
    }
  }
}