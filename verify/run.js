/*
 * verify 服务入口：代码测试 + 构建检查 + 页面 HTTP 冒烟。
 * 全部完成后退出，退出码 0 表示通过、1 表示存在失败。
 *
 * 用法：node verify/run.js   （WEB_URL 环境变量指向被测页面，默认 http://127.0.0.1:8080）
 */
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DSATUR = require(path.join(ROOT, 'dsatur.js'));
const Validate = require(path.join(ROOT, 'validate.js'));

const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function report(ok, name, err) {
  if (ok) {
    passed++;
    console.log(`ok ${passed + failed} - ${name}`);
  } else {
    failed++;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(
      String((err && err.stack) || err)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    );
  }
}

function test(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

/* ---------- 工具：确定性伪随机与重排 ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// 录入重排：打乱通道顺序、打乱边的顺序并随机交换端点
function reorder(ids, pairs, rand) {
  const ids2 = ids.slice();
  for (let i = ids2.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids2[i], ids2[j]] = [ids2[j], ids2[i]];
  }
  const pairs2 = pairs
    .map((p) => (rand() < 0.5 ? [p[1], p[0]] : [p[0], p[1]]))
    .sort(() => rand() - 0.5);
  return [ids2, pairs2];
}

// 测试专用暴力色数（仅用于交叉验证，不属于产品代码）
function bruteChi(n, pairs) {
  const nbr = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) {
    nbr[a].push(b);
    nbr[b].push(a);
  }
  const color = new Array(n).fill(-1);
  function rec(v, k) {
    if (v === n) return true;
    for (let c = 0; c < k; c++) {
      let ok = true;
      for (const u of nbr[v]) {
        if (color[u] === c) {
          ok = false;
          break;
        }
      }
      if (ok) {
        color[v] = c;
        if (rec(v + 1, k)) return true;
        color[v] = -1;
      }
    }
    return false;
  }
  for (let k = 1; k <= n; k++) {
    if (rec(0, k)) return k;
  }
  return n;
}

/* ---------- 1. 代码测试：DSATUR 精确求解 ---------- */

test('三角冲突需要 3 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 3, '最大团下界应为 3');
  assert.deepStrictEqual(r.bands, [['A'], ['B'], ['C']]);
});

test('四通道完全冲突需要 4 个频段', () => {
  const ids = ['C1', 'C2', 'C3', 'C4'];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) pairs.push([ids[i], ids[j]]);
  }
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 4);
  assert.strictEqual(r.lb, 4);
});

test('二分链式关系需要 2 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  assert.strictEqual(r.k, 2);
  assert.deepStrictEqual(r.bands, [['A', 'C'], ['B', 'D']]);
  assert.strictEqual(DSATUR.verifyAssignment([['A', 'B'], ['B', 'C'], ['C', 'D']], r.bandOf).length, 0);
});

test('奇环 C5 需要 3 个频段（下界 2 < 3，须经分支定界证明）', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 2, 'C5 最大团为 2');
  assert.ok(r.nodes > 0, '应实际执行分支定界搜索');
});

test('无干扰边时只需 1 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], []);
  assert.strictEqual(r.k, 1);
  assert.deepStrictEqual(r.bands, [['A', 'B', 'C']]);
});

test('录入重排后规范分配保持一致（三角 / K4 / 链式 / 组合图）', () => {
  const cases = [
    { ids: ['A', 'B', 'C'], pairs: [['A', 'B'], ['B', 'C'], ['A', 'C']] },
    {
      ids: ['C1', 'C2', 'C3', 'C4'],
      pairs: [['C1', 'C2'], ['C1', 'C3'], ['C1', 'C4'], ['C2', 'C3'], ['C2', 'C4'], ['C3', 'C4']],
    },
    { ids: ['A', 'B', 'C', 'D'], pairs: [['A', 'B'], ['B', 'C'], ['C', 'D']] },
    {
      ids: ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6'],
      pairs: [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH6'], ['CH4', 'CH6']],
    },
  ];
  const rand = lcg(20260926);
  for (const c of cases) {
    const base = DSATUR.solveGraph(c.ids, c.pairs);
    for (let t = 0; t < 8; t++) {
      const [ids2, pairs2] = reorder(c.ids, c.pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.strictEqual(r.k, base.k, '重排后色数改变');
      assert.deepStrictEqual(r.bandOf, base.bandOf, '重排后规范分配改变');
      assert.deepStrictEqual(r.bands, base.bands, '重排后频段清单改变');
    }
  }
});

test('随机小图上与暴力色数一致（精确性交叉验证）', () => {
  const rand = lcg(1234567);
  let searched = 0;
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 个顶点
    const p = 0.15 + rand() * 0.6;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const res = DSATUR.exactColor(adj, n);
    const expect = bruteChi(n, pairs);
    assert.strictEqual(res.k, expect, `图 ${t} 色数不符：${JSON.stringify({ n, pairs })}`);
    assert.ok(res.lb <= res.k && res.k <= res.ub0, '下界/上界应夹住色数');
    if (res.nodes > 0) searched++;
  }
  assert.ok(searched > 0, '应有样例实际触发分支定界搜索');
});

test('随机图上录入重排后规范分配保持一致', () => {
  const rand = lcg(2026);
  for (let t = 0; t < 30; t++) {
    const n = 2 + Math.floor(rand() * 8); // 2..9
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.4) pairs.push([ids[i], ids[j]]);
      }
    }
    const base = DSATUR.solveGraph(ids, pairs);
    for (let s = 0; s < 4; s++) {
      const [ids2, pairs2] = reorder(ids, pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.deepStrictEqual(r.bandOf, base.bandOf, `图 ${t} 重排后规范分配改变`);
    }
  }
});

