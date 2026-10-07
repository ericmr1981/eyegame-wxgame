# 脖动圈 / eyegame-wxgame · 长期记忆

## 定位
原 GitHub `ericmr1981/eyegame`（PC 摄像头头部控制飞船）→ 微信小游戏。
**颈椎舒缓小游戏**：让用户主动转头活动颈椎。**核心约束：必须头部控制**（不能退化为陀螺仪/触屏）。

## 工程
| 字段 | 值 |
|---|---|
| 项目名 / AppID | 脖动圈 bodongquan ／ `wx778e47baebf21ee3` |
| 主工程 | `~/WorkBuddy/小游戏/eyegame-wxgame`（**portrait，纵轴 MVP 已落地**） |
| POC 工程 | `~/WorkBuddy/小游戏/vk-poc`（VisionKit 验证工程 / 技术参考） |
| 远端仓库 | **`github.com/ericmr1981/eyegame-wxgame`**（public，2026-10-07 建） |
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
- **✅ Camera 可隐藏（2026-10-07 发现）**：`wx.createCamera` 接受 `x/y/width/height`
  → 丢到屏幕外（`x:-4,y:-4,w:2,h:2`）画面里就无预览 → 规格 §11.1 头号风险解除
- **`wx.createOffscreenCanvas` 小游戏不存在**（那是小程序 API）
- `Camera.onCameraFrame` iOS 主线程拿不到帧；`Worker.getCameraFrameData` 仅 iOS+worker+useExperimentalWorker
- `open3d:true` 需微信 ≥8.1.0（当前 8.0.78 不可用）
- **冒烟经验**：小游戏主 canvas 尺寸 = **屏幕逻辑像素**（与触摸 clientX 同坐标系），不是物理像素

## 技术里程碑（细节见当日日志）
✅ **v16 技术侧收官（2026-10-06）→ 头部控制证明可做**
- 拉取式闭环 + 拆三处自设限速（`PACE_MIN` 80→0 / 检测超时 600→140ms / 派发改事件驱动）
- 真机四档：关 2~3/s · ÷2 9/s · **÷3(96×170) 17/s = 默认档** · ÷4(72×128) 21/s；脸 173/173
- **桥接带宽 `回 ≈ 13ms + 字节/1536`（≈1.5MB/s）** → 慢在**序列化**非 memcpy → 理论天花板 ≈55/s
- 官方 `Worker.postMessage` 无 transferList → 零拷贝不可行
- 教训（冒烟+对照实验捕获）：推送式洪水=假实时 / 节流正反馈自杀 / 自设 `PACE_MIN` 顶死 12.5/s
- 遗留：各档静态 σ（**roll σ 0.074rad≈4.2° → roll 不做操作**）· **pitch 量程/方向未测**

## 玩法 v1.0 · 纵轴卷轴（2026-10-07 定稿）
规格：`脖动圈_垂直切片设计规格v1.0_纵轴_2026-10-07.md`
- 形态：纵轴卷轴飞行，飞船 y=0.78H，世界从上方涌来 → **必须竖屏**
- 渲染：**Canvas 2D** → 伪 3D 投影（尺寸∝1/z）+ 多层视差
- **★ 速度感与可玩性解耦**：可反应预算 600ms → `V_mech ≤ 1.30 H/s`（加顶部预告区 1.55）；
  而视觉速度需 3~9 H/s → **视觉自由拉高，机制被红线压住**（爽感靠视觉层，可玩性靠机制层）
- 控制：yaw→横移（左转即左移）· **pitch→Boost 抬头氮气（≤3s+冷却 4s）** · roll 仅装饰
- 防挫败：5 泳道，每波**至少留 1 条空泳道**且与上波空道相邻可达；纵向间距 ≥0.22H
- 降级：三档输入源 `visionkit → gyro → touch`（摄像头 6s 未就绪自动降级）

## MVP v1 已落地（2026-10-07）
`eyegame-wxgame/{game.js, game.json, workers/index.js}`，29511B，**冒烟 55/55**
说明 `脖动圈_MVP_v1_说明_2026-10-07.md`；二维码 `mvp_v1_预览二维码.png`
- 伪 3D：`sy = horizon + PPY/z` · `sx = cx + wx*PPX/z` · 尺寸 ∝ 1/z（SHIP_Z=8）
- 控制器：死区 3° + EMA α0.35 + 速率外推 0.55；yaw×2.2，软限位 ±1.05
- 速度感三件套：星场三层视差 + 向外飞出的速度线 + 尾迹
- 颈椎记账：带滞回的左右转头计数 + 平衡率（结算页展示）
- 真 bug（冒烟抓到）：`trackNeck` 滞回顺序错（先判进入再判退出）→ **从左直接切右会吞一次计数**
  → 改为「先退出滞回、再重新判定」
- **待真机确认**：① **pitch 方向**（抬头还是低头触发 Boost）② 相机藏屏外后取帧是否正常 ③ 取帧/渲染帧率

## 合规（1026）
- `1026 隐私接口被封禁` = MP 后台《用户隐私保护指引》**未声明「摄像头」**，不是代码 bug
- 解法：MP → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引（勾"访问你的摄像头"）+ 开通隐私授权弹窗
- 隐私权限需**重新发布**才在正式版生效
- 红线：**不落盘/不上传任何人脸数据**；指引须写"仅本机实时处理、不留存"

## 其他坑
- `game.json` 的 `openDataContext` 不能写空字符串
- wechatide CLI 首次授权需开发者工具**完全退出**后触发（单例锁）
