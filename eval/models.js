// Тянет публичный список моделей OpenRouter (ключ не нужен) и печатает
// id + цены ($ за 1 млн токенов) кандидатов. Сохраняет в eval/results/models.json.
// Запуск: node eval/models.js [--all]   (--all печатает все модели вендора)
const fs = require('fs');
const path = require('path');

const VENDORS = { anthropic: 'anthropic/', openai: 'openai/', google: 'google/' };
const out = path.join(__dirname, 'results', 'models.json');

(async () => {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error('OpenRouter models: HTTP ' + res.status);
  const all = (await res.json()).data;
  const result = { fetched_at: new Date().toISOString(), total: all.length, vendors: {} };
  for (const [v, prefix] of Object.entries(VENDORS)) {
    result.vendors[v] = all
      .filter((m) => m.id.startsWith(prefix) && !m.id.includes(':')) // без :free/:thinking-вариантов
      .map((m) => ({
        id: m.id,
        created: new Date(m.created * 1000).toISOString().slice(0, 10),
        in_per_m: +(m.pricing.prompt * 1e6).toFixed(4),
        out_per_m: +(m.pricing.completion * 1e6).toFixed(4),
        context: m.context_length,
      }))
      .sort((a, b) => b.created.localeCompare(a.created)); // свежие сверху
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  for (const [v, list] of Object.entries(result.vendors)) {
    console.log('\n== ' + v + ' (свежие сверху, всего ' + list.length + ')');
    for (const m of list.slice(0, process.argv.includes('--all') ? 999 : 14))
      console.log(`${m.id.padEnd(46)} ${m.created}  in $${m.in_per_m}  out $${m.out_per_m}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
