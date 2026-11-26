// Вызов Claude через свой шлюз в n8n: ключ Anthropic хранится в n8n, сюда не попадает.
// Адрес шлюза — ТОЛЬКО из переменной окружения KAN_LLM_URL или из файла .llm-url в корне
// (файл в .gitignore). В репозиторий и в отчёт адрес не пишем.
// LLM_MOCK=1 — фальшивые ответы без сети (проверка конвейера бесплатно).
// Бюджет: LLM_BUDGET (по умолчанию 15 долларов) — перед каждым вызовом сверяемся с cost.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 130000; // шлюз сам ждёт Claude до 120 с
const MAX_RETRIES = 2; // повторов на одну модель при 429/5xx/таймауте

// Цены $ за 1 млн токенов [вход, выход] — по каталогу моделей на 25.11.2026 (eval/results/models.json).
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  // OpenAI — для сравнения, через тот же шлюз (ключ OpenAI тоже в n8n)
  'gpt-6-luna': [0.1, 0.5],
  'gpt-6.1-terra': [1, 5],
  'gpt-6.2-sol': [2, 10],
  default: [8, 40], // неизвестная модель — считаем по самой дорогой
};

const isMock = () => process.env.LLM_MOCK === '1';
const budget = () => Number(process.env.LLM_BUDGET || 15);
const OPENAI_BUDGET = 5; // отдельный лимит на ключ OpenAI (решение Артёма 25.11)
const isOpenAI = (m) => /^gpt-/.test(m);
const OPENAI_ALLOWED = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol']; // Astra не берём — дорого (Артём 25.11)

function gatewayUrl() {
  if (process.env.KAN_LLM_URL) return process.env.KAN_LLM_URL.trim();
  try { return fs.readFileSync(path.join(__dirname, '..', '.llm-url'), 'utf8').trim(); } catch { return ''; }
}

// В мок-режиме стоимость пишем во временную папку, чтобы не загрязнить настоящий cost.json.
function costFile() {
  if (process.env.LLM_COST_FILE) return process.env.LLM_COST_FILE;
  if (isMock()) return path.join(os.tmpdir(), 'kan-mock', 'cost.json');
  return path.join(__dirname, '..', 'eval', 'results', 'cost.json');
}

function readCost() {
  try { return JSON.parse(fs.readFileSync(costFile(), 'utf8')); }
  catch { return { total_usd: 0, calls: [] }; }
}

function addCost(entry) {
  const c = readCost();
  c.calls.push(entry);
  c.total_usd = +c.calls.reduce((s, x) => s + x.cost, 0).toFixed(6);
  fs.mkdirSync(path.dirname(costFile()), { recursive: true });
  fs.writeFileSync(costFile(), JSON.stringify(c, null, 1));
}

function estimateCost(model, usage) {
  const [pin, pout] = PRICES[model] || PRICES.default;
  return ((usage.input_tokens || 0) * pin + (usage.output_tokens || 0) * pout) / 1e6;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Мок: детерминированный текст. Если в промпте есть «около N знаков» — делает такую длину.
function mockReply(model, messages) {
  const prompt = messages.map((m) => m.content).join('\n');
  if (prompt.includes('ВЕРНИ_JSON')) {
    return JSON.stringify({ topic: 'Тема (мок)', facts: ['Факт 1 — 12 февраля', 'Факт 2 — 90 дней', 'Факт 3 — Ozon'] });
  }
  const m = prompt.match(/около (\d+) знаков/);
  const n = m ? Number(m[1]) : 300;
  const seed = prompt.length % 7;
  const base = `Мок-текст ${seed} от ${model}. Проверка конвейера без сети. `;
  return base.repeat(Math.ceil(n / base.length)).slice(0, n);
}

// Один вызов шлюза с повторами на 429/5xx/таймаут. Шлюз отвечает {status, body}, body — ответ Anthropic.
async function callOnce(body) {
  const url = gatewayUrl();
  if (!url) throw new Error('Не задан адрес шлюза: переменная KAN_LLM_URL или файл .llm-url (в git не попадает).');
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt) await sleep(2000 * 3 ** (attempt - 1)); // 2 с, потом 6 с
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) throw Object.assign(new Error('шлюз выключен (404) — включить его в n8n'), { fatal: true });
      if (res.status >= 500) { lastErr = new Error('шлюз HTTP ' + res.status); continue; }
      const data = await res.json();
      const st = Number(data.status);
      if (st === 429 || st === 529 || st >= 500) { lastErr = new Error('API HTTP ' + st); continue; }
      if (st !== 200) throw Object.assign(new Error('API HTTP ' + st + ': ' + (data.body?.error?.message || '')), { fatal: true });
      return data.body;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e.name === 'TimeoutError' ? new Error('таймаут') : e;
    }
  }
  throw lastErr;
}