test('求解确定性：同一输入重复求解结论一致', () => {
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH1']];
  const a = DSATUR.solveGraph(ids, pairs);
  const b = DSATUR.solveGraph(ids, pairs);
  assert.deepStrictEqual(a.bandOf, b.bandOf);
  assert.strictEqual(a.nodes, b.nodes);
});

test('复核器能发现同频段冲突（负例）', () => {
  const v = DSATUR.verifyAssignment([['A', 'B']], { A: 1, B: 1 });
  assert.strictEqual(v.length, 1);
});

/* ---------- 1b. 代码测试：复线审计（受限颜色分支定界） ---------- */

// 测试专用暴力最少同频边（仅用于交叉验证，不属于产品代码）
function bruteMinConflicts(n, pairs, t) {
  const color = new Array(n).fill(0);
  let best = Infinity;
  function rec(v, acc) {
    if (acc >= best) return;
    if (v === n) {
      best = acc;
      return;
    }
    for (let c = 0; c < t; c++) {
      let add = 0;
      for (const [a, b] of pairs) {
        if (b === v && color[a] === c) add++;
      }
      color[v] = c;
      rec(v + 1, acc + add);
    }
  }
  rec(0, 0);
  return best;
}

test('复线审计：三角网络降至二频段需解除一条关系', () => {
  const ids = ['CH1', 'CH2', 'CH3'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3']];
  const r = DSATUR.auditGraph(ids, pairs, 2);
  assert.strictEqual(r.removed, 1, '三角降至 2 频段的最少解除数应为 1');
  assert.deepStrictEqual(r.removedEdges, [['CH1', 'CH2']], '解除关系应为规范排序的最小见证');
  assert.strictEqual(r.lb, 1, '三角团在 2 频段下必然冲突 1 条');
  assert.strictEqual(r.ub, 1, '已知方案上界应为 1');
  assert.deepStrictEqual(r.bands, [['CH1', 'CH2'], ['CH3']]);
  // 剩余关系上逐频段无冲突，可复算
  const kept = pairs.filter((p) => JSON.stringify(p) !== JSON.stringify(r.removedEdges[0]));
  assert.strictEqual(kept.length, 2);
  for (const [a, b] of kept) assert.notStrictEqual(r.bandOf[a], r.bandOf[b]);
});

test('复线审计：四通道完全冲突降至三频段的稳定最小见证', () => {
  const ids = ['C1', 'C2', 'C3', 'C4'];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) pairs.push([ids[i], ids[j]]);
  }
  const r = DSATUR.auditGraph(ids, pairs, 3);
  assert.strictEqual(r.removed, 1, 'K4 降至 3 频段的最少解除数应为 1');
  assert.deepStrictEqual(r.removedEdges, [['C1', 'C2']], '最小见证应稳定为规范最小关系');
  assert.strictEqual(r.lb, 1, 'K4 在 3 频段下必然冲突 1 条');
  assert.deepStrictEqual(r.bands, [['C1', 'C2'], ['C3'], ['C4']]);
  // 稳定性：任意重排录入（通道顺序 / 边顺序 / 端点方向），见证保持一致
  const rand = lcg(424242);
  for (let s = 0; s < 8; s++) {
    const [ids2, pairs2] = reorder(ids, pairs, rand);
    const r2 = DSATUR.auditGraph(ids2, pairs2, 3);
    assert.deepStrictEqual(r2.removedEdges, r.removedEdges, '重排后解除关系改变');
    assert.deepStrictEqual(r2.bandOf, r.bandOf, '重排后频段编号改变');
    assert.deepStrictEqual(r2.bands, r.bands, '重排后频段清单改变');
  }
});

