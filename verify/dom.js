/*
 * 页面行为测试：最小 DOM 仿真驱动 main.js，验证复线审计交互与过期任务防护。
 * 由 verify/run.js 调用（node verify/run.js），不直接运行。
 *
 * 覆盖：求解 -> 审计 -> 渲染；目标不小于原最少数 / 格式非法时拒绝审计并清除
 * 本次审计证据且原结论保持可用；编辑、取消、再次发起审计、重新求解时，
 * 迟到的 Worker 结果不得覆盖当前草稿、原有求色结论或较新的复线结果。
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DSATUR = require(path.join(ROOT, 'dsatur.js'));

class El {
  constructor(id) {
    this.id = id;
    this.children = [];
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this._cls = new Set();
    this.listeners = {};
  }
  get classList() {
    const s = this._cls;
    return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  dispatch(t) {
    (this.listeners[t] || []).slice().forEach((f) => f({}));
  }
  getAttribute() {
    return null;
  }
}

class FakeWorker {
  constructor(url, registry) {
    this.url = url;
    this.terminated = false;
    registry.push(this);
  }
  postMessage(msg) {
    this.lastMsg = msg;
  }
  terminate() {
    this.terminated = true;
  }
  respond(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}

// 搭建一次页面仿真，返回操作句柄
function setupPage() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, new El(id));
    return els.get(id);
  };
  const workers = [];
  const document = {
    getElementById: (id) => el(id),
    querySelector: (sel) => el('qs:' + sel),
    querySelectorAll: () => [],
    createElement: (tag) => new El('<' + tag + '>'),
  };
  const sandbox = {
    document,
    Worker: function (url) {
      return new FakeWorker(url, workers);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'validate.js'), 'utf8'), sandbox, { filename: 'validate.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), sandbox, { filename: 'main.js' });
  return { el, workers };
}

const TRI_IDS = ['CH1', 'CH2', 'CH3'];
const TRI_EDGES = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3']];

function solveMsg() {
  return Object.assign({ type: 'result' }, DSATUR.solveGraph(TRI_IDS, TRI_EDGES));
}
function auditMsg() {
  return Object.assign({ type: 'audit' }, DSATUR.auditGraph(TRI_IDS, TRI_EDGES, 2));
}

// 录入三角网络并提交，且让 Worker 立即回包
function solve(page) {
  page.el('channels').value = 'CH1 CH2 CH3';
  page.el('edges').value = 'CH1 CH2\nCH2 CH3\nCH1 CH3';
  page.el('submit').dispatch('click');
  const w = page.workers[page.workers.length - 1];
  w.respond(Object.assign({ jobId: w.lastMsg.jobId }, solveMsg()));
  return w;
}

function lastWorker(page) {
  return page.workers[page.workers.length - 1];
}

module.exports = function registerDomTests(test) {
  test('页面：求解就绪后开放复线审计，审计结果完整渲染', () => {
    const page = setupPage();
    solve(page);
    assert.strictEqual(page.el('resultPanel').hidden, false, '结论应显示');
    assert.strictEqual(page.el('auditPanel').hidden, false, '审计面板应随结论开放');
    page.el('target').value = '2';
    page.el('auditSubmit').dispatch('click');
    const w = lastWorker(page);
    assert.strictEqual(w.lastMsg.mode, 'audit');
    assert.strictEqual(w.lastMsg.target, 2);
    assert.strictEqual(page.el('auditCancel').disabled, false);
    w.respond(Object.assign({ jobId: w.lastMsg.jobId }, auditMsg()));
    assert.strictEqual(page.el('auditResult').hidden, false, '审计结果应渲染');
    assert.strictEqual(page.el('removed').children.length, 1);
    assert.strictEqual(page.el('removed').children[0].textContent, 'CH1 — CH3');
    assert.match(page.el('auditSummary').textContent, /最少解除数 = 1/);
    assert.match(page.el('auditVerification').textContent, /复核通过/);
  });

  test('页面：不降低频段数时拒绝审计，清除审计证据且原结论保持可用', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = '3'; // 等于原最少频段数 χ=3
    const before = page.workers.length;
    page.el('auditSubmit').dispatch('click');
    assert.strictEqual(page.workers.length, before, '拒绝时不应创建 Worker');
    assert.strictEqual(page.el('auditResult').hidden, true, '本次审计证据应被清除');
    assert.ok(page.el('auditErrors').children.length >= 1, '应给出定位反馈');
    assert.match(page.el('auditErrors').children[0].textContent, /不小于原最少频段数/);
    assert.strictEqual(page.el('resultPanel').hidden, false, '原结论保持可用');
    assert.match(page.el('summary').textContent, /χ = 3/);
  });

  test('页面：目标格式非法被定位反馈并清除本次审计证据', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = 'abc';
    page.el('auditSubmit').dispatch('click');
    assert.strictEqual(page.el('auditResult').hidden, true);
    assert.match(page.el('auditErrors').children[0].textContent, /格式非法/);
    assert.strictEqual(page.el('resultPanel').hidden, false, '原结论保持可用');
  });

  test('页面：编辑输入时在途审计被终止，迟到结果不得覆盖', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = '2';
    page.el('auditSubmit').dispatch('click');
    const w = lastWorker(page);
    const jobId = w.lastMsg.jobId;
    page.el('channels').dispatch('input'); // 编辑输入
    assert.strictEqual(w.terminated, true, '编辑应终止在途审计 Worker');
    assert.strictEqual(page.el('auditPanel').hidden, true, '编辑后审计面板收回');
    w.respond(Object.assign({ jobId }, auditMsg())); // 迟到结果
    assert.strictEqual(page.el('auditResult').hidden, true, '迟到审计结果不得渲染');
    assert.strictEqual(page.el('removed').children.length, 0, '迟到结果不得写入解除清单');
    assert.ok(page.el('resultPanel').classList.contains('stale-on'), '原结论应标记失效而非被覆盖');
  });

  test('页面：再次发起审计时，旧审计迟到结果不得覆盖较新的复线结果', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = '2';
    page.el('auditSubmit').dispatch('click');
    const wA = lastWorker(page);
    page.el('auditSubmit').dispatch('click'); // 再次发起
    const wB = lastWorker(page);
    assert.strictEqual(wA.terminated, true, '再次发起应终止旧审计 Worker');
    wA.respond(Object.assign({ jobId: wA.lastMsg.jobId }, auditMsg())); // A 迟到
    assert.strictEqual(page.el('auditResult').hidden, true, '旧审计迟到结果不得渲染');
    wB.respond(Object.assign({ jobId: wB.lastMsg.jobId }, auditMsg()));
    assert.strictEqual(page.el('auditResult').hidden, false, '较新审计结果应正常渲染');
    assert.strictEqual(page.el('removed').children.length, 1);
  });

  test('页面：取消审计后迟到结果被丢弃', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = '2';
    page.el('auditSubmit').dispatch('click');
    const w = lastWorker(page);
    const jobId = w.lastMsg.jobId;
    page.el('auditCancel').dispatch('click');
    assert.strictEqual(w.terminated, true);
    assert.match(page.el('auditStatus').textContent, /已取消/);
    w.respond(Object.assign({ jobId }, auditMsg()));
    assert.strictEqual(page.el('auditResult').hidden, true, '取消后迟到结果不得渲染');
  });

  test('页面：审计在途时重新提交求解，迟到审计结果被丢弃', () => {
    const page = setupPage();
    solve(page);
    page.el('target').value = '2';
    page.el('auditSubmit').dispatch('click');
    const w = lastWorker(page);
    const jobId = w.lastMsg.jobId;
    page.el('submit').dispatch('click'); // 重新求解
    assert.strictEqual(w.terminated, true, '重新求解应终止在途审计');
    w.respond(Object.assign({ jobId }, auditMsg())); // 迟到审计
    assert.strictEqual(page.el('auditResult').hidden, true);
    const wSolve = lastWorker(page);
    wSolve.respond(Object.assign({ jobId: wSolve.lastMsg.jobId }, solveMsg()));
    assert.strictEqual(page.el('resultPanel').hidden, false);
    assert.strictEqual(page.el('auditPanel').hidden, false, '新结论就绪后审计入口重新开放');
  });

  test('页面：录入校验失败时清除结论与审计证据', () => {
    const page = setupPage();
    solve(page);
    page.el('edges').value = 'CH1 CH1'; // 自环
    page.el('submit').dispatch('click');
    assert.strictEqual(page.el('resultPanel').hidden, true, '校验失败清除结论');
    assert.strictEqual(page.el('auditPanel').hidden, true, '校验失败清除审计面板');
    assert.match(page.el('errors').children[0].textContent, /自环/);
  });
};
