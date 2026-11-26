'use strict';
// Выбор поста для кнопки «Проверить пример»: полный конвейер бота (линтер, 3 оценки детектора, «Сократить») на 8 постах канала.
//   node eval/example_pick.js -> eval/results/example_pick.md/json. Бюджет <= $0,3.
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const S = require('../src/shorten');
const { lintStep } = require('../src/bot_lint');
const { stripMarkdown } = require('../src/clean');

(async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8'));
  const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
  const fixed = [985, 1001, 893].filter((id) => byId[id]);
  const recent = posts.filter((p) => p.text.length >= 600 && p.text.length <= 3500 && ![916, 960, ...fixed].includes(p.id)).sort((a, b) => b.id - a.id).slice(0, 8 - fixed.length).map((p) => p.id);
  const ids = [...fixed, ...recent];
  const t0 = llm.readCost().total_usd;
  const rows = [];
  for (const id of ids) {
    const text = stripMarkdown(byId[id].text);
    const li = lintStep(text);
    const responses = [];
    for (let i = 0; i < 3; i++) {
      const rq = B.detectorRequest(text);
      try {
        const r = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, { role: 'user', content: rq.messages[0].content }], max_tokens: 400, tag: 'example_pick' });
        responses.push({ content: [{ type: 'text', text: r.text }] });
      } catch (e) { responses.push({ error: { message: 'x' } }); }
    }
    const sc = B.scoreStep(responses);
    let sh = null;
    if (!sc.api_error && sc.need_shorten) { try { sh = await S.shorten(text, { tag: 'example_pick' }); } catch (e) { sh = null; } }
    rows.push({ id, chars: text.length, scores: sc.scores, mean: sc.mean, zone: sc.zone, places: li.highlights.length, sh });
    console.log(id, sc.zone, sc.mean, sh ? sh.status + ' ' + sh.removed.length : '-');
  }
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  let md = `# Кандидаты на пример (кнопка «Проверить пример»)\n\nПолный конвейер бота, Sonnet 5.5, среднее трёх оценок. Расход ${spent} $.\n\n| id | знаков | оценки | среднее | зона | мест (линтер) | правка | что удалено |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const rem = r.sh ? r.sh.removed.map((x) => `[${x.n}] «${x.quote.slice(0, 70)}» (${x.reason}${x.covered_by_quote ? ', уже сказано: «' + x.covered_by_quote.slice(0, 60) + '»' : ''})`).join('; ') : '';
    md += `| ${r.id} | ${r.chars} | ${r.scores.join(', ')} | ${r.mean} | ${r.zone} | ${r.places} | ${r.sh ? r.sh.status + ' (' + r.sh.removed.length + ')' : '-'} | ${rem || '-'} |\n`;
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'example_pick.md'), md);
  fs.writeFileSync(path.join(__dirname, 'results', 'example_pick.json'), JSON.stringify(rows, null, 1));
  console.log(md);
})().catch((e) => { console.log('ОШИБКА', e.message.replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
