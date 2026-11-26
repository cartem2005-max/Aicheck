'use strict';
// Правка «Сократить» (REVIEW_3 + REVIEW_ASTRA): модель ТОЛЬКО предлагает удаления, решает и применяет КОД.
//   prepare(text)            -> {st, numbered, total}      нумерация предложений (заголовок и подпись защищены)
//   buildRequest(text)       -> тело запроса к Claude      (без сети; его же шлёт HTTP-нода n8n)
//   apply(text, modelAnswer) -> {text, removed, kept_by_guard, layout_suggestions, status}
//   shorten(text, {chat})    -> то же + вызов модели (для проверки на dev; в n8n не используется)
// Модель возвращает JSON {"delete":[{"n":5,"reason":"повтор","covered_by":3}]}. Правка может быть пустой.
// Код НЕ удаляет предложение, если в нём: факт по facts.js, отрицание/ограничение/условие, ссылка/@/путь «→»,
// инструкция (повелительное + шаг). Исключение: reason=призыв без фактов и ссылок. Целевой призыв анонса
// (регистрация, ссылка) не трогаем никогда. reason=повтор требует covered_by (номер ДРУГОГО предложения, которое остаётся).
// Потом checkFacts(оригинал, результат): потерянный факт -> код возвращает предложение. Автоправки вёрстки
// (autofix) в текст НЕ применяются: идут отдельным списком «предложение по оформлению».
// Нумерация и сборка текста (structure/numbered/build) — из src/rewrite_v3.js без изменений логики.
const { parseText, bodyParagraphs, wordCount } = require('./textparse');
const { extractFacts, checkFacts } = require('./facts');
const { autofix } = require('./autofix');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1500;
const REASONS = ['повтор', 'пустая подводка', 'вода', 'мораль', 'призыв', 'очевидное'];
const MIN_RATIO = 0.6;     // результат не короче 60% исходного
const MAX_SHARE = 1 / 3;   // не больше трети предложений
const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[*•–—-])\s+|^\s*(?:[0-9#*]️?⃣|\u{1F51F})/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

// ---------------- структура текста ----------------
function structure(text) {
  const parsed = parseText(text);
  const body = new Set(bodyParagraphs(parsed));
  const rawParas = [];
  let pos = 0, cur = null;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') cur = null;
    else { if (!cur) { cur = []; rawParas.push(cur); } cur.push({ ls: pos, le: pos + raw.length, raw }); }
    pos += raw.length + 1;
  }
  let n = 0;
  const paragraphs = parsed.map((p, i) => {
    const first = i === 0 && p.lines.length === 1 && wordCount(p.text) <= 12; // заголовок в одну строку
    const prot = !body.has(p) || first;
    const lines = rawParas[i].map((rl) => ({ ls: rl.ls, le: rl.le, raw: rl.raw, sents: [] }));
    for (const s of p.sentences) {
      const ln = lines.find((l) => s.start >= l.ls && s.end <= l.le);
      const lead = text.slice(s.start, s.end).match(/^\s*/)[0].length;
      ln.sents.push({ n: prot ? null : ++n, start: s.start + lead, end: s.end, text: text.slice(s.start + lead, s.end) });
    }
    return { protected: prot, lines };
  });
  return { paragraphs, total: n };
}

function numbered(st) {
  return st.paragraphs.map((p) => p.lines.map((l) => {
    const mark = LIST_LINE.test(l.raw) ? '— ' : '';
    return mark + l.sents.map((s) => (s.n ? `[${s.n}] ` : '[—] ') + s.text).join(' ');
  }).join('\n')).join('\n\n');
}

// state: {del:Set<n>}
function build(text, st, state) {
  const paras = st.paragraphs.map((p, pi) => {
    const lines = p.lines.map((l) => {
      let s = l.raw;
      const ops = [];
      for (const x of l.sents) if (x.n && state.del.has(x.n)) ops.push({ a: x.start, b: x.end, t: '' });
      const touched = ops.length > 0;
      for (const o of ops.sort((a, b) => b.a - a.a)) s = s.slice(0, o.a - l.ls) + o.t + s.slice(o.b - l.ls);
      if (touched) {
        s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trimEnd();
        if (!/^\s/.test(l.raw)) s = s.trimStart();
      }
      const list = LIST_LINE.test(l.raw);
      const alive = !touched || HAS_WORD.test(s.replace(LIST_LINE, ''));
      return { s, alive, list, line: l };
    });
    return { lines: lines.filter((l) => l.alive), protected: p.protected, idx: pi, origSents: p.lines.reduce((a, l) => a + l.sents.length, 0), origLines: p.lines };
  }).filter((p) => p.lines.length);

  // осиротевшие «подводки к списку» и хвосты списков
  const fixed = [];
  paras.forEach((p, i) => {
    const last = p.lines[p.lines.length - 1];
    const origLast = p.origLines[p.origLines.length - 1];
    const origNext = st.paragraphs[p.idx + 1];
    const origNextList = !!origNext && LIST_LINE.test(origNext.lines[0].raw);
    const next = paras[i + 1];
    const nextKeepsList = !!next && next.idx === p.idx + 1 && next.lines[0].list;
    const endsColon = /:\s*$/.test(last.s);
    const origEndsColon = /:\s*$/.test(origLast.raw);
    const listLost = endsColon && (!origEndsColon || (origNextList && !nextKeepsList));
    if (listLost && !p.protected) {
      if (wordCount(last.s) <= 6 && p.lines.length === 1) return; // подводка без списка — убираем вместе с абзацем
      last.s = last.s.replace(/:\s*$/, '.');
    }
    if (last.list && /[;,]\s*$/.test(last.s)) last.s = last.s.replace(/[;,]\s*$/, '.');
    fixed.push(p);
  });

  // осиротевший короткий абзац (был >= 2 предложений, остался одно до 5 слов) склеиваем с предыдущим
  const merged = [];
  for (const p of fixed) {
    const prev = merged[merged.length - 1];
    const remaining = p.origLines.reduce((a, l) => a + l.sents.filter((x) => !x.n || !state.del.has(x.n)).length, 0);
    const words = wordCount(p.lines.map((l) => l.s).join(' '));
    if (prev && !p.protected && !prev.protected && p.origSents >= 2 && remaining === 1 && words <= 5 && p.lines.length === 1 && !p.lines[0].list && !prev.lines[prev.lines.length - 1].list) {
      prev.lines[prev.lines.length - 1].s += ' ' + p.lines[0].s;
    } else merged.push(p);
  }
  return merged.map((p) => p.lines.map((l) => l.s).join('\n')).join('\n\n');
}

// ---------------- запрос к модели ----------------
const REASON_HELP = [
  'повтор: предложение пересказывает то, что уже сказано в другом предложении поста (обязательно укажи covered_by — номер ОСТАЮЩЕГОСЯ предложения, которое несёт ту же информацию)',
  'пустая подводка: вводная без содержания («Давайте разберёмся», «Что это значит?», «А теперь о главном»)',
  'вода: фраза без информации («в современном мире», «как известно», «не секрет, что»)',
  'мораль: итог или вывод, который пост уже показал («главное», «в итоге», «поэтому важно»)',
  'призыв: общий призыв без ссылки и без конкретного шага («следите за обновлениями», «пишите, что думаете»)',
  'очевидное: то, что читатель и так знает или что прямо следует из соседнего предложения',
].map((x) => '- ' + x).join('\n');

const SYSTEM = `Ты редактор Telegram-канала сервиса аналитики для селлеров маркетплейсов. Ты ничего не переписываешь и не добавляешь: ты только отмечаешь предложения, которые можно удалить целиком без потери смысла и фактов. Пост показан с пронумерованными предложениями: [12] текст. Предложения с пометкой [—] (заголовок, подпись) трогать нельзя.

Верни ТОЛЬКО JSON, без пояснений и без Markdown:
{"delete":[{"n":5,"reason":"повтор","covered_by":3}]}

reason — одно из закрытого списка:
${REASON_HELP}
covered_by — номер оставшегося предложения, которое уже несёт ту же информацию; для других причин укажи номер, если он есть, иначе null.

Правила:
1. Если сомневаешься — оставляй. Пустой список {"delete":[]} — нормальный ответ.
2. Не отмечай предложения с фактом (число, дата, название, ссылка, @тег, цитата в «ёлочках»), с отрицанием, ограничением или условием (не, нет, без, кроме, только, если, когда, пока, нельзя), с инструкцией («нажмите», «откройте», «проверьте»), со ссылкой или путём «→».
3. Целевой призыв поста (регистрация, переход по ссылке, запись) оставляй.
4. Не больше трети предложений. Самые уверенные — первыми.`;

const USER = (numberedText) => '# Пост\n\n' + numberedText;

function prepare(text) {
  const st = structure(text);
  return { st, numbered: numbered(st), total: st.total };
}

// тело запроса к Anthropic Messages API (его же собирает Code-нода n8n)
function buildRequest(text) {
  const p = prepare(text);
  return {
    model: MODEL, max_tokens: MAX_TOKENS,
    thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
    system: SYSTEM, messages: [{ role: 'user', content: USER(p.numbered) }],
  };
}

function parseJson(raw) {
  const t = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const a = t.search(/[{[]/);
  if (a < 0) return null;
  const closer = t[a] === '{' ? '}' : ']';
  const b = t.lastIndexOf(closer);
  if (b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return Array.isArray(j) ? { delete: j } : j; } catch { return null; }
}

// ---------------- гарды ----------------
const NEG = /(?<![\p{L}\p{N}])(?:не|нет|без|кроме|только|если|когда|пока|нельзя)(?![\p{L}\p{N}])/iu;
const LINK = /https?:\/\/|www\.|t\.me\/|@[\p{L}\p{N}_]|→|->/iu;
const IMPERATIVE = /(?<![\p{L}])(?<!(?<![\p{L}])вы\s+)(?!давайте(?![\p{L}]))[\p{L}]{2,}(?:йте|ите|ьте)(?![\p{L}])|(?<![\p{L}])(?:нужно|надо|необходимо|следует)\s+[\p{L}]+(?:ть|ться|ти)(?![\p{L}])/iu;
const TARGET_CTA = /(?<![\p{L}])(?:регистр\p{L}*|запиш\p{L}*|записыва\p{L}*|переход\p{L}*|перейд\p{L}*|ссылк\p{L}*|заполн\p{L}*|участв\p{L}*|подайте|заявк\p{L}*)/iu;

// почему предложение удалять нельзя (строка) или null
function guardFor(sentText, reason) {
  const facts = extractFacts(sentText);
  if (facts.length) return 'факт: ' + facts.slice(0, 3).map((f) => f.value).join(', ');
  if (LINK.test(sentText)) return 'ссылка, @ или путь';
  const n = norm(sentText);
  if (reason === 'призыв') return TARGET_CTA.test(n) ? 'целевой призыв анонса' : null; // призыв без фактов и ссылок: остальные гарды не нужны
  if (NEG.test(n)) return 'отрицание, ограничение или условие';
  if (IMPERATIVE.test(n)) return 'инструкция';
  return null;
}

// ---------------- применение ответа модели ----------------
function apply(text, js, opts = {}) {
  const allow = (opts.allow || []).map(norm);
  const out = { status: null, text, removed: [], kept_by_guard: [], layout_suggestions: [], total_sentences: 0 };
  const lay = autofix(text).changes.filter((c) => c.rule !== 'W01');
  out.layout_suggestions = lay.map((c) => ({ rule: c.rule, before: c.before.trim(), after: c.after.trim() }));
  const st = structure(text);
  out.total_sentences = st.total;
  if (!st.total) { out.status = 'empty'; return out; }
  if (!js || !Array.isArray(js.delete)) { out.status = 'error'; return out; }
  const sents = {};
  for (const p of st.paragraphs) for (const l of p.lines) for (const s of l.sents) if (s.n) sents[s.n] = s;

  const keep = (n, reason, guard) => out.kept_by_guard.push({ n, quote: sents[n].text, reason, guard });
  const want = new Map(); // n -> {reason, covered}
  for (const d of js.delete) {
    const n = Number(d && d.n), reason = String((d && d.reason) || '').trim().toLowerCase();
    if (!sents[n] || want.has(n)) continue;
    if (!REASONS.includes(reason)) { keep(n, reason, 'причина не из списка'); continue; }
    if (allow.some((a) => a && norm(sents[n].text).includes(a))) { keep(n, reason, 'исключение редакции (/allow)'); continue; }
    if ((opts.links || []).some((l) => l.start < sents[n].end && l.end > sents[n].start)) { keep(n, reason, 'кликабельная ссылка'); continue; }
    const covered = d.covered_by === null || d.covered_by === undefined ? null : Number(d.covered_by);
    if (reason === 'повтор' && !(covered && covered !== n && sents[covered])) { keep(n, reason, 'повтор без covered_by'); continue; }
    const g = guardFor(sents[n].text, reason);
    if (g) { keep(n, reason, g); continue; }
    want.set(n, { reason, covered: covered && sents[covered] ? covered : null });
  }
  // «повтор» держится на оставшемся предложении: если оно само удаляется, оставляем оба
  for (let changed = true; changed;) {
    changed = false;
    for (const [n, w] of [...want]) {
      if (w.reason === 'повтор' && want.has(w.covered)) { want.delete(n); keep(n, w.reason, 'предложение, которое «уже говорит то же», тоже удаляется'); changed = true; }
    }
  }
  // не больше трети предложений: лишние (с конца списка модели) остаются
  const order = [...want.keys()];
  while (order.length > Math.floor(st.total * MAX_SHARE)) { const n = order.pop(); keep(n, want.get(n).reason, 'больше трети предложений'); want.delete(n); }

  const state = { del: new Set(want.keys()) };
  let cur = build(text, st, state);
  // потерянный факт: предложение с ним возвращает код
  for (let i = 0; i < 8; i++) {
    const f = checkFacts(text, cur);
    if (f.ok) break;
    let any = false;
    for (const m of f.missing) {
      const v = norm(m.value);
      for (const n of [...state.del]) if (norm(sents[n].text).includes(v)) { state.del.delete(n); keep(n, want.get(n).reason, 'потерян факт: ' + m.value); want.delete(n); any = true; }
    }
    if (!any) break;
    cur = build(text, st, state);
  }
  // длина не короче 60%: возвращаем удаления с конца списка модели
  while (cur.length / text.length < MIN_RATIO && order.some((n) => state.del.has(n))) {
    const n = [...order].reverse().find((x) => state.del.has(x));
    state.del.delete(n); keep(n, want.get(n).reason, 'длина'); want.delete(n);
    cur = build(text, st, state);
  }
  if (!checkFacts(text, cur).ok) { // последний рубеж: возвращаем всё
    for (const n of [...state.del]) { state.del.delete(n); keep(n, want.get(n).reason, 'факты не сходятся'); want.delete(n); }
    cur = build(text, st, state);
  }
  out.text = cur;
  for (const n of [...state.del].sort((a, b) => a - b)) {
    const w = want.get(n);
    out.removed.push({ n, start: sents[n].start, end: sents[n].end, quote: sents[n].text, reason: w.reason, covered_by: w.covered, covered_by_quote: w.covered ? sents[w.covered].text : null });
  }
  out.kept_by_guard.sort((a, b) => a.n - b.n);
  out.status = cur === text ? 'unchanged' : 'shortened';
  out.length_change = +(cur.length / text.length - 1).toFixed(3);
  return out;
}

// только для проверки на dev (в n8n вызов делает HTTP-нода)
async function shorten(text, opts = {}) {
  const chat = opts.chat || require('./llm').chat;
  const p = prepare(text);
  if (!p.total) return { ...apply(text, null), cost: 0 };
  const res = await chat({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER(p.numbered) }], max_tokens: MAX_TOKENS, tag: opts.tag || 'shorten' });
  const r = apply(text, parseJson(res.text));
  r.cost = res.cost; r.raw = res.text;
  return r;
}

module.exports = { MODEL, MAX_TOKENS, REASONS, MIN_RATIO, SYSTEM, prepare, buildRequest, parseJson, apply, shorten, guardFor, structure, numbered, build };