// chat({model, fallback, messages, max_tokens, temperature, tag}) -> {text, model, cost, fallback_used}
// Сообщения role:'system' уходят в поле system (так требует API Anthropic).
async function chat({ model, fallback, messages, max_tokens = 2000, temperature = 0.7, tag = '' }) {
  const spent = readCost().total_usd;
  if (spent >= budget()) {
    throw new Error(`Бюджет исчерпан: потрачено $${spent.toFixed(3)} из $${budget()}. Остановлено.`);
  }
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = messages.filter((m) => m.role !== 'system');
  const candidates = [model, fallback].filter(Boolean);
  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      let text, usage, source;
      if (isMock()) {
        text = mockReply(m, messages);
        usage = { input_tokens: Math.ceil(JSON.stringify(messages).length / 2.5), output_tokens: Math.ceil(text.length / 2.5) };
        source = 'mock';
      } else {
        // temperature у Claude 5.5 не задаётся (400). Думание: Haiku — выключено, Sonnet — between_tools,
        // Opus выключить нельзя — effort low. Тексты короткие, думание тут только тратит токены.
        if (isOpenAI(m)) {
          if (!OPENAI_ALLOWED.includes(m)) throw Object.assign(new Error('модель OpenAI не в списке: ' + m), { fatal: true });
          const spentOA = readCost().calls.filter((x) => isOpenAI(x.model)).reduce((s, x) => s + x.cost, 0);
          if (spentOA >= OPENAI_BUDGET) throw Object.assign(new Error(`лимит OpenAI $${OPENAI_BUDGET} исчерпан`), { fatal: true });
          const body = await callOnce({ model: m, messages: msgs, max_tokens, reasoning_effort: 'low', ...(system ? { system } : {}) });
          text = (body.choices?.[0]?.message?.content || '').trim();
          usage = { input_tokens: body.usage?.prompt_tokens || 0, output_tokens: body.usage?.completion_tokens || 0 };
        } else {
          const think = /haiku/.test(m) ? { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }
            : /sonnet/.test(m) ? { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }
            : { output_config: { effort: 'low' } };
          const body = await callOnce({ model: m, messages: msgs, max_tokens, ...think, ...(system ? { system } : {}) });
          text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
          usage = body.usage || {};
        }
        source = 'estimate';
      }
      // деньги тратятся, даже если ответ мусорный — записываем до проверки
      const c = estimateCost(m, usage);
      addCost({ ts: new Date().toISOString(), tag, model: m, requested: model,
        input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cost: c, source });
      if (text.length < 5) throw new Error('пустой ответ');
      return { text, model: m, cost: c, fallback_used: i > 0 };
    } catch (e) {
      errors.push(`${m}: ${e.message}`);
      if (/Не задан адрес|шлюз выключен/.test(e.message)) throw e; // запасная модель не поможет
    }
  }
  throw new Error('Все модели не ответили: ' + errors.join('; '));
}

module.exports = { chat, readCost, costFile, isMock, PRICES, gatewayUrl };
