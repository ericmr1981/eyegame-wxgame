#!/usr/bin/env bash
# ============================================================================
# smoke/contrast.sh — 对照实验：故意改坏代码，确认断言真的有区分力
# ============================================================================
# 用法：bash smoke/contrast.sh
#
# 为什么需要它：
#   离线冒烟最大的风险不是"没写断言"，而是**断言的恒真性** —— 断言写着，
#   改坏了代码却照样 PASS，等于没测。尤其像「块必须偏离中线」「暂停不偷走
#   无敌时间」这种**设计意图**断言，一不小心就写成「拿实现常量当阈值」，
#   把常量改小就自动通过。
#
#   所以每改一次断言或核心常量，都该跑一遍：**期望每一项都命中指定断言**。
#   没命中的项，要么对照写坏了，要么断言没有区分力，两种都要修。
#
# 历史命中记录（2026-10-08 首次建立，9/9 全中；2026-10-07 v6 扩到 15/15）：
#   1a 块落回中线          → O3, O5c
#   1b 串跨度压平为 0      → O6, O5c
#   2  zig 节拍缩到 1.0×   → O5c
#   3  生成上限退回 TUN_FWD → O15b（空窗 50.2%）
#   4  收益结构反转        → O16, O17
#   5  暂停不平移时间戳    → Q6
#   6  跨越式判定→窗口式   → O14（连带 O8/O9/O12/O13/P5）
#   7  暂停不冻结世界      → Q3, Q4, Q5, Q6
#   8  机动能力腰斩        → O5, O7b
#   9  暂停层不拦输入      → Q11, Q12, Q13, Q17
#   --- v6 新增（用户反馈：没声音 / 块靠边 / 敏感度低）---
#   10 撤销块可达性修复    → O7（最远 |wx| 1.13 → 1.49，够不到）
#   11 offs 全改回贴边     → O3b, O5c
#   12 去掉 jitter         → O3c（不同 off 值 145 → 22）
#   13 串间换向补偿取消    → O7e（比值 2.82 → 0.99）
#   14 标准档退回 30°/4°   → N1
#   15 ORB_OFF_MIN 回 0.50 → O3b, O3c
#   --- v7 新增（2026-10-08，居中连乘）---
#   16 宽限归零            → S4（倍率脱离 0.00s 就破）
#   17 倍率不乘块分        → S8（比值 1.00）
#   18 倍率不乘存活分      → S9（比值 1.01）
#   19 倍率去掉上限        → S3（×7 > 5）
#   20 撞管壁不清零        → S7
#   21 脱离超时不清零      → S5, S6
#   22 光球配色恒冷        → S12
#   --- v8 新增（2026-10-10，金龟子翅膀倍率驱动 / 屏幕常亮）---
#   23 翅膀不看倍率        → T2, T3
#   24 结算不还原常亮      → T7
#
# ⚠️ 音效（iOS 手势解锁）**没有**对照项 —— 离线冒烟打桩了 wx，无法复现真机限制。
#    那部分只能真机验证，别以为"冒烟全绿"就等于音效没问题。
# ⚠️ O7（块可达性）靠 1500 帧随机采样取最坏 |wx|，覆盖充分但非严格保证 ——
#    曾出现过一次"对照10 显示失败 0"的偶发。看到"失败 0"先重跑一次再下结论。
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="$ROOT/game.js"
SMOKE="$ROOT/smoke/mvp-smoke.js"
NODE="${NODE:-node}"
PY="${PY:-/usr/bin/python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/smoke"

# 冒烟脚本按 __dirname/../game.js 取游戏源码 → 副本必须保持同样的目录结构
prep() { cp "$GAME" "$TMP/game.js"; cp "$SMOKE" "$TMP/smoke/mvp-smoke.js"; }

run() {
  local name="$1"
  echo "=== $name ==="
  local out
  out="$("$NODE" "$TMP/smoke/mvp-smoke.js" 2>&1 | grep -E '^  FAIL|^--- 共 ')"
  if [ -z "$out" ]; then out="  （脚本异常退出）"; fi
  echo "$out" | sed 's/^/   /'
}

# 可用 py 做多行替换（BSD sed 处理带引号的多行很别扭）
py() { "$PY" -c "$1"; }

echo "### 基线（应「失败 0」）"
prep; run "基线"

