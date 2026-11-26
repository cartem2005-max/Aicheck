'use strict';
// Шаг 9, п. 1: шум оценщика (Sonnet, промпт baseline_ai) — 30 текстов dev × 3 вызова. -> eval/results/noise_dev.md/json
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const L = require('./v3_lib');
const { select } = require('./v3_select');
(async () => {
  const t0 = llm.readCost().total_usd; L.setCap(10.69);
  const s = select();
  const m = await L.judgeAll('claude-sonnet-5-5', s.noise, 3, 'noise_dev');
  const legacy = JSON.parse(fs.readFileSync(path.join(L.RES, 'cache', 'baseline_dev.json'), 'utf8'));
  const rows = s.noise.map((x) => { const v = m.get(x.key); const lg = legacy[x.key] ? legacy[x.key].ai_score : null; return { key: x.key, kind: x.kind, scores: v, legacy: lg, mean: +L.mean(v).toFixed(1), std: +L.std(v).toFixed(2), range: Math.max(...v) - Math.min(...v), flips: v.some((z) => z >= 30) && v.some((z) => z < 30) }; });
  const agg = (rs) => ({ n: rs.length, mean_std: +L.mean(rs.map((r) => r.std)).toFixed(2), mean_range: +L.mean(rs.map((r) => r.range)).toFixed(1), flips: rs.filter((r) => r.flips).length, with_legacy_flips: rs.filter((r) => { const a = [...r.scores, ...(r.legacy !== null ? [r.legacy] : [])]; return a.some((z) => z >= 30) && a.some((z) => z < 30); }).length });
  const sum = { all: agg(rows), ai: agg(rows.filter((r) => r.kind === 'ai')), founder: agg(rows.filter((r) => r.kind === 'founder')), editorial: agg(rows.filter((r) => r.kind === 'editorial')) };
  // дисперсия среднего из 3 вызовов и порог «2σ»
  sum.sigma = sum.all.mean_std;
  sum.sigma_rms = +Math.sqrt(L.mean(rows.map((r) => r.std ** 2))).toFixed(2);
  sum.spent_usd = +(llm.readCost().total_usd - t0).toFixed(4);
  fs.writeFileSync(path.join(L.RES, 'noise_dev.json'), JSON.stringify({ summary: sum, rows }, null, 1));
  const f = (n, a) => `| ${n} | ${a.n} | ${a.mean_std} | ${a.mean_range} | ${a.flips} из ${a.n} (${(100 * a.flips / a.n).toFixed(0)}%) | ${a.with_legacy_flips} |`;
  const md = `# Шум оценщика на dev (шаг 9, п. 1)

Оценщик claude-sonnet-5-5, промпт дословно из eval/baseline_ai.js, 30 текстов dev (10 AI, 10 founder, 10 editorial, зерно 5150), по 3 новых вызова на текст. Порог «флаг» 30 (>= 30).
**σ (средняя по текстам std одного вызова, ddof=1) = ${sum.sigma}**, корень из средней дисперсии ${sum.sigma_rms}. Это σ из V3_CRITERIA.

| группа | текстов | средняя std | средний размах (макс−мин) | вердикт относительно 30 меняется (3 вызова) | то же, считая старый вызов из baseline_dev четвёртым |
|---|---|---|---|---|---|
${f('все', sum.all)}
${f('AI', sum.ai)}
${f('founder', sum.founder)}
${f('editorial', sum.editorial)}

Построчно (оценки трёх вызовов; в скобках старый вызов из baseline_dev):

| текст | вид | оценки | среднее | std |
|---|---|---|---|---|
${rows.map((r) => `| ${r.key} | ${r.kind} | ${r.scores.join(', ')} (${r.legacy}) | ${r.mean} | ${r.std} |`).join('\n')}

Расход ${sum.spent_usd} $.
`;
  fs.writeFileSync(path.join(L.RES, 'noise_dev.md'), md);
  console.log(md);
})();
