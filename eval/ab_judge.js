'use strict';
// Слепой A/B «где писал человек» (шаг 8). Оценщик — claude-sonnet-5-5 (другой вендор, чем terra), effort low (llm.js).
// Пара = (ближайший по теме пост основателя dev из src/samples.js, исключая источник) + кандидат; порядок случайный (зерно).
// Оценщик отвечает «Человек: 1» или «Человек: 2» (одна цифра llm.js не принимает: ответ < 5 знаков = ошибка).
// Метрика: «обманул оценщика» = доля пар, где оценщик назвал человеком кандидата.
//   node eval/ab_judge.js        -> dev: до / после правки terra на 20 текстах + контроли; пишет eval/results/ab_dev.md/json
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { pickSamples } = require('../src/samples');

const RES = path.join(__dirname, 'results');
const CACHE = process.env.KAN_CACHE_DIR || path.join(RES, 'cache');
const JUDGE = 'claude-sonnet-5-5';
const SYSTEM = 'Ты редактор Telegram-каналов. Тебе дают два текста на одну тему для канала сервиса аналитики для селлеров маркетплейсов. ' +
  'Один написал живой человек (автор канала), другой — нейросеть. Определи, какой текст написал человек.';
const USER = (a, b) => `Текст 1:\n${a}\n\n————\n\nТекст 2:\n${b}\n\nКакой текст написал человек? Ответь строго в формате «Человек: 1» или «Человек: 2», без пояснений.`;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const strip = (t) => t.replace(/\s*@\w+\s*$/, '').trim();

// один вызов: cand — кандидат, human — текст человека, candSlot — 1 или 2 (где лежит кандидат)
async function judgePair(cand, human, candSlot, tag) {
  const [a, b] = candSlot === 1 ? [strip(cand), strip(human)] : [strip(human), strip(cand)];
  const res = await llm.chat({ model: JUDGE, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER(a, b) }], max_tokens: 400, tag });
  const m = res.text.match(/Человек:\s*([12])/i) || res.text.match(/\b([12])\b/);
  const said = m ? Number(m[1]) : null;
  return { said, cand_named_human: said === null ? null : said === candSlot, cost: res.cost };
}

