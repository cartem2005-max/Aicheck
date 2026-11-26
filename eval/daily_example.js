'use strict';
// Пример ежедневной сводки: тот же код, что в daily (dailyRequests -> три оценки -> digest), но посты берём из data/posts.json
// (в боевой ноде их разбирает parsePosts со страницы t.me/s/kultura_analitiki). Расход ~ $0,03.
//   node eval/daily_example.js -> eval/results/daily_example.md (+ daily_example.json: кэш ответов, повтор бесплатный)
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');

const OUT = path.join(__dirname, 'results');
const CACHE = path.join(OUT, 'daily_example.json');
function toMd(html) {
  return html.replace(/<b>/g, '**').replace(/<\/b>/g, '**').replace(/<i>/g, '_').replace(/<\/i>/g, '_')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}
(async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8')).sort((a, b) => b.id - a.id).slice(0, 3).sort((a, b) => a.id - b.id);
  const reqItems = B.dailyRequests(posts, (t) => lintStep(t, 5, []));
  const cached = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : null;
  const t0 = llm.readCost().total_usd;
  const texts = [];
  for (let k = 0; k < reqItems.length; k++) {
    if (cached && cached[k] !== undefined) { texts.push(cached[k]); continue; }
    const rq = reqItems[k].req;
    const res = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, rq.messages[0]], max_tokens: 400, tag: 'daily_example' });
    texts.push(res.text);
  }
  fs.writeFileSync(CACHE, JSON.stringify(texts, null, 1));
  const responses = texts.map((t) => ({ content: [{ type: 'text', text: t }] }));
  const sd = {};
  const d = B.digest(reqItems, responses, sd, Date.parse('2026-11-26T07:00:00Z')); // 10:00 МСК
  const md = `# Пример на трёх сохранённых постах (ежедневная сводка)\n\nЭто не живой прогон по каналу, а пример на трёх сохранённых постах. Тот же код, что в ежедневной ноде (оценка модели по трём вызовам, линтер, места), на трёх последних постах канала из data/posts.json (боевая нода берёт их со страницы t.me/s/kultura_analitiki). Так сообщение выглядит в Telegram (разметка переведена в markdown).\n\n---\n\n${toMd(d.html)}\n`;
  fs.writeFileSync(path.join(OUT, 'daily_example.md'), md);
  console.log(d.posts, 'постов, расход', +(llm.readCost().total_usd - t0).toFixed(4));
})().catch((e) => { console.log('ОШИБКА', String(e.stack || e.message).replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