# --- 1a：块允许落在中线（P0 的设计意图直接失效）---
prep
sed -i.bak 's/offs: \[0.30, 0.47, 0.66, 0.86\]/offs: [0.00, 0.33, 0.66, 0.86]/' "$TMP/game.js"
sed -i.bak 's/ORB_OFF_MIN: 0.28,/ORB_OFF_MIN: 0.00,/' "$TMP/game.js"
run "对照1a：块允许落在中线"

# --- 1b：所有串跨度压平为 0（没有横移需求）---
prep
sed -i.bak 's/const flip = Math.random() < 0.5 ? 1 : -1/const flip = 1/' "$TMP/game.js"
sed -i.bak 's/offs: \[[^]]*\]/offs: [0.60]/g' "$TMP/game.js"
run "对照1b：所有串跨度压平为 0"

# --- 2：zigzag 取消长节拍（跨度大却没给时间）---
prep
sed -i.bak 's/offs: \[-0.74, 0.74, -0.74\], gapScale: 1.50/offs: [-0.74, 0.74, -0.74], gapScale: 1.00/' "$TMP/game.js"
run "对照2：zigzag 节拍缩到 1.0×"

# --- 3：两道防线同时拆掉，复现"视野外生成→被裁剪删掉"的断流 bug ---
prep
sed -i.bak 's/const limit = t.scroll + CFG.SHIP_Z + CFG.ORB_VIEW/const limit = t.scroll + CFG.TUN_FWD - 3/' "$TMP/game.js"
sed -i.bak 's/dz < CFG.ORB_VIEW + 40/dz < CFG.ORB_VIEW/' "$TMP/game.js"
run "对照3：生成上限 + 裁剪上界同时收回（断流应复现）"

# --- 4：收益结构反转（能量块变成次要收益）---
prep
sed -i.bak 's/ROOM_SCORE: 5,/ROOM_SCORE: 14,/' "$TMP/game.js"
sed -i.bak 's/ORB_SCORE: 30,/ORB_SCORE: 8,/' "$TMP/game.js"
run "对照4：居中分改回 14 + 能量块分降到 8"

# --- 5：暂停不做绝对时间戳平移 ---
prep
sed -i.bak 's/if (g.invulnUntil) g.invulnUntil += dtms/;/' "$TMP/game.js"
run "对照5：暂停不平移无敌/冷却时间戳"

# --- 6：跨越式判定退回窗口式（高速漏检）---
prep
sed -i.bak 's/if (!o.taken && !isNaN(o.pz) && o.pz > 0 && dz <= 0) {/if (!o.taken \&\& Math.abs(dz) < 0.15) {/' "$TMP/game.js"
run "对照6：判定退回「窗口式」"

# --- 7：暂停时照常推进世界（不冻结）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old=\"} else if (S.mode === 'paused') {\"
new=\"} else if (S.mode === 'paused') { updateControl(dt); updateWorld(dt); updateOrbs(dt);\"
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照7：暂停时世界照常推进"

# --- 8：机动能力腰斩（跨度超出飞船物理上限）---
prep
sed -i.bak 's/ROLL_XRANGE: 1.15,/ROLL_XRANGE: 0.60,/' "$TMP/game.js"
run "对照8：XRANGE 1.15 → 0.60"

# --- 9：暂停层不再拦截输入 ---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old=\"  if (S.mode === 'paused') {\n    const act = hitUI(tx, ty)\"
new=\"  if (false) {\n    const act = hitUI(tx, ty)\"
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照9：暂停层不再拦截输入"

# ============================ v6 新增（2026-10-07） ============================
# --- 10：撤销「块可达性」修复 → 贴边块重新跑到飞船够不到的地方 ---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='wx: at.cx + off * usable'
new='wx: at.cx + off * hw'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照10：撤销可达性修复（块 = cx + off×hw）"

# --- 11：所有 pattern 改回「贴边」（v6 之前的样子：块全堆在管壁边）---
prep
sed -i.bak 's/offs: \[[^]]*\]/offs: [0.66, 0.80]/g' "$TMP/game.js"
run "对照11：offs 全部改回贴边（0.66~0.80）"