test('复线审计：四通道完全冲突降至二频段需解除两条关系', () => {
  const ids = ['C1', 'C2', 'C3', 'C4'];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) pairs.push([ids[i], ids[j]]);
  }
  const r = DSATUR.auditGraph(ids, pairs, 2);
  assert.strictEqual(r.removed, 2, 'K4 在 2 频段下至少冲突 2 条（均衡投放 2+2）');
  assert.strictEqual(r.lb, 2, '互不重叠团下界应为 2');
  assert.strictEqual(r.removedEdges.length, 2);
  // 解除关系按端点标识规范排序
  const sorted = r.removedEdges.slice().sort((e1, e2) =>
    e1[0] !== e2[0] ? (e1[0] < e2[0] ? -1 : 1) : e1[1] < e2[1] ? -1 : 1
  );
  assert.deepStrictEqual(r.removedEdges, sorted);
  // 保留关系两端分属不同频段
  const removedKeys = new Set(r.removedEdges.map((p) => JSON.stringify(p)));
  for (const [a, b] of pairs) {
    const key = JSON.stringify(a < b ? [a, b] : [b, a]);
    assert.strictEqual(r.bandOf[a] === r.bandOf[b], removedKeys.has(key), `边 ${a}-${b} 的同频性与解除标记不一致`);
  }
});

test('复线审计：奇环 C5 降至二频段须经分支定界证明（下界 0 < 上界）', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = DSATUR.auditGraph(ids, pairs, 2);
  assert.strictEqual(r.removed, 1, '奇环解除一条边即可二染色');
  assert.strictEqual(r.lb, 0, 'C5 的互不重叠团（匹配）在 2 频段下不导出必然冲突');
  assert.ok(r.nodes > 0, '应实际执行分支定界搜索');
  const removedKeys = new Set(r.removedEdges.map((p) => JSON.stringify(p)));
  for (const [a, b] of pairs) {
    const key = JSON.stringify(a < b ? [a, b] : [b, a]);
    if (!removedKeys.has(key)) assert.notStrictEqual(r.bandOf[a], r.bandOf[b], `保留边 ${a}-${b} 同频`);
  }
});

test('复线审计：随机小图上与暴力最少同频边一致（精确性交叉验证）', () => {
  const rand = lcg(987654321);
  let searched = 0;
  for (let tc = 0; tc < 120; tc++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 个顶点
    const p = 0.25 + rand() * 0.6;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    if (pairs.length === 0) continue;
    const chi = bruteChi(n, pairs);
    if (chi < 2) continue;
    const t = 1 + Math.floor(rand() * (chi - 1)); // 1..chi-1
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const res = DSATUR.restrictedBnB(adj, n, t);
    const expect = bruteMinConflicts(n, pairs, t);
    assert.strictEqual(res.m, expect, `图 ${tc}（n=${n}, t=${t}）最少同频边不符：${JSON.stringify(pairs)}`);
    assert.ok(res.lb <= res.m && res.m <= res.ub0, '下界/上界应夹住最少解除数');
    if (res.nodes > 0) searched++;
  }
  assert.ok(searched > 0, '应有样例实际触发分支定界搜索');
});

test('复线审计：解除关系恰为同频边且逐频段无冲突（随机图复核）', () => {
  const rand = lcg(13579);
  for (let tc = 0; tc < 40; tc++) {
    const n = 3 + Math.floor(rand() * 6); // 3..8
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.5) pairs.push([ids[i], ids[j]]);
      }
    }
    if (pairs.length === 0) continue;
    const chi = DSATUR.solveGraph(ids, pairs).k;
    if (chi < 2) continue;
    const t = chi - 1;
    const r = DSATUR.auditGraph(ids, pairs, t);
    assert.strictEqual(r.removed, r.removedEdges.length);
    assert.ok(r.bands.length <= t, '剩余网络所用频段数不应超过目标');
    const removedKeys = new Set(r.removedEdges.map((p) => JSON.stringify(p)));
    let sameCount = 0;
    for (const [a, b] of pairs) {
      const key = JSON.stringify(a < b ? [a, b] : [b, a]);
      const same = r.bandOf[a] === r.bandOf[b];
      assert.strictEqual(same, removedKeys.has(key), `边 ${a}-${b} 的同频性与解除标记不一致`);
      if (same) sameCount++;
    }
    assert.strictEqual(sameCount, r.removed, '同频边数应等于最少解除数');
    // 每个频段内部不存在保留的干扰关系
    for (const band of r.bands) {
      const inBand = new Set(band);
      for (const [a, b] of pairs) {
        const key = JSON.stringify(a < b ? [a, b] : [b, a]);
        if (inBand.has(a) && inBand.has(b)) {
          assert.ok(removedKeys.has(key), `频段内存在保留冲突边 ${a}-${b}`);
        }
      }
    }
  }
});

