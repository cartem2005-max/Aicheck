'use strict';
// Шаг 7: сравнение моделей переписывания на 20 AI-текстах dev (test не трогаем).
//   node eval/rewrite_compare.js [--models a,b,c] [--limit N] [--budget 3.9]
// Выбор: зерно 2026, по 3 текста на каждую пару «модель-генератор × naive/human» (18) + 2 добавочных (opus/human, haiku/naive).
// Брать только тексты, которые остаются выше порога после autofix (иначе LLM не нужен — «чисто, не трогаем»).
// Результаты кэшируются в eval/results/rewrite_cache/<model>.json: повторный запуск не тратит деньги на уже готовое.
const fs = require('fs');
const path = require('path');
const { lint } = require('../src/linter');
const { autofix } = require('../src/autofix');
const { rewrite, newEnding } = require('../src/rewrite');
const llm = require('../src/llm');

const RES = path.join(__dirname, 'results');
const CACHE = path.join(RES, 'rewrite_cache');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const MODELS = opt('models', 'claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5,gpt-6.1-terra,gpt-6.2-sol').split(',');
const LIMIT = Number(opt('limit', 20));
const STEP_BUDGET = Number(opt('budget', 3.9));
const CONC = 4;
const THRESHOLD = 15;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function pickTexts() {
  const ai = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ai_posts.json'), 'utf8'));
  const dev = ai.map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev' && x.text.length >= 400)
    .filter((x) => { const s = lint(autofix(x.text).text).score; return s !== null && s >= THRESHOLD; });
  const rand = rng(2026);
  const shuffled = dev.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const key = (x) => x.model + '/' + x.prompt_type;
  const combos = [...new Set(dev.map(key))].sort();
  const picked = [];
  const take = (k, n) => { for (const x of shuffled) { if (n <= 0) break; if (key(x) === k && !picked.includes(x)) { picked.push(x); n--; } } };
  for (const k of combos) take(k, 3);
  take('claude-opus-5-5/human', 1);
  take('claude-haiku-5-5/naive', 1);
  return picked.slice(0, LIMIT);
}

const loadCache = (m) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, m + '.json'), 'utf8')); } catch { return {}; } };
const saveCache = (m, c) => { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, m + '.json'), JSON.stringify(c, null, 1)); };

