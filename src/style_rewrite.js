'use strict';
// Переписывание готового AI-текста словами и манерой основателя (шаг 12, v4). В бота НЕ встроено.
//   styleRewrite(text, {sourceId, chat, model, nSamples, lenMin, lenMax}) ->
//   {status: 'ok'|'human', reason, before, after, facts, copy, worn, ratio, samples, calls, cost, model}
// Модель только пишет; решения «получилось или нет» принимает код: checkFacts, длина, copyRate, worn.
// Потеря/добавление факта, длина вне диапазона, копирование образцов или заезженная фраза -> один повтор с перечнем;
// снова не так -> статус 'human' (текст всё равно возвращается, чтобы его можно было оценить).
const fs = require('fs');
const path = require('path');
const { checkFacts, extractFacts } = require('./facts');
const { autofix } = require('./autofix');
const { stripMarkdown } = require('./clean');
const { pickSamples, copyRate, COPY_THRESHOLD, COPY_RUN } = require('./samples');
const { worn } = require('./worn');
const llm = require('./llm');

const PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'style_rewrite.md'), 'utf8');
const VOICE = fs.readFileSync(path.join(__dirname, 'prompts', 'voice.md'), 'utf8').trim();
const [SYSTEM_T, USER_T] = PROMPT.split('---USER---');
const LEN_MIN = 0.7, LEN_MAX = 1.1;

const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
const factList = (text) => extractFacts(text).map((f) => `- ${f.value}`).join('\n') || '- (нет)';

function parseReply(raw) {
  let t = raw.replace(/<\/?[а-яa-z]+>/gi, '');
  t = stripMarkdown(t.trim());
  t = t.replace(/^(вот|ниже)[^\n]{0,60}:\s*\n+/i, '').trim();
  return t;
}

function buildMessages(text, samples, { lenMin = LEN_MIN, lenMax = LEN_MAX } = {}) {
  const L = text.length;
  const vars = {
    VOICE, FACTS: factList(text), LEN: L, LEN_MIN: Math.round(L * lenMin), LEN_MAX: Math.round(L * lenMax),
    SAMPLES: samples.map((s, i) => `Образец ${i + 1}:\n${s.text}`).join('\n\n———\n\n'), TEXT: text,
  };
  return [{ role: 'system', content: fill(SYSTEM_T, vars).trim() }, { role: 'user', content: fill(USER_T, vars).trim() }];
}

// Проверка кандидата: всё решает код. Возвращает причины по порядку важности и замечание для повтора.
function check(orig, cand, samples, { lenMin = LEN_MIN, lenMax = LEN_MAX } = {}) {
  const facts = checkFacts(orig, cand);
  const ratio = cand.length / orig.length;
  const lenOk = ratio >= lenMin && ratio <= lenMax;
  const copy = copyRate(cand, orig, samples);
  const copyFlag = copy.rate >= COPY_THRESHOLD || copy.run >= COPY_RUN;
  const w = worn(cand, orig);
  const reasons = [], parts = [];
  if (!facts.ok) {
    reasons.push('facts');
    if (facts.missing.length) parts.push('Потеряно (вернуть дословно): ' + facts.missing.map((m) => m.value).join('; '));
    if (facts.added.length) parts.push('Добавлено лишнее, которого нет в исходнике (убрать): ' + facts.added.map((m) => m.value).join('; '));
  }
  if (!lenOk) { reasons.push('length'); parts.push(`Длина ${cand.length} знаков, нужно ${Math.round(orig.length * lenMin)}–${Math.round(orig.length * lenMax)}.`); }
  if (copyFlag) { reasons.push('copy'); parts.push('Совпадения с образцами, перепиши эти места своими словами: ' + (copy.copied.join('; ') || `цепочка из ${copy.run} слов подряд`)); }
  if (w.length) { reasons.push('worn'); parts.push('Запрещённые фразы (убрать): ' + w.map((x) => '«' + x + '»').join('; ')); }
  return { ok: !reasons.length, reasons, facts, ratio, lenOk, copy: { ...copy, flag: copyFlag }, worn: w, message: parts.join('\n') };
}

async function styleRewrite(text, opts = {}) {
  const { model = 'claude-sonnet-5-5', fallback, sourceId = null, nSamples = 4, maxTokens = 3000, lenMin = LEN_MIN, lenMax = LEN_MAX } = opts;
  const chat = opts.chat || llm.chat;
  const tag = opts.tag || 'style_rewrite';
  const samples = pickSamples(text, { k: nSamples, excludeId: sourceId });
  const out = { status: null, reason: null, before: text, model, cost: 0, calls: 0, retried: false, samples: samples.map((s) => ({ id: s.id, score: s.score })) };
  const messages = buildMessages(text, samples, { lenMin, lenMax });
  let res = await chat({ model, fallback, messages, max_tokens: maxTokens, tag });
  out.cost += res.cost; out.calls++; out.model = res.model;
  let cand = autofix(parseReply(res.text)).text;
  let c = check(text, cand, samples, { lenMin, lenMax });
  if (!c.ok) {
    out.retried = true; out.first_problems = c.reasons;
    const retry = messages.concat([{ role: 'assistant', content: res.text },
      { role: 'user', content: 'В твоей версии есть ошибки.\n' + c.message + '\nИсправь только это, остальное сохрани. Верни весь текст целиком, без пояснений.' }]);
    res = await chat({ model, fallback, messages: retry, max_tokens: maxTokens, tag: tag + '_retry' });
    out.cost += res.cost; out.calls++; out.model = res.model;
    cand = autofix(parseReply(res.text)).text;
    c = check(text, cand, samples, { lenMin, lenMax });
  }
  out.after = cand; out.facts = c.facts; out.ratio = +c.ratio.toFixed(3); out.copy = c.copy; out.worn = c.worn;
  out.status = c.ok ? 'ok' : 'human';
  out.reason = c.ok ? null : c.reasons[0];
  out.reasons = c.reasons;
  out.cost = +out.cost.toFixed(6);
  return out;
}

module.exports = { styleRewrite, buildMessages, check, parseReply, LEN_MIN, LEN_MAX };