test('复线审计：随机图上录入重排后见证保持一致', () => {
  const rand = lcg(24680);
  for (let tc = 0; tc < 20; tc++) {
    const n = 3 + Math.floor(rand() * 6); // 3..8
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.5) pairs.push([ids[i], ids[j]]);
      }
    }
    if (pairs.length === 0) continue;
    const chi = DSATUR.solveGraph(ids, pairs).k;
    if (chi < 2) continue;
    const t = chi - 1;
    const base = DSATUR.auditGraph(ids, pairs, t);
    for (let s = 0; s < 4; s++) {
      const [ids2, pairs2] = reorder(ids, pairs, rand);
      const r = DSATUR.auditGraph(ids2, pairs2, t);
      assert.deepStrictEqual(r.removedEdges, base.removedEdges, `图 ${tc} 重排后解除关系改变`);
      assert.deepStrictEqual(r.bandOf, base.bandOf, `图 ${tc} 重排后频段编号改变`);
    }
  }
});

test('复线审计：同一输入重复审计结论一致（确定性）', () => {
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH1']];
  const a = DSATUR.auditGraph(ids, pairs, 2);
  const b = DSATUR.auditGraph(ids, pairs, 2);
  assert.deepStrictEqual(a.removedEdges, b.removedEdges);
  assert.deepStrictEqual(a.bandOf, b.bandOf);
  assert.strictEqual(a.nodes, b.nodes);
});

/* ---------- 2. 代码测试：录入校验定位 ---------- */

