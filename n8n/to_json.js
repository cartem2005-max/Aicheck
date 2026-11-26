'use strict';
// SDK-код (то, что лежит в n8n/dist/*.sdk.ts) -> обычный JSON workflow n8n (name, nodes, connections, settings).
// SDK-файл исполняется с «пустыми» реализациями workflow/node/trigger/expr/ifElse/switchCase, которые только записывают граф,
// поэтому JSON — тот же граф, что SDK-версия (одни и те же ноды, параметры, связи).
// Не переносится: группы нод (.group) — в JSON их нет; sticky-заметок в графе нет.
const crypto = require('crypto');

const uid = (s) => { const h = crypto.createHash('md5').update(String(s)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };

function toWorkflow(sdkSource) {
  const nodes = [], conns = {};
  const handle = (type, cfgIn, isTrigger, kind) => {
    const cfg = cfgIn.config || {};
    const h = { name: cfg.name, kind: kind || 'node' };
    const n = { id: uid(cfg.name), name: cfg.name, type, typeVersion: cfgIn.version, position: cfg.position || [0, 0], parameters: cfg.parameters || {} };
    if (cfg.credentials) n.credentials = cfg.credentials;
    for (const k of ['onError', 'alwaysOutputData', 'executeOnce', 'retryOnFail', 'maxTries']) if (cfg[k] !== undefined) n[k] = cfg[k];
    if (type === 'n8n-nodes-base.telegramTrigger') n.webhookId = uid('webhook:' + cfg.name);
    if (nodes.some((x) => x.name === n.name)) throw new Error('повтор имени ноды: ' + n.name);
    nodes.push(n);
    const headOf = (y) => y.head || y;
    const tailOf = (y) => y.tail || y;
    const link = (fromName, out, y) => {
      const c = conns[fromName] = conns[fromName] || { main: [] };
      while (c.main.length <= out) c.main.push([]);
      const t = headOf(y).name;
      if (!c.main[out].some((x) => x.node === t)) c.main[out].push({ node: t, type: 'main', index: 0 });
    };
    const mkChain = (head, tail) => ({ head, tail, to(y) { link(tail.name, 0, y); return mkChain(head, tailOf(y)); } });
    h.to = (y) => mkChain(h, h).to(y);
    h.onTrue = (y) => { link(h.name, 0, y); return h; };
    h.onFalse = (y) => { link(h.name, 1, y); return h; };
    h.onCase = (i, y) => { link(h.name, i, y); return h; };
    h.link = link; h.headOf = headOf; h.tailOf = tailOf;
    return h;
  };
  let wfName = '', wfSettings = {}, cur = null;
  const mkW = () => {
    const W = {
      add(x) { cur = x; return W; },
      to(y) { const t = cur.tail || cur; t.link(t.name, 0, y); cur = { head: cur.head || cur, tail: y.tail || y }; return W; },
      group() { return W; },
    };
    return W;
  };
  const sdk = {
    workflow: (id, name, opts) => { wfName = name; wfSettings = (opts && opts.settings) || {}; return mkW(); },
    node: (c) => handle(c.type, c),
    trigger: (c) => handle(c.type, c, true),
    ifElse: (c) => handle('n8n-nodes-base.if', c, false, 'branch'),
    switchCase: (c) => handle('n8n-nodes-base.switch', c, false, 'branch'),
    expr: (s) => '=' + s,
  };
  const code = sdkSource.replace(/^import .*$/m, '').replace('export default workflow(', 'return workflow(');
  new Function('workflow', 'node', 'trigger', 'expr', 'ifElse', 'switchCase', code)(sdk.workflow, sdk.node, sdk.trigger, sdk.expr, sdk.ifElse, sdk.switchCase);
  // Switch: у каждого правила outputKey -> renameOutput (так n8n показывает имена выходов)
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.switch' && n.parameters.rules) for (const r of n.parameters.rules.values) if (r.outputKey) r.renameOutput = true;
  }
  const names = new Set(nodes.map((n) => n.name));
  for (const [from, c] of Object.entries(conns)) {
    if (!names.has(from)) throw new Error('связь из несуществующей ноды: ' + from);
    for (const outs of c.main) for (const t of outs) if (!names.has(t.node)) throw new Error('связь в несуществующую ноду: ' + t.node);
  }
  return { name: wfName, nodes, connections: conns, settings: { executionOrder: 'v1', ...wfSettings } };
}

module.exports = { toWorkflow };
