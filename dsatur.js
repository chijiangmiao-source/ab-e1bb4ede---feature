/*
 * 确定性精确求解：最少频段着色 + 复线审计（受限颜色分支定界）。
 *
 * 同一模块同时服务于浏览器 Worker（importScripts）与 Node 测试（require），
 * 保证页面结论与代码测试行为一致。
 *
 * 求色算法要点：
 *  - 顶点顺序固定为通道标识升序，所有平局按顶点下标裁决 => 与录入顺序无关；
 *  - 贪心 DSATUR 给出可行上界（初始 incumbent）；
 *  - Tomita 最大团给出可证明下界，并用于团预着色与全局剪枝；
 *  - 分支定界按 DSATUR 饱和度选点、按颜色编号升序尝试，
 *    「used >= best」与「used + 1 >= best 不得开新色」完成上界剪枝。
 *
 * 复线审计算法要点（目标频段数 k 小于原最少频段数）：
 *  - 受限颜色分支定界：在恰好 k 个频段下最小化同频干扰边数，
 *    该最小值即最少需要解除的干扰关系数；
 *  - 已知方案上界：确定性贪心 k 色重配的冲突数作为初始 incumbent；
 *  - 必然冲突下界：互不重叠团（Tomita 装箱）中剩余未着色顶点必然产生的
 *    同频边，叠加「未着色顶点对已着色邻居的逐点最小冲突」；
 *  - 顶点 0 固定为颜色 0 消除颜色置换对称，所有平局按确定规则裁决。
 * 不使用贪心重配代替精确求解，不做随机搜索，不枚举完整分配，也不逐条试删关系。
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

  // Tomita 最大团（贪心着色界剪枝）：可证明下界；P0 可指定候选集合（默认全集）
  function maxClique(adj, n, P0) {
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
    expand(0, 0, P0 === undefined ? (n >= 31 ? -1 : (1 << n) - 1) : P0);
    return { size: bestSize, mask: bestMask };
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

  /* ---------- 复线审计：受限颜色分支定界最小化同频干扰边 ---------- */

  // k 种颜色下，大小为 s 的团内不可避免的同频边数（颜色类尽量均衡时取到）：
  // s = q*k + r（0 <= r < k）时，r 个类大小 q+1、其余大小 q。
  function cliqueMinConflicts(s, k) {
    if (s <= 1) return 0;
    const q = Math.floor(s / k);
    const r = s - q * k;
    return (r * (q + 1) * q + (k - r) * q * (q - 1)) / 2;
  }

  // 互不重叠团装箱：反复取当前剩余顶点中的最大团（Tomita，确定性）
  function cliquePacking(adj, n) {
    const cliques = [];
    let remaining = n >= 31 ? -1 : (1 << n) - 1;
    while (remaining !== 0) {
      const c = maxClique(adj, n, remaining);
      if (c.size < 2) break;
      cliques.push(c.mask);
      remaining &= ~c.mask;
    }
    return cliques;
  }

  // 确定性贪心 k 色重配：已知方案上界（仅提供 incumbent，不代替精确求解）
  function greedyKColor(adj, n, k, deg) {
    const color = new Array(n).fill(-1);
    const sat = new Array(n).fill(0);
    const nbrColorCount = [];
    for (let i = 0; i < n; i++) nbrColorCount.push(new Array(k).fill(0));
    let cost = 0;
    let colored = 0;
    while (colored < n) {
      const v = pickVertex(color, sat, deg, n);
      // 冲突最少的颜色；平局按颜色编号升序（确定性）
      let cBest = 0;
      for (let c = 1; c < k; c++) {
        if (nbrColorCount[v][c] < nbrColorCount[v][cBest]) cBest = c;
      }
      color[v] = cBest;
      cost += nbrColorCount[v][cBest];
      colored++;
      let m = adj[v];
      while (m) {
        const bit = m & -m;
        const u = lowbitIndex(bit);
        m ^= bit;
        if (color[u] === -1) {
          if (nbrColorCount[u][cBest] === 0) sat[u]++;
          nbrColorCount[u][cBest]++;
        }
      }
    }
    return { color: color, cost: cost };
  }

  /*
   * 受限颜色分支定界：在恰好 k 个频段下最小化同频干扰边数。
   *  - 已知方案上界：贪心 k 色重配的冲突数作为初始 incumbent；
   *  - 必然冲突下界：互不重叠团中剩余未着色顶点必然产生的同频边，
   *    叠加未着色顶点对已着色邻居的逐点最小冲突（三类边集互不相交，可相加）；
   *  - 顶点 0 固定为颜色 0 消除颜色置换对称；所有平局按确定规则裁决。
   */
  function exactMinConflicts(adj, n, k) {
    const deg = adj.map(popcount);
    const greedy = greedyKColor(adj, n, k, deg);
    let best = greedy.cost; // 已知方案上界
    let bestColor = greedy.color.slice();

    // 必然冲突下界：互不重叠团
    const f = new Array(n + 1);
    for (let s = 0; s <= n; s++) f[s] = cliqueMinConflicts(s, k);
    const cliques = cliquePacking(adj, n);
    const cliqueOf = new Array(n).fill(-1);
    const rem = [];
    let cliqueBound = 0;
    cliques.forEach(function (mask, i) {
      const sz = popcount(mask);
      rem.push(sz);
      cliqueBound += f[sz];
      let m = mask;
      while (m) {
        const bit = m & -m;
        cliqueOf[lowbitIndex(bit)] = i;
        m ^= bit;
      }
    });
    const rootLb = cliqueBound; // 根节点必然冲突下界（此时逐点项为 0）
    let nodes = 0;

    if (best > rootLb) {
      const color = new Array(n).fill(-1);
      const sat = new Array(n).fill(0);
      const nbrColorCount = [];
      for (let i = 0; i < n; i++) nbrColorCount.push(new Array(k).fill(0));
      const minExtra = new Array(n).fill(0); // 未着色顶点对已着色邻居的最小冲突
      let extraBound = 0;
      let cost = 0;
      let coloredCount = 0;

      function assign(v, c) {
        color[v] = c;
        extraBound -= minExtra[v]; // v 已着色，其逐点项不再计入
        let m = adj[v];
        while (m) {
          const bit = m & -m;
          const u = lowbitIndex(bit);
          m ^= bit;
          if (color[u] === -1) {
            if (nbrColorCount[u][c] === 0) sat[u]++;
            nbrColorCount[u][c]++;
            let mn = nbrColorCount[u][0];
            for (let c2 = 1; c2 < k; c2++) if (nbrColorCount[u][c2] < mn) mn = nbrColorCount[u][c2];
            extraBound += mn - minExtra[u];
            minExtra[u] = mn;
          }
        }
        const ci = cliqueOf[v];
        if (ci !== -1) {
          cliqueBound -= f[rem[ci]];
          rem[ci]--;
          cliqueBound += f[rem[ci]];
        }
      }
      function unassign(v, c) {
        const ci = cliqueOf[v];
        if (ci !== -1) {
          cliqueBound -= f[rem[ci]];
          rem[ci]++;
          cliqueBound += f[rem[ci]];
        }
        let m = adj[v];
        while (m) {
          const bit = m & -m;
          const u = lowbitIndex(bit);
          m ^= bit;
          if (color[u] === -1) {
            nbrColorCount[u][c]--;
            if (nbrColorCount[u][c] === 0) sat[u]--;
            let mn = nbrColorCount[u][0];
            for (let c2 = 1; c2 < k; c2++) if (nbrColorCount[u][c2] < mn) mn = nbrColorCount[u][c2];
            extraBound += mn - minExtra[u];
            minExtra[u] = mn;
          }
        }
        color[v] = -1;
        // v 重新成为未着色：其逐点项按当前已着色邻居重新计入
        let mn = nbrColorCount[v][0];
        for (let c2 = 1; c2 < k; c2++) if (nbrColorCount[v][c2] < mn) mn = nbrColorCount[v][c2];
        minExtra[v] = mn;
        extraBound += mn;
      }

      function search() {
        nodes++;
        if (best === rootLb) return; // 已达必然冲突下界，全局最优
        if (coloredCount === n) {
          if (cost < best) {
            best = cost;
            bestColor = color.slice();
          }
          return;
        }
        if (cost + extraBound + cliqueBound >= best) return; // 下界剪枝
        const v = pickVertex(color, sat, deg, n);
        // 颜色尝试顺序：边际冲突升序，平局按颜色编号升序（确定性）
        const order = [];
        for (let c = 0; c < k; c++) order.push(c);
        order.sort(function (a, b) {
          return nbrColorCount[v][a] - nbrColorCount[v][b] || a - b;
        });
        for (let i = 0; i < order.length; i++) {
          const c = order[i];
          const add = nbrColorCount[v][c];
          if (cost + add >= best) continue; // 仅已着色部分即不可能更优
          cost += add;
          assign(v, c);
          coloredCount++;
          search();
          coloredCount--;
          unassign(v, c);
          cost -= add;
          if (best === rootLb) return;
        }
      }

      // 颜色置换对称性：顶点 0 固定为颜色 0（最优解经颜色置换必然可达）
      assign(0, 0);
      coloredCount = 1;
      search();
    }

    return { cost: best, color: bestColor, rootLb: rootLb, greedyCost: greedy.cost, nodes: nodes };
  }

  /* ---------- 共享：建图与规范频段编号 ---------- */

  // 任意顺序的通道标识 + 无向干扰关系 -> 升序顶点下标与邻接位掩码
  function indexGraph(ids, pairs) {
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
  function canonicalize(colors, k, sorted) {
    const n = sorted.length;
    const classMin = new Array(k).fill(Number.MAX_SAFE_INTEGER);
    for (let v = 0; v < n; v++) {
      if (v < classMin[colors[v]]) classMin[colors[v]] = v;
    }
    const order = [];
    for (let c = 0; c < k; c++) order.push(c);
    order.sort(function (c1, c2) {
      return classMin[c1] - classMin[c2];
    });
    const relabel = new Array(k).fill(0);
    order.forEach(function (c, i) {
      relabel[c] = i + 1;
    });
    const bandOf = {};
    const bands = [];
    for (let i = 0; i < k; i++) bands.push([]);
    for (let v = 0; v < n; v++) {
      const b = relabel[colors[v]];
      bandOf[sorted[v]] = b;
      bands[b - 1].push(sorted[v]);
    }
    return { bandOf: bandOf, bands: bands };
  }

  /*
   * 求色高层入口：任意顺序的通道标识 + 无向干扰关系 -> 规范结论。
   * 顶点按通道标识升序排列后求解，再按「各频段最小通道标识升序」重编号，
   * 因此改变录入顺序结论保持一致。
   */
  function solveGraph(ids, pairs) {
    const started = Date.now();
    const g = indexGraph(ids, pairs);
    const res = exactColor(g.adj, g.n);
    const canon = canonicalize(res.colors, res.k, g.sorted);
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
   * 复线审计高层入口：在目标频段数 target（小于原最少频段数）下，
   * 精确求解最少需要解除的干扰关系，使剩余网络按目标频段运行。
   * 解除关系按端点标识规范排序；剩余网络上的频段编号按通道标识稳定裁决，
   * 因此改变录入顺序审计结论保持一致。
   */
  function auditGraph(ids, pairs, target) {
    const started = Date.now();
    if (!(target >= 1) || Math.floor(target) !== target) {
      throw new Error('目标频段数必须为正整数: ' + target);
    }
    const g = indexGraph(ids, pairs);
    const res = exactMinConflicts(g.adj, g.n, target);
    const canon = canonicalize(res.color, target, g.sorted);

    // 解除关系：同频干扰边；端点按标识升序规范，整表按端点标识规范排序
    const removed = [];
    for (const pair of pairs) {
      const i = g.index.get(pair[0]);
      const j = g.index.get(pair[1]);
      if (res.color[i] === res.color[j]) {
        removed.push(pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]]);
      }
    }
    removed.sort(function (e1, e2) {
      if (e1[0] !== e2[0]) return e1[0] < e2[0] ? -1 : 1;
      if (e1[1] !== e2[1]) return e1[1] < e2[1] ? -1 : 1;
      return 0;
    });

    return {
      target: target,
      removedCount: removed.length,
      removed: removed,
      kept: pairs.length - removed.length,
      total: pairs.length,
      bands: canon.bands,
      bandOf: canon.bandOf,
      channels: g.sorted,
      lb: res.rootLb,
      ub: res.greedyCost,
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
    exactMinConflicts: exactMinConflicts,
    greedyDsatur: greedyDsatur,
    greedyKColor: greedyKColor,
    maxClique: maxClique,
    cliquePacking: cliquePacking,
  };
});
