'use strict';
// Шаг 8, C2-C3: переписывание terra на test, слепой A/B, «не ломаем живое». Запуск ОДИН раз после eval/FROZEN.md.
//   node eval/fix_eval.js [--split test] [--budget 2.5]
// Пишет eval/results/test_fix.md/json, test_ab.md/json, test_live.md/json.
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { lint, SCORE_CONFIG } = require('../src/linter');
const { autofix } = require('../src/autofix');
const { checkFacts } = require('../src/facts');
const { rewrite } = require('../src/rewrite');
const ab = require('./ab_judge');
const { loadSet } = require('./run_test');

const OUT = process.env.KAN_OUT_DIR || path.join(__dirname, 'results');
const CACHE_DIR = process.env.KAN_CACHE_DIR || path.join(__dirname, 'results', 'cache');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SPLIT = opt('split', 'test');
const STEP_BUDGET = Number(opt('budget', 2.5));
const MODEL = 'gpt-6.1-terra', FALLBACK = 'claude-sonnet-5-5';
const THR = SCORE_CONFIG.threshold;
const sfx = SPLIT === 'test' ? '' : '_' + SPLIT;
const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : null);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function summarize(rs) {
  const n = rs.length;
  const llmRs = rs.filter((r) => r.rounds && r.rounds.length);
  const r1 = llmRs.filter((r) => r.rounds[0].facts_ok && r.rounds[0].len_first_ok !== false && r.rounds[0].score < THR);
  const fixed = llmRs.filter((r) => r.status === 'fixed');
  const human = llmRs.filter((r) => r.status === 'human');
  return {
    n, to_llm: llmRs.length, cleared_by_autofix: rs.filter((r) => r.status === 'clean').length,
    score_before_mean: +avg(rs.map((r) => r.score_before)).toFixed(1),
    score_after_autofix_mean: +avg(rs.map((r) => r.score_autofix)).toFixed(1),
    score_after_mean: +avg(rs.map((r) => r.score_after)).toFixed(1),
    llm_score_before_mean: +avg(llmRs.map((r) => r.score_autofix)).toFixed(1), llm_score_after_mean: +avg(llmRs.map((r) => r.score_after)).toFixed(1),
    below_1_round: { n: r1.length, of: llmRs.length, pct: pct(r1.length, llmRs.length) },
    below_2_rounds: { n: fixed.length, of: llmRs.length, pct: pct(fixed.length, llmRs.length) },
    facts_first_try: { n: llmRs.filter((r) => r.rounds[0].facts_first_ok).length, of: llmRs.length, pct: pct(llmRs.filter((r) => r.rounds[0].facts_first_ok).length, llmRs.length) },
    facts_final_ok: { n: llmRs.filter((r) => r.facts && r.facts.ok).length, of: llmRs.length },
    human: { n: human.length, of: llmRs.length, pct: pct(human.length, llmRs.length), reasons: human.reduce((o, r) => { o[r.reason] = (o[r.reason] || 0) + 1; return o; }, {}) },
    length_change_mean_pct: +(100 * avg(llmRs.map((r) => r.length_change || 0))).toFixed(1),
    length_change_abs_pct: +(100 * avg(llmRs.map((r) => Math.abs(r.length_change || 0)))).toFixed(1),
    copy_flagged: llmRs.filter((r) => r.copy && r.copy.flag).length, worn: llmRs.filter((r) => r.worn && r.worn.length).length,
    fallback_used: llmRs.filter((r) => r.model !== MODEL).length,
    calls_per_llm_text: +avg(llmRs.map((r) => r.calls)).toFixed(2),
    cost_total: +rs.reduce((s, r) => s + r.cost, 0).toFixed(4),
    cost_per_llm_text: +avg(llmRs.map((r) => r.cost)).toFixed(5),
  };
}

