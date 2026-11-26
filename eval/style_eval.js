'use strict';
// Шаг 12: прогон критерия eval/V4_STYLE_CRITERIA.md (v4: переписать AI-текст словами основателя) на dev.
//   node eval/style_eval.js [--cap 1.4]   (потолок расхода шага по тегам v4_*, $; кэши в eval/results/v4_cache/ — повтор бесплатный)
// Пишет eval/results/v4_style_dev.md/json и v4_style_pairs.md. Критерий и вердикт — строго по V4_STYLE_CRITERIA.md.
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { styleRewrite } = require('../src/style_rewrite');
const { pickSamples, loadPool } = require('../src/samples');
const { select } = require('./v4_select');
const { rng, shuffle } = require('./v3_select');
const { judgeAll, mean, std, setCap } = require('./v3_lib');

const RES = path.join(__dirname, 'results');
const CACHE_DIR = path.join(RES, 'v4_cache');
const SIGMA = 5.06; // eval/results/noise_dev.md
const JUDGE = 'claude-sonnet-5-5';
const AB_MODEL = 'claude-haiku-5-5';
const SEED_AB = 4402, SEED_CTRL = 4403;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const strip = (t) => t.replace(/\s*@\w+\s*$/, '').trim();
const r1 = (x) => (x === null || x === undefined ? '-' : (+x).toFixed(1));

async function pool(items, conc, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < items.length) { const it = items[next++]; await fn(it); } }));
}

// ---------- слепой выбор «кто основатель» ----------
const AB_SYSTEM = 'Ты внимательный читатель Telegram-каналов сервиса аналитики для селлеров маркетплейсов.';
const AB_USER = (a, b) => `Пост 1:\n${a}\n\n————\n\nПост 2:\n${b}\n\n————\n\nОдин из двух постов написал основатель канала (живой человек), другой написан не им. Какой написал основатель: 1 или 2? Формат ответа строго: «Ответ: 1» или «Ответ: 2», без пояснений.`;
async function askAB(a, b, tag) {
  const res = await llm.chat({ model: AB_MODEL, messages: [{ role: 'system', content: AB_SYSTEM }, { role: 'user', content: AB_USER(a, b) }], max_tokens: 50, tag });
  const m = res.text.match(/[12]/);
  return m ? Number(m[0]) : null;
}

