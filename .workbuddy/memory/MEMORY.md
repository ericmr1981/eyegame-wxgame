# 脖动圈 / eyegame-wxgame · 长期记忆

## 定位
原 `ericmr1981/eyegame`（PC 摄像头头部控制飞船）→ 微信小游戏。
**颈椎舒缓小游戏**。**核心约束：必须头部控制**（不退化为陀螺仪/触屏）。

## 工程
- AppID `wx778e47baebf21ee3`（compileType `game`）· 主工程 `~/WorkBuddy/小游戏/eyegame-wxgame`（portrait）· POC `vk-poc`
- 远端 `github.com/ericmr1981/eyegame-wxgame`（public）· 纯本地不上云 · 纯免费 · **push 必须先问 Eric**

## 工具链
- 工具 `/Applications/wechatwebdevtools.app`（**不是**「微信开发者工具.app」）
- CLI `…/MacOS/wechatide -c workbuddy <cmd> --skill-version 0.3.11`（需 dangerouslyDisableSandbox）
  常用 `auth` `check_wechatide_status` `auto_preview` `create_preview_qrcode`
- 坑：端口 17891 会死 → `auth` 重握手/pkill；**模拟器不支持 VisionKit，必须真机**

## VisionKit 链路（唯一可用路径）
`wx.createCamera({devicePosition:'front'})` → 等 `SETTLE_MS`(3s) 前置生效
→ `wx.createWorker(...,{useExperimentalWorker:true})` + `listenFrameChange(worker)`
→ worker 内 `getCameraFrameData()` 取裸 ArrayBuffer → 主线程 `createVKSession({track:{face:{mode:2}}})`
+ `detectFace({frameBuffer,w:288,h:512,sourceType:0})` → 结果**只从 `updateAnchors` 事件**
`anchor.angle`=(pitch,yaw,roll) **弧度**；帧 **RGBA 288×512=589824B**（不带宽高）；相机**默认后置**须等 1s
- **✅ Camera 可隐藏**：接受 `x/y/width/height` → 丢屏幕外 `-4,-4,2,2` 无预览
- `wx.createOffscreenCanvas` 小游戏不存在 · `open3d` 需微信 ≥8.1.0（当前 8.0.78 不可用）
- iOS 主线程 `Camera.onCameraFrame` 拿不到帧 · **冒烟**：主 canvas = 屏幕逻辑像素

## 头部追踪能力（v16 实测）
真机四档：关 2~3/s · ÷2 9/s · **÷3(96×170) 17/s=默认** · ÷4 21/s；脸 173/173
**桥接带宽 `回 ≈ 13ms + 字节/1536`（≈1.5MB/s）** → 慢在**序列化**非 memcpy → 天花板 ≈55/s
`Worker.postMessage` 无 transferList（零拷贝不可行）
★ **静止噪声：yaw/pitch σ<1.5°（干净）· roll σ≈4.2°（大 3~5 倍）**
遗留：**roll 符号未实测** · **pitch 方向未实测**

## 玩法 · 纵轴隧道
规格 `脖动圈_垂直切片设计规格v1.0_纵轴_2026-10-07.md`（含 v1.1 横幅）
最新变更 `脖动圈_MVP_v3_歪头主控_2026-10-07.md`
- 纵轴卷轴：飞船 y=0.78H，世界从上方涌来 → **必须竖屏**；Canvas 2D + 伪 3D（尺寸∝1/z）
- ★ **速度感与可玩性解耦**：机制速度有红线，视觉速度自由拉高
- **玩法 = 穿越隧道**：须保持管内、贴中心线；`|wx−cx| > hw−SHIP_HW` 扣血；
  蹭壁软推回 45% + 1200ms 无敌 · 计分含**居中加成** · 红线：中心线斜率 ≤ 0.28
  渲染：对数采样 21 档 → 左右管壁折线 + 横向肋条（肋条渐亮渐粗 = 速度感主力）
- **控制（v3 改）**：**歪头 roll → 横移**，约定 `轴值>0⟺右移`，`ROLL_SIGN`/`YAW_SIGN` 一处收口
  · roll 滤波必须比 yaw 厚：死区 4°、EMA τ0.20s、外推 0.40（yaw 档 3°/0.09/0.55）
  · 四档（「控制」按钮循环）：歪头·位置(默认)/歪头·位置反/歪头·速度/转头·位置
  · **pitch→Boost（≤3s+冷却 4s）** · 丢脸>400ms 输入回中 · 零点静息带慢校正
- 降级：`visionkit → gyro → touch`（摄像头 6s 未就绪自动降级）

## 最新包 v3
32516B，**冒烟 97/97**（对照组：滤波降级即挂 E5/E11）；二维码 `mvp_v3_歪头_预览二维码.png`
冒烟抓到的真 bug：v1 `trackNeck` 滞回顺序错（从左直接切右吞计数）· v2 转向符号反 + 颈椎左右标反
**待真机确认**：① **歪头方向**（核心；反了切「歪头·位置反」）② **念 `歪头±X.XX` 定符号**
③ pitch 方向 ④ 静止是否自飘 ⑤ 位置律 vs 速度律

## 合规（1026）
`1026 隐私接口被封禁` = MP 后台《用户隐私保护指引》**未声明「摄像头」**，非代码 bug。
解法：MP → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引（勾"访问你的摄像头"）
+ 开通隐私授权弹窗；**需重新发布**才在正式版生效。
红线：**不落盘/不上传任何人脸数据**；指引须写"仅本机实时处理、不留存"

## 其他坑
- `game.json` 的 `openDataContext` 不能写空字符串
- wechatide CLI 首次授权需开发者工具**完全退出**后触发（单例锁）
