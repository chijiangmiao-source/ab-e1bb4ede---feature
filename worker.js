/* 求解 Worker：求色（确定性 DSATUR 分支定界）与复线审计（受限颜色分支定界）共用后台线程。 */
importScripts('dsatur.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    if (msg.mode === 'audit') {
      var audit = DSATUR.auditGraph(msg.channels, msg.edges, msg.target);
      audit.type = 'audit';
      audit.jobId = msg.jobId;
      self.postMessage(audit);
      return;
    }
    var res = DSATUR.solveGraph(msg.channels, msg.edges);
    res.type = 'result';
    res.jobId = msg.jobId;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: msg.jobId,
      mode: msg.mode,
      message: String((err && err.message) || err),
    });
  }
};