test('自环被定位提示', () => {
  const r = Validate.parseEdges('A B\nA A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /自环/);
});

test('重复无向关系被定位提示（A B 与 B A 视为重复）', () => {
  const r = Validate.parseEdges('A B\nB A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /重复/);
});

test('不存在端点被定位提示', () => {
  const r = Validate.parseEdges('A Z', new Set(['A', 'B']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /「Z」/);
});

test('通道数量边界：少于 2 个、多于 26 个、重复标识', () => {
  assert.ok(Validate.parseChannels('ONLY1').errors.some((e) => /至少需要 2 个/.test(e.message)));
  const many = Array.from({ length: 27 }, (_, i) => 'C' + i).join(' ');
  assert.ok(Validate.parseChannels(many).errors.some((e) => /至多允许 26 个/.test(e.message)));
  const dup = Validate.parseChannels('A B A');
  assert.ok(dup.errors.some((e) => /重复/.test(e.message) && /第 3 个/.test(e.message)));
  assert.strictEqual(Validate.parseChannels('A B').errors.length, 0);
});

test('干扰关系条数上限 120 条', () => {
  const ids = Array.from({ length: 26 }, (_, i) => 'C' + i);
  const set = new Set(ids);
  const lines = [];
  outer: for (let i = 0; i < 26; i++) {
    for (let j = i + 1; j < 26; j++) {
      lines.push(`C${i} C${j}`);
      if (lines.length === 121) break outer;
    }
  }
  assert.strictEqual(Validate.parseEdges(lines.slice(0, 120).join('\n'), set).errors.length, 0);
  const over = Validate.parseEdges(lines.join('\n'), set);
  assert.ok(over.errors.some((e) => /至多允许 120 条/.test(e.message)));
});

test('干扰关系行格式错误被定位提示', () => {
  const r = Validate.parseEdges('A B C', new Set(['A', 'B', 'C']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /恰好两个/);
});

/* ---------- 2b. 代码测试：复线审计目标校验 ---------- */

test('复线审计：不降低频段数时拒绝审计并保持原结论可用', () => {
  // 目标频段等于 / 大于原最少数均被拒绝
  for (const raw of ['3', '4']) {
    const chk = Validate.parseAuditTarget(raw, 3, 3);
    assert.ok(!chk.ok, `目标 ${raw} 应被拒绝`);
    assert.match(chk.errors[0].message, /不小于原最少频段数/);
    assert.match(chk.errors[0].message, /χ = 3/);
  }
  // 拒绝后原求色结论不受影响、仍可复算
  const r = DSATUR.solveGraph(['CH1', 'CH2', 'CH3'], [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3']]);
  assert.strictEqual(r.k, 3);
  assert.deepStrictEqual(r.bands, [['CH1'], ['CH2'], ['CH3']]);
  assert.strictEqual(DSATUR.verifyAssignment([['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3']], r.bandOf).length, 0);
  // 严格更少的目标频段被接受
  const ok = Validate.parseAuditTarget('2', 3, 3);
  assert.ok(ok.ok && ok.target === 2);
});

test('复线审计：目标频段格式非法被定位反馈', () => {
  for (const raw of ['', 'abc', '1.5', '0', '-2', '2e1', '  ']) {
    const chk = Validate.parseAuditTarget(raw, 3, 3);
    assert.ok(!chk.ok, `目标「${raw}」应被判格式非法`);
    assert.match(chk.errors[0].message, /格式非法/);
    assert.strictEqual(chk.target, null);
  }
  const ok = Validate.parseAuditTarget(' 2 ', 3, 3); // 允许首尾空白
  assert.ok(ok.ok && ok.target === 2);
});

test('复线审计：不存在可保留关系时拒绝审计', () => {
  const chk = Validate.parseAuditTarget('1', 1, 0);
  assert.ok(!chk.ok);
  assert.match(chk.errors[0].message, /不存在可保留的干扰关系/);
  // 求解器侧同样防御空关系
  assert.throws(() => DSATUR.auditGraph(['A', 'B'], [], 1), /不存在可保留/);
});

/* ---------- 3. 构建检查 ---------- */

test('构建检查：关键文件存在、JS 语法有效、页面引用完整', () => {
  const files = [
    'index.html',
    'styles.css',
    'main.js',
    'worker.js',
    'dsatur.js',
    'validate.js',
    'server.js',
    'Dockerfile',
    'compose.yaml',
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件 ${f}`);
  }
  const jsFiles = ['main.js', 'worker.js', 'dsatur.js', 'validate.js', 'server.js', 'verify/run.js'];
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('src="validate.js"') && html.includes('src="main.js"'), 'index.html 脚本引用缺失');
  assert.ok(
    html.includes('id="auditTarget"') && html.includes('id="auditLaunch"') && html.includes('复线审计'),
    'index.html 缺少复线审计界面'
  );
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(mainJs.includes("new Worker('worker.js')"), 'main.js 未在 Worker 中求解');
  assert.ok(mainJs.includes('parseAuditTarget') && mainJs.includes('launchAudit'), 'main.js 未接入复线审计');
  const workerJs = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  assert.ok(workerJs.includes("importScripts('dsatur.js')"), 'worker.js 未加载求解器');
  assert.ok(workerJs.includes('auditGraph'), 'worker.js 未处理复线审计任务');
  const dsaturJs = fs.readFileSync(path.join(ROOT, 'dsatur.js'), 'utf8');
  assert.ok(dsaturJs.includes('auditGraph') && dsaturJs.includes('disjointCliques'), 'dsatur.js 缺少审计求解');
  const validateJs = fs.readFileSync(path.join(ROOT, 'validate.js'), 'utf8');
  assert.ok(validateJs.includes('parseAuditTarget'), 'validate.js 缺少审计目标校验');
});

/* ---------- 4. 页面 HTTP 冒烟 ---------- */

async function fetchWithRetry(url, attempts, delayMs) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

async function smoke() {
  const targets = [
    ['/', (body) => body.includes('束流诊断柜') && body.includes('id="channels"') && body.includes('id="edges"')],
    ['/', (body) => body.includes('复线审计') && body.includes('id="auditTarget"') && body.includes('id="auditLaunch"')],
    ['/main.js', (body) => body.includes('new Worker') && body.includes('launchAudit')],
    ['/worker.js', (body) => body.includes('importScripts') && body.includes('auditGraph')],
    ['/dsatur.js', (body) => body.includes('solveGraph') && body.includes('auditGraph')],
    ['/validate.js', (body) => body.includes('parseChannels') && body.includes('parseAuditTarget')],
    ['/styles.css', (body) => body.includes('resultPanel')],
    ['/healthz', (body) => body.includes('ok')],
  ];
  for (const [p, check] of targets) {
    await testAsync(`HTTP 冒烟 GET ${p}`, async () => {
      const res = await fetchWithRetry(WEB_URL + p, 12, 500);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(check(body), '响应缺少预期标记');
    });
  }
}

/* ---------- 主流程 ---------- */

(async () => {
  await smoke();
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
