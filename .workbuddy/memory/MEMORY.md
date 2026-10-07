# 脖动圈 / eyegame-wxgame · 长期记忆

## 定位
原 `ericmr1981/eyegame`（PC 摄像头头部控制飞船）→ 微信小游戏。
**颈椎舒缓小游戏**：让用户主动转头活动颈椎。**核心约束：必须头部控制**（不能退化为陀螺仪/触屏）。

## 工程
- AppID：`wx778e47baebf21ee3`（bodongquan，compileType `game`）
- 主工程 `~/WorkBuddy/小游戏/eyegame-wxgame`（portrait，纵轴 MVP v2）· POC `vk-poc`
- 远端 `github.com/ericmr1981/eyegame-wxgame`（public）
- 决策：纯本地不上云 · 难度章节树+每关 4 档 · 纯免费 · 留存靠成就

## 工具链
- 工具 `/Applications/wechatwebdevtools.app`（**不是**「微信开发者工具.app」）
- CLI `…/MacOS/wechatide -c workbuddy <cmd> --skill-version 0.3.11`（需 dangerouslyDisableSandbox）
  常用 `auth` `check_wechatide_status` `auto_preview` `create_preview_qrcode`
- 坑：端口 17891 会死 → `auth` 重握手/pkill；**模拟器不支持 VisionKit，必须真机**

## VisionKit 链路（唯一可用路径）
`wx.createCamera({devicePosition:'front'})` → 等 `SETTLE_MS`(3s) 前置生效
→ `wx.createWorker(...,{useExperimentalWorker:true})` + `camera.listenFrameChange(worker)`
→ worker 内 `getCameraFrameData()` 取裸 ArrayBuffer
→ 主线程 `wx.createVKSession({track:{face:{mode:2}}})` + `detectFace({frameBuffer,w:288,h:512,sourceType:0})`
→ 结果**只从 `updateAnchors` 事件**；`anchor.angle`=(pitch,yaw,roll) **弧度**

固化事实：
- 帧 = **RGBA 288×512 = 589824B**；`getCameraFrameData()` 不带宽高
- 相机**默认后置启动**，`devicePosition:'front'` 要 ~1s 生效
- **✅ Camera 可隐藏**：`wx.createCamera` 接受 `x/y/width/height` → 丢屏幕外（`-4,-4,2,2`）无预览
- `wx.createOffscreenCanvas` 小游戏不存在 · `open3d` 需微信 ≥8.1.0（当前 8.0.78 不可用）
- `Camera.onCameraFrame` iOS 主线程拿不到帧 · **冒烟**：主 canvas = 屏幕逻辑像素

## 技术里程碑
✅ **v16（2026-10-06）头部控制证明可做**
- 拉取式闭环 + 拆三处自设限速（`PACE_MIN` 80→0 / 超时 600→140ms / 派发事件驱动）
- 真机四档：关 2~3/s · ÷2 9/s · **÷3(96×170) 17/s=默认** · ÷4 21/s；脸 173/173
- **桥接带宽 `回 ≈ 13ms + 字节/1536`（≈1.5MB/s）** → 慢在**序列化**非 memcpy → 天花板 ≈55/s
- `Worker.postMessage` 无 transferList · 遗留：**roll σ 4.2° 不做操作** · **pitch 方向未测**

## 玩法 v1.1 · 纵轴隧道（2026-10-07）
规格 `脖动圈_垂直切片设计规格v1.0_纵轴_2026-10-07.md`（含 v1.1 修订横幅）
修订说明 `脖动圈_MVP_v2_隧道_2026-10-07.md`（**最完整的一版**）
- 纵轴卷轴：飞船 y=0.78H，世界从上方涌来 → **必须竖屏**；Canvas 2D + 伪 3D（尺寸∝1/z）
- ★ **速度感与可玩性解耦**：机制速度有红线，视觉速度自由拉高
- ★ **转向约定：左转头 → 飞船左移**（`CFG.YAW_SIGN=-1`；因「左转 yaw↑」而屏幕 x 随 wx 右移）
- **玩法 = 穿越隧道**（v1.1 由「5 泳道躲障碍」改）：中心线沿 z 蜿蜒，须保持管内、贴中心线
  · 判定 `|wx−cx| > hw−SHIP_HW` 扣血；蹭壁软推回 45% + 1200ms 无敌 · 计分含**居中加成**
  · ★ 红线：中心线斜率 ≤ 0.28（余量 6.2 倍：5.6/s vs 35/s 横移能力）
  · 渲染：对数采样 21 档 → 左右管壁折线 + 横向肋条（肋条渐亮渐粗 = 速度感主力）
- 控制：yaw→横移 · **pitch→Boost（≤3s+冷却 4s，方向未实测）** · roll 仅装饰
- 降级：`visionkit → gyro → touch`（摄像头 6s 未就绪自动降级）

## MVP v2（2026-10-07）
`eyegame-wxgame/{game.js,game.json,workers/index.js}`，30652B，**冒烟 74/74**；二维码 `mvp_v2_隧道_预览二维码.png`
- 控制器：死区 3° + EMA α0.35 + 外推 0.55；yaw×2.2，**软限位 ±1.25**
- 真 bug（冒烟抓到）：① trackNeck 滞回顺序错 → 从左直接切右吞一次计数 ② 转向符号反 + 颈椎左右标反
- **待真机确认**：① **左转头是否飞船左移**（核心）② pitch 方向 ③ 隧道观感/转头幅度 ④ 相机藏屏外取帧

## 合规（1026）
- `1026 隐私接口被封禁` = MP 后台《用户隐私保护指引》**未声明「摄像头」**，非代码 bug
- 解法：MP → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引（勾"访问你的摄像头"）+ 开通隐私授权弹窗；**需重新发布**才在正式版生效
- 红线：**不落盘/不上传任何人脸数据**；指引须写"仅本机实时处理、不留存"

## 其他坑
- `game.json` 的 `openDataContext` 不能写空字符串
- wechatide CLI 首次授权需开发者工具**完全退出**后触发（单例锁）
