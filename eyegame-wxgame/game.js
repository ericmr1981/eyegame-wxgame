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
// ── v5（2026-10-07）：玩法纵深 + 视听反馈 + 暂停 ────────────────
//   ① ★ P0 能量块：块刻意**偏离中线**（见 ORB_PATTERNS），把原本"永远贴中线
//      最优"的无脑追球，变成"要不要冒险去够两侧"的真取舍。居中加成同步
//      从 14 压到 5（CFG.ROOM_SCORE）——两个目标不能互相打架，否则玩家会
//      理性地选择忽略能量块。
//      ★ 这是「游戏收益 ↔ 颈椎运动量」第一次真正对齐：不靠文案劝人动脖子，
//        分数自己会驱动。结算里的"平均离中线 X%"就是这条对齐的量化。
//   ② P2 视听反馈：音效**全部现场合成**（WebAudio，零素材 —— 整包才 30 多 KB，
//      塞 mp3 直接翻几倍）；粒子池 + 分数滚动 + 吃块脉冲。
//      语汇纪律：奖励 = 亮度 + 上扬音；惩罚 = 抖动 + 红屏 + 下滑音。两套不混用。
//   ③ 暂停 / 主动结束：顶栏正中 ⏸。世界冻结、但姿态链路保持热（恢复无空窗）；
//      恢复时把绝对时间戳整体平移 —— 否则暂停 30 秒回来，无敌时间和 Boost
//      冷却都被"偷走"了。
//      ★ 这也是对「颈椎舒缓」定位的交代：脖子累了可以停，而不是只能玩到扣光血。
//
// ── 核心设计 ──────────────────────────────────────────────────
//   · 纵轴卷轴：飞船在 y=0.78H，世界迎面涌来（伪 3D，尺寸 ∝ 1/z）
//   · ★★ 主控轴 = **歪头（roll）**，不是转头（用户 2026-10-07 二次修正）：
//     用户反馈「脑袋向左右肩歪」比「左右转头」对脖子更舒服 → 换成 roll 主控。
//     ⚠️ 这里有个硬约束：POC 实测两个轴的信噪比差 3~5 倍 ——
//        yaw  σ ≈ 0.013~0.026 rad（<1.5°）  → 干净
//        roll σ ≈ 0.074 rad（≈4.2°）        → 噪声大，**这正是上一版把 roll
//        降级成"仅装饰"的原因**。所以要它做主控，滤波必须做厚：
//        死区 3°→4°、EMA τ 0.09s→0.20s、外推 0.55→0.40。
//     ⚠️ 符号：`CFG.ROLL_SIGN` 一处收口。v4 按真机反馈「飞船方向要和头部方向一致」
//        翻正为 +1（头向右肩歪 → 飞船右移）；若又反了，切「控制:位置反」档即可。
//   · ★★ v4 新增「幅度」档（2026-10-07，用户反馈「对头部动作过于敏感、
//     需要增大动作幅度让颈部得到更多运动」）：
//     修法 = **把满量程角度拉开**，而不是单纯砍增益 ——
//       · 满量程 20° → 30°（标准档）：小角度输出成比例变小（不敏感），
//         到满舵所需动作量变大（颈部真的要多动）
//       · 三档只改"动作量"，**不改最大机动能力**（XRANGE/VMAX 恒定）
//       · 外推 0.40 → 0.30，减少"提前窜出去"的手感
//       · 颈椎记账阈值随之抬高（7.5° → 11.5°）：要真歪到位才算一次
//   · ★ v6 回调敏感度（2026-10-07，用户反馈「对头部运动的角度敏感度太低」）：
//     30° 那一档过钝 → 标准档满量程 **30° → 25°**、死区 4° → 3.5°；
//     舒展档 40° → 36°；紧凑档维持 3°/20°（v3 原手感，最灵敏）。
//     ★ 注意这是钟摆的另一头：幅度档越大越"累脖子"、越小越"跟手"，
//       两件事此消彼长 —— 别再来回拉，靠三档让用户自己选。
//     档位：紧凑(3°/20°) · 标准(3.5°/25°) · 舒展(4.2°/36°)，底部第 2 个按钮切换
//   · 符号约定（两个轴统一）：**轴值 > 0 ⟺ 飞船向右移**。
//     所以"头向左肩歪 / 向左转头"必须映射成**负**轴值。
//   · ★ 玩法 = **穿越隧道**（用户 2026-10-07 修正，替代原「5 泳道躲障碍」）：
//     一条连续蜿蜒的管道，飞船要尽量**待在管内、贴近中心线**；蹭管壁扣血。
//     为什么换成隧道：① 隧道是**连续追踪**，正好匹配 17~21/s 采样 +
//     44~58ms 延迟的能力边界（躲障碍要的"瞬间精确"做不到）；
//     ② 颈椎是**平滑连续摆动**而非急促甩头，对产品定位更友好；
//     ③ 纵轴高速 + 管壁/肋条冲刺，速度感与代入感天然更强。
//   · pitch 抬头 → Boost 氮气（短促动作 + 冷却，不是"保持角度=保持速度"）
//   · roll → **主控轴**（歪头即转向）+ 机身压倾（与操作同向 → 代入感）
//   · 控制律两条（「控制」按钮现场切）：
//       位置律（默认）：轴值 → 目标横向**位置**，所见即所得，追踪弯道最直观
//       速度律：轴值 → 目标横向**速度**，噪声被积分再平滑一次更稳，回正即缓停
//   · ★ 速度感与可玩性解耦：世界流动速度受可反应时间约束，而视觉速度
//     （星场/速度线/尾迹/隧道肋条）自由拉高 —— 爽感靠视觉层；
//     隧道的**曲率上限**同样由可反应时间反推（见 TUN_SLOPE_*）
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

// ================================================================ 色板 · 昆虫主题「晨露草茎」
// ★ 三层结构（对应《脖动圈_视觉规范_v1_2026-10-10.md》）：
//   世界层（深林/草茎）· 主体层（金龟子）· 功能层（UI/语义色）
// ★★ 本主题最大风险：绿甲虫飞在绿隧道 = 糊。靠三重分离解：
//   ① 隧道壁去饱和（wall）／甲虫保留饱和（ship）  ② 明度拉开（隧道暗 / 甲虫亮）
//   ③ 甲虫外缘 1px 冷白轮廓光（rim）—— 写实绘画最常用的分离手法，必做
const C = {
  // ---- 世界层：深林 → 草茎通道 ----
  bg0: '#08120C',        // 最远处深林底
  bg1: '#0E1A12',        // 林间微光（地平线以上）
  lane: '#14281C',       // 草茎内部（管道底面）
  wall: '#4E8A5E',       // 草茎壁（★ 已去饱和，让甲虫能跳出来）
  wallLit: '#6FA87C',    // 草茎壁亮面 / 肋条
  wallGlow: '#2C4A36',   // 管壁辉光垫底（粗线用）
  mid: '#7FD98A',        // 通道中线（露水反光）
  star: '#CFF0DC',       // 露珠（替代星点）
  speed: '#D8E8B0',      // 鳞粉速度线
  // ---- 主体层：金龟子 ----
  ship: '#7FA83E',       // 鞘翅主色
  shipDark: '#4A6626',   // 鞘翅暗面 / 鞘翅中缝
  shipLite: '#C6E08A',   // 鞘翅高光
  pronotum: '#5F8A2A',   // 前胸背板
  headC: '#3F5A1E',      // 头部
  leg: '#3A4E1C',        // 六足
  antenna: '#C9A227',    // 鳃叶触角（金属金 = 科级标志）
  rim: '#D8FFE8',        // ★ 轮廓光（冷白，把绿虫从绿底上撕开）
  wing: '#D8FFE8',       // 膜翅（半透明，用 alpha 控制）
  spec: '#FFFFFF',       // 镜面高光
  trail: '#FFD166',      // 尾迹 → 金色鳞粉
  // ---- 功能层 ----
  obs: '#E24B4A', obsEdge: '#FF9D8A',
  fg: '#E8FFF4', dim: '#7F9A86',
  ok: '#6FCF7A', bad: '#E24B4A', warn: '#FFC98A', accent: '#7FD98A',
  panel: '#0E1A12', line: '#22402C',
  boost: '#FFC98A',      // Boost 光效（暖金，偏橙以区别于花粉黄）
  // 能量块 → 花粉球：全屏唯一的高饱和暖色，一眼可辨
  orb: '#FFD166', orbGlow: '#E8A838', orbCore: '#FFF6D8'
}
// ★ v7 倍率光球配色：**全程冷青白**（越低越冷、越满越白）。
//   为什么要改冷色：金色已被花粉球占用（P0 的主收益物），倍率环若也用金 → 玩家分不清
//   "我在攒倍率"还是"前面有一块花粉"。满档不靠色相、靠**纯白 + 加粗环**表达（用亮度分层）。
function multColor(m) {
  const t = clamp((m - 1) / (CFG.MULT_MAX - 1), 0, 1)
  if (t < 0.25) return '#8FD9C8'
  if (t < 0.50) return '#B6EDDD'
  if (t < 0.78) return '#DCFAF0'
  return '#F6FFFC'
}