(async () => {
  const t0 = llm.readCost().total_usd;
  const { ai, ch } = loadSet(SPLIT);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cfile = path.join(CACHE_DIR, 'fix_' + SPLIT + '.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cfile, 'utf8')); } catch { /* нет */ }

  // что отмечено: линтер на оригинале >= порога; autofix внутри rewrite() может снять часть без LLM
  const flaggedAI = ai.filter((x) => { const s = lint(x.text).score; return s !== null && s >= THR; });
  const flaggedCh = ch.filter((p) => lint(p.text).score >= THR);
  const jobs = [...flaggedAI.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', text: x.text, source_id: x.source_id, meta: x })), ...flaggedCh.map((p) => ({ key: 'p' + p.id, kind: 'channel', text: p.text, source_id: p.id, meta: p }))];
  let next = 0, stopped = false;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (cache[j.key]) continue;
      if (llm.readCost().total_usd - t0 > STEP_BUDGET) { stopped = true; return; }
      try { cache[j.key] = await rewrite(j.text, { model: MODEL, fallback: FALLBACK, sourceId: j.source_id, tag: 'fix8' }); fs.writeFileSync(cfile, JSON.stringify(cache)); console.log(j.key, cache[j.key].status, cache[j.key].reason || '', cache[j.key].score_before, '->', cache[j.key].score_after); }
      catch (e) { console.log('ОШИБКА', j.key, e.message); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (stopped) console.log('БЮДЖЕТ ШАГА исчерпан');

  const resAI = jobs.filter((j) => j.kind === 'ai' && cache[j.key]).map((j) => ({ ...cache[j.key], key: j.key, gen: j.meta.model, prompt: j.meta.prompt_type }));
  const resCh = jobs.filter((j) => j.kind === 'channel' && cache[j.key]).map((j) => ({ ...cache[j.key], key: j.key, id: j.meta.id }));
  const sAI = summarize(resAI), sCh = summarize(resCh);
  const bySub = (rs, f) => summarize(rs.filter(f));
  const split2 = { naive: bySub(resAI, (r) => r.prompt === 'naive'), human: bySub(resAI, (r) => r.prompt === 'human') };

  // ---------- слепой A/B: 20 случайных AI test, прошедших LLM (до = оригинал, после = итог конвейера)
  const rand = ab.rng(8003);
  const pool = jobs.filter((j) => j.kind === 'ai' && cache[j.key] && cache[j.key].rounds.length)
    .map((j) => [rand(), j]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 20);
  const items = pool.map((j) => ({ id: j.meta.idx, source_id: j.source_id, before: j.text, after: cache[j.key].after, status: cache[j.key].status }));
  const { before, after } = ab.buildBeforeAfter(items, 8004);
  const rb = await ab.runPairs('test_before', before), ra = await ab.runPairs('test_after', after);
  const abOut = { judge: ab.JUDGE, n: items.length, before: ab.summarize(rb), after: ab.summarize(ra), paired: ab.paired(rb, ra),
    status_counts: items.reduce((o, i) => { o[i.status] = (o[i.status] || 0) + 1; return o; }, {}),
    pairs: rb.map((b, i) => ({ idx: b.id, human_id: b.human_id, slot: b.slot, before_named_human: b.cand_named_human, after_named_human: ra[i].cand_named_human })) };
  fs.writeFileSync(path.join(OUT, `test_ab${sfx}.json`), JSON.stringify(abOut, null, 1));
  const L = (s) => `${s.fooled} из ${s.answered} (${s.fooled_pct}%)`;
  fs.writeFileSync(path.join(OUT, `test_ab${sfx}.md`), `# Слепой A/B на ${SPLIT} (шаг 8)

Оценщик ${ab.JUDGE}, ${abOut.n} случайных AI-текстов ${SPLIT}, прошедших переписывание (зерно 8003), человек в паре — ближайший по теме founder-пост dev. «Обманул» = оценщик назвал человеком кандидата.

| набор | пар | кандидата назвали человеком |
|---|---|---|
| до правки | ${abOut.before.n} | ${L(abOut.before)} |
| после правки ${MODEL} | ${abOut.after.n} | ${L(abOut.after)} |

Парно: оба раза человеком ${abOut.paired.both}, только до ${abOut.paired.b_only}, только после ${abOut.paired.a_only}, ни разу ${abOut.paired.neither}. Статусы: ${JSON.stringify(abOut.status_counts)}. Доля ответов «1»: до ${abOut.before.said_1_pct}%, после ${abOut.after.said_1_pct}%.
`);

  // ---------- «не ломаем живое»
  const noLLM = async () => { throw new Error('LLM_CALLED'); };
  const clean = ch.filter((p) => lint(p.text).score < THR);
  const live = [];
  for (const p of clean) {
    const af = autofix(p.text);
    let r, calledLLM = false;
    try { r = await rewrite(p.text, { chat: noLLM, sourceId: p.id }); } catch (e) { calledLLM = /LLM_CALLED/.test(e.message); }
    live.push({ id: p.id, score: lint(p.text).score, status: r && r.status, called_llm: calledLLM, changed: r ? r.after !== p.text : null,
      changes: af.changes.map((c) => c.rule), facts_ok: r ? !!(r.facts && r.facts.ok) : null, only_autofix: r ? r.after === af.text : null });
  }
  const touched = live.filter((x) => x.changed);
  // повторный прогон исправленного: все итоги со статусом fixed / clean (AI и канал) -> без LLM и без изменений
  const rerun = [];
  for (const j of jobs) {
    const c = cache[j.key];
    if (!c || (c.status !== 'fixed' && c.status !== 'clean')) continue;
    let r, calledLLM = false;
    try { r = await rewrite(c.after, { chat: noLLM, sourceId: j.source_id }); } catch (e) { calledLLM = /LLM_CALLED/.test(e.message); }
    rerun.push({ key: j.key, kind: j.kind, status0: c.status, called_llm: calledLLM, unchanged: r ? r.after === c.after : false });
  }
  // и чистые посты канала (после autofix) прогоняем второй раз
  for (const p of clean) {
    const r1 = await rewrite(p.text, { chat: noLLM, sourceId: p.id }).catch(() => null);
    if (!r1) continue;
    const r2 = await rewrite(r1.after, { chat: noLLM, sourceId: p.id }).catch(() => null);
    rerun.push({ key: 'clean_p' + p.id, kind: 'channel_clean', status0: r1.status, called_llm: !r2, unchanged: !!r2 && r2.after === r1.after });
  }
  const liveOut = {
    clean_channel_posts: clean.length, llm_called: live.filter((x) => x.called_llm).length,
    status_counts: live.reduce((o, x) => { o[x.status] = (o[x.status] || 0) + 1; return o; }, {}),
    changed_by_bot: touched.length, changed_only_by_autofix: touched.filter((x) => x.only_autofix).length,
    facts_ok_all: live.every((x) => x.facts_ok !== false),
    autofix_rules: touched.reduce((o, x) => { for (const r of x.changes) o[r] = (o[r] || 0) + 1; return o; }, {}),
    touched: touched.map((x) => ({ id: x.id, score: x.score, rules: x.changes })),
    rerun: { n: rerun.length, unchanged: rerun.filter((x) => x.unchanged && !x.called_llm).length, called_llm: rerun.filter((x) => x.called_llm).length,
      changed: rerun.filter((x) => !x.unchanged).map((x) => x.key) },
  };
  fs.writeFileSync(path.join(OUT, `test_live${sfx}.json`), JSON.stringify({ ...liveOut, rows: live, rerun_rows: rerun }, null, 1));
  fs.writeFileSync(path.join(OUT, `test_live${sfx}.md`), `# «Не ломаем живое» на ${SPLIT} (шаг 8)

Неотмеченные посты канала (балл < ${THR}): ${liveOut.clean_channel_posts}. Статусы после конвейера: ${JSON.stringify(liveOut.status_counts)}; вызовов LLM: ${liveOut.llm_called}.
Текст изменился у ${liveOut.changed_by_bot} из ${liveOut.clean_channel_posts}; все изменения — только autofix (кодом, без модели): ${liveOut.changed_only_by_autofix} из ${liveOut.changed_by_bot}. Факты (числа, даты, ссылки) сохранены во всех: ${liveOut.facts_ok_all ? 'да' : 'НЕТ'}.
Что меняет autofix (число постов по правилам): ${JSON.stringify(liveOut.autofix_rules)}. Затронутые посты: ${liveOut.touched.map((t) => t.id + ' (' + t.rules.join(',') + ')').join('; ') || 'нет'}.

Повторный прогон исправленного (итоги fixed/clean по AI и каналу + чистые посты канала): ${liveOut.rerun.n} текстов, без изменений и без вызова LLM — ${liveOut.rerun.unchanged}${liveOut.rerun.changed.length ? '; изменились: ' + liveOut.rerun.changed.join(', ') : ''}.
`);

  // ---------- главный отчёт по переписыванию
  const row = (l, k, f = (x) => x) => `| ${l} | ${f(sAI[k])} | ${f(sCh[k])} |`;
  const P = (o) => `${o.n} из ${o.of} (${o.pct ?? pct(o.n, o.of)}%)`;
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  const out = { split: SPLIT, model: MODEL, fallback: FALLBACK, threshold: THR, flagged: { ai: flaggedAI.length, ai_total: ai.length, channel: flaggedCh.length, channel_total: ch.length },
    ai: sAI, channel: sCh, ai_naive: split2.naive, ai_human: split2.human, spent_usd: spent, budget_stopped: stopped };
  fs.writeFileSync(path.join(OUT, `test_fix${sfx}.json`), JSON.stringify({ ...out, rows: [...resAI, ...resCh].map(({ before, after, rounds, samples, ...r }) => ({ ...r, rounds: rounds.map(({ problems, ...x }) => x), before_len: before.length, after_len: after.length })) }, null, 1));
  const md = `# Переписывание ${MODEL} на ${SPLIT} (шаг 8)

Запасная модель ${FALLBACK}. Порог ${THR}. Отмечено линтером: AI-текстов ${out.flagged.ai} из ${out.flagged.ai_total} (≥400 знаков), постов канала ${out.flagged.channel} из ${out.flagged.channel_total}. Часть снимает autofix без модели; в LLM уходят остальные.

| метрика | AI-тексты | отмеченные посты канала |
|---|---|---|
| отмечено до правки | ${sAI.n} | ${sCh.n} |
| снято одним autofix (без модели) | ${sAI.cleared_by_autofix} | ${sCh.cleared_by_autofix} |
| ушло в LLM | ${sAI.to_llm} | ${sCh.to_llm} |
| балл до (средний, по всем отмеченным) | ${sAI.score_before_mean} | ${sCh.score_before_mean} |
| балл после autofix (средний) | ${sAI.score_after_autofix_mean} | ${sCh.score_after_autofix_mean} |
| балл после всего (средний) | ${sAI.score_after_mean} | ${sCh.score_after_mean} |
| балл в LLM-группе: до LLM → после | ${sAI.llm_score_before_mean} → ${sAI.llm_score_after_mean} | ${sCh.llm_score_before_mean} → ${sCh.llm_score_after_mean} |
${row('ниже порога за 1 круг (из ушедших в LLM)', 'below_1_round', P)}
${row('ниже порога за 2 круга', 'below_2_rounds', P)}
${row('факты ок с первого раза', 'facts_first_try', P)}
${row('ушло человеку', 'human', P)}
| причины «человеку» | ${JSON.stringify(sAI.human.reasons)} | ${JSON.stringify(sCh.human.reasons)} |
| длина, среднее изменение % | ${sAI.length_change_mean_pct} | ${sCh.length_change_mean_pct} |
| длина, по модулю % | ${sAI.length_change_abs_pct} | ${sCh.length_change_abs_pct} |
| флаг копирования образцов / заезженные фразы | ${sAI.copy_flagged} / ${sAI.worn} | ${sCh.copy_flagged} / ${sCh.worn} |
| ответила запасная модель | ${sAI.fallback_used} | ${sCh.fallback_used} |
| вызовов на текст в LLM | ${sAI.calls_per_llm_text} | ${sCh.calls_per_llm_text} |
| $ за текст в LLM (в среднем) | ${sAI.cost_per_llm_text} | ${sCh.cost_per_llm_text} |
| $ всего | ${sAI.cost_total} | ${sCh.cost_total} |

AI-тексты по промпту: naive — ушло в LLM ${split2.naive.to_llm}, ниже порога за 2 круга ${P(split2.naive.below_2_rounds)}; human — ушло в LLM ${split2.human.to_llm}, ниже порога за 2 круга ${P(split2.human.below_2_rounds)}.
${stopped ? '\nВНИМАНИЕ: бюджет шага исчерпан, часть текстов не обработана.\n' : ''}
Расход запуска (переписывание, A/B, живое): $${spent}.
`;
  fs.writeFileSync(path.join(OUT, `test_fix${sfx}.md`), md);
  console.log(md);
})();
