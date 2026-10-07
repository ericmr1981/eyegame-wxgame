# 脖动圈 / eyegame-wxgame · 长期记忆

## 定位
原 GitHub `ericmr1981/eyegame`（PC 摄像头头部控制飞船）→ 微信小游戏。
**颈椎舒缓小游戏**：让用户主动转头活动颈椎。**核心约束：必须头部控制**（不能退化为陀螺仪/触屏）。

## 工程
| 字段 | 值 |
|---|---|
| 项目名 / AppID | 脖动圈 bodongquan ／ `wx778e47baebf21ee3` |
| 主工程 | `~/WorkBuddy/小游戏/eyegame-wxgame`（landscape，**当前仍是陀螺仪版**） |
| POC 工程 | `~/WorkBuddy/小游戏/vk-poc`（portrait，VisionKit 已跑通） |
| compileType | `game` |

## 关键决策
- 纯本地（不上云）：积分/难度/成就存 `wx.setStorageSync`，不做排行榜
- 难度：章节树 + 每关 4 档（简/普/困/极）· 商业化：**纯免费** · 留存：成就（无 streak）

## 工具链
- 开发者工具 Nightly：`/Applications/wechatwebdevtools.app`（**不是** `/Applications/微信开发者工具.app`）
- CLI：`/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide -c workbuddy <cmd> --skill-version 0.3.11`（需 dangerouslyDisableSandbox）
- 常用：`auth` `check_wechatide_status` `auto_preview` `create_preview_qrcode`
- 坑：服务端口 17891 会死 → `auth` 重握手或 pkill 重启工具；**模拟器不支持 VisionKit，必须真机**

## VisionKit 摄像头链路（唯一可用路径）
`wx.createCamera({devicePosition:'front'})` → 等 `SETTLE_MS`(3s) 让前置生效
→ `wx.createWorker('workers/index.js',{useExperimentalWorker:true})` + `camera.listenFrameChange(worker)`
→ worker 内 `worker.getCameraFrameData()` 取裸 ArrayBuffer
→ 主线程 `wx.createVKSession({track:{face:{mode:2}}})` + `detectFace({frameBuffer,width:288,height:512,sourceType:0})`
→ 结果**只从 `updateAnchors` 事件回调**；`anchor.angle`=(pitch,yaw,roll)，**单位=弧度**

已固化：
- 帧 = **RGBA 288×512 = 589824B**；`getCameraFrameData()` 不带宽高
- 微信相机**默认后置启动**，`devicePosition:'front'` 要 ~1s 才生效
- **`wx.createOffscreenCanvas` 小游戏不存在**（那是小程序 API）
- `Camera.onCameraFrame` iOS 主线程拿不到帧；`Worker.getCameraFrameData` 仅 iOS+worker+useExperimentalWorker
- `open3d:true` 需微信 ≥8.1.0（当前 8.0.78 不可用）

## 技术里程碑（细节见当日日志）
✅ **v16 技术侧收官（2026-10-06）→ 头部控制证明可做**
- 拉取式闭环（feed-on-demand）+ 拆三处自设限速（`PACE_MIN` 80→0 / 检测超时 600→140ms / 派发改事件驱动）
- 真机四档：关 2~3/s · ÷2 9/s · **÷3(96×170) 17/s = 默认档** · ÷4(72×128) 21/s；脸 173/173
- **桥接带宽模型 `回 ≈ 13ms + 字节/1536`（≈1.5MB/s）** → 慢在**序列化**而非 memcpy → 理论天花板 ≈55/s
- 官方 `Worker.postMessage` 无 transferList → 零拷贝不可行
- 教训（均由离线冒烟 + 对照实验捕获）：推送式洪水=假实时 / 节流正反馈自杀 / 自设 `PACE_MIN` 顶死 12.5/s
- 遗留：各档静态 σ（**roll σ 0.074rad≈4.2° → roll 不做操作**）· ÷3/÷4 丢脸角上限 · **pitch 量程未测**

## 玩法设计 v1.0 · 纵轴卷轴（2026-10-07 定稿）
文档：`脖动圈_垂直切片设计规格v1.0_纵轴_2026-10-07.md`（60s 切片，交开发）
- 形态：纵轴卷轴飞行，飞船在 y=0.78H，世界从上方涌来 → **必须竖屏**（主工程现 landscape）
- 渲染：**Canvas 2D** → 伪 3D 投影（尺寸∝1/z）+ 多层视差（0.5 / 1.0 / 1.4 / 4~6）
- **★ 速度感与可玩性解耦**：可反应预算 600ms（检测60+决策250+横移208+余量80）
  → `V_mech ≤ 1.30 H/s`（加顶部 15% 预告区 → 1.55）；而视觉速度需 3~9 H/s
  → **视觉自由拉高，机制被红线压住**（爽感靠视觉层，可玩性靠机制层）
- 控制：yaw→横移（左转即左移）· **pitch→Boost 抬头氮气（≤3s + 冷却 4s 的短促动作）** ·
  roll 仅装饰 · 死区 3° + EMA α0.35 + 速率外推
- 防挫败：5 泳道，每波**至少留 1 条完全空泳道**；纵向间距 ≥0.22H
- 🔴 **下一步必先验：Camera 原生组件能否隐藏**（正式游戏不能显示摄像头预览）
  → 验不过则改「飞船后视镜/传感器窗口」叙事。**这是沉浸式纵轴的地基**
- 降级路径：`PoseSource` = VisionKitSource(主) / GyroSource(兜底) / MockSource(调试)

## 合规（1026）
- `1026 隐私接口被封禁` = MP 后台《用户隐私保护指引》**未声明「摄像头」**，不是代码 bug
- 解法：MP → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引（勾"访问你的摄像头"）+ 开通隐私授权弹窗
- 隐私权限需**重新发布**才在正式版生效
- 红线：**不落盘/不上传任何人脸数据**；指引须写"仅本机实时处理、不留存"

## 其他坑
- `game.json` 的 `openDataContext` 不能写空字符串
- wechatide CLI 首次授权需开发者工具**完全退出**后触发（单例锁）