// ---------------------------------------------------------------- 配置
const CFG = {
  // 布局比例
  HORIZON_R: 0.22,        // 地平线位置（占屏高）
  SHIP_Y_R: 0.78,         // 飞船位置（占屏高）
  SHIP_Z: 8,              // 飞船纵深（世界单位）
  Z_FAR: 36,              // 隧道采样最远纵深（v5：30→36，为能量块留出足够预见时间）
  Z_NEAR: 6.0,            // 隧道最近采样纵深（在飞船平面之下，属正常）

  SHIP_HW: 0.10,          // 飞船半宽（世界单位）
  X_LIMIT: 1.25,          // 飞船横向软限位

  // ---- 隧道（穿越玩法）----
  TUN_HH: 1.10,           // 隧道截面半高（世界单位，纯视觉不参与判定）
  TUN_HW_MAX: 0.66,       // 隧道半宽：简单档
  TUN_HW_MIN: 0.42,       // 隧道半宽：困难档（越窄越难）
  TUN_STEP: 4.0,          // 中心线控制点沿 z 间距（世界单位）
  TUN_SLOPE_MIN: 0.12,    // 中心线最大斜率：简单档（单位 z 的横向变化量）
  TUN_SLOPE_MAX: 0.28,    // 中心线最大斜率：困难档
  TUN_X_LIMIT: 0.85,      // 中心线横向活动范围（+半宽 ≤ X_LIMIT，保证够得着）
  TUN_BACK: 24,           // 飞船身后保留纵深
  TUN_FWD: 64,            // 飞船身前生成纵深

  // ---- 控制（2026-10-07：主控轴改为「歪头 roll」）----
  // 两个轴信噪比差别很大，参数必须分开写，不能共用：
  //   yaw  σ ≈ 0.013~0.026 rad（<1.5°）→ 干净，小死区 + 快 EMA
  //   roll σ ≈ 0.074 rad（≈4.2°）      → 噪声大 3~5 倍，大死区 + 慢 EMA
  CTRL_IDX: 0,            // 控制模式索引（见 CTRL_MODES）：0=歪头·位置
  RANGE_IDX: 1,           // ★【幅度】档索引（见 RANGES）：0=紧凑 1=标准 2=舒展
  ROLL_SIGN: +1,          // ★ 头向右肩歪 → 飞船右移（v4 按真机反馈翻正；若又反了切「歪头·位置反」）
  ROLL_DEAD: 0.061,       // （基准值，实际由 RANGES 覆盖）
  ROLL_FULL: 0.436,       // （基准值，实际由 RANGES 覆盖）满量程 25°（v6：30°→25°，手感更跟）
  ROLL_TAU: 0.18,         // roll EMA 时间常数(s)：噪声大 → 比 yaw 平滑一倍以上（v6：0.20→0.18，响应更快）
  ROLL_EXTRAP: 0.32,      // roll 速率外推权重（v4 降到 0.30；v6 回到 0.32 提高跟手度）
  ROLL_XRANGE: 1.15,      // 位置律：满倾角 → 世界横向 ±1.15（三档恒定，保证最大机动能力不变）
  ROLL_VMAX: 5.5,         // 速度律：满倾角 → 横向速度（世界单位/s）
  TILT_K: 0.55,           // 机身随歪头压倾幅度（纯视觉；与操作同向 = 代入感）

  // yaw（保留为可选 / 回退档）
  YAW_GAIN: 2.2,          // yaw(rad) → 世界横向：0.45rad(26°) ≈ 世界单位 1.0
  YAW_SIGN: -1,           // ★ 左转→左移（POC 实测左转 yaw 增大，故须取反）
  YAW_DEAD: 0.052,        // 死区 3°
  YAW_FULL: 0.45,         // 满量程 26°
  YAW_TAU: 0.09,          // EMA 时间常数(s)
  YAW_EXTRAP: 0.55,       // 速率外推（补延迟）
  EMA_A: 0.35,            // （旧字段，保留兼容）
  EXTRAP: 0.55,           // （旧字段，保留兼容）
  ROLL_K: 0.30,           // （旧字段，保留兼容）

  // 颈椎记账阈值（跟随主控轴 + 跟随「幅度」档，见 RANGES）
  NECK_TH_ROLL: 0.165,    // （基准）歪头计数阈值 ≈9.5°（v6：随满量程 30°→25° 等比下调）
  NECK_TH_YAW: 0.17,      // 转头计数阈值 ≈10°
  NECK_CALM: 0.079,       // （基准）零点慢速校正的"静息带"（≈死区×1.3，带内输出本来就是 0）

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

  // ---- ★ P0 能量块（2026-10-07）------------------------------------
  // 目的：给「贴中线」以外第二个选项 —— 想拿分就得离开中线去够两侧。
  // 这样**游戏收益第一次和颈椎运动量对齐**：不用靠文案劝人动脖子，分数自然会驱动。
  // ⚠️ 与「居中加成」是竞争关系，所以居中分从 14 压到 5（见 ROOM_SCORE）。
  ORB_ON: true,
  ORB_GAP_SEC: 0.52,      // ★ 相邻块的**时间**间隔（秒）—— 按时间不按距离：
  ORB_GAP_JIT: 0.34,      //   速度从 9 爬到 20，若按固定距离，节奏会快一倍。
                        //   0.52s 的由来：视野纵深 40 世界单位 / 速度 9.6 ≈ 4.2 秒，
                        //   而一串 4 块 = 4×0.52 = 2.1 秒 → 视野里正好两串。
                        //   （旧值 1.05 时一串就占满视野，屏幕上只剩孤零零一个块）
  ORB_R: 0.075,           // 块半径（世界单位，纯视觉+判定）
  ORB_VIEW: 28,           // ★ 相对飞船平面的可见纵深（= Z_FAR 36 − SHIP_Z 8）
                        //   ★★ 生成上限必须与它对齐：早先用 TUN_FWD(64) 当生成上限，
                        //   新串会生成在视野外 19 单位处，第一次 updateOrbs 裁剪就把它们
                        //   删了 —— scroll 追上时那块早没了，屏幕上周期性"断流"。
                        //   冒烟 O15b（空窗帧占比）抓到的就是这个。
  ORB_OFF_MIN: 0.28,      // 相对隧道半宽的**最小**偏移比例 ← 保证「中线附近没有块」
                        //   ★ v6：0.50 → 0.28。原来所有 pattern 的 |off| 都在 0.50~0.85，
                        //   视觉上"块全堆在管壁边上"，玩起来单调。放宽到 0.28 后，
                        //   块在「中线留空 → 半宽」这段里随机铺开（配合 pattern 表的 jitter）。
  ORB_OFF_MAX: 0.88,      // 最大偏移（0.88×hw + ORB_R 仍 < hw，块不穿出管壁）
  ORB_CATCH: 0.045,       // 横向判定富余（对玩家友好；0 = 严格贴合）
  ORB_SCORE: 30,          // 基础分（再乘 combo 倍率）
  COMBO_SEC: 2.6,         // 连击保持时间：超时未吃到就归零
  COMBO_CAP: 9,           // 连击倍率上限
  ROOM_SCORE: 5,          // 居中保底分（原 14 → 5）

  // ---- ★ v7 居中连乘（Center Multiplier）----
  //  设计意图：把「保持居中」从**静默的保命行为**变成**看得见的收益放大器**。
  //  病根（v6 体感诊断）：居中链路只有一条几乎不可见的加分（5 分/秒，被无条件的
  //  存活分淹没），且**中心线在屏幕上根本没被画出来** → 玩家「感觉不到保持中线的变化」。
  //  解法：贴中线攒倍率，倍率乘**所有**得分（含能量块）。
  //    → 贴中线 = 投资（攒倍率），够块 = 兑现（基础分 × 倍率）
  //    → 「安全」与「收益」从竞争关系变成**乘法关系**，不再是两个打架的目标。
  MULT_ON: true,
  MULT_MAX: 5,            // 满倍率 ×5
  MULT_RAMP_SEC: 6,       // 从 ×1 攒到 ×5 需要连续居中的秒数
  MULT_HOLD_CENT: 0.62,   // 「算居中」的阈值（cent ≥ 该值才推进计时）
  // ★ 脱离宽限：**必须有** —— 块都刻意偏离中线（ORB_OFF_MIN=0.28），
  //   若「一离开就清零」，吃任何块都会破倍率 → 玩家永远不敢够块 → P0 被废掉。
  //   0.7s 的用意：单块/短串能「短冲」吃到而不破倍率；4 块长串（≈1.5s）必然破
  //   → 串长天然成了取舍表：短串 = 甜点，长串 = 高风险大餐。
  MULT_GRACE_SEC: 0.7,
  MULT_TIER: 1.0,         // 每涨满 1.0 倍率 → 光球脉冲 + 上扬音
  // ★ 翅膀展开阈值（2026-10-10 真机反馈后改）：倍率到 ×2 才开始开翅 ——
  //   平时巡航鞘翅是**闭合**的，"充能到一定级别才展开"才有仪式感。
  WING_OPEN_MULT: 2.0,

  // ---- P2 视听反馈 ----
  AUDIO_ON: true,
  P_MAX: 140,             // 粒子池上限（超出就丢最老的，避免长局内存爬升）
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
  mode: 'boot',           // boot | play | paused | over
  srcKind: 'auto',        // auto | visionkit | gyro | touch
  srcActive: 'none',      // 实际生效：visionkit | gyro | touch
  err: '', msg: '',
  audio: 'unknown',       // unknown | on | off（WebAudio 可用性，见 initAudio）

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
    nYaw: 0, nPitch: 0, nRoll: 0,          // 零点：开局标定 + 静息带慢速校正
    calibrated: false, samples: 0
  },

  // 玩法
  g: {
    wx: 0,            // 飞船横向（世界单位）
    tgt: 0, tilt: 0,
    score: 0, best: 0, lives: CFG.LIVES,
    invulnUntil: 0, dead: false,
    t: 0,                       // 本局时间（秒）
    speed: CFG.SPEED_MIN,
    tunnel: { pts: [], dir: 0, dirTgt: 0, scroll: 0, nextOrbZ: 0, queue: [] },
    stars: [], streaks: [],
    shake: 0, flash: 0, hitFlash: 0,
    boostUntil: 0, boostCoolAt: 0, boosting: false,
    hits: 0, cent: 1, centSum: 0, centN: 0,

    // ★ v7 居中连乘
    mult: 1,          // 当前倍率（1 ~ MULT_MAX）
    multHold: 0,      // 已连续居中的秒数（攒倍率用）
    multOut: 0,       // 脱离计时（秒），用于宽限判定
    multBest: 1,      // 本局最高倍率（结算展示）
    multTier: 1,      // 上次触发的档位（跨档才脉冲，避免每帧都闪）
    multPop: 0,       // 脉冲动画进度 1→0（涨满一档）
    multLost: 0,      // 清零碎裂动画进度 1→0

    // ★ P0 能量块
    orbs: [],                 // 视野内的块（世界坐标）
    parts: [],                // 粒子池
    combo: 0, comboT: 0,      // 连击数 / 剩余保持时间(s)
    comboPop: 0,              // 吃到块时的弹出动画进度 1→0
    comboPopMul: 1,           // ★ v7 弹出时的居中倍率（>1.5 用金色 → "这分是倍率挣来的"）
    comboPopTxt: '',          // 弹出文字（含分数）
    orbFlash: 0,              // 吃块屏幕脉冲（呼吸感，不是震屏）
    took: 0, miss: 0,         // 本局吃到 / 错过（错过不清连击，见 updateOrbs）
    offSum: 0, offN: 0,       // 吃到块的 |off| 累加 → 结算显示"平均离中线 X%"
    scoreShow: 0,             // 显示用分数（缓动追 g.score，制造"跳动"感）

    // 暂停
    pausedAt: 0, endedByUser: false
  },

  // 颈椎记账
  neck: { left: 0, right: 0, activity: 0, side: 0 },

  // 控制模式索引（0=歪头·位置 1=歪头·位置反 2=歪头·速度 3=转头·位置）
  ctrlIdx: 0,

  // 幅度档索引（0=紧凑 1=标准 2=舒展）
  rangeIdx: 1,

  // 调试
  perf: { renderStamps: [], renderFps: 0 },
  // 按钮命中区：btn = 底部四按钮；pause = 顶部暂停；pui = 暂停层两按钮；aSW = 音效开关
  btn: { y: 0, h: 0, x: 0, w: 0, xs: [], pause: null, pui: null, aSW: null },
}

try { S.g.best = wx.getStorageSync('bd_best') || 0 } catch (e) { S.g.best = 0 }
try { S.ctrlIdx = wx.getStorageSync('bd_ctrl') || 0 } catch (e) { S.ctrlIdx = 0 }
if (!(S.ctrlIdx >= 0 && S.ctrlIdx < 4)) S.ctrlIdx = 0
// ⚠️ 首次读 storage 返回 ''（parseInt→NaN），必须显式回落到默认 1（标准档）
try {
  const rv = parseInt(wx.getStorageSync('bd_range'), 10)
  S.rangeIdx = (rv >= 0 && rv <= 2) ? rv : 1
} catch (e) { S.rangeIdx = 1 }
// 音效开关（暂停层里可切）：首次读是 ''，只有显式存过 0/1 才覆盖默认
try {
  const av = wx.getStorageSync('bd_audio')
  if (av === 0 || av === 1 || av === '0' || av === '1') CFG.AUDIO_ON = !!parseInt(av, 10)
} catch (e) { /* 用默认 */ }

let camObj = null
let workerObj = null

function msgOf(e) { return (e && e.message) ? e.message : String(e) }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }
function lerp(a, b, t) { return a + (b - a) * t }
function rnd(a, b) { return a + Math.random() * (b - a) }

// ---------------------------------------------------------------- 音效（P2）
// ★ 零素材方案：不加载任何音频文件，用 WebAudio 现场合成。
//   理由：① 小游戏包体敏感（现在整包才 33KB，塞 mp3 直接翻几倍）；
//        ② 合成音能跟着 combo 变调 —— 音高随连击上升，正反馈强度是"听得见"的。
//   降级：基础库 <2.19 / 接口缺失 / 用户关掉 → S.audio='off'，全程静默，玩法不受影响。
//   ⚠️ iOS 上 WebAudio 需要用户手势后才能出声 → 首次触摸时 resume()（见 onTouchStart）。
let AC = null
let audioWhy = ''          // 创建失败原因（诊断用，HUD 可显示）

function initAudio() {
  if (AC !== null) {
    // 已创建：补一次 resume（iOS 首帧常是 suspended，等用户手势）
    // ★ 不判 state —— 小游戏的 WebAudioContext 未必暴露该字段，判了反而漏掉真正需要 resume 的情况
    try { if (AC && AC.resume) AC.resume() } catch (e) { /* ignore */ }
    return AC
  }
  if (!CFG.AUDIO_ON) { AC = false; S.audio = 'off'; return AC }
  try {
    if (typeof wx.createWebAudioContext !== 'function') throw new Error('接口缺失')
    AC = wx.createWebAudioContext()
    if (!AC || !AC.destination) throw new Error('创建失败')
    try { if (AC.resume) AC.resume() } catch (e) { /* ignore */ }
    S.audio = 'on'; audioWhy = ''
  } catch (e) { AC = false; S.audio = 'off'; audioWhy = msgOf(e) }
  return AC
}

// ★★ iOS 音频解锁：AudioContext 必须**在用户手势的同步调用栈里**被唤醒，
//    且一次 resume 往往不够（首次触摸时 ctx 刚创建，pending 状态要下一拍才生效）。
//    所以：每次触摸都无条件 resume（幂等），并在首次解锁时播一个极短近乎无声的音，
//    把音频管线真正"顶"开 —— 这是 iOS WebAudio 的标准解锁姿势。
//    另外用 setInnerAudioOption 关掉"跟随静音键"，否则 iPhone 侧面开关一拨就全程无声。
let unlocked = false
function unlockAudio() {
  if (!CFG.AUDIO_ON) return
  // 每次触摸都尝试解除"跟随系统静音键"（首次有效，之后幂等）
  try {
    if (wx.setInnerAudioOption) wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true })
  } catch (e) { /* 低版本没有此接口，忽略 */ }
  const ac = initAudio()
  if (!ac) return
  try {
    if (ac.resume) ac.resume()
    // 只要状态还没到 running 就继续"顶"（有的机型第一次触摸不够，要两三次）
    const st = ac.state
    if (!unlocked || (st && st !== 'running')) {
      unlocked = true
      const o = ac.createOscillator()
      const gn = ac.createGain()
      gn.gain.value = 0.0001          // 近乎无声，只为激活管线
      o.connect(gn); gn.connect(ac.destination)
      o.start(); o.stop(ac.currentTime + 0.02)
      // 首触摸时不放真实音效（此时可能还没开局），静默激活即可
    }
  } catch (e) { /* ignore */ }
}

// 一个带包络的振荡器音符。sweepTo = 频率滑到哪（做"下滑/上扫"的听感）
function tone(freq, dur, type, vol, sweepTo, at) {
  if (!CFG.AUDIO_ON) return
  const ac = initAudio()
  if (!ac) return
  try {
    const t0 = ac.currentTime + (at || 0)
    const o = ac.createOscillator()
    const gn = ac.createGain()
    o.type = type || 'sine'
    o.frequency.setValueAtTime(freq, t0)
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur)
    // 8ms 起音 + 指数收尾：不做硬切，否则每次都有"啪"的爆音
    gn.gain.setValueAtTime(0.0001, t0)
    gn.gain.exponentialRampToValueAtTime(vol, t0 + 0.008)
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.connect(gn); gn.connect(ac.destination)
    o.start(t0); o.stop(t0 + dur + 0.03)
  } catch (e) { /* 单次失败不致命 */ }
}

