'use strict';
// Шаг 13: калибровка и проверка прозрачного балла на dev (из кэша eval/results/explain_dev_cache.json, сеть не нужна).
//   node eval/explain_score_dev.js  -> eval/results/explain_score_dev.md/json
const fs = require('fs');
const path = require('path');
const E = require('../src/explain_fix');
const S = require('../src/explain_score');
const { lintStep } = require('../src/bot_lint');
const { devItems, readCache } = require('./explain_dev');
const { auc } = require('./baseline_ai');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'baseline_dev.json'), 'utf8')).rows;
const model = Object.fromEntries(base.map((r) => [r.key, r.ai_score]));
const cache = readCache();
const rows = [];
for (const it of devItems()) {
  const c = cache[it.key];
  if (!c) continue;
  const fx = E.apply(it.text, E.parseJson(c.raw));
  if (fx.status === 'error') continue;
  const li = lintStep(it.text, 5, []);
  const sc = S.scoreText(it.text, fx.findings, li.lint_findings);
  rows.push({ key: it.key, kind: it.kind, len: it.text.length, sc, model: model[it.key], n: fx.findings.length });
}
const by = (k) => rows.filter((r) => r.kind === k);
const sc = (a) => a.map((r) => r.sc.score);
const out = { n: { ai: by('ai').length, founder: by('founder').length, editorial: by('editorial').length } };
out.auc = {
  transparent: { founder: auc(sc(by('ai')), sc(by('founder'))), editorial: auc(sc(by('ai')), sc(by('editorial'))) },
  model: { founder: auc(by('ai').map((r) => r.model), by('founder').map((r) => r.model)), editorial: auc(by('ai').map((r) => r.model), by('editorial').map((r) => r.model)) },
};
const high = (a) => a.filter((r) => r.sc.zone === 'high').length, mid = (a) => a.filter((r) => r.sc.zone === 'mid').length;
out.zones = Object.fromEntries(['ai', 'founder', 'editorial'].map((k) => [k, { low: by(k).length - high(by(k)) - mid(by(k)), mid: mid(by(k)), high: high(by(k)) }]));
out.mean = Object.fromEntries(['ai', 'founder', 'editorial'].map((k) => [k, +(sc(by(k)).reduce((a, b) => a + b, 0) / by(k).length).toFixed(1)]));
out.config = { K: S.K, ZONE_MID: S.ZONE_MID, ZONE_HIGH: S.ZONE_HIGH };
console.log(JSON.stringify(out));
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(__dirname, 'results', 'explain_score_dev.json'), JSON.stringify({ ...out, rows: rows.map((r) => ({ key: r.key, kind: r.kind, score: r.sc.score, parts: r.sc.parts, flagged: r.sc.flagged, bonus: r.sc.bonus, distinct: r.sc.distinct, capped: r.sc.capped, model: r.model })) }, null, 1));
}
module.exports = { rows };
