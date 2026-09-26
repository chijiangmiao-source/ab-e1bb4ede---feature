/*
 * 页面主逻辑：录入校验、Worker 调度、结论渲染、复线审计。
 *
 * 过期任务防护：jobSeq 单调递增，任何「编辑 / 取消 / 再次提交 / 再次发起审计」
 * 都会使其前进并终止在跑的 Worker；Worker 回包必须携带当前 jobId 且仍是当前
 * Worker，否则一律丢弃 —— 迟到的旧任务不得覆盖当前草稿、原有求色结论或较新的
 * 复线结果。
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var channelsEl = $('channels');
  var edgesEl = $('edges');
  var submitBtn = $('submit');
  var cancelBtn = $('cancel');
  var statusEl = $('status');
  var errorsEl = $('errors');
  var resultPanel = $('resultPanel');
  var staleEl = $('stale');
  var summaryEl = $('summary');
  var assignmentBody = document.querySelector('#assignment tbody');
  var bandsEl = $('bands');
  var verificationEl = $('verification');

  var auditPanel = $('auditPanel');
  var auditHintEl = $('auditHint');
  var targetEl = $('target');
  var auditSubmitBtn = $('auditSubmit');
  var auditCancelBtn = $('auditCancel');
  var auditStatusEl = $('auditStatus');
  var auditErrorsEl = $('auditErrors');
  var auditResultEl = $('auditResult');
  var auditSummaryEl = $('auditSummary');
  var removedEl = $('removed');
  var auditAssignmentBody = document.querySelector('#auditAssignment tbody');
  var auditBandsEl = $('auditBands');
  var auditVerificationEl = $('auditVerification');

  var jobSeq = 0; // 任务序号：编辑 / 取消 / 提交 / 发起审计时递增
  var worker = null; // 当前在跑的 Worker（若有）
  var lastSolve = null; // 当前有效求色结论及其输入 {channels, edges, result}

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    cancelBtn.disabled = true;
    auditCancelBtn.disabled = true;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function setAuditStatus(text, cls) {
    auditStatusEl.textContent = text;
    auditStatusEl.className = cls || '';
  }

  function showErrors(messages) {
    errorsEl.textContent = '';
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      errorsEl.appendChild(li);
    });
  }

  function showAuditErrors(messages) {
    auditErrorsEl.textContent = '';
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      auditErrorsEl.appendChild(li);
    });
  }

  function edgeKey(pair) {
    return JSON.stringify(pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]]);
  }

  function clearResults() {
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    summaryEl.textContent = '';
    assignmentBody.textContent = '';
    bandsEl.textContent = '';
    verificationEl.textContent = '';
  }

  // 清除本次审计证据（拒绝审计 / 重新求解 / 编辑时调用）
  function clearAuditEvidence() {
    auditResultEl.hidden = true;
    auditSummaryEl.textContent = '';
    removedEl.textContent = '';
    auditAssignmentBody.textContent = '';
    auditBandsEl.textContent = '';
    auditVerificationEl.textContent = '';
  }

  function hideAuditPanel() {
    auditPanel.hidden = true;
    clearAuditEvidence();
    showAuditErrors([]);
    setAuditStatus('');
    targetEl.value = '';
  }

  function markStale() {
    if (!resultPanel.hidden) {
      resultPanel.classList.add('stale-on');
      staleEl.hidden = false;
    }
  }

  function onEdit() {
    jobSeq++; // 使任何在途旧任务的结论失效
    stopWorker();
    lastSolve = null;
    markStale();
    hideAuditPanel(); // 审计以有效结论为前提，输入变更后一律收回
    setStatus('输入已修改，既有结论已失效，请重新提交。', 'muted');
  }
  channelsEl.addEventListener('input', onEdit);
  edgesEl.addEventListener('input', onEdit);

  cancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setStatus('已取消本次求解。', 'muted');
  });

  auditCancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setAuditStatus('已取消本次复线审计。', 'muted');
  });

  function validate() {
    var ch = Validate.parseChannels(channelsEl.value);
    var ed = Validate.parseEdges(edgesEl.value, new Set(ch.channels));
    var errors = ch.errors.concat(ed.errors).map(function (e) {
      return e.message;
    });
    return { ok: errors.length === 0, channels: ch.channels, edges: ed.edges, errors: errors };
  }

  function renderResult(msg, edges) {
    resultPanel.hidden = false;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;

    summaryEl.textContent =
      '最少频段数 χ = ' +
      msg.k +
      '；可证明下界（最大团）= ' +
      msg.lb +
      '；初始可行上界 = ' +
      msg.ub +
      '；分支定界节点 = ' +
      msg.nodes +
      '；耗时 ' +
      msg.elapsed +
      ' ms。';

    assignmentBody.textContent = '';
    msg.channels.forEach(function (id) {
      var tr = document.createElement('tr');
      var tdId = document.createElement('td');
      tdId.textContent = id;
      var tdBand = document.createElement('td');
      tdBand.textContent = '频段 ' + msg.bandOf[id];
      tr.appendChild(tdId);
      tr.appendChild(tdBand);
      assignmentBody.appendChild(tr);
    });

    bandsEl.textContent = '';
    msg.bands.forEach(function (members, i) {
      var li = document.createElement('li');
      li.textContent =
        '频段 ' + (i + 1) + '（' + members.length + ' 个通道）：' + members.join('、') + ' —— 组内无干扰边';
      bandsEl.appendChild(li);
    });

    // 主线程复核：每条干扰边两端必须落在不同频段，结论可复算
    var bad = edges.filter(function (pair) {
      return msg.bandOf[pair[0]] === msg.bandOf[pair[1]];
    });
    var covered = msg.channels.every(function (id) {
      return msg.bandOf[id] >= 1 && msg.bandOf[id] <= msg.k;
    });
    if (bad.length === 0 && covered && msg.bands.length === msg.k) {
      verificationEl.textContent =
        '复核通过：' + edges.length + ' 条干扰边的两端均分属不同频段，各频段内部不存在干扰边。';
      verificationEl.className = 'ok-text';
    } else {
      verificationEl.textContent = '复核失败：求解结果与输入不一致，请重新提交。';
      verificationEl.className = 'error-text';
    }

    // 结论就绪：开放复线审计入口（旧的审计证据一律清除）
    clearAuditEvidence();
    showAuditErrors([]);
    setAuditStatus('');
    auditHintEl.textContent =
      '原最少频段数 χ = ' + msg.k + '：目标频段数须为小于 χ 的正整数，审计在 Worker 内精确求解。';
    auditPanel.hidden = false;
  }

  function renderAudit(msg, edges) {
    auditResultEl.hidden = false;

    auditSummaryEl.textContent =
      '最少解除数 = ' +
      msg.removedCount +
      '（共 ' +
      msg.total +
      ' 条干扰关系，保留 ' +
      msg.kept +
      ' 条）；目标频段数 = ' +
      msg.target +
      '；必然冲突下界（互不重叠团）= ' +
      msg.lb +
      '；已知方案上界 = ' +
      msg.ub +
      '；分支定界节点 = ' +
      msg.nodes +
      '；耗时 ' +
      msg.elapsed +
      ' ms。';

    removedEl.textContent = '';
    msg.removed.forEach(function (pair) {
      var li = document.createElement('li');
      li.textContent = pair[0] + ' — ' + pair[1];
      removedEl.appendChild(li);
    });

    auditAssignmentBody.textContent = '';
    msg.channels.forEach(function (id) {
      var tr = document.createElement('tr');
      var tdId = document.createElement('td');
      tdId.textContent = id;
      var tdBand = document.createElement('td');
      tdBand.textContent = '频段 ' + msg.bandOf[id];
      tr.appendChild(tdId);
      tr.appendChild(tdBand);
      auditAssignmentBody.appendChild(tr);
    });

    auditBandsEl.textContent = '';
    msg.bands.forEach(function (members, i) {
      var li = document.createElement('li');
      li.textContent =
        '频段 ' +
        (i + 1) +
        '（' +
        members.length +
        ' 个通道）：' +
        members.join('、') +
        ' —— 剩余关系上组内无干扰边';
      auditBandsEl.appendChild(li);
    });

    // 主线程复核（可复算）：解除集必须恰为全部同频干扰边，
    // 且每条解除关系都真实存在于录入的干扰关系中。
    var edgeKeys = new Set(edges.map(edgeKey));
    var removedKeys = new Set(msg.removed.map(edgeKey));
    var mono = 0;
    var monoAllRemoved = true;
    edges.forEach(function (pair) {
      if (msg.bandOf[pair[0]] === msg.bandOf[pair[1]]) {
        mono++;
        if (!removedKeys.has(edgeKey(pair))) monoAllRemoved = false;
      }
    });
    var removedAreEdges = msg.removed.every(function (pair) {
      return edgeKeys.has(edgeKey(pair));
    });
    var covered = msg.channels.every(function (id) {
      return msg.bandOf[id] >= 1 && msg.bandOf[id] <= msg.target;
    });
    if (
      monoAllRemoved &&
      removedAreEdges &&
      mono === msg.removedCount &&
      msg.removed.length === msg.removedCount &&
      msg.kept + msg.removedCount === msg.total &&
      covered &&
      msg.bands.length === msg.target
    ) {
      auditVerificationEl.textContent =
        '复核通过：解除 ' +
        msg.removedCount +
        ' 条关系后，剩余 ' +
        msg.kept +
        ' 条干扰边的两端均分属不同频段，各频段内部不存在干扰边。';
      auditVerificationEl.className = 'ok-text';
    } else {
      auditVerificationEl.textContent = '复核失败：审计结果与输入不一致，请重新发起。';
      auditVerificationEl.className = 'error-text';
    }
  }

  function submit() {
    jobSeq++;
    stopWorker();
    showErrors([]);

    var v = validate();
    if (!v.ok) {
      clearResults(); // 清除既有成功证据
      hideAuditPanel();
      lastSolve = null;
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }

    var jobId = jobSeq;
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    hideAuditPanel();
    lastSolve = null;
    setStatus('求解中（Worker 内执行确定性 DSATUR 分支定界）…', 'busy');

    var w = new Worker('worker.js');
    worker = w;
    cancelBtn.disabled = false;

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        setStatus('求解失败：' + msg.message, 'error');
        return;
      }
      lastSolve = { channels: v.channels, edges: v.edges, result: msg };
      renderResult(msg, v.edges);
      setStatus('求解完成。', 'ok');
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      setStatus('Worker 执行异常：' + (ev.message || '未知错误'), 'error');
    };
    w.postMessage({ jobId: jobId, channels: v.channels, edges: v.edges });
  }
  submitBtn.addEventListener('click', submit);

  function submitAudit() {
    if (!lastSolve) {
      setAuditStatus('复线审计需要一份有效的求色结论：请先提交求解。', 'error');
      return;
    }
    var parsed = Validate.parseAuditTarget(targetEl.value, lastSolve.result.k, lastSolve.edges.length);
    // 清除本次审计证据：无论校验成败，既有审计结果一律收回
    clearAuditEvidence();
    showAuditErrors([]);
    if (parsed.errors.length > 0) {
      // 拒绝审计：仅清除审计证据，原有求色结论保持可用
      showAuditErrors(
        parsed.errors.map(function (e) {
          return e.message;
        })
      );
      setAuditStatus('复线审计被拒绝：请按提示修正后重新发起。', 'error');
      return;
    }

    jobSeq++;
    stopWorker();
    var jobId = jobSeq;
    var auditChannels = lastSolve.channels;
    var auditEdges = lastSolve.edges;
    setAuditStatus('审计中（Worker 内执行受限颜色分支定界，最小化同频干扰边）…', 'busy');

    var w = new Worker('worker.js');
    worker = w;
    auditCancelBtn.disabled = false;

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        setAuditStatus('审计失败：' + msg.message, 'error');
        return;
      }
      renderAudit(msg, auditEdges);
      setAuditStatus('复线审计完成。', 'ok');
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      setAuditStatus('Worker 执行异常：' + (ev.message || '未知错误'), 'error');
    };
    w.postMessage({ jobId: jobId, mode: 'audit', channels: auditChannels, edges: auditEdges, target: parsed.target });
  }
  auditSubmitBtn.addEventListener('click', submitAudit);

  var EXAMPLES = {
    triangle: {
      channels: 'CH1 CH2 CH3',
      edges: 'CH1 CH2\nCH2 CH3\nCH1 CH3',
    },
    k4: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH1 CH3\nCH1 CH4\nCH2 CH3\nCH2 CH4\nCH3 CH4',
    },
    chain: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH2 CH3\nCH3 CH4',
    },
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-example]'), function (btn) {
    btn.addEventListener('click', function () {
      var ex = EXAMPLES[btn.getAttribute('data-example')];
      channelsEl.value = ex.channels;
      edgesEl.value = ex.edges;
      onEdit();
      setStatus('已载入示例，点击「提交求解」。', 'muted');
    });
  });
})();
