'use strict';
// Шаг 9, п. 2: тот же вопрос «это нейросеть? 0–100», но claude-haiku-5-5, на dev. -> eval/results/baseline_haiku_dev.md/json
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const L = require('./v3_lib');
const { auc, thresholdAtFpr } = require('./baseline_ai');
const D = path.join(__dirname, '..', 'data');
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
(async () => {
  const t0 = llm.readCost().total_usd; L.setCap(10.69);
  const posts = rj(path.join(D, 'posts.json')), voice = rj(path.join(D, 'voice_dev.json')).labels;
  const ai = rj(path.join(D, 'ai_posts.json')).map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev');
  const items = [
    ...ai.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', prompt: x.prompt_type, text: x.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'founder' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'founder', text: p.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'editorial', text: p.text })),
  ];
  const H = await L.judgeAll('claude-haiku-5-5', items, 1, 'haiku_det');
  const S = rj(path.join(L.RES, 'cache', 'baseline_dev.json'));
  const row = (r) => ({ ...r, h: (H.get(r.key) || [])[0] ?? null, s: S[r.key] ? S[r.key].ai_score : null });
  const rs = items.map(row);
  const A = rs.filter((r) => r.kind === 'ai' && r.text.length >= 400), F = rs.filter((r) => r.kind === 'founder'), E = rs.filter((r) => r.kind === 'editorial');
  const col = (l, k) => l.filter((r) => r[k] !== null).map((r) => r[k]);
  const out = {};
  for (const [name, k] of [['haiku', 'h'], ['sonnet', 's']]) {
    const o = { auc_all: auc(col(A, k), col(F, k)), auc_naive: auc(col(A.filter((r) => r.prompt === 'naive'), k), col(F, k)), auc_human: auc(col(A.filter((r) => r.prompt === 'human'), k), col(F, k)), auc_vs_editorial: auc(col(A, k), col(E, k)), auc_editorial_vs_founder: auc(col(E, k), col(F, k)), at_fpr15: thresholdAtFpr(col(A, k), col(F, k), 0.15) };
    const t30 = (thr) => { const fp = F.filter((r) => r[k] >= thr).length, tp = A.filter((r) => r[k] >= thr).length; return { t: thr, tp, n_pos: A.length, fp, n_neg: F.length, editorial: E.filter((r) => r[k] >= thr).length, n_ed: E.length }; };
    o.at_30 = t30(30);
    o.means = { ai: +L.mean(col(A, k)).toFixed(1), founder: +L.mean(col(F, k)).toFixed(1), editorial: +L.mean(col(E, k)).toFixed(1) };
    o.unanswered = rs.filter((r) => r[k] === null).length;
    out[name] = o;
  }
  // совпадение сторон порога между Haiku и Sonnet
  const both = rs.filter((r) => r.h !== null && r.s !== null);
  out.agree_30 = { n: both.length, same_side: both.filter((r) => (r.h >= 30) === (r.s >= 30)).length };
  out.spent_usd = +(llm.readCost().total_usd - t0).toFixed(4);
  fs.writeFileSync(path.join(L.RES, 'baseline_haiku_dev.json'), JSON.stringify({ summary: out, rows: rs.map(({ text, ...r }) => r) }, null, 1));
  const f = (o) => (o ? `порог ${o.t}: AI ${o.tp}/${o.n_pos} (${(100 * o.tpr).toFixed(1)}%), ложных на founder ${o.fp}/${o.n_neg}` : '-');
  const h = out.haiku, s = out.sonnet;
  const md = `# Haiku как детектор на dev (шаг 9, п. 2)

Тот же промпт, что eval/baseline_ai.js (дословно), один вызов на текст. Haiku = claude-haiku-5-5; Sonnet = claude-sonnet-5-5 из baseline_dev (один вызов, старый кэш). Выборка: AI dev от 400 знаков (${A.length} из ${ai.length}), founder ${F.length}, editorial ${E.length}. Без ответа Haiku: ${h.unanswered}.
Правило REVIEW_2 для замены Sonnet на Haiku: AUC против founder >= 0,95 и AUC human >= 0,93.

| метрика | Haiku | Sonnet |
|---|---|---|
| AUC: AI против founder | ${h.auc_all} | ${s.auc_all} |
| AUC naive | ${h.auc_naive} | ${s.auc_naive} |
| AUC human | ${h.auc_human} | ${s.auc_human} |
| AUC: AI против editorial | ${h.auc_vs_editorial} | ${s.auc_vs_editorial} |
| AUC: editorial против founder | ${h.auc_editorial_vs_founder} | ${s.auc_editorial_vs_founder} |
| порог 30: пойман AI / ложных на founder / editorial отмечено | ${h.at_30.tp}/${h.at_30.n_pos} / ${h.at_30.fp}/${h.at_30.n_neg} / ${h.at_30.editorial}/${h.at_30.n_ed} | ${s.at_30.tp}/${s.at_30.n_pos} / ${s.at_30.fp}/${s.at_30.n_neg} / ${s.at_30.editorial}/${s.at_30.n_ed} |
| порог с ложными на founder <= 15% | ${f(h.at_fpr15)} | ${f(s.at_fpr15)} |
| средняя оценка AI / founder / editorial | ${h.means.ai} / ${h.means.founder} / ${h.means.editorial} | ${s.means.ai} / ${s.means.founder} / ${s.means.editorial} |

Совпадение стороны порога 30 у Haiku и Sonnet: ${out.agree_30.same_side} из ${out.agree_30.n}.
Решение по правилу REVIEW_2: ${h.auc_all >= 0.95 && h.auc_human >= 0.93 ? 'Haiku проходит' : 'Haiku НЕ проходит, детектор остаётся Sonnet'}.
Расход ${out.spent_usd} $.
`;
  fs.writeFileSync(path.join(L.RES, 'baseline_haiku_dev.md'), md);
  console.log(md);
})();
