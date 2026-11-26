// Шаг 5: брифы (тема + факты) по 96 постам и 192 AI-текста (по 2 на бриф).
// Запуск:  node eval/gen.js            — по-настоящему (шлюз n8n: KAN_LLM_URL или файл .llm-url)
//          node eval/gen.js --dry      — мок без сети и без денег, файлы во временной папке
//          node eval/gen.js --limit 3  — только первые 3 поста (пробный прогон)
// Можно прерывать и запускать снова: уже готовое пропускается.
const fs = require('fs');
const os = require('os');
const path = require('path');
if (process.argv.includes('--dry')) process.env.LLM_MOCK = '1'; // до подключения llm.js
const { chat, isMock, readCost } = require('../src/llm');
const { stripMarkdown } = require('../src/clean'); // тот же код, что чистит вход бота: линтер видит только чистый текст

const ROOT = path.join(__dirname, '..');
// Мок пишет во временную папку, настоящие data/*.json не трогает.
const OUT = process.env.KAN_OUT_DIR || (isMock() ? path.join(os.tmpdir(), 'kan-mock', 'data') : path.join(ROOT, 'data'));
const P = {
  briefs: path.join(OUT, 'briefs.json'),
  ai: path.join(OUT, 'ai_posts.json'),
  problems: path.join(OUT, 'gen_problems.log'),
};

// Три генератора — три модели Claude разного размера (через шлюз в n8n); запасная — соседняя по кольцу.
// Тексты других вендоров (GPT, Gemini) — отдельная малая выборка из их чатов: eval/data/ai_cross.json.
const GEN = [
  { vendor: 'haiku', model: 'claude-haiku-5-5', fallback: 'claude-sonnet-5-5' },
  { vendor: 'sonnet', model: 'claude-sonnet-5-5', fallback: 'claude-opus-5-5' },
  { vendor: 'opus', model: 'claude-opus-5-5', fallback: 'claude-sonnet-5-5' },
];
const BRIEF_MODEL = { model: 'claude-haiku-5-5', fallback: 'claude-sonnet-5-5' }; // дешёвая
const CONCURRENCY = 4;

const prompt = (name) => fs.readFileSync(path.join(ROOT, 'src', 'prompts', name + '.md'), 'utf8');
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
const load = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const save = (f, data) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 1)); };
const problem = (msg) => { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(P.problems, msg + '\n'); console.log('  ! ' + msg); };

// Простая очередь: CONCURRENCY задач одновременно.
async function pool(items, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

// ---------- (а) брифы ----------
function parseBrief(raw) {
  const m = raw.replace(/```(json)?/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  if (typeof j.topic !== 'string' || !j.topic.trim() || !Array.isArray(j.facts)) return null;
  const facts = j.facts.filter((f) => typeof f === 'string' && f.trim()).slice(0, 6);
  return facts.length >= 3 ? { topic: j.topic.trim(), facts } : null; // нужно 3–6 фактов
}

async function makeBriefs(posts, briefs) {
  const todo = posts.filter((p) => !briefs[p.id]);
  console.log(`Брифы: готово ${posts.length - todo.length}, осталось ${todo.length}`);
  await pool(todo, async (p) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await chat({ ...BRIEF_MODEL, tag: 'brief', temperature: 0.2, max_tokens: 3000,
        messages: [{ role: 'user', content: fill(prompt('brief'), { text: p.text }) }] });
      const b = parseBrief(r.text);
      if (b) { briefs[p.id] = { ...b, model: r.model }; save(P.briefs, briefs); return; }
      problem(`бриф ${p.id}: не разобрался JSON (попытка ${attempt + 1})`);
    }
  });
}

// ---------- (б) AI-тексты ----------
// Для i-го поста: наивный — вендор i%3; очеловеченный — другой вендор. За каждые 6 постов
// каждая пара «вендор × промпт» встречается ровно 2 раза → 96 постов дают по 32 текста в ячейке.
function assign(i) {
  const naive = i % 3;
  const human = (naive + 1 + (i % 2)) % 3;
  return [{ type: 'naive', g: GEN[naive] }, { type: 'human', g: GEN[human] }];
}

const REFUSAL = /^(извин|к сожалению|я не могу|не могу (помочь|выполнить|написать)|как (ии|искусственный)|i can'?t|i'm sorry|sorry)/i;
function validate(text, srcLen) {
  if (!text || text.length < 5) return 'пусто';
  if (REFUSAL.test(text.slice(0, 60).toLowerCase())) return 'отказ модели';
  const ratio = text.length / srcLen;
  if (ratio < 0.5 || ratio > 2) return `длина ×${ratio.toFixed(2)} от источника (нужно 0,5–2)`;
  return null;
}

async function makeAi(posts, briefs, ai, split) {
  const jobs = [];
  posts.forEach((p, i) => {
    if (!briefs[p.id]) return; // без брифа текст не сделать
    for (const a of assign(i)) {
      if (!ai.some((x) => String(x.source_id) === p.id && x.prompt_type === a.type)) jobs.push({ p, ...a });
    }
  });
  console.log(`AI-тексты: готово ${ai.length}, осталось ${jobs.length}`);
  await pool(jobs, async ({ p, type, g }) => {
    const b = briefs[p.id];
    const content = fill(prompt('gen_' + (type === 'naive' ? 'naive' : 'human')), {
      topic: b.topic, facts: b.facts.map((f) => '- ' + f).join('\n'), length: Math.round(p.text.length / 50) * 50,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await chat({ model: g.model, fallback: g.fallback, tag: 'gen_' + type, temperature: 0.8,
        max_tokens: 3000, messages: [{ role: 'user', content }] });
      const clean = stripMarkdown(r.text);
      const err = validate(clean, p.text.length);
      if (!err) {
        // text_raw = ответ модели как есть; text = после снятия разметки — только его видят линтер и оценка
        ai.push({ source_id: Number(p.id), split: split[p.id], model: r.model, requested_model: g.model, prompt_type: type,
          fallback_used: r.fallback_used, source_len: p.text.length, text_raw: r.text, text: clean });
        save(P.ai, ai);
        return;
      }
      problem(`текст ${p.id}/${type}/${r.model}: ${err} (попытка ${attempt + 1})`);
    }
  });
}

function report(ai, briefs, posts) {
  console.log(`\nИтого: брифов ${Object.keys(briefs).length}/${posts.length}, AI-текстов ${ai.length}/${posts.length * 2}`);
  const cnt = {};
  for (const x of ai) { const k = x.model + ' / ' + x.prompt_type; cnt[k] = (cnt[k] || 0) + 1; }
  console.log('По вендорам и промптам:', cnt);
  const sp = {}; for (const x of ai) sp[x.split] = (sp[x.split] || 0) + 1;
  console.log('По частям:', sp, ' запасная модель сработала:', ai.filter((x) => x.fallback_used).length);
  console.log(`Потрачено: $${readCost().total_usd}` + (isMock() ? ' (мок)' : '') + ' | файлы: ' + OUT);
}

(async () => {
  const all = load(path.join(ROOT, 'data', 'posts.json'), []);
  const { split } = load(path.join(ROOT, 'data', 'split.json'), {});
  const lim = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
  const posts = Object.keys(split).map((id) => all.find((p) => String(p.id) === id)).slice(0, lim)
    .map((p) => ({ ...p, id: String(p.id) }));
  const briefs = load(P.briefs, {});
  const ai = load(P.ai, []);
  await makeBriefs(posts, briefs);
  await makeAi(posts, briefs, ai, split);
  report(ai, briefs, posts);
})().catch((e) => { console.error('СТОП: ' + e.message); process.exit(1); });
