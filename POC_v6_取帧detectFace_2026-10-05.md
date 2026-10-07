# POC v6 · 取帧 + detectFace(mode:2) · 自动探测帧尺寸

> 2026-10-05 深夜 · 脖动圈（bodongquan）头部控制路线验证
> 工程：`/Users/ericmr/WorkBuddy/小游戏/vk-poc/`

---

## 一、为什么做 v6 —— 基于 v5 的实测事实

v5 在 iPhone 上跑出来的结果（用户截图 23:23）已经把话说清了一半：

| 配置 | 帧 | st | 尺寸/字节 | 事件 |
|---|---|---|---|---|
| VK default | 0 | 1 | 1080x1920 | **无任何事件** |
| VK v1 | 0 | 1 | 1080x1920 | **无任何事件** |
| VK v2 | 0 | 1 | 1080x1920 | **无任何事件** |
| **相机·Worker** | **70** | - | **589824B** | — |
| 相机·主线程 | 70 | - | -（无宽高） | — |

**两条结论：**

1. ✅ **iOS 取帧通了** —— `相机·Worker` 拿到 70 帧真实数据。「最后一搏」命中。
   （附注：`相机·主线程` 虽然也回调了 70 次，但 `frame` 对象里**没有 width/height**，拿不到有效数据 → Worker 才是唯一有效路径）
2. ❌ **VK `mode:1`（摄像头实时）在 iOS 上不可用** —— 三档都是「会话运行中 + 相机尺寸有值 + 一个事件都不发」。
   截图里人的脸就在画面中，仍然 0 事件 → **不是"没脸"，是它根本不回调**。

于是走 VisionKit 官方给的**另一条正路**：静态图片检测。

---

## 二、官方接口（本次查实）

| 接口 | 关键信息 |
|---|---|
| `VKSession.detectFace` | 基础库 **2.32.1**；需 `{track:{face:{mode:2}}}` |
| 入参 | `frameBuffer`(RGBA ArrayBuffer) / `width` / `height` / `scoreThreshold`(默认0.8) / `sourceType`(0=连续视频帧更优,1=随机图片) / `modelMode` |
| 触发方式 | **每调一次 `detectFace` 就触发一次 `updateAnchors`** |
| 输出 | `anchor.points`(106点) / `origin` / `size` / **`angle` = `(pitch, yaw, roll)`** / `confidence` |
| 平台 | 安卓微信 ≥ 8.0.25 / iOS 微信 ≥ 8.0.24 |

- detectFace 文档：https://developers.weixin.qq.com/minigame/dev/api/ai/visionkit/VKSession.detectFace.html
- 人脸能力指南：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/visionkit/face.html
- 取帧文档：https://developers.weixin.qq.com/minigame/dev/api/worker/Worker.getCameraFrameData.html

---

## 三、v6 解决的核心难题：帧尺寸反推

`detectFace` 必须给 `width`/`height`，但：

- `Worker.getCameraFrameData()` **只返回裸 ArrayBuffer**，不带宽高
- `wx.createCamera` 的 `size` 只能是 `small|medium|large`（官方注明是「帧数据图像尺寸」），**无法直接指定像素**

**解法（自动探测）：**

```
px = byteLength / 4                    // 每像素 4 字节 RGBA
589824 / 4 = 147456 px
→ 枚举因数对（宽高 ≥64、≤2048、8 的倍数、长宽比 0.25~4）
→ 按接近 9:16 排序
候选顺序：288x512 · 256x576 · 192x768 · 384x384 · 512x288 · 576x256 · 768x192
→ 逐帧轮流喂给 detectFace，哪一组能出人脸就锁定哪一组
```

屏幕底部会显示**「帧尺寸探测」**命中表，哪一组打中会亮绿。

---

## 四、v6 跑什么（打开自动跑，约 35 秒）

| 阶段 | 内容 | 时长 | 需要人脸 |
|---|---|---|---|
| ① | **VK `mode:1` 干净版**（不塞非官方 `cameraPosition`，最后复测一次） | 4s | 需要 |
| ② | **取帧（Worker）+ `detectFace(mode:2)`** + 自动探测尺寸 | 30s | 需要 |

**阶段②的链路：**

```
wx.createVKSession({track:{face:{mode:2}}})      ← 静态检测会话（不开摄像头）
       ↓
wx.createCamera({devicePosition:'front', size:'small'})   ← 前置摄像头
       ↓  camera.listenFrameChange(worker)
worker.getCameraFrameData()                       ← iOS 唯一合法取帧方式
       ↓  postMessage(帧 ArrayBuffer) 回主线程
session.detectFace({frameBuffer, width, height, sourceType:0})
       ↓  触发 updateAnchors
anchor.angle = [pitch, yaw, roll]                 ← 头部姿态角
```

---

## 五、屏幕上怎么看（认新包）

- ✅ 标题是「**取帧+detectFace v6 · 自动探测帧尺寸**」→ 新包
- 阶段②运行时顶部显示：`帧 N · 人脸 M · 试 288x512`
- 结果表下面有「**帧尺寸探测**」区，命中会显示 `✓ 288x512　命中 X 次`
- 最下方有「**头部姿态（anchor.angle = pitch,yaw,roll）**」区，出 `当前值 + 近似角度 + 范围 + σ`

---

## 六、判读（结论三种可能全覆盖）

| 现象 | 结论 | 下一步 |
|---|---|---|
| 阶段②出现人脸 + `pitch/yaw/roll` 有数 | **✅ 头部姿态链路打通** | 脖子控制能守回来，进入玩法设计 |
| 有帧、有尺寸命中但人脸 0 | 尺寸没试对 / 脸没对准 | 继续跑完 7 组候选；确认脸在画面正中、光线足 |
| 阶段②连通帧都没有 | Worker 取帧异常 | 回看 `相机·Worker` 帧数（v5 已证明 70 帧），排查相机/Worker 生命周期 |

---

## 七、合规红线（不变）

- 帧数据**只在本机内存里实时处理，不落盘、不上传**（代码里没有任何存储/网络逻辑）
- 隐私指引已声明「摄像头」（1026 已解除）
- 不得采集、存储人脸生物特征

---

## 八、验证记录

- 语法检查：`game.js` / `workers/index.js` / `game.json` 全过
- 离线冒烟：**38 项断言 0 失败**（假时钟跑完两个阶段 + 尺寸轮换命中 288x512 + `angle` 解析为 pitch/yaw/roll + worker 回传 ArrayBuffer）
- 真机预览已推送：**23.4KB**
