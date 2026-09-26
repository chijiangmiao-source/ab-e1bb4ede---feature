/*
 * 确定性 DSATUR 分支定界精确图着色。
 *
 * 同一模块同时服务于浏览器 Worker（importScripts）与 Node 测试（require），
 * 保证页面结论与代码测试行为一致。
 *
 * 算法要点：
 *  - 顶点顺序固定为通道标识升序，所有平局按顶点下标裁决 => 与录入顺序无关；
 *  - 贪心 DSATUR 给出可行上界（初始 incumbent）；
 *  - Tomita 最大团给出可证明下界，并用于团预着色与全局剪枝；
 *  - 分支定界按 DSATUR 饱和度选点、按颜色编号升序尝试，
 *    「used >= best」与「used + 1 >= best 不得开新色」完成上界剪枝。
 * 不使用随机搜索，也不枚举全部完整分配。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DSATUR = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }

  // 最低置位比特的下标（x 必须非 0）
  function lowbitIndex(x) {
    return popcount((x & -x) - 1);
  }

  // 选点规则：饱和度最大；平局 -> 度最大；再平局 -> 下标最小（确定性）
  function pickVertex(color, sat, deg, n) {
    let v = -1;
    for (let i = 0; i < n; i++) {
      if (color[i] !== -1) continue;
      if (
        v === -1 ||
        sat[i] > sat[v] ||
        (sat[i] === sat[v] && (deg[i] > deg[v] || (deg[i] === deg[v] && i < v)))
      ) {
        v = i;
      }
    }
    return v;
  }

  // 贪心 DSATUR：可行上界 + 初始 incumbent
  function greedyDsatur(adj, n, deg) {
    const color = new Array(n).fill(-1);
    const sat = new Array(n).fill(0);
    const nbrColors = new Array(n).fill(0);
    let used = 0;
    let colored = 0;
    while (colored < n) {
      const v = pickVertex(color, sat, deg, n);
      let c = 0;
      while (nbrColors[v] & (1 << c)) c++;
      color[v] = c;
      if (c === used) used++;
      colored++;
      let m = adj[v];
      while (m) {
        const bit = m & -m;
        const u = lowbitIndex(bit);
        m ^= bit;
        if (color[u] === -1 && !(nbrColors[u] & (1 << c))) {
          nbrColors[u] |= 1 << c;
          sat[u]++;
        }
      }
    }
    return { color: color, used: used };
  }

  // Tomita 最大团（贪心着色界剪枝）：在候选点集 candMask 内求最大团
  function maxCliqueIn(adj, candMask) {
    let bestSize = 0;
    let bestMask = 0;
    function expand(R, size, P) {
      if (P === 0) {
        if (size > bestSize) {
          bestSize = size;
          bestMask = R;
        }
        return;
      }
      const order = [];
      const bounds = [];
      let uncolored = P;
      let c = 0;
      while (uncolored) {
        c++;
        let avail = uncolored;
        while (avail) {
          const bit = avail & -avail;
          const v = lowbitIndex(bit);
          avail ^= bit;
          uncolored ^= bit;
          order.push(v);
          bounds.push(c);
          avail &= ~adj[v];
        }
      }
      let Pm = P;
      for (let i = order.length - 1; i >= 0; i--) {
        if (size + bounds[i] <= bestSize) return;
        const v = order[i];
        const bit = 1 << v;
        Pm &= ~bit;
        expand(R | bit, size + 1, Pm & adj[v]);
      }
    }
    expand(0, 0, candMask);
    return { size: bestSize, mask: bestMask };
  }

  function maxClique(adj, n) {
    return maxCliqueIn(adj, n >= 31 ? -1 : (1 << n) - 1);
  }

  // 互不重叠团：反复取剩余点集的最大团并移除，顶点两两不相交
  function disjointCliques(adj, n) {
    const cliques = [];
    let rest = n >= 31 ? -1 : (1 << n) - 1;
    while (rest !== 0) {
      const c = maxCliqueIn(adj, rest);
      if (c.size < 2) break; // 孤立点对下界无贡献
      const vs = [];
      let m = c.mask;
      while (m) {
        const bit = m & -m;
        vs.push(lowbitIndex(bit));
        m ^= bit;
      }
      cliques.push(vs);
      rest &= ~c.mask;
    }
    return cliques;
  }

  // 精确 DSATUR 分支定界
  function exactColor(adj, n) {
    const deg = adj.map(popcount);
    const greedy = greedyDsatur(adj, n, deg);
    let best = greedy.used; // 已知可行上界
    let bestColor = greedy.color.slice();
    const clique = maxClique(adj, n);
    const lb = clique.size; // 可证明下界
    let nodes = 0;

    if (lb < best) {
      const color = new Array(n).fill(-1);
      const sat = new Array(n).fill(0);
      const nbrColors = new Array(n).fill(0);
      let used = 0;
      let coloredCount = 0;

      function assign(v, c, touched) {
        color[v] = c;
        let m = adj[v];
        while (m) {
          const bit = m & -m;
          const u = lowbitIndex(bit);
          m ^= bit;
          if (color[u] === -1 && !(nbrColors[u] & (1 << c))) {
            nbrColors[u] |= 1 << c;
            sat[u]++;
            touched.push(u);
          }
        }
      }
      function unassign(v, c, touched) {
        color[v] = -1;
        for (let i = 0; i < touched.length; i++) {
          const u = touched[i];
          nbrColors[u] &= ~(1 << c);
          sat[u]--;
        }
        touched.length = 0;
      }

      // 团预着色：团内顶点在任何可行解中颜色两两不同，
      // 经颜色置换可令其依次占用 0..lb-1 —— 这是安全的下界利用。
      let cm = clique.mask;
      while (cm) {
        const bit = cm & -cm;
        const v = lowbitIndex(bit);
        cm ^= bit;
        assign(v, used, []);
        used++;
        coloredCount++;
      }

      function search() {
        nodes++;
        if (best === lb) return; // 已达可证明下界，全局终止
        if (coloredCount === n) {
          if (used < best) {
            best = used;
            bestColor = color.slice();
          }
          return;
        }
        if (used >= best) return; // 上界剪枝：继续不可能严格更优
        const v = pickVertex(color, sat, deg, n);
        const forbid = nbrColors[v];
        for (let c = 0; c < used; c++) {
          if (forbid & (1 << c)) continue;
          const touched = [];
          assign(v, c, touched);
          coloredCount++;
          search();
          coloredCount--;
          unassign(v, c, touched);
        }
        if (used + 1 < best) {
          // 开新频段仅在可能严格优于当前最优时才有意义
          const touched = [];
          assign(v, used, touched);
          used++;
          coloredCount++;
          search();
          coloredCount--;
          used--;
          unassign(v, used, touched);
        }
      }
      search();
    }

    return { k: best, colors: bestColor, lb: lb, ub0: greedy.used, nodes: nodes };
  }

  // 任意顺序的通道标识 + 无向干扰关系 -> 按通道标识升序建图（与录入顺序无关）
  function buildGraph(ids, pairs) {
    const sorted = ids.slice().sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const n = sorted.length;
    const index = new Map();
    sorted.forEach(function (id, i) {
      index.set(id, i);
    });
    const adj = new Array(n).fill(0);
    for (const pair of pairs) {
      const i = index.get(pair[0]);
      const j = index.get(pair[1]);
      if (i === undefined || j === undefined) {
        throw new Error('干扰关系包含未知端点: ' + pair[0] + ' ' + pair[1]);
      }
      adj[i] |= 1 << j;
      adj[j] |= 1 << i;
    }
    return { sorted: sorted, n: n, index: index, adj: adj };
  }

  // 规范频段编号：按频段内最小通道下标（即通道标识升序）重编号为 1..k
  function canonicalBands(colors, sorted) {
    const n = sorted.length;
    const classMin = new Map(); // 色号 -> 该频段最小通道下标
    for (let v = 0; v < n; v++) {
      const c = colors[v];
      if (!classMin.has(c) || v < classMin.get(c)) classMin.set(c, v);
    }
    const order = Array.from(classMin.keys()).sort(function (c1, c2) {
      return classMin.get(c1) - classMin.get(c2);
    });
    const relabel = new Map();
    order.forEach(function (c, i) {
      relabel.set(c, i + 1);
    });
    const bandOf = {};
    const bands = [];
    for (let i = 0; i < order.length; i++) bands.push([]);
    for (let v = 0; v < n; v++) {
      const b = relabel.get(colors[v]);
      bandOf[sorted[v]] = b;
      bands[b - 1].push(sorted[v]);
    }
    return { bandOf: bandOf, bands: bands };
  }

  /*
   * 高层入口：任意顺序的通道标识 + 无向干扰关系 -> 规范结论。
   * 顶点按通道标识升序排列后求解，再按「各频段最小通道标识升序」重编号，
   * 因此改变录入顺序结论保持一致。
   */
  function solveGraph(ids, pairs) {
    const started = Date.now();
    const g = buildGraph(ids, pairs);
    const res = exactColor(g.adj, g.n);
    const canon = canonicalBands(res.colors, g.sorted);
    return {
      k: res.k,
      bands: canon.bands,
      bandOf: canon.bandOf,
      channels: g.sorted,
      lb: res.lb,
      ub: res.ub0,
      nodes: res.nodes,
      elapsed: Date.now() - started,
    };
  }

  /*
   * 受限颜色分支定界：固定 t 个频段，精确最小化同频干扰边数。
   *
   * 与完整着色的 DSATUR 分支定界同构，但目标改为「同频边最少」：
   *  - 贪心受限着色经确定性首轮改进后给出已知方案上界（初始 incumbent）；
   *  - 互不重叠团导出必然冲突下界：s 阶团在 t 色下至少产生
   *    「把 s 个顶点均衡放入 t 个频段后的同频点对数」条同频边，
   *    团两两顶点不相交 => 各团必然冲突边互不相同，可累加为全局下界；
   *  - 另有逐点必然冲突下界：每个未着色顶点相对已着色点集取冲突最少的
   *    频段，其冲突边恰以该未着色点为端点 => 求和不重复计数；
   *    两类下界各自成立，取较大者参与「当前冲突 + 下界 >= 上界」剪枝；
   *  - 顶点按通道标识升序编号，选点（已着色邻居最多 -> 度最大 -> 下标最小）
   *    与尝色（色号升序）全部确定性裁决 => 结论与录入顺序无关。
   * 不使用贪心重配、随机搜索、完整分配枚举或逐条试删关系代替精确求解。
   */

  // 向 t 个已装 bins[c] 个顶点的频段再均衡投放 u 个顶点，新增同频点对数的最小值
  function minAddedPairs(bins, u) {
    const b = bins.slice().sort(function (x, y) {
      return x - y;
    });
    let added = 0;
    for (let i = 0; i < u; i++) {
      let mi = 0;
      for (let j = 1; j < b.length; j++) {
        if (b[j] < b[mi]) mi = j;
      }
      added += b[mi]; // 放入含 x 个顶点的频段新增 x 对同频
      b[mi]++;
    }
    return added;
  }

  // 贪心受限着色：已知方案的初始候选（确定性）
  function greedyRestricted(adj, n, t, deg) {
    const color = new Array(n).fill(-1);
    const colorMask = new Array(t).fill(0);
    let coloredMask = 0;
    for (let step = 0; step < n; step++) {
      let v = -1;
      for (let i = 0; i < n; i++) {
        if (color[i] !== -1) continue;
        if (
          v === -1 ||
          popcount(adj[i] & coloredMask) > popcount(adj[v] & coloredMask) ||
          (popcount(adj[i] & coloredMask) === popcount(adj[v] & coloredMask) &&
            (deg[i] > deg[v] || (deg[i] === deg[v] && i < v)))
        ) {
          v = i;
        }
      }
      let bestC = 0;
      let bestAdd = Infinity;
      for (let c = 0; c < t; c++) {
        const add = popcount(adj[v] & colorMask[c]);
        if (add < bestAdd) {
          bestAdd = add;
          bestC = c;
        }
      }
      color[v] = bestC;
      coloredMask |= 1 << v;
      colorMask[bestC] |= 1 << v;
    }
    return color;
  }

  // 确定性首轮改进：按顶点下标升序扫描，换色能严格减少冲突即采纳，直至不动点
  function polishRestricted(adj, n, t, color) {
    const colorMask = new Array(t).fill(0);
    for (let v = 0; v < n; v++) colorMask[color[v]] |= 1 << v;
    let improved = true;
    while (improved) {
      improved = false;
      for (let v = 0; v < n; v++) {
        const cur = color[v];
        let bestC = cur;
        let bestCost = popcount(adj[v] & colorMask[cur]);
        for (let c = 0; c < t; c++) {
          if (c === cur) continue;
          const cost = popcount(adj[v] & colorMask[c]);
          if (cost < bestCost) {
            bestCost = cost;
            bestC = c;
          }
        }
        if (bestC !== cur) {
          colorMask[cur] &= ~(1 << v);
          colorMask[bestC] |= 1 << v;
          color[v] = bestC;
          improved = true;
        }
      }
    }
    return color;
  }

  // 统计着色下的同频干扰边数（每条边在大下标端点处计一次）
  function countConflicts(adj, n, color) {
    let total = 0;
    for (let v = 0; v < n; v++) {
      let m = adj[v];
      while (m) {
        const bit = m & -m;
        const u = lowbitIndex(bit);
        m ^= bit;
        if (u > v && color[u] === color[v]) total++;
      }
    }
    return total;
  }

  function restrictedBnB(adj, n, t) {
    const deg = adj.map(popcount);
    const incumbent = polishRestricted(adj, n, t, greedyRestricted(adj, n, t, deg));
    let best = countConflicts(adj, n, incumbent); // 已知方案上界
    const ub0 = best;
    const cliques = disjointCliques(adj, n); // 互不重叠团
    const color = new Array(n).fill(-1);
    const colorMask = new Array(t).fill(0);
    let coloredMask = 0;
    let nodes = 0;

    // 动态下界一：各团在部分着色下还需产生的必然同频边数之和
    function cliqueLb() {
      let total = 0;
      for (let ci = 0; ci < cliques.length; ci++) {
        const vs = cliques[ci];
        const bins = new Array(t).fill(0);
        let u = 0;
        for (let k = 0; k < vs.length; k++) {
          const cv = color[vs[k]];
          if (cv === -1) u++;
          else bins[cv]++;
        }
        total += minAddedPairs(bins, u);
      }
      return total;
    }

    // 动态下界二：每个未着色顶点相对已着色点集的最少必然冲突之和
    // （此类冲突边恰有一个未着色端点 => 逐点求和不重复计数）
    function vertexLb() {
      let total = 0;
      for (let v = 0; v < n; v++) {
        if (color[v] !== -1) continue;
        let min = Infinity;
        for (let c = 0; c < t; c++) {
          const cnt = popcount(adj[v] & colorMask[c]);
          if (cnt < min) min = cnt;
        }
        total += min;
      }
      return total;
    }

    function remainLb() {
      const a = cliqueLb();
      const b = vertexLb();
      return a > b ? a : b; // 两类下界各自成立，取较大者
    }

    const lb0 = remainLb(); // 全局必然冲突下界（全未着色时）

    // 选点：必然冲突最大（fail-first）；平局 -> 已着色邻居最多 -> 度最大 -> 下标最小
    function pickVertex() {
      let v = -1;
      let vMin = -1;
      for (let i = 0; i < n; i++) {
        if (color[i] !== -1) continue;
        let min = Infinity;
        for (let c = 0; c < t; c++) {
          const cnt = popcount(adj[i] & colorMask[c]);
          if (cnt < min) min = cnt;
        }
        if (
          v === -1 ||
          min > vMin ||
          (min === vMin &&
            (popcount(adj[i] & coloredMask) > popcount(adj[v] & coloredMask) ||
              (popcount(adj[i] & coloredMask) === popcount(adj[v] & coloredMask) &&
                (deg[i] > deg[v] || (deg[i] === deg[v] && i < v)))))
        ) {
          v = i;
          vMin = min;
        }
      }
      return v;
    }

    function assign(v, c) {
      color[v] = c;
      coloredMask |= 1 << v;
      colorMask[c] |= 1 << v;
    }
    function unassign(v, c) {
      color[v] = -1;
      coloredMask &= ~(1 << v);
      colorMask[c] &= ~(1 << v);
    }

    // 阶段一：求最少同频边数 best（仅严格更优才更新；尝色按冲突递增加速收敛）
    function searchMin(cc, coloredCount) {
      nodes++;
      if (coloredCount === n) {
        if (cc < best) best = cc;
        return;
      }
      if (cc + remainLb() >= best) return; // 上界 + 下界剪枝
      const v = pickVertex();
      const order = [];
      for (let c = 0; c < t; c++) order.push(c);
      order.sort(function (c1, c2) {
        const a1 = popcount(adj[v] & colorMask[c1]);
        const a2 = popcount(adj[v] & colorMask[c2]);
        return a1 !== a2 ? a1 - a2 : c1 - c2; // 冲突相同则色号升序（确定性）
      });
      for (let oi = 0; oi < order.length; oi++) {
        const c = order[oi];
        const add = popcount(adj[v] & colorMask[c]);
        if (cc + add >= best) continue;
        assign(v, c);
        searchMin(cc + add, coloredCount + 1);
        unassign(v, c);
      }
    }
    if (lb0 < best) searchMin(0, 0);

    // 阶段二：在「冲突数 == best」的解中按确定性顺序取首个作为规范见证
    let witness = null;
    function searchWitness(cc, coloredCount) {
      nodes++;
      if (witness) return;
      if (coloredCount === n) {
        if (cc === best) witness = color.slice();
        return;
      }
      if (cc + remainLb() > best) return; // 仅需达到 best 的解
      const v = pickVertex();
      for (let c = 0; c < t; c++) {
        const add = popcount(adj[v] & colorMask[c]);
        if (cc + add > best) continue;
        assign(v, c);
        searchWitness(cc + add, coloredCount + 1);
        unassign(v, c);
        if (witness) return;
      }
    }
    searchWitness(0, 0);

    return { m: best, color: witness, lb: lb0, ub0: ub0, nodes: nodes };
  }

  /*
   * 复线审计高层入口：在已有求色结论（原最少频段数 χ）基础上，给定更小的
   * 目标频段数 t，精确求「最少需要解除多少条现有干扰关系，剩余网络才能
   * 按 t 个频段运行」——等价于 t 色受限着色的最少同频边数。
   * 返回：最少解除数、按端点标识规范排序的解除关系、剩余关系上按通道标识
   * 稳定裁决的频段编号与逐频段清单，以及下界 / 上界 / 节点等证明信息。
   */
  function auditGraph(ids, pairs, target) {
    const started = Date.now();
    const t = typeof target === 'string' && /^\d+$/.test(target) ? parseInt(target, 10) : target;
    if (!(typeof t === 'number' && isFinite(t) && Math.floor(t) === t && t >= 1)) {
      throw new Error('目标频段数必须为正整数: ' + target);
    }
    const g = buildGraph(ids, pairs);
    if (pairs.length === 0) {
      throw new Error('当前网络不存在可保留的干扰关系，无法审计');
    }
    const res = restrictedBnB(g.adj, g.n, t);

    // 解除关系 = 规范见证着色下的同频干扰边；端点升序、关系间按端点标识排序
    const removedEdges = [];
    for (const pair of pairs) {
      const i = g.index.get(pair[0]);
      const j = g.index.get(pair[1]);
      if (res.color[i] === res.color[j]) {
        const lo = pair[0] < pair[1] ? pair[0] : pair[1];
        const hi = pair[0] < pair[1] ? pair[1] : pair[0];
        removedEdges.push([lo, hi]);
      }
    }
    removedEdges.sort(function (e1, e2) {
      if (e1[0] !== e2[0]) return e1[0] < e2[0] ? -1 : 1;
      if (e1[1] !== e2[1]) return e1[1] < e2[1] ? -1 : 1;
      return 0;
    });

    // 剩余关系上的规范频段编号（按通道标识稳定裁决）
    const canon = canonicalBands(res.color, g.sorted);
    return {
      target: t,
      removed: removedEdges.length,
      removedEdges: removedEdges,
      bands: canon.bands,
      bandOf: canon.bandOf,
      channels: g.sorted,
      lb: res.lb,
      ub: res.ub0,
      nodes: res.nodes,
      elapsed: Date.now() - started,
    };
  }

  // 复核：返回两端落在同一频段的干扰关系（应为空）
  function verifyAssignment(pairs, bandOf) {
    const violations = [];
    for (const pair of pairs) {
      if (bandOf[pair[0]] === bandOf[pair[1]]) violations.push([pair[0], pair[1]]);
    }
    return violations;
  }

  return {
    solveGraph: solveGraph,
    auditGraph: auditGraph,
    verifyAssignment: verifyAssignment,
    exactColor: exactColor,
    greedyDsatur: greedyDsatur,
    maxClique: maxClique,
    disjointCliques: disjointCliques,
    restrictedBnB: restrictedBnB,
  };
});
