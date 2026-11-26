'use strict';
// Шаг 9, п. 4–5: прогон v3 (А и Б) на 20 свежих AI dev + 10 editorial dev, независимая мера, парный выбор, вердикт по eval/V3_CRITERIA.md.
//   node eval/v3_dev.js        -> eval/results/v3_dev.md/json, v3_pairs_A.md, v3_pairs_B.md
// Один проход на текст и вариант, без выбора лучшего по оценке. Кэш: eval/results/v3_cache/*.json (повторный запуск денег не тратит).
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const L = require('./v3_lib');
const { select, rng } = require('./v3_select');
const { dry } = require('../src/rewrite_v3');

const RES = L.RES;
const CACHE_DIR = path.join(RES, 'v3_cache');
const CAP = Number(process.env.V3_CAP || 10.69); // потолок cost.json: 7,697836 + 3
const GEN = 'claude-sonnet-5-5', JUDGE = 'claude-sonnet-5-5', PAIR = 'claude-haiku-5-5';
const REPS = 3;
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const r1 = (x) => (x === null || x === undefined ? null : +x.toFixed(1));

function loadCache(name) { try { return rj(path.join(CACHE_DIR, name + '.json')); } catch { return {}; } }
function saveCache(name, c) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name + '.json'), JSON.stringify(c)); }

async function pool(items, conc, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < items.length) { const it = items[next++]; await fn(it); } }));
}

const PAIR_SYS = 'Ты внимательный читатель Telegram-каналов о маркетплейсах. Тебе дают две версии одного и того же поста.';
const PAIR_USER = (a, b) => `Версия 1:\n${a}\n\n————\n\nВерсия 2:\n${b}\n\n————\n\nКакая версия звучит так, как написал живой человек, а не нейросеть? Формат ответа строго: «Версия: 1» или «Версия: 2», без пояснений.`;
async function askPair(a, b, tag) {
  if (llm.readCost().total_usd >= CAP) throw new Error('потолок шага исчерпан');
  const res = await llm.chat({ model: PAIR, messages: [{ role: 'system', content: PAIR_SYS }, { role: 'user', content: PAIR_USER(a, b) }], max_tokens: 200, tag });
  const m = res.text.match(/Версия:\s*([12])/i) || res.text.match(/\b([12])\b/);
  return m ? Number(m[1]) : null;
}