// pairs: [{key, cand, human, slot}] -> результаты с кэшем в eval/results/cache/<name>.json
async function runPairs(name, pairs, conc = 4) {
  const file = path.join(CACHE, name + '.json');
  fs.mkdirSync(CACHE, { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет кэша */ }
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const p = pairs[next++];
      if (cache[p.key]) continue;
      try { cache[p.key] = await judgePair(p.cand, p.human, p.slot, 'ab_' + name); fs.writeFileSync(file, JSON.stringify(cache)); }
      catch (e) { console.log('ОШИБКА', p.key, e.message); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return pairs.map((p) => ({ ...p, ...(cache[p.key] || { said: null, cand_named_human: null, cost: 0 }) }));
}

const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : null);
function summarize(rs) {
  const ok = rs.filter((r) => r.cand_named_human !== null);
  const k = ok.filter((r) => r.cand_named_human).length;
  return { n: rs.length, answered: ok.length, fooled: k, fooled_pct: pct(k, ok.length), said_1_pct: pct(ok.filter((r) => r.said === 1).length, ok.length) };
}
// парные «до/после»: по парам, где есть оба ответа
function paired(before, after) {
  const o = { both: 0, b_only: 0, a_only: 0, neither: 0 };
  before.forEach((b, i) => {
    const a = after[i];
    if (b.cand_named_human === null || a.cand_named_human === null) return;
    if (b.cand_named_human && a.cand_named_human) o.both++;
    else if (b.cand_named_human) o.b_only++;
    else if (a.cand_named_human) o.a_only++;
    else o.neither++;
  });
  return o;
}

// ближайший по теме founder-пост dev; excludeId — источник кандидата
const nearest = (text, excludeId) => pickSamples(text, { k: 1, excludeId, maxChars: 4000 })[0];

// пары «кандидат до / после» для набора {id, source_id, before, after}; общий человек и общий слот у до и после
function buildBeforeAfter(items, seed) {
  const rand = rng(seed);
  const before = [], after = [];
  for (const it of items) {
    const h = nearest(it.before, it.source_id);
    const slot = rand() < 0.5 ? 1 : 2;
    before.push({ key: 'b' + it.id, id: it.id, human_id: h.id, cand: it.before, human: h.text, slot });
    after.push({ key: 'a' + it.id, id: it.id, human_id: h.id, cand: it.after, human: h.text, slot });
  }
  return { before, after };
}

module.exports = { JUDGE, rng, judgePair, runPairs, summarize, paired, nearest, buildBeforeAfter, strip };

if (require.main === module) (async () => {
  const t0 = llm.readCost().total_usd;
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8'));
  const voice = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'voice_dev.json'), 'utf8')).labels;
  const cmp = JSON.parse(fs.readFileSync(path.join(RES, 'rewrite_compare.json'), 'utf8'));
  const cache = JSON.parse(fs.readFileSync(path.join(RES, 'rewrite_cache', 'gpt-6.1-terra.json'), 'utf8'));
  const srcOf = Object.fromEntries(cmp.selection.ids.map((id, i) => [id, cmp.selection.sources[i]]));
  const items = cmp.selection.ids.map((id) => ({ id, source_id: srcOf[id], before: cache[id].before, after: cache[id].after, status: cache[id].status }));
  const { before, after } = buildBeforeAfter(items, 8001);
  const rb = await runPairs('dev_before', before), ra = await runPairs('dev_after', after);

  // контроль 1: founder vs editorial (10 пар): «кандидат» = editorial-пост, человек = ближайший founder
  const rand = rng(8002);
  const shuf = (a) => a.map((x) => [rand(), x]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const edit = shuf(posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 400)).slice(0, 10);
  const cE = edit.map((p) => { const h = nearest(p.text, p.id); return { key: 'e' + p.id, id: p.id, human_id: h.id, cand: p.text, human: h.text, slot: rand() < 0.5 ? 1 : 2 }; });
  const rE = await runPairs('dev_ctrl_editorial', cE);
  // контроль 2: founder vs другой founder (10 пар)
  const fnd = shuf(posts.filter((p) => voice[p.id] && voice[p.id].label === 'founder' && p.text.length >= 400)).slice(0, 10);
  const cF = fnd.map((p) => { const h = nearest(p.text, p.id); return { key: 'f' + p.id, id: p.id, human_id: h.id, cand: p.text, human: h.text, slot: rand() < 0.5 ? 1 : 2 }; });
  const rF = await runPairs('dev_ctrl_founder', cF);

  const out = { judge: JUDGE, seed: 8001, before: summarize(rb), after: summarize(ra), paired: paired(rb, ra), ctrl_editorial: summarize(rE), ctrl_founder: summarize(rF),
    status_counts: items.reduce((o, i) => { o[i.status] = (o[i.status] || 0) + 1; return o; }, {}),
    pairs: rb.map((b, i) => ({ id: b.id, human_id: b.human_id, slot: b.slot, before_named_human: b.cand_named_human, after_named_human: ra[i].cand_named_human })),
    spent_usd: +(llm.readCost().total_usd - t0).toFixed(4) };
  fs.writeFileSync(path.join(RES, 'ab_dev.json'), JSON.stringify(out, null, 1));
  const L = (s) => `${s.fooled} из ${s.answered} (${s.fooled_pct}%)`;
  fs.writeFileSync(path.join(RES, 'ab_dev.md'), `# Слепой A/B на dev (шаг 8)

Оценщик ${JUDGE} (effort low), вопрос «какой из двух текстов написал человек». Человек в паре — ближайший по теме founder-пост dev (src/samples.js, источник кандидата исключён). Порядок случайный (зерно 8001). «Обманул» = оценщик назвал человеком кандидата.

| набор | пар | кандидата назвали человеком |
|---|---|---|
| AI-текст до правки (20 текстов dev) | ${out.before.n} | ${L(out.before)} |
| после правки gpt-6.1-terra (те же пары) | ${out.after.n} | ${L(out.after)} |
| контроль: editorial-пост канала против founder | ${out.ctrl_editorial.n} | ${L(out.ctrl_editorial)} |
| контроль: founder против другого founder | ${out.ctrl_founder.n} | ${L(out.ctrl_founder)} |

Парно (до → после): человеком названы оба раза ${out.paired.both}, только до ${out.paired.b_only}, только после ${out.paired.a_only}, ни разу ${out.paired.neither}.
Доля ответов «1» (смещение по позиции): до ${out.before.said_1_pct}%, после ${out.after.said_1_pct}%, editorial ${out.ctrl_editorial.said_1_pct}%, founder ${out.ctrl_founder.said_1_pct}%.
Статусы переписывания в этих 20: ${JSON.stringify(out.status_counts)} (в «после» берётся итог конвейера, в том числе у ушедших человеку).

Оговорки: 20 пар — доверительный интервал ±20 п.п.; оценщик один вызов на пару, без температуры; судья-LLM любит «складные» тексты (docs/learnings-from-bots.md), годится для сравнения до/после, не как абсолютная оценка. Расход ${out.spent_usd} $.
`);
  console.log(fs.readFileSync(path.join(RES, 'ab_dev.md'), 'utf8'));
})();
