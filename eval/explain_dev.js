'use strict';
// Шаг 13: «Разбор» (только запрос модели) на всех dev-текстах >=400 знаков: 116 AI + 24 founder + 30 editorial.
// Ответы кэшируются в eval/results/explain_dev_cache.json (повторный запуск бесплатный). Test не трогаем.
//   node eval/explain_dev.js            -> дозапрашивает недостающее (потолок CAP долларов по cost.json)
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const E = require('../src/explain_fix');

const CACHE_FILE = path.join(__dirname, 'results', 'explain_dev_cache.json');
const CAP = Number(process.env.EXPLAIN_CAP || 3.3);

function devItems() {
  const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
  const posts = D('posts.json');
  const voice = D('voice_dev.json').labels;
  const ai = D('ai_posts.json').map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev' && x.text.length >= 400);
  return [
    ...ai.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', text: x.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'founder' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'founder', text: p.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'editorial', text: p.text })),
  ];
}
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } };

module.exports = { devItems, readCache, CACHE_FILE };

if (require.main === module) (async () => {
  const items = devItems();
  const cache = readCache();
  const t0 = llm.readCost().total_usd;
  const todo = items.filter((x) => !cache[x.key]);
  console.log('всего', items.length, 'в кэше', items.length - todo.length, 'осталось', todo.length);
  let next = 0, stop = false;
  const worker = async () => {
    while (next < todo.length && !stop) {
      const it = todo[next++];
      if (llm.readCost().total_usd - t0 > CAP) { stop = true; console.log('потолок бюджета'); break; }
      try {
        const r = await E.explainFix(it.text, { tag: 'explain_dev' });
        cache[it.key] = { raw: r.raw, cost: r.cost };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      } catch (e) { console.log('ОШИБКА', it.key, String(e.message).replace(/https?:\/\/\S+/g, '<адрес>')); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log('расход', +(llm.readCost().total_usd - t0).toFixed(4), 'всего в кэше', Object.keys(readCache()).length);
})();