(async () => {
  const t0 = llm.readCost().total_usd;
  L.setCap(CAP);
  const sel = select();
  const items = [...sel.ai20, ...sel.ed10];
  const noise = rj(path.join(RES, 'noise_dev.json')).summary;
  const sigma = noise.sigma;

  // 1. переписывание А и Б (один вызов на текст и вариант)
  const gen = { A: loadCache('gen_A'), B: loadCache('gen_B') };
  for (const variant of ['A', 'B']) {
    const todo = items.filter((it) => !gen[variant][it.key]);
    await pool(todo, 4, async (it) => {
      try {
        const r = await dry(it.text, { variant, model: GEN, sourceId: it.source_id, tag: 'v3dev' });
        gen[variant][it.key] = r; saveCache('gen_' + variant, gen[variant]);
        console.log(variant, it.key, r.status, r.reason || '', 'del', r.diff.filter((d) => d.type === 'delete').length, 'rep', r.diff.filter((d) => d.type === 'replace').length, 'facts', r.facts && r.facts.ok, '$' + r.cost);
      } catch (e) { console.log('ОШИБКА', variant, it.key, e.message); }
    });
  }

  // 2. независимая мера: Sonnet, 3 вызова на «до» и на «после» каждого варианта
  const judgeItems = [];
  for (const it of items) {
    judgeItems.push({ key: it.key + '|before', text: it.text });
    for (const v of ['A', 'B']) if (gen[v][it.key]) judgeItems.push({ key: it.key + '|' + v, text: gen[v][it.key].after });
  }
  const sc = await L.judgeAll(JUDGE, judgeItems, REPS, 'v3_judge');

  // 3. парный выбор (Haiku), порядок случайный, зерно 4401; плюс обратный порядок для контроля смещения
  const rand = rng(4401);
  const pc = loadCache('pairs');
  const pairs = { A: {}, B: {} };
  const pjobs = [];
  for (const v of ['A', 'B']) for (const it of items) {
    const g = gen[v][it.key]; if (!g) continue;
    const afterFirst = rand() < 0.5; // порядок фиксируется до вызова и пишется в результат
    pairs[v][it.key] = { afterFirst, same: g.after === it.text };
    if (g.after !== it.text) pjobs.push({ v, it, g, afterFirst });
  }
  await pool(pjobs, 4, async ({ v, it, g, afterFirst }) => {
    const k = `${v}|${it.key}|${require('crypto').createHash('sha1').update(g.after).digest('hex').slice(0, 10)}|${afterFirst}`;
    try {
      if (pc[k] === undefined) {
        const a1 = afterFirst ? g.after : it.text, b1 = afterFirst ? it.text : g.after;
        const c1 = await askPair(a1, b1, 'v3_pair');
        const c2 = await askPair(b1, a1, 'v3_pair_swap'); // обратный порядок
        pc[k] = { c1, c2 }; saveCache('pairs', pc);
      }
      const { c1, c2 } = pc[k];
      pairs[v][it.key].pick1 = c1 === null ? null : (afterFirst ? c1 === 1 : c1 === 2); // true = выбрали «после» в случайном порядке
      pairs[v][it.key].pick2 = c2 === null ? null : (afterFirst ? c2 === 2 : c2 === 1); // в обратном порядке
    } catch (e) { console.log('ОШИБКА пара', v, it.key, e.message); }
  });

  // 4. сводка
  const spent = () => +(llm.readCost().total_usd - t0).toFixed(4);
  const mean = L.mean;
  const rows = {};
  for (const v of ['A', 'B']) {
    rows[v] = items.map((it) => {
      const g = gen[v][it.key]; if (!g) return null;
      const b = sc.get(it.key + '|before'), a = sc.get(it.key + '|' + v);
      const pr = pairs[v][it.key] || {};
      return { key: it.key, kind: it.kind, prompt: it.prompt || null, status: g.status, reason: g.reason, before: mean(b), after: mean(a), before_all: b, after_all: a,
        better: mean(a) < mean(b), worse_sigma: mean(a) - mean(b) > sigma, win: pr.same ? null : pr.pick1 === true, tie_same: !!pr.same, win_swapped: pr.same ? null : pr.pick2 === true, facts_ok: g.facts.ok,
        len: g.length_change, lint_before: g.lint_before, lint_after: g.lint_after, n_del: g.diff.filter((d) => d.type === 'delete').length, n_rep: g.diff.filter((d) => d.type === 'replace').length,
        rejected: g.rejected.length, restored: g.restored.length, copy_flag: g.copy ? g.copy.flag : null, cost: g.cost };
    }).filter(Boolean);
  }
  const agg = (rs) => {
    const n = rs.length;
    const mb = mean(rs.map((r) => r.before)), ma = mean(rs.map((r) => r.after));
    return {
      n, before: r1(mb), after: r1(ma), drop: r1(mb - ma),
      better: rs.filter((r) => r.better).length, worse_sigma: rs.filter((r) => r.worse_sigma).length,
      flagged_before: rs.filter((r) => r.before >= 30).length, flagged_after: rs.filter((r) => r.after >= 30).length,
      wins: rs.filter((r) => r.win === true).length, wins_swapped: rs.filter((r) => r.win_swapped === true).length, unchanged: rs.filter((r) => r.tie_same).length,
      wins_both_orders: rs.filter((r) => r.win === true && r.win_swapped === true).length,
      facts_ok: rs.filter((r) => r.facts_ok).length, len: r1(100 * mean(rs.map((r) => r.len))),
      lint_before: r1(mean(rs.filter((r) => r.lint_before !== null).map((r) => r.lint_before))), lint_after: r1(mean(rs.filter((r) => r.lint_after !== null).map((r) => r.lint_after))),
      n_del: r1(mean(rs.map((r) => r.n_del))), n_rep: r1(mean(rs.map((r) => r.n_rep))), rejected: rs.reduce((s, r) => s + r.rejected, 0), restored: rs.reduce((s, r) => s + r.restored, 0), copy_flags: rs.filter((r) => r.copy_flag).length,
      errors: rs.filter((r) => r.status === 'error').length, unresolved: rs.filter((r) => r.reason === 'facts_unresolved').length,
    };
  };
  const S = { sigma };
  for (const v of ['A', 'B']) {
    S[v] = { ai: agg(rows[v].filter((r) => r.kind === 'ai')), editorial: agg(rows[v].filter((r) => r.kind === 'editorial')), ai_before_ge40: agg(rows[v].filter((r) => r.kind === 'ai' && r.before >= 40)) };
  }
  // вердикт строго по V3_CRITERIA.md
  const verdict = {};
  for (const v of ['A', 'B']) {
    const a = S[v].ai, e = S[v].editorial;
    const c = {
      c1_drop: { value: a.drop, need: `>= 15 и >= ${r1(2 * sigma)} (2σ)`, ok: a.drop >= 15 && a.drop >= 2 * sigma },
      c2_better: { value: `${a.better}/${a.n}`, need: '>= 15 из 20', ok: a.better >= 15 },
      c3_pairs: { value: `${a.wins}/${a.n}`, need: '>= 15 из 20', ok: a.wins >= 15 },
      c4_facts: { value: `${a.facts_ok}/${a.n}`, need: '>= 18 из 20', ok: a.facts_ok >= 18 },
      c5_editorial: { value: `хуже больше чем на σ: ${e.worse_sigma} из ${e.n}`, need: '0', ok: e.worse_sigma === 0 },
    };
    c.success = Object.values(c).every((x) => x.ok);
    c.stop_v4 = a.drop < 8;
    verdict[v] = c;
  }
  verdict.b_over_a = { diff_after: r1(S.A.ai.after - S.B.ai.after), copy_flags_B: S.B.ai.copy_flags + S.B.editorial.copy_flags };
  verdict.b_over_a.take_B = verdict.b_over_a.diff_after >= 5 && verdict.b_over_a.copy_flags_B === 0;
  verdict.overall = (verdict.A.success || verdict.B.success) ? 'успех' : (verdict.A.stop_v4 && verdict.B.stop_v4 ? 'не прошло: падение < 8 у обоих, v4 не делаем' : 'не прошло (промежуточное)');
  const out = { generator: GEN, judge: JUDGE, pair_judge: PAIR, reps: REPS, summary: S, verdict, rows, spent_usd: spent() };
  fs.writeFileSync(path.join(RES, 'v3_dev.json'), JSON.stringify(out, null, 1));

  // 5. пары для чтения
  const idx = Object.fromEntries(items.map((it) => [it.key, it]));
  for (const v of ['A', 'B']) {
    const L2 = [`# Пары до/после, вариант ${v} (v3, dev)\n`, 'Порядок для читателя: сначала исходный текст, потом результат. Зачёркнутые — предложения, убранные кодом по предложению модели (причина в скобках); замены — было → стало.\n'];
    for (const r of rows[v]) {
      const g = gen[v][r.key], it = idx[r.key];
      L2.push(`## ${r.key} (${r.kind}${r.prompt ? ', ' + r.prompt : ''}) оценка ${r1(r.before)} → ${r1(r.after)}, длина ${(100 * (r.len || 0)).toFixed(0)}%, факты ${r.facts_ok ? 'ок' : 'НЕТ'}, пара: ${r.tie_same ? 'без изменений' : r.win ? 'после лучше' : 'до лучше'}${r.copy_flag ? ', ФЛАГ копирования' : ''}\n`);
      L2.push('**Правки:**');
      for (const d of g.diff) L2.push(d.type === 'delete' ? `- ~~[${d.n}] ${d.text}~~ (${d.reason})` : `- [${d.n}] «${d.was}» → «${d.now}»`);
      if (g.restored.length) L2.push('- возвращено кодом: ' + g.restored.map((x) => `[${x.n}] ${x.why}`).join('; '));
      if (g.rejected.length) L2.push('- отклонено кодом: ' + g.rejected.map((x) => `[${x.n}] ${x.type}: ${x.why}`).join('; '));
      L2.push('\n**До:**\n\n' + it.text + '\n\n**После:**\n\n' + g.after + '\n\n---\n');
    }
    fs.writeFileSync(path.join(RES, `v3_pairs_${v}.md`), L2.join('\n'));
  }

  // 6. v3_dev.md
  const f = (a) => `| ${a.before} → ${a.after} (${a.drop > 0 ? '−' : '+'}${Math.abs(a.drop)}) | ${a.flagged_before} → ${a.flagged_after} | ${a.better}/${a.n} | ${a.wins}/${a.n - a.unchanged} (без изменений ${a.unchanged}; в обоих порядках ${a.wins_both_orders}; обратный порядок ${a.wins_swapped}) | ${a.facts_ok}/${a.n} | ${a.len}% | ${a.lint_before} → ${a.lint_after} | ${a.n_del} / ${a.n_rep} | ${a.rejected} / ${a.restored} | ${a.copy_flags} |`;
  const md = `# v3 на dev: «сушка» (А) и «сушка + пары» (Б) (шаг 9)

Критерий записан заранее: eval/V3_CRITERIA.md. Генератор ${GEN}, один вызов на текст и вариант, без цикла. Оценщик ${JUDGE} (промпт baseline_ai), ${REPS} вызова на «до» и на «после», σ одного вызова = ${r1(sigma)} (noise_dev.md). Парный выбор: ${PAIR}, порядок случайный (зерно 4401). Выборки: 20 свежих AI dev (зерно 3101), 10 editorial dev (зерно 3102).

| группа | вариант | оценка «AI» до → после | ≥30 до → после | лучше парно (оценка) | парный выбор «после человечнее» | факты ок | длина | линтер до → после | удалено / замен на текст | отклонено / возвращено кодом | флаги копирования |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AI 20 | А ${f(S.A.ai)}
| AI 20 | Б ${f(S.B.ai)}
| editorial 10 | А ${f(S.A.editorial)}
| editorial 10 | Б ${f(S.B.editorial)}

Дополнительно, AI-тексты с «до» >= 40 (n=${S.A.ai_before_ge40.n}): А ${S.A.ai_before_ge40.before} → ${S.A.ai_before_ge40.after}, Б ${S.B.ai_before_ge40.before} → ${S.B.ai_before_ge40.after}.
Ошибок JSON: А ${S.A.ai.errors + S.A.editorial.errors}, Б ${S.B.ai.errors + S.B.editorial.errors}. Факты не сошлись после всех возвратов: А ${S.A.ai.unresolved + S.A.editorial.unresolved}, Б ${S.B.ai.unresolved + S.B.editorial.unresolved}.
Редакционные посты, ставшие «хуже» больше чем на σ: А ${S.A.editorial.worse_sigma}, Б ${S.B.editorial.worse_sigma}.

## Вердикт по V3_CRITERIA.md
${['A', 'B'].map((v) => `**Вариант ${v}** — ${verdict[v].success ? 'ВСЕ пункты выполнены' : 'не выполнен'}${verdict[v].stop_v4 ? '; падение < 8, v4 не делаем' : ''}\n` + Object.entries(verdict[v]).filter(([k]) => /^c\d/.test(k)).map(([k, x]) => `- ${k}: ${x.value}, нужно ${x.need} → ${x.ok ? 'да' : 'НЕТ'}`).join('\n')).join('\n\n')}

Б против А: среднее «после» у А минус у Б = ${verdict.b_over_a.diff_after} п., флагов копирования у Б ${verdict.b_over_a.copy_flags_B} → ${verdict.b_over_a.take_B ? 'берём Б' : 'берём А (проще)'}.
**Итог: ${verdict.overall}.**

Построчно (AI): оценки до → после А / Б
${rows.A.filter((r) => r.kind === 'ai').map((r) => { const b = rows.B.find((x) => x.key === r.key); return `- ${r.key} (${r.prompt}): ${r1(r.before)} → ${r1(r.after)} / ${b ? r1(b.after) : '-'}`; }).join('\n')}

Построчно (editorial): оценки до → после А / Б
${rows.A.filter((r) => r.kind === 'editorial').map((r) => { const b = rows.B.find((x) => x.key === r.key); return `- ${r.key}: ${r1(r.before)} → ${r1(r.after)} / ${b ? r1(b.after) : '-'}`; }).join('\n')}

Расход шага: ${out.spent_usd} $ (cost.json на конец ${llm.readCost().total_usd.toFixed(3)}).
`;
  fs.writeFileSync(path.join(RES, 'v3_dev.md'), md);
  console.log(md);
})();
