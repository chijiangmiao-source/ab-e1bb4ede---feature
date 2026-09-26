/*
 * 页面主逻辑：录入校验、Worker 调度、结论渲染、复线审计。
 *
 * 过期任务防护：jobSeq 单调递增，任何「编辑 / 取消 / 提交求解 / 发起或取消审计 /
 * 修改审计草稿」都会使其前进并终止在跑的 Worker；Worker 回包必须携带当前 jobId
 * 且仍是当前 Worker，否则一律丢弃 —— 迟到的旧任务不得覆盖当前草稿、原有求色
 * 结论或较新的复线结果。
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

  var auditTargetEl = $('auditTarget');
  var auditLaunchBtn = $('auditLaunch');
  var auditCancelBtn = $('auditCancel');
  var auditStatusEl = $('auditStatus');
  var auditErrorsEl = $('auditErrors');
  var auditResultEl = $('auditResult');
  var auditSummaryEl = $('auditSummary');
  var removedListEl = $('removedList');
  var auditAssignmentBody = document.querySelector('#auditAssignment tbody');
  var auditBandsEl = $('auditBands');
  var auditVerificationEl = $('auditVerification');

  var jobSeq = 0; // 任务序号：编辑 / 取消 / 提交 / 发起审计 / 修改审计草稿时递增
  var worker = null; // 当前在跑的 Worker（若有）
  var lastSolve = null; // 当前有效求色结论 { msg, channels, edges }，供复线审计使用

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

  // 清除本次审计证据（结果、提示、状态），但保留目标频段草稿
  function clearAudit() {
    auditResultEl.hidden = true;
    auditSummaryEl.textContent = '';
    removedListEl.textContent = '';
    auditAssignmentBody.textContent = '';
    auditBandsEl.textContent = '';
    auditVerificationEl.textContent = '';
    auditErrorsEl.textContent = '';
    auditStatusEl.textContent = '';
    auditStatusEl.className = '';
  }

  function clearResults() {
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    summaryEl.textContent = '';
    assignmentBody.textContent = '';
    bandsEl.textContent = '';
    verificationEl.textContent = '';
    clearAudit();
    auditLaunchBtn.disabled = true;
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
    markStale();
    clearAudit(); // 审计证据依附于旧结论，一并清除
    auditLaunchBtn.disabled = true; // 结论失效期间禁止发起审计
    setStatus('输入已修改，既有结论已失效，请重新提交。', 'muted');
  }
  channelsEl.addEventListener('input', onEdit);
  edgesEl.addEventListener('input', onEdit);

  cancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setStatus('已取消本次求解。', 'muted');
  });

  function validate() {
    var ch = Validate.parseChannels(channelsEl.value);
    var ed = Validate.parseEdges(edgesEl.value, new Set(ch.channels));
    var errors = ch.errors.concat(ed.errors).map(function (e) {
      return e.message;
    });
    return { ok: errors.length === 0, channels: ch.channels, edges: ed.edges, errors: errors };
  }

  // 统一 Worker 调度：kind 为 'solve' 或 'audit'，回包先过过期防护再按类型分发
  function runJob(kind, payload, onResult, onError) {
    var jobId = jobSeq;
    var w = new Worker('worker.js');
    worker = w;
    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        onError(msg.message);
        return;
      }
      onResult(msg);
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      onError(ev.message || '未知错误');
    };
    payload.jobId = jobId;
    payload.mode = kind;
    w.postMessage(payload);
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
  }

  function renderAudit(msg, edges) {
    auditResultEl.hidden = false;

    auditSummaryEl.textContent =
      '最少解除数 = ' +
      msg.removed +
      '；目标频段数 = ' +
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

    removedListEl.textContent = '';
    msg.removedEdges.forEach(function (pair) {
      var li = document.createElement('li');
      li.textContent = pair[0] + ' — ' + pair[1];
      removedListEl.appendChild(li);
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
        '频段 ' + (i + 1) + '（' + members.length + ' 个通道）：' + members.join('、') + ' —— 组内无干扰边';
      auditBandsEl.appendChild(li);
    });

    // 主线程复核（可复算）：同频边必须恰为解除关系，保留关系两端必须分属不同频段
    var removedKeys = new Set(
      msg.removedEdges.map(function (pair) {
        return JSON.stringify(pair);
      })
    );
    var bad = [];
    var kept = 0;
    edges.forEach(function (pair) {
      var key = JSON.stringify(pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]]);
      var same = msg.bandOf[pair[0]] === msg.bandOf[pair[1]];
      if (same !== removedKeys.has(key)) bad.push(pair);
      if (!same) kept++;
    });
    var covered = msg.channels.every(function (id) {
      return msg.bandOf[id] >= 1 && msg.bandOf[id] <= msg.bands.length;
    });
    if (
      bad.length === 0 &&
      covered &&
      msg.removed === msg.removedEdges.length &&
      msg.bands.length <= msg.target
    ) {
      auditVerificationEl.textContent =
        '复核通过：解除 ' +
        msg.removed +
        ' 条关系后，剩余 ' +
        kept +
        ' 条保留关系的两端均分属不同频段，各频段内部不存在干扰边。';
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
    clearAudit();
    auditLaunchBtn.disabled = true;

    var v = validate();
    if (!v.ok) {
      clearResults(); // 清除既有成功证据
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }

    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    setStatus('求解中（Worker 内执行确定性 DSATUR 分支定界）…', 'busy');
    cancelBtn.disabled = false;

    runJob(
      'solve',
      { channels: v.channels, edges: v.edges },
      function (msg) {
        lastSolve = { msg: msg, channels: v.channels, edges: v.edges };
        renderResult(msg, v.edges);
        clearAudit(); // 新结论取代任何旧审计证据
        auditLaunchBtn.disabled = false; // 结论新鲜，允许发起复线审计
        setStatus('求解完成。', 'ok');
      },
      function (message) {
        setStatus('求解失败：' + message, 'error');
      }
    );
  }
  submitBtn.addEventListener('click', submit);

  // 修改目标频段草稿：使在途审计失效并清除其证据，草稿本身保留
  auditTargetEl.addEventListener('input', function () {
    jobSeq++;
    stopWorker();
    clearAudit();
    setAuditStatus('目标频段数已修改，既有审计结论已失效，请重新发起。', 'muted');
  });

  auditCancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setAuditStatus('已取消本次审计。', 'muted');
  });

  function launchAudit() {
    jobSeq++;
    stopWorker();
    clearAudit(); // 清除上一次审计证据

    if (!lastSolve) {
      setAuditStatus('无有效求色结论，请先提交求解。', 'error');
      return;
    }
    var v = validate();
    if (!v.ok) {
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }
    var chk = Validate.parseAuditTarget(auditTargetEl.value, lastSolve.msg.k, v.edges.length);
    if (!chk.ok) {
      // 拒绝审计：定位反馈并清除本次审计证据，原有求色结论保持可用
      showAuditErrors(
        chk.errors.map(function (e) {
          return e.message;
        })
      );
      setAuditStatus('复线审计被拒绝：请按提示修正后重新发起。', 'error');
      return;
    }

    setAuditStatus('审计中（Worker 内执行受限颜色分支定界）…', 'busy');
    auditCancelBtn.disabled = false;

    runJob(
      'audit',
      { channels: v.channels, edges: v.edges, target: chk.target },
      function (msg) {
        renderAudit(msg, v.edges);
        setAuditStatus('审计完成。', 'ok');
      },
      function (message) {
        setAuditStatus('审计失败：' + message, 'error');
      }
    );
  }
  auditLaunchBtn.addEventListener('click', launchAudit);

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