async function main() {
  const t0 = llm.readCost().total_usd;
  const T_START = new Date().toISOString().slice(0, 10) + 'T00:00'; // расход считаем только по своим тегам v4_*: другие сессии платят параллельно
  const mySpend = () => +llm.readCost().calls.filter((x) => /^v4_/.test(x.tag)).reduce((a, x) => a + x.cost, 0).toFixed(4);
  const CAP = Number(opt('cap', 1.4));
  setCap(null);
  const sel = select();
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8'));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const founderPool = loadPool();
  const founderIds = new Set(founderPool.map((p) => p.id));
  const items = [...sel.ai20, ...sel.ed10];

  // 1. переписывание
  const rwFile = path.join(CACHE_DIR, 'rewrite.json');
  const rw = rj(rwFile, {});
  await pool(items.filter((it) => !rw[it.key]), 4, async (it) => {
    try {
      rw[it.key] = await styleRewrite(it.text, { sourceId: it.source_id ?? null, tag: 'v4_style' });
      wj(rwFile, rw);
      console.log('rewrite', it.key, rw[it.key].status, rw[it.key].reason || '', rw[it.key].ratio, '$' + rw[it.key].cost);
    } catch (e) { console.log('ОШИБКА rewrite', it.key, e.message); }
  });
  const done = items.filter((it) => rw[it.key]);

  // 2. оценка «это AI»: 3 вызова до и после
  const before = await judgeAll(JUDGE, done.map((it) => ({ key: it.key, text: it.text })), 3, 'v4_judge');
  const after = await judgeAll(JUDGE, done.map((it) => ({ key: it.key, text: rw[it.key].after })), 3, 'v4_judge');

  // 3. слепой выбор (haiku): переписанный против настоящего поста основателя, обе позиции
  const abFile = path.join(CACHE_DIR, 'ab.json');
  const ab = rj(abFile, {});
  const rand = rng(SEED_AB);
  const abJobs = [];
  for (const it of sel.ai20.filter((x) => rw[x.key])) {
    let real;
    if (founderIds.has(it.source_id)) real = { id: it.source_id, how: 'источник' };
    else {
      const used = new Set(rw[it.key].samples.map((s) => s.id));
      const near = pickSamples(it.text, { k: 8 }).find((s) => !used.has(s.id));
      real = { id: near.id, how: 'ближайший' };
    }
    const first = rand() < 0.5 ? 'rew' : 'real'; // кто идёт первым в первом вызове; второй вызов — зеркало
    const rewT = strip(rw[it.key].after), realT = strip(byId.get(real.id).text);
    for (const pos of [first, first === 'rew' ? 'real' : 'rew']) abJobs.push({ k: `${it.key}|${pos}`, key: it.key, real, pos, a: pos === 'rew' ? rewT : realT, b: pos === 'rew' ? realT : rewT });
  }
  // контроль: founder-пост против другого founder-поста на близкую тему
  const ctrl = shuffle(founderPool, SEED_CTRL).slice(0, 10);
  const ctrlJobs = [];
  for (const p of ctrl) {
    const other = pickSamples(p.text, { k: 1, excludeId: p.id })[0];
    for (const pos of ['x', 'y']) ctrlJobs.push({ k: `c${p.id}|${pos}`, p: p.id, other: other.id, pos, a: strip(pos === 'x' ? p.text : byId.get(other.id).text), b: strip(pos === 'x' ? byId.get(other.id).text : p.text) });
  }
  await pool([...abJobs, ...ctrlJobs].filter((j) => ab[j.k] === undefined), 4, async (j) => {
    try {
      if (mySpend() >= CAP) return;
      ab[j.k] = await askAB(j.a, j.b, 'v4_ab'); wj(abFile, ab);
    } catch (e) { console.log('ОШИБКА ab', j.k, e.message); }
  });
  // «основатель назван»: в позиции pos пост a стоит под номером 1
  const namedRew = abJobs.filter((j) => ab[j.k] != null).map((j) => ({ ...j, rew: (j.pos === 'rew' ? 1 : 2) === ab[j.k] }));
  const ctrlNamed = ctrlJobs.filter((j) => ab[j.k] != null).map((j) => ({ ...j, x: (j.pos === 'x' ? 1 : 2) === ab[j.k] })); // x = «первый» founder-пост назван основателем
  const pos1 = [...abJobs, ...ctrlJobs].filter((j) => ab[j.k] != null);
  const share1 = pos1.length ? pos1.filter((j) => ab[j.k] === 1).length / pos1.length : null; // смещение «называет первый»

  // 4. таблицы
  const rows = done.map((it) => {
    const b = before.get(it.key), a = after.get(it.key), r = rw[it.key];
    return { key: it.key, kind: it.kind, prompt: it.prompt || null, source_id: it.source_id ?? null, before: b, after: a, mb: mean(b), ma: mean(a), status: r.status, reason: r.reason, retried: r.retried, facts_ok: r.facts.ok, missing: r.facts.missing.map((m) => m.value), added: r.facts.added.map((m) => m.value), ratio: r.ratio, copy_flag: r.copy.flag, copy_rate: r.copy.rate, copy_run: r.copy.run, worn: r.worn, samples: r.samples.map((s) => s.id), cost: r.cost, len_before: it.text.length, len_after: r.after.length };
  });
  const full = (r) => r.before.length === 3 && r.after.length === 3;
  const summ = (kind) => {
    const R = rows.filter((r) => r.kind === kind);
    const F = R.filter(full);
    const mB = mean(F.map((r) => r.mb)), mA = mean(F.map((r) => r.ma));
    return { n: R.length, n_scored: F.length, mean_before: mB, mean_after: mA, drop: mB - mA, better: F.filter((r) => r.ma < r.mb).length, worse_gt_sigma: F.filter((r) => r.ma - r.mb > SIGMA).length,
      facts_ok: R.filter((r) => r.facts_ok).length, flags: R.filter((r) => r.copy_flag || r.worn.length).length, human: R.filter((r) => r.status !== 'ok').length,
      flagged_before: F.filter((r) => r.mb >= 30).length, flagged_after: F.filter((r) => r.ma >= 30).length, len_ratio_mean: mean(R.map((r) => r.ratio)) };
  };
  const A = summ('ai'), E = summ('editorial');
  const abShare = namedRew.length ? namedRew.filter((j) => j.rew).length / namedRew.length : null;
  const abBySeat = ['rew', 'real'].map((p) => { const L = namedRew.filter((j) => j.pos === p); return { first: p, n: L.length, named_rew: L.filter((j) => j.rew).length }; });
  const ctrlShare = ctrlNamed.length ? ctrlNamed.filter((j) => j.x).length / ctrlNamed.length : null;
  const spent = mySpend();
  const c = {
    c1: A.drop >= 15 && A.drop >= 2 * SIGMA, c2: A.better >= 15, c3: abShare !== null && abShare >= 0.3, c4: A.facts_ok >= 18, c5: A.flags === 0,
  };
  const all = Object.values(c).every(Boolean) && A.n === 20 && A.n_scored === 20 && namedRew.length === 40;
  const verdict = all ? 'УСПЕХ' : A.drop < 8 ? 'ПАДЕНИЕ < 8: пишем честно, дальше не идём (v4 не делаем)' : 'НЕ ПРОШЛО (падение 8–15 или не выполнены остальные пункты), решение за ведущим';
  const summary = { sigma: SIGMA, A, E, ab: { n: namedRew.length, share_rewritten_named_founder: abShare, by_seat: abBySeat, control_n: ctrlNamed.length, control_first_named: ctrlShare, share_names_position1: share1, ab_model: AB_MODEL }, criteria: c, verdict, spent_usd: spent, judge: JUDGE };
  wj(path.join(RES, 'v4_style_dev.json'), { summary, rows, ab_jobs: abJobs.map((j) => ({ key: j.key, real: j.real, pos: j.pos, answer: ab[j.k] ?? null })), ctrl_jobs: ctrlJobs.map((j) => ({ p: j.p, other: j.other, pos: j.pos, answer: ab[j.k] ?? null })) });

  const pct = (x) => (x === null ? '-' : (100 * x).toFixed(0) + '%');
  const line = (r) => `| ${r.key} | ${r.prompt || '-'} | ${r1(r.mb)} (${r.before.join(', ')}) | ${r1(r.ma)} (${r.after.join(', ')}) | ${r.status}${r.reason ? ' ' + r.reason : ''}${r.retried ? ' (повтор)' : ''} | ${r.facts_ok ? 'ок' : 'нет: -' + r.missing.join(',') + ' +' + r.added.join(',')} | ${r.ratio} | ${r.copy_flag ? 'флаг ' + r.copy_rate + '/' + r.copy_run : '-'}${r.worn.length ? ' worn: ' + r.worn.join(',') : ''} |`;
  const md = `# v4: переписывание словами основателя на dev (шаг 12)

Критерий: eval/V4_STYLE_CRITERIA.md (записан до прогона). Переписывает claude-sonnet-5-5, оценщик «это AI» ${JUDGE} (среднее 3 вызовов), слепой выбор ${AB_MODEL}. σ = ${SIGMA}. Расход шага $${spent}.

## Критерий на 20 AI

| пункт | порог | факт | выполнен |
|---|---|---|---|
| 1. падение средней оценки «AI» | >= 15 и >= 2σ (${(2 * SIGMA).toFixed(1)}) | ${r1(A.mean_before)} → ${r1(A.mean_after)}, падение ${r1(A.drop)} | ${c.c1 ? 'да' : 'нет'} |
| 2. парно лучше (после < до) | >= 15 из 20 | ${A.better} из ${A.n_scored} | ${c.c2 ? 'да' : 'нет'} |
| 3. слепой выбор: переписанный назван основателем | >= 30% (из 40) | ${pct(abShare)} (${namedRew.filter((j) => j.rew).length} из ${namedRew.length}); по позиции: ${abBySeat.map((s) => `переписанный первым ${s.named_rew}/${s.n}`).join(', ')} | ${c.c3 ? 'да' : 'нет'} |
| контроль слепого: founder против founder | ~50% | первый founder-пост назван основателем ${pct(ctrlShare)} (${ctrlNamed.filter((j) => j.x).length} из ${ctrlNamed.length}); оценщик называет «1» в ${pct(share1)} всех вызовов | справочно |
| 4. факты ок | >= 18 из 20 | ${A.facts_ok} из ${A.n} | ${c.c4 ? 'да' : 'нет'} |
| 5. флаги copyRate / worn | 0 из 20 | ${A.flags} из ${A.n} | ${c.c5 ? 'да' : 'нет'} |

Флаг «AI» (оценка >= 30): было ${A.flagged_before} из 20, стало ${A.flagged_after} из 20. Статус «человеку» после повтора: ${A.human} из 20. Средняя длина результата ${(A.len_ratio_mean * 100).toFixed(0)}% исходной.

**Вердикт: ${verdict}**

## Editorial 10 (справочно, на вердикт не влияет)
Было ${r1(E.mean_before)} → стало ${r1(E.mean_after)}, падение ${r1(E.drop)}; парно лучше ${E.better} из ${E.n_scored}; стало выше «до» больше чем на σ: ${E.worse_gt_sigma} из ${E.n_scored}; факты ок ${E.facts_ok} из ${E.n}; флаги ${E.flags}.

## Построчно (оценки трёх вызовов в скобках)

| текст | промпт | до | после | статус | факты | длина | копирование / worn |
|---|---|---|---|---|---|---|---|
${rows.map(line).join('\n')}
`;
  fs.writeFileSync(path.join(RES, 'v4_style_dev.md'), md);

  const pairs = rows.map((r) => `## ${r.key} (${r.kind}${r.prompt ? ', ' + r.prompt : ''}) оценка AI ${r1(r.mb)} → ${r1(r.ma)}, ${r.status}${r.reason ? ' ' + r.reason : ''}, длина ${r.len_before} → ${r.len_after}, образцы ${r.samples.join(', ')}\n\n### Было\n\n${items.find((i) => i.key === r.key).text}\n\n### Стало\n\n${rw[r.key].after}\n`);
  fs.writeFileSync(path.join(RES, 'v4_style_pairs.md'), '# v4: пары «было → стало» (шаг 12)\n\n' + pairs.join('\n---\n\n'));
  console.log(md);
}
main().catch((e) => { console.error(e); process.exit(1); });
