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
# 历史命中记录（2026-10-08 首次建立，9/9 全中）：
#   1a 块落回中线          → O3, O5c
#   1b 串跨度压平为 0      → O6, O5c
#   2  zig 节拍缩到 1.0×   → O5c
#   3  生成上限退回 TUN_FWD → O15b（空窗 50.2%）
#   4  收益结构反转        → O16, O17
#   5  暂停不平移时间戳    → Q6
#   6  跨越式判定→窗口式   → O14（连带 O8/O9/O12/O13/P5）
#   7  暂停不冻结世界      → Q3, Q4, Q5, Q6
#   8  机动能力腰斩        → O5, O7
#   9  暂停层不拦输入      → Q11, Q12, Q13, Q17
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
sed -i.bak 's/offs: \[0.50, 0.66, 0.79, 0.85\]/offs: [0.00, 0.33, 0.66, 0.85]/' "$TMP/game.js"
sed -i.bak 's/ORB_OFF_MIN: 0.50,/ORB_OFF_MIN: 0.00,/' "$TMP/game.js"
run "对照1a：块允许落在中线"

# --- 1b：所有串跨度压平为 0（没有横移需求）---
prep
sed -i.bak 's/const flip = Math.random() < 0.5 ? 1 : -1/const flip = 1/' "$TMP/game.js"
sed -i.bak 's/offs: \[[^]]*\]/offs: [0.60]/g' "$TMP/game.js"
run "对照1b：所有串跨度压平为 0"

# --- 2：zigzag 取消长节拍（跨度大却没给时间）---
prep
sed -i.bak 's/offs: \[-0.78, 0.78, -0.78\], gapScale: 1.50/offs: [-0.78, 0.78, -0.78], gapScale: 1.00/' "$TMP/game.js"
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

echo
echo "### 每项都应出现 FAIL（基线除外）。若某项显示「失败 0」，说明断言对该改动没有区分力，必须修断言。"
