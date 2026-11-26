'use strict';
// Шаг 18: таблица зон бота В РЕЖИМЕ БОТА на test (72 AI-текста + 36 постов канала >= 400 знаков).
// Бот считает не один вызов, а СРЕДНЕЕ ТРЁХ оценок модели и зону «много приёмов» даёт только при оценке >= 55 И находках >= 3 разных пунктов.
// Здесь то же: первая оценка уже есть (eval/results/cache/baseline_test.json, тот же промпт), две новые — тем же запросом, что в боте;
// «Разбор» (explain_fix, без повтора: набор пунктов от повтора не меняется) зовём только когда среднее >= 55: ниже зона не зависит от находок.
//   node eval/zones_bot.js            -> eval/results/zones_bot.md/.json (кэш ответов: eval/results/zones_bot_cache.json, повтор бесплатный)
//   --limit=N  — только первые N текстов (проверка конвейера)
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const E = require('../src/explain_fix');
const { loadSet } = require('./run_test');

const OUT = path.join(__dirname, 'results');
const CACHE_FILE = path.join(OUT, 'zones_bot_cache.json');
const CAP = Number(process.env.ZONES_CAP || 2.2);
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;
const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));

(async () => {
  const t0 = llm.readCost().total_usd;
  const { ai, ch } = loadSet('test');
  const labels = rd('data/voice_test.json').labels;
  const base = JSON.parse(fs.readFileSync(path.join(OUT, 'cache', 'baseline_test.json'), 'utf8'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* нет кэша */ }
  const save = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  let items = [
    ...ai.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', prompt: x.prompt_type, text: x.text })),
    ...ch.map((p) => ({ key: 'p' + p.id, kind: (labels[p.id] || {}).label || 'unclear', id: p.id, text: p.text })),
  ];
  if (LIMIT) items = items.filter((x, i) => i % Math.ceil(items.length / LIMIT) === 0).slice(0, LIMIT);
  const over = () => llm.readCost().total_usd - t0 > CAP;
  let stopped = false;

  async function det(it) { // две новые оценки
    const c = cache[it.key] = cache[it.key] || {};
    c.scores = c.scores || [];
    while (c.scores.length < 2 && !over()) {
      const rq = B.detectorRequest(it.text);
      const res = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, rq.messages[0]], max_tokens: 400, tag: 'zones_bot_det' });
      const sc = B.parseScore({ content: [{ type: 'text', text: res.text }] });
      if (sc !== null) c.scores.push(sc);
      save();
    }
  }
  let next = 0;
  const worker = async () => { while (next < items.length) { const it = items[next++]; try { await det(it); } catch (e) { console.log('ОШИБКА det', it.key, String(e.message).slice(0, 80)); } } };
  await Promise.all(Array.from({ length: 4 }, worker));

  const rows = items.map((it) => {
    const c = cache[it.key] || {};
    const first = base[it.key] ? base[it.key].ai_score : null;
    const scores = [first, ...(c.scores || [])].filter((s) => s !== null && s !== undefined);
    return { ...it, scores, mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, first };
  });
  // разбор — только где среднее >= 55
  const need = rows.filter((r) => r.scores.length === 3 && r.mean >= B.ZONE_HIGH);
  next = 0;
  const wf = async () => {
    while (next < need.length) {
      const r = need[next++];
      const c = cache[r.key];
      if (!c.raw) {
        if (over()) { stopped = true; continue; }
        try { c.raw = (await llm.chat({ model: E.MODEL, messages: [{ role: 'system', content: E.SYSTEM }, { role: 'user', content: '# Пост' + String.fromCharCode(10, 10) + r.text }], max_tokens: E.MAX_TOKENS, tag: 'zones_bot_fix' })).text; save(); }
        catch (e) { console.log('ОШИБКА fix', r.key, String(e.message).slice(0, 80)); }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, wf));

  for (const r of rows) {
    if (r.scores.length < 3) { r.zone = null; continue; }
    const plain = B.zoneOf(r.mean);
    if (plain !== 'high') { r.zone = plain; r.distinct = null; continue; }
    const c = cache[r.key];
    if (!c || !c.raw) { r.zone = null; continue; }
    const fx = E.apply(r.text, E.parseJson(c.raw), { gate: true, mean: r.mean });
    r.distinct = fx.signs.length;
    r.zone = B.finalZone(r.mean, fx.findings, true, fx.signs).zone;
  }
  // переходы по каждому тексту: зона по одному вызову (z1) -> по среднему трёх (zm) -> с правилом «>= 3 разных пункта» (zf)
  for (const r of rows) if (r.scores.length === 3 && r.zone !== null) { r.z1 = B.zoneOf(r.first); r.zm = B.zoneOf(r.mean); r.zf = r.zone; }
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  const grp = (f) => rows.filter(f);
  const Z = ['low', 'mid', 'high'];
  const count = (l) => Object.fromEntries(Z.map((z) => [z, l.filter((r) => r.zone === z).length]));
  const groups = { ai: grp((r) => r.kind === 'ai'), ai_naive: grp((r) => r.kind === 'ai' && r.prompt === 'naive'), ai_human: grp((r) => r.kind === 'ai' && r.prompt === 'human'),
    founder: grp((r) => r.kind === 'founder'), editorial: grp((r) => r.kind === 'editorial'), unclear: grp((r) => r.kind === 'unclear') };
  const table = Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, { n: l.length, ...count(l), unknown: l.filter((r) => r.zone === null).length }]));
  // как в прошлой таблице (один вызов): для сравнения
  const one = (l) => ({ low: l.filter((r) => r.first < B.ZONE_MID).length, mid: l.filter((r) => r.first >= B.ZONE_MID && r.first < B.ZONE_HIGH).length, high: l.filter((r) => r.first >= B.ZONE_HIGH).length });
  const oneTable = Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, one(l)]));
  const spreads = rows.filter((r) => r.scores.length === 3).map((r) => Math.max(...r.scores) - Math.min(...r.scores));
  const weak = rows.filter((r) => r.zone === 'mid' && r.mean >= B.ZONE_HIGH).length; // понижены до «есть приёмы» из-за числа разных пунктов
  const tr = rows.filter((r) => r.zf);
  const ids = (f) => tr.filter(f).map((r) => r.key);
  const trans = {
    total: ids((r) => r.z1 !== r.zf),
    by_average_only: ids((r) => r.z1 !== r.zm && r.zm === r.zf),
    by_rule_only: ids((r) => r.z1 === r.zm && r.zm !== r.zf),
    both_steps: ids((r) => r.z1 !== r.zm && r.zm !== r.zf),
    average_moved: ids((r) => r.z1 !== r.zm),
    rule_moved: ids((r) => r.zm !== r.zf),
    moved_by_average_and_back_by_rule: ids((r) => r.z1 !== r.zm && r.zm !== r.zf && r.z1 === r.zf),
  };
  const crossed = trans.total.length;
  const sorted = spreads.slice().sort((a, b) => a - b);
  const stat = { n: spreads.length, max_spread: Math.max(...spreads), median_spread: sorted[Math.floor(sorted.length / 2)], spread_ge10: spreads.filter((s) => s >= 10).length, weak_downgraded: weak, zone_changed_vs_one_call: crossed, transitions: Object.fromEntries(Object.entries(trans).map(([k, v]) => [k, v.length])), explain_calls: need.filter((r) => cache[r.key] && cache[r.key].raw).length, stopped_by_budget: stopped };
  fs.writeFileSync(path.join(OUT, 'zones_bot.json'), JSON.stringify({ spent_usd: spent, table, one_call: oneTable, stat, rows: rows.map((r) => ({ key: r.key, kind: r.kind, prompt: r.prompt, scores: r.scores, mean: r.mean === null ? null : +r.mean.toFixed(1), zone: r.zone, distinct: r.distinct, z1: r.z1, zm: r.zm, zf: r.zf })), transitions: trans }, null, 1));
  const line = (name, k) => `| ${name} | ${table[k].n} | ${table[k].low} | ${table[k].mid} | ${table[k].high} |${table[k].unknown ? ' нет данных: ' + table[k].unknown : ''}`;
  const md = `# Зоны бота на test в режиме бота (шаг 18)\n\nСреднее трёх вызовов + условие «много приёмов» только при >= 3 разных пунктах находок «Разбора» (пункт 50 не считается). Расход на этот прогон $${spent}.\n\n| Группа | N | меньше 30 | 30–54 | 55+ и >= 3 пунктов |\n|---|---|---|---|---|\n${line('AI-тексты', 'ai')}\n${line('  из них naive', 'ai_naive')}\n${line('  из них human', 'ai_human')}\n${line('Основатель', 'founder')}\n${line('Редакция', 'editorial')}\n${line('Спорные', 'unclear')}\n\nТо же по одному вызову (прошлая таблица): ${JSON.stringify(oneTable)}\n\nРазброс трёх оценок: медиана ${stat.median_spread}, максимум ${stat.max_spread}, >= 10 пунктов у ${stat.spread_ge10} из ${stat.n}. Зона изменилась по сравнению с одним вызовом (по номерам постов и AI-текстов, а не по таблицам) у ${trans.total.length} из ${tr.length}: только из-за усреднения трёх вызовов у ${trans.by_average_only.length}, только из-за правила «>= 3 разных пунктов» у ${trans.by_rule_only.length}, из-за обоих шагов у ${trans.both_steps.length}. Усреднение сдвинуло зону у ${trans.average_moved.length}, правило «>= 3» понизило «много приёмов» до «есть приёмы» у ${trans.rule_moved.length} (понижено: ${weak}).

Номера. Сменили зону: ${trans.total.join(', ')}. Из-за усреднения: ${trans.by_average_only.join(', ')}. Из-за правила: ${trans.by_rule_only.join(', ')}. Из-за обоих: ${trans.both_steps.join(', ')}.

Честно: test мы смотрели при разработке бота (среднее трёх и правило «>= 3 пунктов» введены после первого запуска на test), поэтому это уже не чистая проверка; правила выбирали по dev.

Вызовов «Разбора»: ${stat.explain_calls}${stopped ? ' (БЮДЖЕТ КОНЧИЛСЯ, часть без разбора)' : ''}.\n`;
  fs.writeFileSync(path.join(OUT, 'zones_bot.md'), md);
  console.log(md);
})().catch((e) => { console.log('ОШИБКА', String(e.stack || e.message).replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
