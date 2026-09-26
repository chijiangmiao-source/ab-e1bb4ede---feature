/* 求解 Worker：后台线程执行确定性分支定界（最少频段求色 / 复线审计）。 */
importScripts('dsatur.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    var res;
    if (msg.mode === 'audit') {
      res = DSATUR.auditGraph(msg.channels, msg.edges, msg.target);
      res.type = 'audit';
    } else {
      res = DSATUR.solveGraph(msg.channels, msg.edges);
      res.type = 'result';
    }
    res.jobId = msg.jobId;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: msg.jobId,
      message: String((err && err.message) || err),
    });
  }
};
