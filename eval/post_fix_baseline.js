'use strict';
// Независимая проверка переписывания: тот же простой вопрос «это нейросеть? 0–100» (eval/baseline_ai.js, без изменений)
// к текстам ДО и ПОСЛЕ правки. Тексты берутся из кэшей rewrite_cache/gpt-6.1-terra.json (dev) и cache/fix_test.json (test).
//   node eval/post_fix_baseline.js   -> eval/results/post_fix_baseline.md/json
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { scoreAll, JUDGE } = require('./baseline_ai');

const RES = path.join(__dirname, 'results');
const CACHE = process.env.KAN_CACHE_DIR || path.join(RES, 'cache');
const TH = 30;
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : null);
const below = (a) => a.filter((x) => x < TH).length;

(async () => {
  const t0 = llm.readCost().total_usd;
  const bdev = rj(path.join(CACHE, 'baseline_dev.json'));
  const btest = rj(path.join(CACHE, 'baseline_test.json'));
  const devRows = rj(path.join(RES, 'baseline_dev.json')).rows;
  const dev = rj(path.join(RES, 'rewrite_cache', 'gpt-6.1-terra.json'));
  const fix = rj(path.join(CACHE, 'fix_test.json'));
  const ai = rj(path.join(__dirname, '..', 'data', 'ai_posts.json'));

  // единый список записей: {group, key, model, status, before_key, before_text?, after}
  const recs = [];
  for (const [id, r] of Object.entries(dev)) recs.push({ group: 'dev_ai', id, key: 'ai' + id, bcache: bdev, r });
  for (const [key, r] of Object.entries(fix)) {
    if (r.status === 'clean') continue; // снято одним autofix без модели, LLM не участвовала
    recs.push({ group: key.startsWith('p') ? 'test_channel' : 'test_ai', id: key, key, bcache: btest, r });
  }
  // «до»: берём из кэша baseline; если нет — считаем
  const needBefore = recs.filter((x) => !x.bcache[x.key] || x.bcache[x.key].ai_score === null).map((x) => ({ key: 'pre_' + x.group + '_' + x.id, text: x.r.before, rec: x }));
  if (needBefore.length) {
    const rs = await scoreAll('post_fix_before_extra', needBefore.map(({ key, text }) => ({ key, text })));
    for (const n of needBefore) n.rec.before_score = rs.find((q) => q.key === n.key).ai_score;
  }
  for (const x of recs) if (x.before_score === undefined) x.before_score = x.bcache[x.key].ai_score;
  // «после»
  const after = await scoreAll('post_fix_after', recs.map((x) => ({ key: x.group + '_' + x.id, text: x.r.after })));
  for (const x of recs) x.after_score = after.find((q) => q.key === x.group + '_' + x.id).ai_score;

  const rows = recs.map((x) => ({ group: x.group, id: x.id, model: x.r.model, status: x.r.status, reason: x.r.reason || null, changed: x.r.after !== x.r.before, lint_before: x.r.score_before, lint_after: x.r.score_after, before: x.before_score, after: x.after_score }));
  const agg = (rs) => {
    const ok = rs.filter((r) => r.before !== null && r.after !== null);
    const b = ok.map((r) => r.before), a = ok.map((r) => r.after);
    return { n: ok.length, mean_before: mean(b), mean_after: mean(a), below30_before: below(b), below30_after: below(a), pct_below30_before: ok.length ? +(100 * below(b) / ok.length).toFixed(1) : null, pct_below30_after: ok.length ? +(100 * below(a) / ok.length).toFixed(1) : null, unchanged_text: rs.filter((r) => !r.changed).length, unanswered: rs.length - ok.length };
  };
  const out = { judge: JUDGE, threshold: TH, groups: {}, by_model: {} };
  for (const g of ['dev_ai', 'test_ai', 'test_channel']) {
    const rs = rows.filter((r) => r.group === g);
    out.groups[g] = { all_to_llm: agg(rs), fixed_only: agg(rs.filter((r) => r.status === 'fixed')), human_status: agg(rs.filter((r) => r.status === 'human')) };
    for (const m of [...new Set(rs.map((r) => r.model))]) (out.by_model[g + ' / ' + m] = agg(rs.filter((r) => r.model === m)));
  }
  const test = rows.filter((r) => r.group !== 'dev_ai');
  for (const m of [...new Set(test.map((r) => r.model))]) out.by_model['test (ai+канал) / ' + m] = agg(test.filter((r) => r.model === m));
  out.by_model['test_ai_only_all_models'] = agg(rows.filter((r) => r.group === 'test_ai'));
  const f = devRows.filter((r) => r.kind === 'founder' && r.ai_score !== null).map((r) => r.ai_score);
  const e = devRows.filter((r) => r.kind === 'editorial' && r.ai_score !== null).map((r) => r.ai_score);
  out.founder_dev = { n: f.length, mean: mean(f), below30: below(f), pct_below30: +(100 * below(f) / f.length).toFixed(1) };
  out.editorial_dev = { n: e.length, mean: mean(e), below30: below(e), pct_below30: +(100 * below(e) / e.length).toFixed(1) };
  out.spent_usd = +(llm.readCost().total_usd - t0).toFixed(4);
  fs.writeFileSync(path.join(RES, 'post_fix_baseline.json'), JSON.stringify({ summary: out, rows }, null, 1));

  const line = (name, a) => `| ${name} | ${a.n} | ${a.mean_before} → ${a.mean_after} | ${a.below30_before} (${a.pct_below30_before}%) → ${a.below30_after} (${a.pct_below30_after}%) | ${a.unchanged_text} |`;
  const L = [];
  for (const [g, title] of [['dev_ai', 'dev: 20 AI-текстов (terra, rewrite_compare)'], ['test_ai', 'test: AI-тексты, ушедшие в LLM'], ['test_channel', 'test: отмеченные посты канала, ушедшие в LLM']]) {
    L.push(line(title + ', все', out.groups[g].all_to_llm), line(title + ', только status=fixed', out.groups[g].fixed_only));
    if (out.groups[g].human_status.n) L.push(line(title + ', status=human (не отдали бы)', out.groups[g].human_status));
  }
  for (const [k, a] of Object.entries(out.by_model)) L.push(line('по модели: ' + k, a));
  const md = `# Независимая проверка переписывания простым вопросом «это нейросеть?» (после шага 8)

Оценщик ${JUDGE} (тот же промпт, что eval/baseline_ai.js, «Оценка: N», 0 — человек, 100 — нейросеть). Порог 30 (выбран на dev). «До» взято из кэшей baseline_dev / baseline_test; «после» — тексты \`after\` из rewrite_cache/gpt-6.1-terra.json (dev) и cache/fix_test.json (test). В выборку входят только тексты, прошедшие через LLM (status fixed или human); 10 текстов test, снятых одним autofix без модели, не включены.

| группа | n | средний балл до → после | ниже 30: до → после | текст не изменился |
|---|---|---|---|---|
${L.join('\n')}

Для сравнения, dev, оценка того же оценщика: founder-посты n=${out.founder_dev.n}, средний балл ${out.founder_dev.mean}, ниже 30: ${out.founder_dev.below30} (${out.founder_dev.pct_below30}%); editorial n=${out.editorial_dev.n}, средний ${out.editorial_dev.mean}, ниже 30: ${out.editorial_dev.below30} (${out.editorial_dev.pct_below30}%).

Оговорки: «после» на test — смесь terra и запасной claude-sonnet-5-5 (шлюз OpenAI упёрся в лимит); оценщик тот же вендор, что запасная модель (возможна симпатия к собственному стилю). Строки status=human в реальном продукте человеку не отдаются как «исправлено». Расход ${out.spent_usd} $.
`;
  fs.writeFileSync(path.join(RES, 'post_fix_baseline.md'), md);
  console.log(md);
})();