async function runModel(model, texts, startTotal) {
  const cache = loadCache(model);
  const todo = texts.filter((t) => !cache[t.idx]);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      if (llm.readCost().total_usd - startTotal > STEP_BUDGET) { console.log('БЮДЖЕТ ШАГА исчерпан, стоп'); return; }
      try {
        const r = await rewrite(t.text, { model, sourceId: t.source_id, tag: 'cmp7_' + model });
        cache[t.idx] = r;
        saveCache(model, cache);
        console.log(model, '#' + t.idx, r.status, r.reason || '', r.score_before, '->', r.score_after, '$' + r.cost);
      } catch (e) { console.log(model, '#' + t.idx, 'ОШИБКА', e.message); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  return cache;
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : 0);

function summarize(model, texts, cache) {
  const rs = texts.map((t) => cache[t.idx]).filter(Boolean);
  const n = rs.length;
  const r1 = rs.filter((r) => r.rounds[0] && r.rounds[0].facts_ok && r.rounds[0].len_first_ok !== false && r.rounds[0].score < THRESHOLD);
  const fixed = rs.filter((r) => r.status === 'fixed');
  const human = rs.filter((r) => r.status === 'human');
  const cost = avg(rs.map((r) => r.cost));
  const lenAbs = avg(rs.map((r) => Math.abs(r.length_change || 0)));
  return {
    model, n,
    below_threshold_1_round_pct: pct(r1.length, n),
    below_threshold_2_rounds_pct: pct(fixed.length, n),
    facts_first_try_pct: pct(rs.filter((r) => r.rounds[0] && r.rounds[0].facts_first_ok).length, n),
    facts_final_ok_pct: pct(rs.filter((r) => r.facts && r.facts.ok).length, n),
    human_pct: pct(human.length, n),
    human_reasons: human.reduce((o, r) => { o[r.reason] = (o[r.reason] || 0) + 1; return o; }, {}),
    length_change_mean_pct: +(100 * avg(rs.map((r) => r.length_change || 0))).toFixed(1),
    length_change_abs_pct: +(100 * lenAbs).toFixed(1),
    copy_rate_mean_pct: +(100 * avg(rs.map((r) => (r.copy ? r.copy.rate : 0)))).toFixed(2),
    copy_flagged: rs.filter((r) => r.copy && r.copy.flag).length,
    worn_phrases: rs.filter((r) => r.worn && r.worn.length).length,
    ending_flag: rs.filter((r) => newEnding(r.before, r.after).length).length,
    prompt_version: [...new Set(rs.map((r) => r.prompt_version || 'v1'))].join('+'),
    unchanged: rs.filter((r) => r.after === r.before).length,
    score_before_mean: +avg(rs.map((r) => r.score_before)).toFixed(1),
    score_after_mean: +avg(rs.map((r) => r.score_after)).toFixed(1),
    calls_per_text: +avg(rs.map((r) => r.calls)).toFixed(2),
    cost_per_text: +cost.toFixed(5),
    month_65: +(cost * 65).toFixed(2),   // 15 постов канала (половина из 30) + ~100 черновиков, из которых правка нужна примерно половине
    month_115: +(cost * 115).toFixed(2), // верхняя оценка: правим всё (30/2 + 100)
  };
}

function writePairs(model, texts, cache) {
  let md = `# Пары было / стало: ${model}\n\nАвтоматические решения (статус, баллы) — код; оценка «звучит как живой текст» — в STATUS.md, раздел «Шаг 7».\n`;
  for (const t of texts) {
    const r = cache[t.idx];
    if (!r) continue;
    md += `\n---\n\n## #${t.idx} · источник ${t.source_id} · генератор ${t.model}, промпт ${t.prompt_type}\n\n`;
    md += `status: **${r.status}**${r.reason ? ' (' + r.reason + ')' : ''} · балл ${r.score_before} → ${r.score_after} (после autofix ${r.score_autofix}) · знаков ${r.before.length} → ${r.after.length} (${(100 * r.length_change).toFixed(1)}%) · ` +
      `круги: ${r.rounds.map((x) => `${x.score}${x.retried ? '(повтор)' : ''}`).join(', ')} · копирование ${r.copy ? (100 * r.copy.rate).toFixed(1) + '%, цепочка ' + r.copy.run : '-'} · заезженные: ${r.worn && r.worn.length ? r.worn.join('; ') : 'нет'} · $${r.cost}\n\n`;
    if (r.facts && !r.facts.ok) md += `факты: потеряно ${r.facts.missing.map((m) => m.value).join('; ') || '-'}; добавлено ${r.facts.added.map((m) => m.value).join('; ') || '-'}\n\n`;
    md += `### было\n\n${r.before}\n\n### стало\n\n${r.after}\n\n### правки (как написала модель)\n\n${r.changes || '(нет)'}\n`;
  }
  fs.writeFileSync(path.join(RES, `rewrite_pairs_${model}.md`), md);
}

(async () => {
  const texts = pickTexts();
  const startTotal = llm.readCost().total_usd;
  console.log(`текстов ${texts.length}; расход до запуска $${startTotal.toFixed(3)}; лимит шага $${STEP_BUDGET}`);
  const combos = {};
  for (const t of texts) { const k = t.model + '/' + t.prompt_type; combos[k] = (combos[k] || 0) + 1; }
  console.log(JSON.stringify(combos));
  const summary = [];
  for (const m of MODELS) {
    const cache = await runModel(m, texts, startTotal);
    writePairs(m, texts, cache);
    summary.push(summarize(m, texts, cache));
  }
  const total = llm.readCost().total_usd;
  const out = { threshold: THRESHOLD, selection: { seed: 2026, count: texts.length, combos, ids: texts.map((t) => t.idx), sources: texts.map((t) => t.source_id) },
    spent_step_usd: +(total - startTotal).toFixed(3), total_usd: total, models: summary };
  fs.writeFileSync(path.join(RES, 'rewrite_compare.json'), JSON.stringify(out, null, 1));
  let md = `# Сравнение моделей переписывания (шаг 7, dev)\n\n${texts.length} AI-текстов dev, зерно 2026, порог ${THRESHOLD}. Выбор: ${Object.entries(combos).map(([k, v]) => k + ' ×' + v).join(', ')}. Только тексты, которые остаются выше порога после autofix. Test не использовался.\n\n`;
  md += '| метрика | ' + summary.map((s) => s.model).join(' | ') + ' |\n|---|' + summary.map(() => '---').join('|') + '|\n';
  const rows = [['ниже порога за 1 круг, %', 'below_threshold_1_round_pct'], ['ниже порога за 2 круга, %', 'below_threshold_2_rounds_pct'], ['факты с первого раза, %', 'facts_first_try_pct'],
    ['факты в итоге ок, %', 'facts_final_ok_pct'], ['ушло человеку, %', 'human_pct'], ['изменение длины, среднее %', 'length_change_mean_pct'], ['изменение длины, по модулю %', 'length_change_abs_pct'],
    ['копирование образцов, средняя доля 4-грамм %', 'copy_rate_mean_pct'], ['текстов с флагом копирования', 'copy_flagged'], ['текстов с заезженной фразой', 'worn_phrases'], ['текст не изменён', 'unchanged'], ['новое предложение в концовке (проверка кодом)', 'ending_flag'], ['версия промпта', 'prompt_version'],
    ['балл до (средний)', 'score_before_mean'], ['балл после (средний)', 'score_after_mean'], ['вызовов на текст', 'calls_per_text'], ['$ за текст', 'cost_per_text'], ['$ в месяц (65 правок)', 'month_65'], ['$ в месяц (115 правок)', 'month_115']];
  for (const [label, k] of rows) md += `| ${label} | ` + summary.map((s) => s[k]).join(' | ') + ' |\n';
  md += '\nПричины «человеку»: ' + summary.map((s) => `${s.model}: ${JSON.stringify(s.human_reasons)}`).join('; ') + '\n';
  md += `\nПотрачено на сравнение: $${out.spent_step_usd}. Проекция «месяц»: 65 = 15 постов канала (половина из 30) + 50 черновиков (половина из ~100 проверок требует правки); 115 = все 15 + 100. Цена — по фактическим токенам в cost.json (оценка по прейскуранту, не счёт провайдера).\n`;
  md += `Пары было/стало: eval/results/rewrite_pairs_<модель>.md\n`;
  fs.writeFileSync(path.join(RES, 'rewrite_compare.md'), md);
  console.log(md);
})();