# --- 12：去掉 jitter（位置退回几个固定档位）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='if (jit) off += (Math.random() * 2 - 1) * jit'
new='if (false) off += (Math.random() * 2 - 1) * jit'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照12：去掉 jitter（位置退回固定档位）"

# --- 13：串间换向补偿取消（cross 也给半拍）---
prep
sed -i.bak 's/base \* (cross ? 1.4 : 0.5)/base * 0.5/' "$TMP/game.js"
run "对照13：串间换向补偿取消（cross 也只给 0.5 拍）"

# --- 14：RANGES 标准档退回 v4 的 30°/4°（敏感度又变钝）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old=\"{ id: 'std',   dead: 0.061, full: 0.436, neck: 0.165, calm: 0.079, label: '标准' }\"
new=\"{ id: 'std',   dead: 0.070, full: 0.524, neck: 0.200, calm: 0.091, label: '标准' }\"
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照14：标准档退回 30°/4°（v4 手感）"

# --- 15：ORB_OFF_MIN 改回 0.50（靠中档位被抹掉）---
prep
sed -i.bak 's/ORB_OFF_MIN: 0.28,/ORB_OFF_MIN: 0.50,/' "$TMP/game.js"
run "对照15：ORB_OFF_MIN 回 0.50（块又被推回边上）"

# ============================ v7 新增（2026-10-08） ============================
# --- 16：宽限窗口归零（一离开中线就破倍率 → 吃块必然破倍率）---
prep
sed -i.bak 's/MULT_GRACE_SEC: 0.7,/MULT_GRACE_SEC: 0,/' "$TMP/game.js"
run "对照16：宽限归零（短冲吃块也破倍率）"

# --- 17：倍率不再乘块分（倍率沦为摆设）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='const add = CFG.ORB_SCORE * mul * g.mult'
new='const add = CFG.ORB_SCORE * mul'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照17：倍率不乘块分（块分与倍率脱钩）"

# --- 18：倍率不再乘存活分 ---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='g.score += (g.speed * 0.5 + g.cent * CFG.ROOM_SCORE) * g.mult * dt'
new='g.score += (g.speed * 0.5 + g.cent * CFG.ROOM_SCORE) * dt'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照18：倍率不乘存活分"

# --- 19：倍率去掉上限（无脑攒就无限大）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='const t01 = clamp(g.multHold / CFG.MULT_RAMP_SEC, 0, 1)'
new='const t01 = g.multHold / CFG.MULT_RAMP_SEC'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照19：倍率去掉上限（clamp 拿掉）"

# --- 20：撞管壁不再清零倍率 ---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='g.mult = 1; g.multHold = 0; g.multOut = 0; g.multTier = 1'
new='/* 撞墙不清零 */'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照20：撞管壁不清零倍率"

# --- 21：脱离超时也不清零（倍率只涨不掉）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='      g.mult = 1; g.multHold = 0; g.multTier = 1'
new=''
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照21：脱离超时不清零（倍率只涨不掉）"

# --- 22：满档退回暖金（丢掉「用亮度而非色相表达充能」的设计）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old=\"return '#F6FFFC'\"
new=\"return '#FFE9A8'\"
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照22：满档退回暖金（丢掉「用亮度表达充能」的设计）"

# ============================ v8 新增（2026-10-10） ============================
# --- 23：翅膀不再看倍率（恒闭合 → 充能也张不开，"展开"这个反馈消失）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='const openTgt = WING_CLOSED + wingT * (WING_FULL - WING_CLOSED) + (g.boosting ? 0.18 : 0)'
new='const openTgt = WING_CLOSED + (g.boosting ? 0.18 : 0)'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照23：翅膀不看倍率（恒闭合，充能也张不开）"

# --- 24：结算不还原屏幕常亮（本局结束后一直亮着白耗电）---
prep
py "
p='$TMP/game.js'
s=open(p,encoding='utf-8').read()
old='  setKeepScreen(false)         // 本局结束：还原系统息屏策略（不在结算页挂着常亮）'
new='  /* 结算不还原常亮 */'
assert old in s, 'anchor not found'
open(p,'w',encoding='utf-8').write(s.replace(old,new))
"
run "对照24：结算不还原屏幕常亮"

echo
echo "### 每项都应出现 FAIL（基线除外）。若某项显示「失败 0」，说明断言对该改动没有区分力，必须修断言。"