// 语义化封装：调用点读起来就是"发生了什么"，不关心波形
function sfxOrb(combo) {
  const c = Math.min(combo, CFG.COMBO_CAP)
  tone(520 + c * 55, 0.085, 'triangle', 0.16, 900 + c * 60)
}
function sfxHit() { tone(190, 0.22, 'sawtooth', 0.20, 65) }
function sfxBoost() { tone(280, 0.30, 'sawtooth', 0.10, 1000) }
function sfxStart() { tone(440, 0.10, 'triangle', 0.13); tone(660, 0.16, 'triangle', 0.11, 660, 0.09) }
function sfxOver() { tone(420, 0.28, 'triangle', 0.15, 170) }
// ★ v7 居中倍率音效：升档 = 上行音（档位越高越亮，正反馈"我在变强"）；
//   破倍率 = 短促下滑音（"泄气"，和撞墙的重低音区分开 —— 撞墙是惩罚，破倍率只是损失）
function sfxMultUp(tier) {
  const b = 300 + tier * 75
  tone(b, 0.09, 'triangle', 0.09, b * 1.7)
}
function sfxMultLost() { tone(360, 0.16, 'sine', 0.11, 160) }

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
const gyro = { y: 0, r: 0, ny: 0, nr: 0, n: 0 }
function startGyro() {
  if (!S.hasAcc) { S.err = '无 startAccelerometer'; return false }
  try {
    wx.startAccelerometer({ interval: 'game' })
    wx.onAccelerometerChange(function (a) {
      const gg = Math.hypot(a.x, a.y, a.z) || 1
      // 手机在**屏幕平面内**左右倾斜（≈"歪头"这个动作的等价物）→ roll
      const rollRaw = a.x / gg
      const yawRaw = -a.y / gg
      gyro.n++
      if (gyro.n === 1) { gyro.nr = rollRaw; gyro.ny = yawRaw }
      const dr = Math.abs(rollRaw - gyro.nr) > 0.03 ? (rollRaw - gyro.nr) : 0
      const dy = Math.abs(yawRaw - gyro.ny) > 0.03 ? (yawRaw - gyro.ny) : 0
      gyro.r += (dr - gyro.r) * 0.25
      gyro.y += (dy - gyro.y) * 0.25
      // 陀螺仪量纲与 VisionKit 弧度不同，等比放大到可比区间
      const p = S.pose
      p.roll = gyro.r * 1.6
      p.yaw = gyro.y * 1.6
      p.pitch = 0            // ★ 陀螺仪下**关闭 Boost**（俯仰不可靠，规格已约定）
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
// ★ 2026-10-07：主控轴从「转头(yaw)」改为「歪头(roll)」。
//   为什么：用户反馈"头向左右肩歪"比"左右转头"对脖子更舒服 —— 这是产品定位
//   层面的判断（转头主要动用颈旋转肌群、持续单侧旋转易累；向肩歪是颈侧屈，
//   动作幅度小、前庭刺激弱，更放松），我认同。
//
//   但工程上有代价：两个轴的信噪比差 3~5 倍（POC v16 实测）——
//     yaw  σ ≈ 0.013~0.026 rad（<1.5°）→ 干净
//     roll σ ≈ 0.074 rad（≈4.2°）      → 噪声大
//   上一版正因这个数才把 roll 定为"仅装饰"。现在要它做主控，三道滤波都得加厚：
//     死区 3°→4° · EMA τ 0.09s→0.20s · 外推 0.55→0.40
//
//   两种控制律（真机用「控制」按钮现场切）：
//     位置律（默认）：轴值 → 目标横向**位置**。所见即所得，追踪弯道最直观。
//     速度律：轴值 → 目标横向**速度**。噪声被积分再平滑一次，更稳；回正即缓停，
//             不需要"一直维持某个歪头角度"（这点与产品定位一致）。
//
//   符号约定（两轴统一）：**轴值 > 0 ⟺ 飞船向右移**。
//   所以"头向左肩歪 / 向左转头"必须映射成负轴值 —— 由 SIGN 常量一处收口。
const ctl = { f: 0, prev: 0, vel: 0, smooth: 0 }

// ---------------------------------------------------------------- 幅度档
// 用户反馈「对头部动作过于敏感」（2026-10-07）：小幅歪头就吃满舵，脖子几乎不用动。
// 修法 = **把满量程角度拉开**（而不是单纯砍增益）：
//   死区/满量程一起抬 → 小角度输出成比例变小（更不敏感），
//   同时"到满舵所需的动作量"变大 → **颈部活动量随之增加**，正中产品诉求。
// 三档**只改动作量，不改最大机动能力**：xrange / vmax 恒定 1.15 / 5.5，
// 所以切档不会让你"够不着弯道"，只会让你"多动脖子"。
//   neck = 颈椎记账阈值（要真歪到位才计一次）；calm = 零点校正静息带（≈死区×1.3）
// ★ v6 回调（用户反馈「角度敏感度太低」）：标准档 30°→25°、舒展档 40°→36°，
//   紧凑档维持 20°。这是"累脖子 ↔ 跟手"钟摆的另一头 —— 三档并存，让用户自己选，
//   别再拿默认档来回拉。
const RANGES = [
  { id: 'tight', dead: 0.052, full: 0.349, neck: 0.130, calm: 0.068, label: '紧凑' }, // 3.0° / 20°（最灵敏）
  { id: 'std',   dead: 0.061, full: 0.436, neck: 0.165, calm: 0.079, label: '标准' }, // 3.5° / 25° ★默认（v6：30°→25°）
  { id: 'wide',  dead: 0.073, full: 0.628, neck: 0.215, calm: 0.095, label: '舒展' }  // 4.2° / 36°（v6：40°→36°）
]
function curRange() { return RANGES[clamp(S.rangeIdx | 0, 0, RANGES.length - 1)] }

const CTRL_MODES = [
  { id: 'roll-pos',   axis: 'roll', law: 'pos', flip: 1,  label: '歪头·位置',   short: '位置' },
  { id: 'roll-pos-r', axis: 'roll', law: 'pos', flip: -1, label: '歪头·位置反', short: '位置反' },
  { id: 'roll-vel',   axis: 'roll', law: 'vel', flip: 1,  label: '歪头·速度',   short: '速度' },
  { id: 'yaw-pos',    axis: 'yaw',  law: 'pos', flip: 1,  label: '转头·位置',   short: '转头' }
]
function ctrlMode() { return CTRL_MODES[clamp(S.ctrlIdx | 0, 0, CTRL_MODES.length - 1)] }
function axisSign(axis) { return axis === 'roll' ? CFG.ROLL_SIGN : CFG.YAW_SIGN }
function resetCtl() { ctl.f = 0; ctl.prev = 0; ctl.vel = 0; ctl.smooth = 0; S.g.tgt = S.g.wx }

// 死区 + 满量程归一化：|v| ≤ dead → 0；|v| = full → ±1；中间线性
function axisMap(v, dead, full) {
  const a = Math.abs(v)
  if (a <= dead) return 0
  const s = Math.min(1, (a - dead) / Math.max(0.0001, full - dead))
  return v < 0 ? -s : s
}
function updateControl(dt) {
  const p = S.pose
  const g = S.g
  const m = ctrlMode()
  const isRoll = m.axis === 'roll'

  // ---- 取原始轴值（相对零点）----
  const base = isRoll ? (p.roll - p.nRoll) : (p.yaw - p.nYaw)
  const raw = base * axisSign(m.axis) * m.flip

  const rg = curRange()
  const dead = isRoll ? rg.dead : CFG.YAW_DEAD
  const full = isRoll ? rg.full : CFG.YAW_FULL
  const tau = isRoll ? CFG.ROLL_TAU : CFG.YAW_TAU
  const expK = isRoll ? CFG.ROLL_EXTRAP : CFG.YAW_EXTRAP

  // ---- 丢脸兜底：>400ms 没检测到脸 → 输入视为回中 ----
  // 否则飞船会带着"最后一帧的角度"一路跑偏（老版本没有这条）
  const stale = (S.srcActive === 'visionkit') && (Date.now() - S.det.latHit > 400)

  // ---- 归一化轴值 [-1,1]（死区 + 满量程）----
  const axis = stale ? 0 : axisMap(raw, dead, full)

  // ---- EMA 平滑（用时间常数，采样率变化时手感一致）----
  const a = 1 - Math.exp(-dt / Math.max(0.02, tau))
  ctl.f += (axis - ctl.f) * a
  // 机身姿态用「未过死区」的归一化值 → 小幅歪头也带一点机身压倾（代入感）
  const visv = stale ? 0 : clamp(raw / full, -1, 1)
  ctl.smooth += (visv - ctl.smooth) * a

  // ---- 速率外推（补 44~58ms 链路延迟）----
  const vel = ctl.f - ctl.prev
  ctl.prev = ctl.f
  const pred = ctl.f + vel * expK

  // ---- 控制律 ----
  if (m.law === 'vel') {
    // 速度律：轴值 → 目标横向速度 → 积分成位置（无自动回中；回正即缓停）
    ctl.vel = pred * CFG.ROLL_VMAX
    g.tgt = clamp(g.tgt + ctl.vel * dt, -CFG.X_LIMIT, CFG.X_LIMIT)
  } else {
    // 位置律：轴值 → 目标横向位置
    const range = isRoll ? CFG.ROLL_XRANGE : (CFG.YAW_GAIN * CFG.YAW_FULL)
    g.tgt = clamp(pred * range, -CFG.X_LIMIT, CFG.X_LIMIT)
  }
  // 飞船实际位移略慢于目标 → "跟手但有质量"的手感
  g.wx += (g.tgt - g.wx) * Math.min(1, dt * 14)
  // 机身压倾：与操作同向（歪头 ↔ 压倾），强化"我就是飞船"的代入感
  g.tilt = clamp(ctl.smooth * CFG.TILT_K, -0.45, 0.45)

  // ---- 零点慢速校正 ----
  // 仅在"静息带"内极慢跟随：带内输出本来就是 0，所以**改了也不影响当前操作**，
  // 只用来吃掉 VisionKit 的慢漂移（否则歪头做主控会像"船慢慢自己跑"）。
  if (!stale && isRoll && Math.abs(base) < rg.calm) {
    p.nRoll += (p.roll - p.nRoll) * Math.min(1, dt * 0.10)
  }

  // ---- 触摸兜底：手指位置直接给横向位置 ----
  if (touch.down) {
    g.wx += (clamp(touch.x, -CFG.X_LIMIT, CFG.X_LIMIT) - g.wx) * Math.min(1, dt * 16)
    g.tgt = g.wx
  }
}

// 颈椎活动记账：带滞回的左右计数（**跟随当前主控轴**）
// ⚠️ 必须"先退出滞回、再重新判定"，否则从左直接切到右时那一次会被吞掉
//    （冒烟 H1 抓到的 bug：旧写法一次调用只能退回到中立，要等下一帧才计数）
// ⚠️ 左右按**物理方向**记（不含「…反」档的 flip）：头朝哪边歪/转就记哪边。
//    用 v = base × 轴 SIGN，v>0 即"向右"，与控制器同一套符号约定。
function trackNeck() {
  const m = ctrlMode()
  const isRoll = m.axis === 'roll'
  const base = isRoll ? (S.pose.roll - S.pose.nRoll) : (S.pose.yaw - S.pose.nYaw)
  const v = base * axisSign(m.axis)
  const th = isRoll ? curRange().neck : CFG.NECK_TH_YAW
  const nk = S.neck
  if (nk.side === 1 && v < th * 0.5) nk.side = 0
  else if (nk.side === -1 && v > -th * 0.5) nk.side = 0
  if (nk.side === 0) {
    if (v < -th) { nk.side = -1; nk.left++; nk.activity++ }
    else if (v > th) { nk.side = 1; nk.right++; nk.activity++ }
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
    sfxBoost()
  }
}

// ---------------------------------------------------------------- 世界
function diffRatio() { return clamp(S.g.t / CFG.RAMP_SEC, 0, 1) }

// ---------------------------------------------------------------- 隧道
// 中心线用**控制点链**表示：pts = [{ zt, cx, hw }]，zt = **世界坐标**（越大越远）。
// 飞船固定在世界坐标 zt = scroll + SHIP_Z，故某点的相对纵深 = zt - scroll。
// ★ 生成约束：相邻控制点的横向变化 ≤ 斜率上限 × 间距。这条上限由
//   「飞船横移能力 vs 可反应时间」反推，保证**永远跟得上**——
//   这就是「可玩性红线」落在隧道上的形式（难度只敢提到 0.28）。
function tunSlope() { return lerp(CFG.TUN_SLOPE_MIN, CFG.TUN_SLOPE_MAX, diffRatio()) }
function tunHalfW() { return lerp(CFG.TUN_HW_MAX, CFG.TUN_HW_MIN, diffRatio()) }

function pushTunnelPt() {
  const t = S.g.tunnel
  const pts = t.pts
  const last = pts[pts.length - 1]
  const step = CFG.TUN_STEP

  // 蜿蜒方向：有惯性（不会抖）+ 偶尔换向 + 贴边反弹 → 平滑的左右摆动
  if (Math.random() < 0.20) t.dirTgt = rnd(-1, 1)
  if (last.cx > CFG.TUN_X_LIMIT - 0.12 && t.dirTgt > 0) t.dirTgt = -Math.abs(t.dirTgt)
  if (last.cx < -(CFG.TUN_X_LIMIT - 0.12) && t.dirTgt < 0) t.dirTgt = Math.abs(t.dirTgt)
  t.dir += (t.dirTgt - t.dir) * 0.22

  const maxStep = tunSlope() * step
  const cx = clamp(last.cx + t.dir * maxStep, -CFG.TUN_X_LIMIT, CFG.TUN_X_LIMIT)

  // 半宽缓慢起伏（但不低于当前难度下限）
  const base = tunHalfW()
  const hw = clamp(last.hw + rnd(-0.05, 0.05), base, base * 1.25)

  pts.push({ zt: last.zt + step, cx: cx, hw: hw })
}

function initTunnel() {
  const g = S.g
  const t = g.tunnel
  t.scroll = 0; t.dir = 0; t.dirTgt = 0
  t.pts = []
  const hw0 = CFG.TUN_HW_MAX
  // 开局先给一段平直段（别一上来就拐）；飞船 zt = SHIP_Z 正处在其中
  for (let i = 0; i <= 4; i++) t.pts.push({ zt: i * CFG.TUN_STEP, cx: 0, hw: hw0 })
  while (t.pts[t.pts.length - 1].zt < CFG.SHIP_Z + CFG.TUN_FWD) pushTunnelPt()
  // 开局留 16 单位空档再出块：先让玩家熟悉歪头控船，别一上来就要够两侧
  t.nextOrbZ = CFG.SHIP_Z + 16
  t.lastOrbOff = 0        // ★ 串间换向补偿用：上一串末块的偏移
  t.lastCross = false     // ★ 本次串间是否跨中线（诊断/冒烟可观测）
  t.lastGapUnits = 0      // ★ 本次串间实际留了多少世界单位
}

// 取「相对纵深 zr」处的隧道参数（相邻控制点线性插值）
function tunnelAt(zr) {
  const t = S.g.tunnel
  const pts = t.pts
  if (!pts.length) return { cx: 0, hw: CFG.TUN_HW_MAX }
  const zt = t.scroll + zr
  if (zt <= pts[0].zt) return { cx: pts[0].cx, hw: pts[0].hw }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    if (zt >= a.zt && zt <= b.zt) {
      const f = (zt - a.zt) / Math.max(0.0001, b.zt - a.zt)
      return { cx: lerp(a.cx, b.cx, f), hw: lerp(a.hw, b.hw, f) }
    }
  }
  const last = pts[pts.length - 1]
  return { cx: last.cx, hw: last.hw }
}

// ---------------------------------------------------------------- ★ P0 能量块
// 设计要点（改这块前先读）：
//  ① 块的横向位置写成「隧道中心线 cx + off × 半宽 hw」。因为中心线本身在摆动，
//     块跟着它走 —— 玩家的「跟随隧道」和「吃块」是同一套动作，**只有 off
//     （相对中心线的偏移）才是额外付出的颈部横摆量**。
//  ② 生成单位是 **pattern（串）**而不是单块。一串块构成一条轨迹（由内向外划出去 /
//     左右横扫 / 来回摆），玩家必须**连续跟随**——那才叫颈部运动；单块只是点一下。
//  ③ ★ 可玩性红线：相邻块的横向跨度必须能在**本串的节拍**内走完。
//     飞船满舵 XRANGE=1.15、跟踪系数 dt*14 → 1.03 世界单位约需 0.14 秒（纯机动，
//     不含人的反应）。真正卡住的是**人的换向速度**：一次 ±13° 头摆约 0.5 秒。
//     所以：★ 跨度大的 pattern 必须配更长的节拍（gapScale）——
//     zigzag 的跨度是 sweep 的 10 倍，节拍就得给到 2 倍，否则物理上根本走不完。
//     难度只敢动 **pattern 权重**，不敢动跨度上限 —— 与隧道曲率是同一条红线。
//  ④ 收益设计：想拿分就必须离开中线，所以**居中加成从 14 压到 5**（CFG.ROOM_SCORE）。
//     这是「游戏收益 ↔ 颈椎运动量」第一次对齐：不靠文案劝人动脖子，分数自己会驱动。
const ORB_PATTERNS = [
  // offs = 相对隧道半宽的比例，正=右。w(d) = 随难度 0→1 的抽取权重
  // gapScale = ★ 节拍倍率：跨度越大，块间给的时间越多（见上文红线③）
  // jitter   = ★ 位置随机抖动（v6 新增）：让"同一个 pattern"每一串也落在不同距离上。
  //            取值已保证 offs ± jitter 落在 [ORB_OFF_MIN, ORB_OFF_MAX] 内，不靠 clamp 兜。
  //  ⚠️ 大跨度的串（zig / wave / sweep）**不加 jitter** —— 那会破坏红线③的跨度预算。
  { id: 'sweepR',  offs: [0.30, 0.47, 0.66, 0.86], gapScale: 1.15, w: function (d) { return 0.16 + d * 0.24 } },
  { id: 'sweepL',  offs: [-0.30, -0.47, -0.66, -0.86], gapScale: 1.15, w: function (d) { return 0.16 + d * 0.24 } },
  { id: 'wave',    offs: [-0.86, -0.46, 0.46, 0.86], gapScale: 1.35, w: function (d) { return 0.04 + d * 0.26 } },
  { id: 'zig',     offs: [-0.74, 0.74, -0.74], gapScale: 1.50, w: function (d) { return d * 0.28 } },
  { id: 'scatter', offs: [0.42, 0.62, 0.46, 0.74], jitter: 0.14, gapScale: 1.20, w: function (d) { return 0.10 + d * 0.16 } },
  { id: 'edgeR',   offs: [0.72], jitter: 0.16, gapScale: 1.00, w: function (d) { return 0.13 - d * 0.06 } },
  { id: 'edgeL',   offs: [-0.72], jitter: 0.16, gapScale: 1.00, w: function (d) { return 0.13 - d * 0.06 } },
  { id: 'rand',    offs: [0.58], jitter: 0.30, gapScale: 1.00, w: function (d) { return 0.26 } },  // ★ 全区间随机距离（"随机分布"主力）
  { id: 'near',    offs: [0.36], jitter: 0.08, gapScale: 1.00, w: function (d) { return 0.14 - d * 0.08 } }  // 喘息：轻微偏移
]

function pickOrbPattern() {
  const d = diffRatio()
  let sum = 0
  for (let i = 0; i < ORB_PATTERNS.length; i++) sum += Math.max(0, ORB_PATTERNS[i].w(d))
  let r = Math.random() * sum
  for (let i = 0; i < ORB_PATTERNS.length; i++) {
    r -= Math.max(0, ORB_PATTERNS[i].w(d))
    if (r <= 0) return ORB_PATTERNS[i]
  }
  return ORB_PATTERNS[0]
}

// ★ 节拍按**时间**算，不按距离：速度从 9 爬到 20，若按固定距离，越往后节奏越快一倍。
function orbGapUnits() {
  const j = 1 + rnd(-CFG.ORB_GAP_JIT, CFG.ORB_GAP_JIT)
  return Math.max(3.0, S.g.speed * CFG.ORB_GAP_SEC * j)
}

// 生成一串块，返回「下一串的起点 z」
function spawnOrbWave(z0) {
  const g = S.g
  const t = g.tunnel
  const p = pickOrbPattern()
  const flip = Math.random() < 0.5 ? 1 : -1     // 镜像：同一 pattern 也有左右两种走向
  const base = orbGapUnits()
  const gap = base * (p.gapScale || 1)          // ★ 跨度大的串给更长节拍（红线③）
  const jit = p.jitter || 0                     // ★ v6：位置随机抖动（只有单块/散布串带）
  const n = p.offs.length

  for (let i = 0; i < n; i++) {
    const z = z0 + i * gap
    const at = tunnelAt(z - t.scroll)
    const hw = Math.max(0.20, at.hw)
    let off = p.offs[i] * flip
    if (jit) off += (Math.random() * 2 - 1) * jit   // ★ 每次生成都不一样 → 不再永远贴在同一个距离
    off = clamp(off, -CFG.ORB_OFF_MAX, CFG.ORB_OFF_MAX)
    // 兜底：保证「中线附近没有块」（pattern 表的取值已避开这条，这里是防御性的）
    if (Math.abs(off) < CFG.ORB_OFF_MIN) off = (off < 0 ? -1 : 1) * CFG.ORB_OFF_MIN
    // ★★ v6 修 bug：块的世界坐标 = cx + off×hw，但中心线荡到一侧时，同侧贴边块会跑到
    //    飞船够不到的地方（cx=0.85、off=0.88、hw=0.66 → 1.43 > X_LIMIT 1.25，永远吃不到）。
    //    解法：块按「它这一侧还剩多少空间」自适应收敛半径 —— 弯道处块自然靠内，但至少吃得到。
    const maxOut = CFG.X_LIMIT - CFG.ORB_CATCH - CFG.ORB_R
    const room = off > 0 ? (maxOut - at.cx) : (maxOut + at.cx)
    const usable = clamp(Math.min(hw, room / Math.max(0.01, Math.abs(off))), 0.12, hw)
    g.orbs.push({
      zt: z, wx: at.cx + off * usable, off: off, gapScale: p.gapScale || 1,
      taken: false, pz: NaN, spin: Math.random() * Math.PI * 2
    })
  }
  // 串与串之间的喘息 —— 这点张弛就是 P1「张弛节拍」的雏形。
  // ★ 换向补偿（v6）：上一串收在左壁、这一串开头在右壁时，半个基拍不够**人**换向
  //   （飞船机动够，但"头从左边甩到右边"要时间）。跨中线就多给半个基拍。
  const firstOff = g.orbs.length >= n ? g.orbs[g.orbs.length - n].off : 0
  const prevOff = t.lastOrbOff || 0
  const cross = (prevOff > 0.2 && firstOff < -0.2) || (prevOff < -0.2 && firstOff > 0.2)
  t.lastOrbOff = g.orbs.length ? g.orbs[g.orbs.length - 1].off : 0
  // 跨中线时最坏跨度约 1.05 世界单位（≈45° 头摆），半个基拍根本甩不过来 → 给 1.4 倍
  t.lastCross = cross
  t.lastGapUnits = base * (cross ? 1.4 : 0.5)
  return z0 + n * gap + t.lastGapUnits
}

// 在隧道前方补足块（只在控制点已经铺好后调用，否则 tunnelAt 取不到正确的 cx/hw）
function refillOrbs() {
  if (!CFG.ORB_ON) return
  const t = S.g.tunnel
  // ★ 生成上限贴着**视野上限**（不是 TUN_FWD）：块一生成就应该在（或刚进）可视范围，
  //   否则它会先被 updateOrbs 的裁剪删掉，永远等不到进入视野那一刻。
  const limit = t.scroll + CFG.SHIP_Z + CFG.ORB_VIEW
  let guard = 0
  while (t.nextOrbZ < limit && guard++ < 24) t.nextOrbZ = spawnOrbWave(t.nextOrbZ)
}

function takeOrb(o) {
  const g = S.g
  o.taken = true
  g.combo++
  g.comboT = CFG.COMBO_SEC
  const mul = Math.min(g.combo, CFG.COMBO_CAP)
  // ★ v7：块分 = 基础 × 连击 × **居中倍率** —— 先把倍率攒起来再吃块，"兑现"才有意义
  const add = CFG.ORB_SCORE * mul * g.mult
  g.score += add
  g.took++
  g.comboPop = 1
  g.comboPopMul = g.mult
  g.comboPopTxt = '+' + Math.round(add) + (mul > 1 ? ' ×' + mul : '')
  g.orbFlash = 1
  g.offSum += Math.abs(o.off); g.offN++
  burst(o.wx, o.zt, C.orb, 9)
  sfxOrb(g.combo)
  try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* 平台不支持就静默 */ }
}

function updateOrbs(dt) {
  const g = S.g
  const t = g.tunnel
  const shipZt = t.scroll + CFG.SHIP_Z
  const catchX = CFG.SHIP_HW + CFG.ORB_R + CFG.ORB_CATCH

  // 连击计时：超时归零（错过**不**清零，见下）
  if (g.comboT > 0) {
    g.comboT -= dt
    if (g.comboT <= 0) { g.comboT = 0; g.combo = 0 }
  }
  if (g.comboPop > 0) g.comboPop = Math.max(0, g.comboPop - dt * 1.6)
  if (g.orbFlash > 0) g.orbFlash = Math.max(0, g.orbFlash - dt * 2.6)

  const keep = []
  for (let i = 0; i < g.orbs.length; i++) {
    const o = g.orbs[i]
    o.spin += dt * 2.2
    const dz = o.zt - shipZt

    // ★ 判定用「跨越飞船平面」而不是「落在窗口内」：
    //   高速时一帧能推进 0.46 世界单位，窗口式判定会漏检，跨越式永不漏。
    if (!o.taken && !isNaN(o.pz) && o.pz > 0 && dz <= 0) {
      if (Math.abs(g.wx - o.wx) < catchX) takeOrb(o)
      // ★ 没吃到**不清连击**：玩家可能是主动放弃（避开管壁），惩罚只留给蹭壁。
      //   对「舒缓」产品，惩罚要温和；连击断在撞墙上才合理。
      else g.miss++
    }
    o.pz = dz

    // ★ 裁剪：只砍「已被越过」的块（dz < -6）。**上界必须远大于可见纵深** ——
    //   串内后续的块天然生成在更远处，若拿可见上限当裁剪线会把它们立刻删掉，
    //   屏幕上就会出现周期性空窗（这正是 O15b 抓到的 bug）。
    if (dz > -6 && dz < CFG.ORB_VIEW + 40) keep.push(o)
  }
  g.orbs = keep
}

// ---------------------------------------------------------------- 粒子（P2）
// 池化 + 硬上限：长局内存不会无限爬升（超限丢最老的）
function burst(wx, zt, color, n) {
  const g = S.g
  for (let i = 0; i < n; i++) {
    if (g.parts.length >= CFG.P_MAX) g.parts.shift()
    g.parts.push({
      wx: wx, zt: zt,
      vx: rnd(-0.85, 0.85), vz: rnd(-0.6, 1.8),
      life: 1, decay: rnd(1.7, 3.1),
      color: color, r: rnd(0.018, 0.048)
    })
  }
}

function updateParts(dt) {
  const g = S.g
  const keep = []
  for (let i = 0; i < g.parts.length; i++) {
    const p = g.parts[i]
    p.wx += p.vx * dt
    p.zt += p.vz * dt
    p.vz *= (1 - dt * 1.6)
    p.life -= dt * p.decay
    if (p.life > 0) keep.push(p)
  }
  g.parts = keep
}

// ★ v7 居中连乘：核心状态推进
//   holding = 当前是否「算居中」（cent ≥ MULT_HOLD_CENT）
//     · holding  ：计时增长 → 倍率线性抬升；跨过整数档位时脉冲 + 上扬音
//     · 非 holding：**宽限期内冻结**（不清零、不增长）；超时才清零
//   ★ 宽限是「暂停计时」而不是「立刻归零」—— 因为块都刻意偏离中线（ORB_OFF_MIN=0.28），
//     若一离开就清零，吃任何块都会破倍率，P0 能量块会被这套机制废掉。
function updateMult(dt) {
  const g = S.g
  if (!CFG.MULT_ON) { g.mult = 1; return }
  if (g.cent >= CFG.MULT_HOLD_CENT) {
    g.multOut = 0
    g.multHold += dt
    const t01 = clamp(g.multHold / CFG.MULT_RAMP_SEC, 0, 1)
    g.mult = 1 + t01 * (CFG.MULT_MAX - 1)
    const tier = Math.floor(g.mult + 1e-6)
    if (tier > g.multTier) { g.multTier = tier; g.multPop = 1; sfxMultUp(tier) }
    if (g.mult > g.multBest) g.multBest = g.mult
  } else {
    g.multOut += dt
    if (g.multOut > CFG.MULT_GRACE_SEC) {
      if (g.mult > 1.02) { g.multLost = 1; sfxMultLost() }
      g.mult = 1; g.multHold = 0; g.multTier = 1
    }
  }
}

function updateWorld(dt) {
  const g = S.g
  const t = g.tunnel
  const now = Date.now()

  // 速度随难度爬升
  g.speed = lerp(CFG.SPEED_MIN, CFG.SPEED_MAX, diffRatio())

  // 世界推进
  t.scroll += g.speed * dt

  // 裁剪身后、补足身前（控制点数恒定，成本 O(1)）
  const pts = t.pts
  while (pts.length > 2 && (pts[0].zt - t.scroll) < -CFG.TUN_BACK) pts.shift()
  while (pts.length < 2 || (pts[pts.length - 1].zt - t.scroll) < CFG.TUN_FWD) pushTunnelPt()
  // ★ 必须在控制点补足**之后**再铺块：spawnOrbWave 要 tunnelAt() 取正确的 cx/hw
  refillOrbs()

  // 飞船平面处的隧道参数 → 判定
  const at = tunnelAt(CFG.SHIP_Z)
  const d = g.wx - at.cx                        // 有符号偏离
  const gap = at.hw - CFG.SHIP_HW               // 允许的最大偏离
  g.cent = clamp(1 - Math.abs(d) / Math.max(0.01, at.hw), 0, 1)
  g.centSum += g.cent; g.centN++

  // ★ v7 居中连乘：贴中线攒倍率，脱离超宽限清零（见 updateMult）
  updateMult(dt)

  if (Math.abs(d) > gap) {
    if (now > g.invulnUntil) {
      g.lives--
      g.hits++
      g.invulnUntil = now + CFG.INVULN_MS
      g.shake = 1
      g.flash = 1
      g.hitFlash = 1
      // ★ 蹭壁才断连击（错过块不断）—— 惩罚只留给"撞墙"，因为未吃到块
      //   很可能是玩家主动放弃（用放弃收益换安全），不该倒扣。
      g.combo = 0; g.comboT = 0
      // ★ v7 撞管壁 = 最硬的「脱离中线」→ 倍率**直接清零**（不给宽限，惩罚要干脆）
      if (g.mult > 1.02) { g.multLost = 1; sfxMultLost() }
      g.mult = 1; g.multHold = 0; g.multOut = 0; g.multTier = 1
      burst(at.cx + (d > 0 ? 1 : -1) * at.hw, t.scroll + CFG.SHIP_Z, C.bad, 7)
      sfxHit()
      if (g.lives <= 0) gameOver()
    }
    // 蹭壁：向管内轻推（不是硬传送，保留位置感）
    g.wx = clamp(at.cx + (d > 0 ? 1 : -1) * gap * 0.45, -CFG.X_LIMIT, CFG.X_LIMIT)
  }

  // 计分：存活 + 居中保底，**再乘居中倍率**（★ v7）
  // 倍率乘一切 → 「贴中线」从"没分"变成"让所有收益翻倍"——这是它唯一的、也足够强的价值。
  g.t += dt
  g.score += (g.speed * 0.5 + g.cent * CFG.ROOM_SCORE) * g.mult * dt
  // 显示分数缓动追真实分数：吃块时数字会"跳"一下，静态数字没有反馈感
  g.scoreShow += (g.score - g.scoreShow) * Math.min(1, dt * 8)

  // ★ v7 倍率动画衰减
  if (g.multPop > 0) g.multPop = Math.max(0, g.multPop - dt * 2.2)
  if (g.multLost > 0) g.multLost = Math.max(0, g.multLost - dt * 1.8)

  g.shake = Math.max(0, g.shake - dt * 3)
  g.flash = Math.max(0, g.flash - dt * 2.5)
  g.hitFlash = Math.max(0, g.hitFlash - dt * 2)
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
// ★ 保持屏幕常亮（2026-10-10 真机反馈：玩一会儿屏幕自动变暗/被系统息屏）。
//   小游戏里系统"自动锁屏/省电"会打断游戏 → 用官方 API 在**本局进行中**请求常亮。
//   策略：开局开、结算/退后台还原（不做全局常亮，免得挂着不动时白耗电）。
function setKeepScreen(on) {
  try { if (wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: !!on }) } catch (e) { /* 平台不支持就静默 */ }
}

function startRun() {
  const g = S.g
  g.wx = 0; g.tgt = 0; g.tilt = 0
  g.score = 0; g.lives = CFG.LIVES; g.invulnUntil = 0
  g.scoreShow = 0
  g.t = 0; g.speed = CFG.SPEED_MIN
  g.shake = 0; g.flash = 0; g.hitFlash = 0
  g.boostUntil = 0; g.boostCoolAt = 0; g.boosting = false
  g.hits = 0; g.cent = 1; g.centSum = 0; g.centN = 0
  g.mult = 1; g.multHold = 0; g.multOut = 0; g.multBest = 1
  g.multTier = 1; g.multPop = 0; g.multLost = 0
  g.comboPopMul = 1
  g.dead = false
  // P0/P2 状态复位
  g.orbs = []; g.parts = []
  g.combo = 0; g.comboT = 0; g.comboPop = 0; g.comboPopTxt = ''
  g.orbFlash = 0; g.took = 0; g.miss = 0
  g.offSum = 0; g.offN = 0
  g.pausedAt = 0; g.endedByUser = false
  initTunnel()
  S.neck = { left: 0, right: 0, activity: 0, side: 0 }
  ctl.f = 0; ctl.prev = 0; ctl.vel = 0; ctl.smooth = 0
  // 开局零点标定：玩家点"开始"时头基本处于中立位 → 用当前三个角做基准
  S.pose.nYaw = S.pose.yaw
  S.pose.nPitch = S.pose.pitch
  S.pose.nRoll = S.pose.roll
  S.pose.calibrated = true
  initStars()
  S.mode = 'play'
  setKeepScreen(true)     // 本局开始：请求屏幕常亮（防自动息屏打断）
  sfxStart()
}

function gameOver() {
  const g = S.g
  g.dead = true
  g.scoreShow = g.score        // 结算页显示真实分数，别停在缓动途中
  S.mode = 'over'
  setKeepScreen(false)         // 本局结束：还原系统息屏策略（不在结算页挂着常亮）
  if (g.score > g.best) {
    g.best = Math.round(g.score)
    try { wx.setStorageSync('bd_best', g.best) } catch (e) { /* ignore */ }
  }
  sfxOver()
}

// ★ 暂停：世界冻结（render 里跳过 updateWorld/Orbs/Parts），
//   但**姿态链路保持热**（stepDetect 照跑）→ 恢复时没有 400ms 的丢脸回中空窗。
function pauseRun() {
  if (S.mode !== 'play') return
  S.g.pausedAt = Date.now()
  // 冻结时把视觉冲击清掉，否则暂停层背后会一直闪
  S.g.shake = 0; S.g.flash = 0; S.g.hitFlash = 0
  S.mode = 'paused'
}

function resumeRun() {
  if (S.mode !== 'paused') return
  const g = S.g
  const dtms = Date.now() - (g.pausedAt || Date.now())
  // ★ 绝对时间戳全部平移 —— 否则暂停 30 秒回来，无敌时间（1.2s）和 Boost
  //   冷却（4s）都被暂停"偷走"了，玩家会莫名其妙吃到一次额外扣血。
  if (g.invulnUntil) g.invulnUntil += dtms
  if (g.boostUntil) g.boostUntil += dtms
  if (g.boostCoolAt) g.boostCoolAt += dtms
  if (S.det.latHit) S.det.latHit += dtms
  g.pausedAt = 0
  // 恢复瞬间重标零点：玩家多半趁暂停挪了坐姿/手机，沿用旧零点会立刻跑偏
  resetCtl()
  S.pose.nYaw = S.pose.yaw
  S.pose.nPitch = S.pose.pitch
  S.pose.nRoll = S.pose.roll
  S.mode = 'play'
}

// 主动结束本局（从暂停层进入）→ 走和死亡同一条结算路径，但换文案
function endByUser() {
  if (S.mode !== 'paused') return
  S.g.endedByUser = true
  gameOver()
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
    updateWorld(dt)     // 内部会 refillOrbs() 铺新块
    updateOrbs(dt)      // ★ 必须在 updateWorld 之后（依赖刚铺好的块）
    updateParts(dt)
    updateFx(dt)
    trackNeck()
  } else if (S.mode === 'paused') {
    // ★ 世界完全冻结：不推进 world / orbs / parts，也不消费输入 ——
    //   暂停层背后还在流动，玩家会以为没暂停成功。但姿态链路（下面 stepDetect）
    //   照常跑，这样恢复时没有 400ms 的"丢脸 → 输入回中"空窗。
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

  // 背景（深林：用两条纯色带模拟，不用真渐变以省性能）
  ctx.fillStyle = C.bg0
  ctx.fillRect(-20, -20, W + 40, H + 40)
  ctx.fillStyle = C.bg1
  ctx.fillRect(-20, -20, W + 40, L.horizon)

  drawStars()
  drawTunnel()
  drawOrbs()      // ★ 隧道之上、飞船之下：块是"管道内的漂浮物"
  drawStreaks()
  drawShip(dt)
  drawParts()     // ★ 粒子压在最上层：吃块的爆散要盖过飞船才醒目

  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (g.flash > 0.01) {
    ctx.fillStyle = 'rgba(226,75,74,' + (g.flash * 0.35) + ')'
    ctx.fillRect(0, 0, W, H)
  }
  // ★ 吃块脉冲：整屏极淡一层青光。刻意不用震屏 —— 震屏是"惩罚"语汇，
  //   而吃块是奖励；奖励用亮度，惩罚用抖动用红，两者不能混。
  if (g.orbFlash > 0.01) {
    ctx.fillStyle = 'rgba(255,209,102,' + (g.orbFlash * 0.10) + ')'
    ctx.fillRect(0, 0, W, H)
  }

  if (S.mode === 'boot') {
    drawBoot()
  } else {
    drawHud(now)
    if (S.mode === 'paused') drawPaused()
    if (S.mode === 'over') drawOver()
  }
}

// 背景星点 → 林间露珠（圆点取代方块，配合昆虫主题）
function drawStars() {
  const g = S.g
  for (let i = 0; i < g.stars.length; i++) {
    const s = g.stars[i]
    const r = s.l >= 5 ? 1.7 : (s.l >= 2 ? 1.2 : 0.8)
    const a = s.l >= 5 ? 0.80 : (s.l >= 2 ? 0.45 : 0.24)
    ctx.globalAlpha = a
    ctx.fillStyle = C.star
    ctx.beginPath(); ctx.arc(s.x * W, s.y * H, r, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

// 隧道渲染：近密远疏对数采样 → 左右管壁（连续光带）+ 横向肋条（从远到近渐亮）
// 肋条是速度感的主力：每根环向前冲过来，"在管道里钻"的代入感全靠它。
function tunnelSamples(n) {
  const out = []
  const zN = CFG.Z_NEAR, zF = CFG.Z_FAR
  const k = zF / zN
  for (let i = 0; i <= n; i++) {
    const z = zN * Math.pow(k, i / n)
    const at = tunnelAt(z)
    const c = project(at.cx, z)
    out.push({ x: c.x, y: c.y, hw: at.hw * c.s, hh: CFG.TUN_HH * c.s, z: z })
  }
  return out
}

function drawTunnel() {
  const g = S.g
  const hit = g.hitFlash || 0
  const boost = g.boosting

  // 地平线
  ctx.strokeStyle = 'rgba(111,168,124,0.20)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, L.horizon)
  ctx.lineTo(W, L.horizon)
  ctx.stroke()

  const ss = tunnelSamples(20)

  // ① 左右管壁：连续折线（先铺半透明粗线做辉光，再压一条细亮线）
  for (let side = -1; side <= 1; side += 2) {
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath()
      for (let i = 0; i < ss.length; i++) {
        const p = ss[i]
        const x = p.x + side * p.hw
        if (i === 0) ctx.moveTo(x, p.y); else ctx.lineTo(x, p.y)
      }
      if (pass === 0) {
        ctx.strokeStyle = 'rgba(78,138,94,' + (0.24 + hit * 0.55) + ')'
        ctx.lineWidth = 7
      } else {
        ctx.strokeStyle = hit > 0.02 ? 'rgba(255,157,138,0.95)'
          : (boost ? 'rgba(255,201,138,0.90)' : 'rgba(111,168,124,0.80)')
        ctx.lineWidth = 2
      }
      ctx.stroke()
    }
  }

  // ② 横向肋条（从远到近，越近越亮、越粗 → 强速度感）
  for (let i = ss.length - 1; i >= 0; i--) {
    const p = ss[i]
    const zn = clamp(1 - (p.z - CFG.Z_NEAR) / (CFG.Z_FAR - CFG.Z_NEAR), 0, 1)
    ctx.globalAlpha = 0.05 + zn * zn * 0.40
    ctx.strokeStyle = boost ? '#FFC98A' : '#6FA87C'
    ctx.lineWidth = zn > 0.72 ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(p.x - p.hw, p.y - p.hh); ctx.lineTo(p.x + p.hw, p.y - p.hh)
    ctx.moveTo(p.x - p.hw, p.y + p.hh); ctx.lineTo(p.x + p.hw, p.y + p.hh)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawStreaks() {
  const g = S.g
  const vis = (g.speed / CFG.SPEED_MAX) * (g.boosting ? CFG.BOOST_GAIN : 1)
  const cx = L.cx
  const cy = L.horizon + (L.shipY - L.horizon) * 0.15   // 消失点（向地平线收敛）
  const R = Math.hypot(W, H) * 0.6
  ctx.lineCap = 'round'
  for (let i = 0; i < g.streaks.length; i++) {
    const k = g.streaks[i]
    const r0 = k.r * R
    const len = (0.06 + vis * 0.16) * R
    const ca = Math.cos(k.ang), sa = Math.sin(k.ang)
    ctx.globalAlpha = clamp(0.10 + vis * 0.42, 0, 0.85)
    ctx.strokeStyle = g.boosting ? C.boost : C.speed
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(cx + ca * r0, cy + sa * r0)
    ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len))
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'
}

// 椭圆路径（4 段 bezier 自绘 —— 不依赖 ctx.ellipse，冒烟桩/低端机都安全）
function ellPath(cx, cy, rx, ry) {
  const K = 0.5522847498
  const ox = rx * K, oy = ry * K
  ctx.beginPath()
  ctx.moveTo(cx, cy - ry)
  ctx.bezierCurveTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy)
  ctx.bezierCurveTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry)
  ctx.bezierCurveTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy)
  ctx.bezierCurveTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry)
  ctx.closePath()
}

// ★ 翅膀开合量（模块级纯渲染状态，不参与玩法数值）
//   由**倍率**驱动（见 drawShip）：闭合 1°(0.017) ← 巡航态 → 全展 58°(1.012)
let wingOpen = 0.017
const WING_CLOSED = 0.017    // 收翅：仅留一条壳缝（≈1°）
const WING_FULL = 1.012      // 全展 58°

// ★ 尾迹 2.0（2026-10-10 重做）—— 金色鳞粉喷流
//   旧版是「三条等宽直线」，太硬、像三根棍子（Eric 真机反馈"太难看"）。
//   新版三件套：① 分层锥形主尾流（根部宽→尖端收细，透明度递减）
//              ② 正弦摆动（活物感，不是一根塑料棍）
//              ③ 程序化鳞粉闪烁点（相位错开 → 持续有新粉冒出）
//   ★ 全部由 now 驱动、无持久状态 → 冒烟可测、长局不涨内存（与粒子池 P_MAX 同理）。
function drawTrail(cx, cy, s, now, boosting) {
  const g = S.g
  const vis = (g.speed / CFG.SPEED_MAX) * (boosting ? CFG.BOOST_GAIN : 1)
  const multT = CFG.MULT_ON ? clamp((g.mult - 1) / (CFG.MULT_MAX - 1), 0, 1) : 0
  const len = s * (1.9 + vis * 3.0) * (0.90 + multT * 0.45)   // 充能越满 → 尾迹越长
  const y0 = cy + s * 0.58
  const col = boosting ? C.boost : C.trail
  const STEPS = 7

  // ① 主尾流：3 层锥形叠加（外层长而淡 → 内层短而浓）
  const LAYERS = [[1.00, 0.34, 0.26], [0.68, 0.22, 0.22], [0.38, 0.12, 0.18]]
  for (let li = 0; li < LAYERS.length; li++) {
    const hw0 = s * LAYERS[li][1]
    const lenL = len * LAYERS[li][0]
    ctx.globalAlpha = LAYERS[li][2]
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.moveTo(cx - hw0, y0)
    for (let i = 1; i <= STEPS; i++) {            // 右半边
      const t = i / STEPS
      const hw = hw0 * (1 - t) * (1 - t)          // 平方收细 → 火焰感
      const sw = Math.sin(now / 110 + t * 3.4 + li * 2.1) * s * 0.11 * t
      ctx.lineTo(cx + hw + sw, y0 + lenL * t)
    }
    for (let i = STEPS; i >= 1; i--) {            // 左半边（回到根部）
      const t = i / STEPS
      const hw = hw0 * (1 - t) * (1 - t)
      const sw = Math.sin(now / 110 + t * 3.4 + li * 2.1) * s * 0.11 * t
      ctx.lineTo(cx - hw + sw, y0 + lenL * t)
    }
    ctx.closePath()
    ctx.fill()
  }
  // ② 鳞粉闪烁点
  const MOTES = 6
  for (let i = 0; i < MOTES; i++) {
    const t = (now / 620 + i / MOTES) % 1
    const ox = Math.sin(now / 170 + i * 2.7) * (s * 0.40 * t)
    const r = Math.max(0.6, s * 0.06 * (1 - t))
    ctx.globalAlpha = (1 - t) * (0.50 + vis * 0.28)
    ctx.fillStyle = C.trail
    ctx.beginPath(); ctx.arc(cx + ox, y0 + len * t, r, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawShip(dt) {
  const g = S.g
  const p = project(g.wx, CFG.SHIP_Z)
  const s = clamp(Math.min(W, H) * 0.045, 14, 34)
  const now = Date.now()
  const invuln = now < g.invulnUntil
  const blink = invuln && (Math.floor(now / 110) % 2 === 0)

  // ---- 翅膀开合：由**倍率**驱动（2026-10-10 Eric 真机反馈后改）----
  //   ★ 改版理由：上一版常态就张 14°、只有 Boost 才全张 → 玩家"没看到它展开翅膀"。
  //   新版：平时巡航 = 鞘翅**闭合**（收翅飞）；贴中线攒倍率 ≥ WING_OPEN_MULT 后随充能
  //   逐渐张开；满倍率 = 全展 58°。Boost 只做**叠加**（再猛张一点），不夺走倍率的表达权。
  const wingT = CFG.MULT_ON
    ? clamp((g.mult - CFG.WING_OPEN_MULT) / (CFG.MULT_MAX - CFG.WING_OPEN_MULT), 0, 1)
    : 0
  const openTgt = WING_CLOSED + wingT * (WING_FULL - WING_CLOSED) + (g.boosting ? 0.18 : 0)
  const openStep = (openTgt > wingOpen ? 1 / 0.22 : 1 / 0.45) * (dt || 0.016)  // 展开快 / 收回慢
  wingOpen += clamp(openTgt - wingOpen, -openStep, openStep)

  // 尾迹：金色鳞粉喷流（见 drawTrail）
  drawTrail(p.x, p.y, s, now, g.boosting)


  // ★ v7 倍率光球 —— 让「保持居中」这件事第一次**可见**。
  //   半径 / 亮度 / 颜色 ∝ 倍率，满档金光 = 成就信号。这是"居中连乘"唯一的可视载体，
  //   没有它玩家只会看到一个凭空变大的分数（验证阶段先做简单标记，特效样式后置）。
  if (CFG.MULT_ON && g.mult > 1.02) {
    const t01 = clamp((g.mult - 1) / (CFG.MULT_MAX - 1), 0, 1)
    const cy = p.y - s * 0.10
    const rr = s * (1.30 + t01 * 1.30) * (1 + g.multPop * 0.30)
    ctx.strokeStyle = multColor(g.mult)
    ctx.globalAlpha = 0.20 + t01 * 0.55
    ctx.lineWidth = s * (0.09 + t01 * 0.13)
    ctx.beginPath(); ctx.arc(p.x, cy, rr, 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 0.08 + t01 * 0.24
    ctx.lineWidth = s * (0.24 + t01 * 0.30)
    ctx.beginPath(); ctx.arc(p.x, cy, rr * 0.80, 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 1
  }
  // ★ v7 破倍率：光环碎散（红色扩散环）—— "啊，攒的倍率没了"
  if (g.multLost > 0) {
    const cy = p.y - s * 0.10
    ctx.strokeStyle = C.bad
    ctx.globalAlpha = g.multLost * 0.65
    ctx.lineWidth = s * 0.18 * g.multLost
    ctx.beginPath(); ctx.arc(p.x, cy, s * (1.6 + (1 - g.multLost) * 2.4), 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ★ 充能光晕：与**翅膀张开同步**出现（Eric："翅膀展开，同时有光晕"）。
  //   刻意用暖金（C.boost）—— 与倍率环的冷青区分：冷环 = 精准度读数，暖晕 = 能量充盈感。
  //   同心圆叠加，不用 shadowBlur（Canvas 上极贵）。
  if (wingT > 0.01 && !blink) {
    const gy = p.y - s * 0.05
    const pulse = 1 + Math.sin(now / 320) * 0.06 + g.multPop * 0.35
    ctx.fillStyle = C.boost
    ctx.globalAlpha = wingT * (0.10 + g.multPop * 0.16)
    ctx.beginPath(); ctx.arc(p.x, gy, s * 2.15 * pulse, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = wingT * (0.14 + g.multPop * 0.20)
    ctx.beginPath(); ctx.arc(p.x, gy, s * 1.35 * pulse, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1
  }

  if (blink) return

  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(g.tilt)          // 转向侧倾：把 roll 输入可视化（"看得见自己脖子转了多少"）

  // ---- ① 膜翅（后翅）：半透明薄膜，才是真动力（仅在鞘翅张开后可见）----
  // ★ "急扇"不能按真实频率画：真甲虫 20~40Hz，60fps 每帧不到半周期 → 只会采样混叠成闪烁。
  //   正解 = 低频真实摆动；Boost 同时画 3 个不同角度的低透明膜翅叠加（残影暗示高频）。
  const wf = clamp((wingOpen - WING_CLOSED) / (WING_FULL - WING_CLOSED), 0, 1)  // 0 闭合 → 1 全展
  if (wf > 0.02) {
    const fan = Math.sin(now / 1000 * Math.PI * 2 * 3.4) * 0.28
    for (let side = -1; side <= 1; side += 2) {
      const span = side * (0.52 + wingOpen * 0.62)
      const ghosts = g.boosting ? [0, 0.20, 0.38] : [0]
      for (let gi = 0; gi < ghosts.length; gi++) {
        ctx.save()
        ctx.translate(side * s * 0.12, -s * 0.40)
        ctx.rotate(span + side * ghosts[gi] + (gi === 0 ? side * fan : 0))
        ctx.globalAlpha = ((gi === 0 ? 0.22 : (gi === 1 ? 0.10 : 0.06)) + (g.boosting ? 0.04 : 0)) * wf
        ctx.fillStyle = C.wing
        ellPath(0, s * 0.66, s * 0.24, s * 0.72)
        ctx.fill()
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1
  }

  // ---- ② 六足：飞行时收拢贴体（更写实，也更省绘制）----
  //   画在鞘翅之下，只露出足尖 —— 真甲虫飞行时六足就是这样收着的。
  ctx.strokeStyle = C.leg
  ctx.lineWidth = Math.max(1, s * 0.06)
  ctx.lineCap = 'round'
  const legs = [[-0.50, -0.18, -0.86, -0.06], [0.50, -0.18, 0.86, -0.06],
                [-0.56, 0.30, -0.92, 0.46], [0.56, 0.30, 0.92, 0.46],
                [-0.46, 0.82, -0.72, 1.02], [0.46, 0.82, 0.72, 1.02]]
  for (let i = 0; i < legs.length; i++) {
    const q = legs[i]
    ctx.beginPath()
    ctx.moveTo(q[0] * s, q[1] * s)
    ctx.lineTo(q[2] * s, q[3] * s)
    ctx.stroke()
  }
  ctx.lineCap = 'butt'

  // ---- ③ 鞘翅（前翅）：不透明硬壳，飞行时上张 ----
  //   ★ 绕"肩部铰链"转（非自身中心）—— 真动作是三维的，2D 俯视用"绕肩旋转=开壳"作视觉约定。
  for (let side = -1; side <= 1; side += 2) {
    ctx.save()
    ctx.translate(side * s * 0.12, -s * 0.40)      // 肩部铰链
    ctx.rotate(side * wingOpen)                    // 开壳
    ellPath(side * s * 0.30, s * 0.62, s * 0.58, s * 0.94)
    ctx.fillStyle = C.ship
    ctx.fill()
    // ★ 轮廓光：1px 冷白描边 —— 把绿虫从绿底上撕开（写实分离的必做项，成本极低效果最直接）
    ctx.globalAlpha = 0.58
    ctx.strokeStyle = C.rim
    ctx.lineWidth = 1
    ctx.stroke()
    // 壳面高光：光源正上方偏左 15° → 窄条实色（不用模糊）
    ctx.globalAlpha = 0.50
    ctx.strokeStyle = C.shipLite
    ctx.lineWidth = Math.max(1, s * 0.10)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(side * s * 0.08, 0)
    ctx.lineTo(side * s * 0.26, s * 0.66)
    ctx.stroke()
    ctx.lineCap = 'butt'
    ctx.globalAlpha = 1
    ctx.restore()
  }

  // ---- ④ 鞘翅中缝：天然对称轴（与"贴中线"同构，可当对准辅助线）----
  if (wingOpen < 0.55) {
    ctx.strokeStyle = C.shipDark
    ctx.globalAlpha = clamp(1 - wingOpen / 0.55, 0, 1) * 0.9
    ctx.lineWidth = Math.max(1, s * 0.06)
    ctx.beginPath()
    ctx.moveTo(0, -s * 0.32)
    ctx.lineTo(0, s * 1.04)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ---- ⑤ 腹部（Boost 张开后露出 + 节纹）----
  if (wingOpen > 0.60) {
    ctx.globalAlpha = clamp((wingOpen - 0.60) / 0.41, 0, 1)
    ctx.fillStyle = C.shipDark
    ellPath(0, s * 0.56, s * 0.40, s * 0.54)
    ctx.fill()
    ctx.strokeStyle = C.leg
    ctx.lineWidth = 1
    for (let k = 0; k < 3; k++) {
      const yy = s * (0.38 + k * 0.20)
      ctx.beginPath(); ctx.moveTo(-s * 0.32, yy); ctx.lineTo(s * 0.32, yy); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // ---- ⑥ 前胸背板（pronotum）----
  ctx.fillStyle = C.pronotum
  ctx.beginPath()
  ctx.moveTo(-s * 0.50, -s * 0.40)
  ctx.lineTo(-s * 0.32, -s * 0.90)
  ctx.lineTo(s * 0.32, -s * 0.90)
  ctx.lineTo(s * 0.50, -s * 0.40)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = C.rim
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1

  // ---- ⑦ 头部 + 鳃叶触角（金龟子科的标志：小尺寸靠"椭圆身+中缝+触角"认虫）----
  ctx.fillStyle = C.headC
  ellPath(0, -s * 0.92, s * 0.30, s * 0.24)
  ctx.fill()
  const asway = Math.sin(now / 620) * s * 0.06   // ★ 触角微摆：收翅巡航时也"是活的"，不是一张贴纸
  for (let side = -1; side <= 1; side += 2) {
    ctx.strokeStyle = C.antenna
    ctx.lineWidth = Math.max(1, s * 0.06)
    ctx.beginPath()
    ctx.moveTo(side * s * 0.20, -s * 1.00)
    ctx.lineTo(side * s * 0.56, -s * 1.30 + asway)
    ctx.stroke()
    // 鳃叶：末端 3 片小叶扇形排开
    ctx.fillStyle = C.antenna
    for (let k = -1; k <= 1; k++) {
      ellPath(side * s * (0.58 + k * 0.05), -s * (1.34 + Math.abs(k) * 0.06) + asway, s * 0.085, s * 0.13)
      ctx.fill()
    }
  }

  // Boost 光晕（尾部）：同心圆叠加，不用 shadowBlur
  if (g.boosting) {
    ctx.fillStyle = C.boost
    ctx.globalAlpha = 0.15
    ctx.beginPath(); ctx.arc(0, s * 1.0, s * 1.05, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.22
    ctx.beginPath(); ctx.arc(0, s * 1.0, s * 0.70, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

// 能量块渲染：远→近（画家算法）。旋转菱形 + 内核 + 呼吸光晕。
// 呼吸脉冲不是装饰 —— 静态几何图形在第一版里几乎抓不住注意力；
// 让块自己"跳"起来，玩家才会主动去找下一个该往哪歪。
function drawOrbs() {
  const g = S.g
  const t = g.tunnel
  if (!g.orbs.length) return
  const order = g.orbs.slice().sort(function (a, b) { return b.zt - a.zt })
  const now = Date.now()
  for (let i = 0; i < order.length; i++) {
    const o = order[i]
    if (o.taken) continue
    const zr = o.zt - t.scroll
    if (zr < 4.5 || zr > CFG.Z_FAR) continue
    const c = project(o.wx, zr)
    const R = Math.max(1.6, CFG.ORB_R * c.s)
    // 空气透视：越远越淡
    const a = clamp(0.32 + (1 - (zr - 4.5) / (CFG.Z_FAR - 4.5)) * 0.68, 0.32, 1)
    const pulse = 0.84 + 0.16 * Math.sin(now / 210 + o.spin)

    // 光晕：同心圆叠加（禁 shadowBlur —— Canvas 上极贵，低端机会掉帧）
    ctx.globalAlpha = a * 0.30
    ctx.fillStyle = C.orbGlow
    ctx.beginPath(); ctx.arc(c.x, c.y, R * 2.3 * pulse, 0, Math.PI * 2); ctx.fill()

    ctx.globalAlpha = a
    // 花粉球体
    ctx.fillStyle = C.orb
    ctx.beginPath(); ctx.arc(c.x, c.y, R * 1.05, 0, Math.PI * 2); ctx.fill()
    // 亮核
    ctx.fillStyle = C.orbCore
    ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(0.8, R * 0.42), 0, Math.PI * 2); ctx.fill()
    // 花粉粒质感：左上一个淡凹点
    ctx.globalAlpha = a * 0.35
    ctx.fillStyle = C.orbGlow
    ctx.beginPath(); ctx.arc(c.x - R * 0.30, c.y + R * 0.30, Math.max(0.5, R * 0.24), 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawParts() {
  const g = S.g
  const t = g.tunnel
  for (let i = 0; i < g.parts.length; i++) {
    const p = g.parts[i]
    const zr = p.zt - t.scroll
    if (zr < 2 || zr > CFG.Z_FAR) continue
    const c = project(p.wx, zr)
    const R = Math.max(0.7, p.r * c.s)
    ctx.globalAlpha = clamp(p.life, 0, 1) * 0.95
    ctx.fillStyle = p.color
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

// 吃到块的弹出文字（+30 ×3）：出现在画面中上部，一出现最大、然后缩小淡出
function drawComboPop() {
  const g = S.g
  if (g.comboPop <= 0.01 || !g.comboPopTxt) return
  const u = Math.min(W, H)
  const k = g.comboPop
  const scale = 1 + k * 0.5
  const alpha = clamp(k * 2.6, 0, 1)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.globalAlpha = alpha
  ctx.translate(W / 2, H * 0.26)
  ctx.scale(scale, scale)
  // ★ v7 弹出文字的"来源色"：被高倍率放大的块 → 金色（"这分是攒倍率挣来的"），
  //   让玩家把「攒倍率」和「吃块得分」在因果上连起来，而不是两个孤立的数字。
  ctx.fillStyle = g.comboPopMul > 1.5 ? C.orbCore : C.orb
  ctx.font = 'bold ' + Math.round(u * 0.052) + 'px sans-serif'
  ctx.fillText(g.comboPopTxt, 0, 0)
  ctx.restore()
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
}

function inRect(r, x, y) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

// 暂停图标：两条竖杠（手绘，不依赖字体里有没有 ⏸）
function drawPauseIcon(x, y, w, h) {
  ctx.fillStyle = 'rgba(14,26,18,0.85)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = C.line; ctx.lineWidth = 1
  ctx.strokeRect(x, y, w, h)
  ctx.fillStyle = C.fg
  const bw = Math.max(2, Math.round(w * 0.11))
  const bh = Math.round(h * 0.46)
  const by = y + (h - bh) / 2
  ctx.fillRect(x + w * 0.35 - bw / 2, by, bw, bh)
  ctx.fillRect(x + w * 0.65 - bw / 2, by, bw, bh)
}

function drawPaused() {
  const g = S.g
  const cx = W / 2
  const u = Math.min(W, H)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(8,18,12,0.88)'
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = C.accent
  ctx.font = 'bold ' + Math.round(u * 0.062) + 'px sans-serif'
  ctx.fillText('已暂停', cx, H * 0.28)

  ctx.fillStyle = C.fg
  ctx.font = Math.round(u * 0.048) + 'px sans-serif'
  ctx.fillText(fmtScore(g.score) + ' 分', cx, H * 0.35)

  const nk = S.neck
  const bal = (nk.left + nk.right > 0)
    ? Math.round(Math.min(nk.left, nk.right) / Math.max(nk.left, nk.right) * 100) : 100
  const cen = g.centN > 0 ? Math.round(g.centSum / g.centN * 100) : 100
  const off = g.offN > 0 ? Math.round(g.offSum / g.offN * 100) : 0

  ctx.font = Math.round(u * 0.032) + 'px sans-serif'
  ctx.fillStyle = C.ok
  ctx.fillText('颈椎活动 ' + nk.activity + ' 次 · 左 ' + nk.left + ' 右 ' + nk.right + ' · 平衡 ' + bal + '%', cx, H * 0.415)
  ctx.fillStyle = C.orb
  ctx.fillText('花粉球 ' + g.took + ' 个 · 平均离中线 ' + off + '%', cx, H * 0.455)
  ctx.fillStyle = C.dim
  ctx.fillText('蹭壁 ' + g.hits + ' 次 · 平均居中 ' + cen + '%', cx, H * 0.495)

  const bw = Math.min(W * 0.36, u * 0.44)
  const bh = Math.max(36, Math.round(u * 0.082))
  const by = H * 0.575
  const gap = W * 0.05
  S.btn.pui = [
    { act: 'resume', x: cx - gap / 2 - bw, y: by, w: bw, h: bh, t: '继续', col: C.accent },
    { act: 'end',    x: cx + gap / 2, y: by, w: bw, h: bh, t: '结束本节', col: C.warn }
  ]
  for (let i = 0; i < S.btn.pui.length; i++) {
    const b = S.btn.pui[i]
    ctx.fillStyle = 'rgba(14,26,18,0.92)'
    ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.strokeStyle = b.col; ctx.lineWidth = 1.5
    ctx.strokeRect(b.x, b.y, b.w, b.h)
    ctx.fillStyle = b.col
    ctx.font = Math.round(u * 0.036) + 'px sans-serif'
    ctx.fillText(b.t, b.x + b.w / 2, b.y + b.h / 2 + u * 0.014)
  }

  const swY = by + bh + u * 0.055
  ctx.fillStyle = CFG.AUDIO_ON ? C.ok : C.dim
  ctx.font = Math.round(u * 0.028) + 'px sans-serif'
  // 诊断：创建失败时把原因带出来（"接口缺失"/"创建失败"），方便真机上定位
  const aTxt = CFG.AUDIO_ON
    ? ('音效:开' + (S.audio === 'off' ? '（不可用·' + (audioWhy || '未知') + '）' : ''))
    : '音效:关'
  ctx.fillText(aTxt, cx, swY)
  S.btn.aSW = { x: cx - u * 0.17, y: swY - u * 0.034, w: u * 0.34, h: u * 0.058 }

  ctx.fillStyle = 'rgba(127,154,134,0.65)'
  ctx.font = Math.round(u * 0.024) + 'px sans-serif'
  ctx.fillText('随时可以歇一歇 —— 脖子放松一下', cx, H * 0.89)
  ctx.textAlign = 'left'
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
  ctx.fillStyle = 'rgba(8,18,12,0.58)'
  ctx.fillRect(0, 0, W, L.top + fs * 1.2)

  ctx.textAlign = 'left'
  ctx.fillStyle = C.fg
  ctx.font = 'bold ' + fsBig + 'px sans-serif'
  const scoreTxt = fmtScore(g.scoreShow)
  ctx.fillText(scoreTxt, pad, L.top)

  // 连击：紧跟分数后面（combo ≤ 1 不画，避免"×1"这种噪音）
  if (g.combo > 1) {
    const sw = ctx.measureText(scoreTxt).width
    ctx.fillStyle = C.orb
    ctx.font = 'bold ' + Math.round(fs * 0.92) + 'px sans-serif'
    ctx.fillText('×' + Math.min(g.combo, CFG.COMBO_CAP), pad + sw + 6, L.top - fs * 0.18)
  }

  // ★ 暂停按钮（顶部正中：避让左上的分数/连击与右上方的生命·速度条）
  S.btn.pause = null
  if (S.mode === 'play') {
    const pb = Math.max(26, Math.round(fs * 1.9))
    const px = Math.round(W / 2 - pb / 2)
    const py = Math.round((L.top + fs * 1.2) / 2 - pb / 2)
    S.btn.pause = { x: px, y: py, w: pb, h: pb }
    drawPauseIcon(px, py, pb, pb)
  }

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
  const line2 = '脖动 ' + nk.activity + ' · 平衡 ' + bal + '%'
  ctx.fillText(line2, pad, L.top + fs * 1.5)
  // ★ v7 倍率：代替原来的「居中 XX%」—— 倍率是居中的**结果量**，玩家关心结果，不关心中间量
  if (CFG.MULT_ON && g.mult > 1.02) {
    const w2 = ctx.measureText(line2).width
    ctx.fillStyle = multColor(g.mult)
    ctx.font = 'bold ' + fs + 'px sans-serif'
    ctx.fillText('  · 倍率 ×' + g.mult.toFixed(1), pad + w2, L.top + fs * 1.5)
  }

  // 速度条（顶部右侧）
  const bw = W * 0.30
  const bx = W - pad - bw
  const by = L.top + fs * 0.9
  ctx.fillStyle = 'rgba(34,64,44,0.9)'
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
  ctx.fillStyle = 'rgba(127,154,134,0.9)'
  const p = S.pose
  const dbg = '渲染' + S.perf.renderFps + '/s · 取帧' + S.fr.fps + '/s · 检' + S.det.fps + '/s'
  ctx.fillText(dbg, pad, H - L.pad - fs * 0.1)
  // 第二行：当前主控轴 + 实时读数（**带正负号** —— 真机判"左右是否反了"就靠它）
  const m = ctrlMode()
  const base = m.axis === 'roll' ? (p.roll - p.nRoll) : (p.yaw - p.nYaw)
  const pv = p.pitch - p.nPitch
  const sg = function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2) }
  const dbg2 = '源:' + S.srcActive + ' · ' + (m.axis === 'roll' ? '歪头' : '转头') + sg(base) +
    ' pitch' + sg(pv) + ' · 脸' + (now - S.det.latHit < 800 ? '有' : '无')
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
    ctx.fillStyle = 'rgba(127,217,138,0.35)'
    ctx.beginPath()
    ctx.arc(W - L.pad - 6, H - L.pad - 30, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(127,154,134,0.55)'
    ctx.font = Math.max(8, fs * 0.7) + 'px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText('传感器·本机处理', W - L.pad, H - L.pad - 36)
    ctx.textAlign = 'left'
  }

  // 底部四按钮：控制模式 / 幅度 / 输入源 / 相机可见性
  const NBTN = 4
  const bh = Math.max(26, Math.round(fs * 1.8))
  const gapB = 6
  const bwid = (W - L.pad * 2 - gapB * (NBTN - 1)) / NBTN
  const btnY = H - L.pad - bh
  S.btn.y = btnY; S.btn.h = bh; S.btn.w = bwid
  S.btn.xs = []
  for (let i = 0; i < NBTN; i++) S.btn.xs.push(L.pad + (bwid + gapB) * i)
  const labels = [
    { i: 0, t: '控制:' + ctrlMode().short, col: C.accent },
    { i: 1, t: '幅度:' + curRange().label, col: C.accent },
    { i: 2, t: '输入源:' + srcLabel(), col: S.srcActive === 'visionkit' ? C.ok : C.warn },
    { i: 3, t: S.camVisible ? '相机:可见' : '相机:隐藏', col: C.dim }
  ]
  for (let i = 0; i < labels.length; i++) {
    const b = labels[i]
    const x = S.btn.xs[b.i]
    ctx.fillStyle = 'rgba(14,26,18,0.85)'
    ctx.fillRect(x, btnY, bwid, bh)
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    ctx.strokeRect(x, btnY, bwid, bh)
    ctx.fillStyle = b.col
    ctx.font = Math.max(8, Math.round(fs * 0.66)) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(b.t, x + bwid / 2, btnY + bh / 2 + fs * 0.28)
  }
  ctx.textAlign = 'left'

  // 弹出反馈放最后画：不被 HUD 其它元素盖住
  drawComboPop()
}

// 命中第几个底部按钮（-1 = 没中）
function hitBtn(tx) {
  const xs = S.btn.xs || []
  for (let i = 0; i < xs.length; i++) {
    if (tx >= xs[i] - 2 && tx <= xs[i] + S.btn.w + 2) return i
  }
  return -1
}

function srcLabel() {
  if (S.srcKind === 'auto') return '自动'
  return S.srcKind === 'gyro' ? '陀螺仪' : '触摸'
}

function saveCtrl() { try { wx.setStorageSync('bd_ctrl', S.ctrlIdx) } catch (e) { /* ignore */ } }
function saveRange() { try { wx.setStorageSync('bd_range', S.rangeIdx) } catch (e) { /* ignore */ } }

function drawBoot() {
  const cx = W / 2
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(8,18,12,0.75)'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = C.accent
  ctx.font = 'bold ' + Math.round(Math.min(W, H) * 0.075) + 'px sans-serif'
  ctx.fillText('脖动圈', cx, H * 0.40)
  ctx.fillStyle = C.fg
  ctx.font = Math.round(Math.min(W, H) * 0.036) + 'px sans-serif'
  ctx.fillText('歪头即转向 · 穿越草茎', cx, H * 0.46)

  ctx.fillStyle = C.dim
  ctx.font = Math.round(Math.min(W, H) * 0.030) + 'px sans-serif'
  let tip = '点屏幕开始'
  if (!S.hasCam || !S.hasVK) tip = '摄像头不可用 · 点屏幕用触摸开始'
  ctx.fillText(tip, cx, H * 0.56)
  ctx.fillText('坐直、手机立起来，正对屏幕', cx, H * 0.60)
  ctx.fillText('头向左右肩歪 → 金龟子左右移动', cx, H * 0.645)
  // ★ v7 玩法引导：把「居中 = 攒倍率」这条新规则讲清楚（旧文案"贴中线没分"已失效）
  ctx.fillStyle = '#DCFAF0'
  ctx.fillText('贴中线稳住 → 攒倍率（最高 ×5）', cx, H * 0.685)
  ctx.fillStyle = C.orb
  ctx.fillText('去够金色花粉球 · 得分被倍率放大', cx, H * 0.72)

  if (S.err) {
    ctx.fillStyle = C.bad
    ctx.font = Math.round(Math.min(W, H) * 0.026) + 'px sans-serif'
    ctx.fillText(S.err.slice(0, 40), cx, H * 0.765)
  }
  ctx.textAlign = 'left'
}

function drawOver() {
  const cx = W / 2
  const g = S.g
  const u = Math.min(W, H)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(8,18,12,0.80)'
  ctx.fillRect(0, 0, W, H)

  // 主动收工 ≠ 撞光血量：文案和颜色都要分开，否则"想歇了就停"会被当成失败
  const byUser = g.endedByUser
  ctx.fillStyle = byUser ? C.accent : C.bad
  ctx.font = 'bold ' + Math.round(u * 0.062) + 'px sans-serif'
  ctx.fillText(byUser ? '本节完成' : '本局结束', cx, H * 0.34)

  ctx.fillStyle = C.fg
  ctx.font = Math.round(u * 0.052) + 'px sans-serif'
  ctx.fillText(fmtScore(g.score) + ' 分', cx, H * 0.42)

  ctx.fillStyle = C.dim
  ctx.font = Math.round(u * 0.032) + 'px sans-serif'
  ctx.fillText('最高 ' + fmtScore(g.best), cx, H * 0.47)

  const nk = S.neck
  const bal = (nk.left + nk.right > 0)
    ? Math.round(Math.min(nk.left, nk.right) / Math.max(nk.left, nk.right) * 100) : 100
  ctx.fillStyle = C.ok
  ctx.fillText('本局活动颈椎 ' + nk.activity + ' 次', cx, H * 0.53)
  ctx.fillStyle = C.dim
  ctx.fillText('左 ' + nk.left + ' · 右 ' + nk.right + '（平衡 ' + bal + '%）', cx, H * 0.572)

  // ★ 这一行是本版存在的理由：把"你到底把脖子动了多远"量化出来
  const off = g.offN > 0 ? Math.round(g.offSum / g.offN * 100) : 0
  ctx.fillStyle = C.orb
  ctx.fillText('花粉球 ' + g.took + ' 个 · 平均离中线 ' + off + '%', cx, H * 0.614)

  const cen = g.centN > 0 ? Math.round(g.centSum / g.centN * 100) : 100
  ctx.fillStyle = C.warn
  ctx.fillText('蹭壁 ' + g.hits + ' 次 · 平均居中 ' + cen + '%', cx, H * 0.656)

  // ★ v7 居中连乘：最高倍率 = "你稳住了多久"的量化证明（避免倍率只是局内的瞬时感受）
  if (CFG.MULT_ON && g.multBest > 1.05) {
    ctx.fillStyle = multColor(g.multBest)
    ctx.fillText('最高倍率 ×' + g.multBest.toFixed(1), cx, H * 0.698)
  }

  ctx.fillStyle = C.accent
  ctx.font = Math.round(u * 0.036) + 'px sans-serif'
  ctx.fillText('点屏幕再来一局', cx, H * 0.755)
  ctx.textAlign = 'left'
}

// 命中暂停层里的控件
function hitUI(x, y) {
  const l = S.btn.pui || []
  for (let i = 0; i < l.length; i++) if (inRect(l[i], x, y)) return l[i].act
  if (inRect(S.btn.aSW, x, y)) return 'audio'
  return ''
}

function toggleAudio() {
  CFG.AUDIO_ON = !CFG.AUDIO_ON
  try { wx.setStorageSync('bd_audio', CFG.AUDIO_ON ? 1 : 0) } catch (e) { /* ignore */ }
  if (CFG.AUDIO_ON) {
    if (AC === false) { AC = null; unlocked = false }  // 之前创建失败过 → 重置后重试
    unlockAudio()                                      // ★ 在手势内激活（用户点了开关）
    tone(660, 0.10, 'triangle', 0.14)                  // 立刻给个确认音，否则用户不知道开没开
  }
}

// ---------------------------------------------------------------- 输入
wx.onTouchStart(function (e) {
  const t = (e.touches && e.touches[0]) || e.changedTouches && e.changedTouches[0]
  if (!t) return
  const tx = t.clientX, ty = t.clientY

  // ★ iOS 上 WebAudio 必须由用户手势唤醒 → 每次触摸补一次 resume（幂等）
  unlockAudio()

  // ① 暂停层：吃掉全部输入，避免误触底下的按钮
  if (S.mode === 'paused') {
    const act = hitUI(tx, ty)
    if (act === 'resume') resumeRun()
    else if (act === 'end') endByUser()
    else if (act === 'audio') toggleAudio()
    return
  }

  // ② 暂停按钮（只在游玩中生效）
  if (S.mode === 'play' && inRect(S.btn.pause, tx, ty)) { pauseRun(); return }

  // ③ 底部四按钮
  if (ty >= S.btn.y - 8 && ty <= S.btn.y + S.btn.h + 8) {
    const bi = hitBtn(tx)
    if (bi === 0) {
      // 切换控制模式：歪头·位置 → 歪头·位置反 → 歪头·速度 → 转头·位置
      S.ctrlIdx = (S.ctrlIdx + 1) % CTRL_MODES.length
      saveCtrl()
      resetCtl()
      return
    }
    if (bi === 1) {
      // 切换「幅度」档：紧凑(20°) → 标准(25°) → 舒展(36°)
      S.rangeIdx = (S.rangeIdx + 1) % RANGES.length
      saveRange()
      resetCtl()
      return
    }
    if (bi === 2) { switchSource(); return }
    if (bi === 3) {
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

// ★ 屏幕常亮：退到后台就还原；回前台若仍在本局（play/paused）再补一次
//   —— 系统切后台时可能重置该项，不补会出现"玩到一半又开始变暗"。
if (wx.onHide) wx.onHide(function () { setKeepScreen(false) })
if (wx.onShow) wx.onShow(function () {
  if (S.mode === 'play' || S.mode === 'paused') setKeepScreen(true)
})

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
