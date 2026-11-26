'use strict';
// Переписывание v3: «сушка» (вариант А) и «сушка + правка помеченных фраз по параллельным парам» (вариант Б).
// Один проход, без цикла, без выбора лучшего по какой-либо оценке (против Goodhart). Балл линтера считается только для таблицы.
// Модель ТОЛЬКО предлагает: какие предложения убрать (причина из закрытого списка) и какие фразы заменить.
// Вычёркивает, заменяет, склеивает абзацы и возвращает потерянные факты КОД.
//   dry(text, {variant:'A'|'B', model, chat, sourceId, pairs, tag}) -> {status, before, after, diff, facts, ...}
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const { parseText, bodyParagraphs, wordCount } = require('./textparse');
const { checkFacts } = require('./facts');
const { lint } = require('./linter');
const { pickSamples, copyRate, cleanSample, COPY_THRESHOLD, COPY_RUN, stems } = require('./samples');

const REASONS = ['вода', 'повтор', 'очевидное', 'хеджирование', 'призыв', 'мораль', 'пустая связка'];
const MAX_REPLACE = { A: 3, B: 6 };
const MIN_RATIO = 0.6; // допуск длины вниз до −40% (REVIEW_2)
const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[*•–—-])\s+|^\s*(?:[0-9#*]️?⃣|\u{1F51F})/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

// ---------------- структура текста ----------------
// paragraphs[i] = {protected, lines:[{ls, le, raw, sents:[{n|null, start, end, text}]}]}; номера только у предложений, которые можно трогать
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

// ---------------- применение правок кодом ----------------
// state: {del:Set<n>, rep:Map<n,{was,now,newText}>}
function build(text, st, state) {
  const paras = st.paragraphs.map((p, pi) => {
    const lines = p.lines.map((l) => {
      let s = l.raw;
      const ops = [];
      for (const x of l.sents) {
        if (x.n && state.del.has(x.n)) ops.push({ a: x.start, b: x.end, t: '' });
        else if (x.n && state.rep.has(x.n)) ops.push({ a: x.start, b: x.end, t: state.rep.get(x.n).newText });
      }
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

// ---------------- разбор ответа модели ----------------
function parseJson(raw) {
  const t = raw.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const TAIL = /[.!?…»"')\]]$/;
function applyFragment(sent, was, now) {
  if (!was) return null;
  const i = sent.indexOf(was);
  if (i < 0) return null;
  let out = sent.slice(0, i) + now + sent.slice(i + was.length);
  if (i === 0 && /^\p{Ll}/u.test(out) && /^\p{Lu}/u.test(was)) out = out[0].toUpperCase() + out.slice(1);
  const tail = sent.trimEnd().slice(-1);
  if (/[.!?…]/.test(tail) && !TAIL.test(out.trimEnd())) out = out.trimEnd() + tail;
  return out.replace(/\s{2,}/g, ' ');
}

// проверка одной замены; A: только сократить и упростить, B: другая формулировка допустима, но без нового содержания
const FIRST_PERSON = /(?:^|[^\p{L}])(?:я|мне|меня|мой|моя|мои|мы|нам|считаю|думаю)(?![\p{L}])/iu;
function checkReplace(variant, sent, was, now, newSent) {
  if (!was || !now || was === now) return 'пусто';
  if (newSent === null) return 'фрагмента нет в предложении';
  const f = checkFacts(sent, newSent);
  if (f.missing.length) return 'потерян факт: ' + f.missing.map((m) => m.value).join('; ');
  if (f.added.length) return 'новый факт: ' + f.added.map((m) => m.value).join('; ');
  if (/\.\.\.|…|\)\)/.test(now) && !/\.\.\.|…|\)\)/.test(was)) return 'многоточие или «))»';
  if (/\p{Extended_Pictographic}/u.test(now) && !/\p{Extended_Pictographic}/u.test(was)) return 'эмодзи';
  if (FIRST_PERSON.test(now) && !FIRST_PERSON.test(sent)) return 'первое лицо';
  const sw = new Set(stems(sent)), nw = stems(now);
  const known = nw.length ? nw.filter((w) => sw.has(w)).length / nw.length : 1;
  if (variant === 'A') {
    if (now.length >= was.length) return 'не короче';
    if (known < 0.85) return 'новые слова (' + known.toFixed(2) + ')';
  } else {
    if (now.length > was.length * 1.2) return 'длиннее на 20%';
    if (known < 0.4) return 'почти все слова новые (' + known.toFixed(2) + ')';
  }
  return null;
}

// ---------------- промпты ----------------
const REASON_HELP = [
  'вода: фраза без информации («в современном мире», «как известно», «не секрет, что»)',
  'повтор: пересказ того, что уже сказано выше в посте',
  'очевидное: то, что читатель и так знает или что следует из соседнего предложения',
  'хеджирование: оговорка без факта («стоит учитывать», «имеет смысл», «обычно», «как правило»)',
  'призыв: «попробуйте», «хотите», «пишите в комментариях», «подключайте»',
  'мораль: итог или вывод, который пост уже показал («главное», «в итоге», «поэтому важно»)',
  'пустая связка: вводная без содержания («Давайте разберёмся», «Что это значит?», «А теперь о главном»)',
].map((x) => '- ' + x).join('\n');

function systemPrompt(variant) {
  const head = `Ты редактор Telegram-канала сервиса аналитики для селлеров маркетплейсов. Ты не переписываешь пост и не изображаешь автора: ты убираешь воду. Пост показан с пронумерованными предложениями: [12] текст. Предложения с пометкой [—] (заголовок, подпись) трогать нельзя.

Верни ТОЛЬКО JSON, без пояснений и без Markdown:
{"delete":[{"n":5,"reason":"вода"}],"replace":[{"n":7,"was":"точный фрагмент предложения","now":"что поставить вместо"}]}

# delete: предложения на удаление целиком
Причина — одно слово из закрытого списка:
${REASON_HELP}
Правила:
1. Удаляй только то, без чего читатель ничего не теряет. Не больше трети предложений. Самые уверенные — первыми.
2. Предложение с фактом (число, дата, название, ссылка, @тег, #хэштег, цитата в «ёлочках», слово латиницей) не удаляй, пока этот факт не повторён в другом месте. Код всё равно вернёт его.
3. Не удаляй единственное предложение абзаца, если абзац после этого теряет смысл.
4. Если удалять нечего, верни пустой список.
`;
  if (variant === 'A') {
    return head + `
# replace: не больше 3 точечных замен внутри предложения
Только сократить или упростить: «не X, а Y» → «Y»; перечисление из 4 и больше однородных → оставить два; убрать вводное или хеджирующее слово. «was» — точный фрагмент предложения (символ в символ), «now» — короче, из тех же слов. Новых слов, чисел, названий и фактов нет.`;
  }
  return head + `
# replace: не больше 6 замен помеченных фраз
Помеченные фразы — те, что звучат как нейросеть: польза без позиции («стоит обратить внимание»), хеджирование, антитеза «не X, а Y», «для кого» («если вы селлер…»), обобщение вместо факта. Скажи это прямо, как факт, без совета и без вступления, как человек в парных примерах ниже. «was» — точный фрагмент одного предложения (символ в символ), «now» — замена, не длиннее более чем на 20%.
Запрещено в «now»: новые числа, даты, названия и факты; первое лицо («я», «мне», «мы»); шутки; эмодзи; многоточия; «))»; слова и обороты из примеров (из них нужен только принцип, копировать нельзя).`;
}

function userPrompt(variant, numberedText, pairs) {
  let s = '';
  if (variant === 'B' && pairs.length) {
    s += '# Парные примеры: версия нейросети → как человек написал о том же (чужие темы; взять только принцип «сказать прямо»)\n\n';
    pairs.forEach((p, i) => { s += `Пример ${i + 1}.\nНейросеть:\n${p.ai}\n\nЧеловек:\n${p.human}\n\n———\n\n`; });
  }
  return s + '# Пост\n\n' + numberedText;
}

// ---------------- пары «AI-версия по брифу → пост основателя» (только dev) ----------------
let AIDEV = null;
function aiBySource() {
  if (AIDEV) return AIDEV;
  const ai = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ai_posts.json'), 'utf8'));
  AIDEV = {};
  for (const x of ai) if (x.split === 'dev') (AIDEV[x.source_id] = AIDEV[x.source_id] || []).push(x);
  return AIDEV;
}
// 3 ближайших по теме founder-поста dev, у которых есть AI-версия; пост-источник исключён
function pickPairs(text, { sourceId = null, k = 3, maxChars = 900, byId, pool } = {}) {
  byId = byId || aiBySource();
  const cands = pickSamples(text, { k: 12, excludeId: sourceId, ...(pool ? { pool } : {}), maxChars });
  const out = [];
  for (const c of cands) {
    const versions = byId[c.id] || [];
    if (!versions.length) continue;
    const v = versions.find((x) => /sonnet/.test(x.model)) || versions[0];
    out.push({ id: c.id, score: c.score, ai: cleanSample(v.text, maxChars), human: c.text, ai_model: v.model, ai_prompt: v.prompt_type });
    if (out.length >= k) break;
  }
  return out;
}

// ---------------- главная функция ----------------
async function dry(text, opts = {}) {
  const { variant = 'A', model = 'claude-sonnet-5-5', sourceId = null, maxTokens = 2000, tag = 'v3' } = opts;
  const chat = opts.chat || llm.chat;
  const out = { version: 'v3', variant, status: null, reason: null, before: text, after: text, model, cost: 0, calls: 0, diff: [], rejected: [], restored: [], lint_before: lint(text).score };
  const st = structure(text);
  if (!st.total) { out.status = 'empty'; out.lint_after = out.lint_before; out.facts = checkFacts(text, text); return out; }
  const pairs = variant === 'B' ? (opts.pairs || pickPairs(text, { sourceId })) : [];
  out.pairs = pairs.map((p) => ({ id: p.id, score: p.score }));
  const messages = [{ role: 'system', content: systemPrompt(variant) }, { role: 'user', content: userPrompt(variant, numbered(st), pairs) }];
  const res = await chat({ model, messages, max_tokens: maxTokens, tag: tag + '_' + variant });
  out.cost = res.cost; out.calls = 1; out.model = res.model; out.raw = res.text;
  const js = parseJson(res.text);
  if (!js) { out.status = 'error'; out.reason = 'json'; out.lint_after = out.lint_before; out.facts = checkFacts(text, text); return out; }

  const sents = {};
  for (const p of st.paragraphs) for (const l of p.lines) for (const s of l.sents) if (s.n) sents[s.n] = s;
  const state = { del: new Set(), rep: new Map() };
  const reasons = {};
  const order = []; // порядок модели = порядок уверенности
  for (const d of Array.isArray(js.delete) ? js.delete : []) {
    const n = Number(d && d.n), reason = String((d && d.reason) || '').trim().toLowerCase();
    if (!sents[n]) { out.rejected.push({ type: 'delete', n, why: 'нет такого номера или предложение защищено' }); continue; }
    if (!REASONS.includes(reason)) { out.rejected.push({ type: 'delete', n, why: 'причина не из списка: ' + reason }); continue; }
    if (state.del.has(n)) continue;
    state.del.add(n); reasons[n] = reason; order.push(n);
  }
  const maxRep = MAX_REPLACE[variant];
  for (const r of Array.isArray(js.replace) ? js.replace : []) {
    const n = Number(r && r.n);
    if (!sents[n] || state.del.has(n) || state.rep.has(n)) { out.rejected.push({ type: 'replace', n, why: 'нет номера, удалено или уже заменено' }); continue; }
    if (state.rep.size >= maxRep) { out.rejected.push({ type: 'replace', n, why: 'сверх лимита ' + maxRep }); continue; }
    const was = String(r.was || ''), now = String(r.now || '');
    const newText = applyFragment(sents[n].text, was, now);
    const why = checkReplace(variant, sents[n].text, was, now, newText);
    if (why) { out.rejected.push({ type: 'replace', n, was, now, why }); continue; }
    state.rep.set(n, { was, now, newText });
  }

  let cur = build(text, st, state);
  // потерянный факт: предложение с ним возвращает код
  const restoreFor = (missing) => {
    let any = false;
    for (const m of missing) {
      const v = norm(m.value);
      for (const n of [...state.del]) if (norm(sents[n].text).includes(v)) { state.del.delete(n); out.restored.push({ n, why: 'факт: ' + m.value }); any = true; }
      for (const n of [...state.rep.keys()]) if (norm(sents[n].text).includes(v)) { state.rep.delete(n); out.restored.push({ n, why: 'факт (замена отменена): ' + m.value }); any = true; }
    }
    return any;
  };
  for (let i = 0; i < 8; i++) {
    const f = checkFacts(text, cur);
    if (f.ok) break;
    if (!restoreFor(f.missing)) break;
    cur = build(text, st, state);
  }
  // длина не короче 60%: возвращаем удаления с конца списка модели
  while (cur.length / text.length < MIN_RATIO && order.some((n) => state.del.has(n))) {
    const n = [...order].reverse().find((x) => state.del.has(x));
    state.del.delete(n); out.restored.push({ n, why: 'длина' });
    cur = build(text, st, state);
  }
  let facts = checkFacts(text, cur);
  if (!facts.ok && state.rep.size) { // на стыках замены могли дать лишнее: отменяем их все
    for (const n of [...state.rep.keys()]) { state.rep.delete(n); out.restored.push({ n, why: 'замены отменены: факты' }); }
    cur = build(text, st, state);
    facts = checkFacts(text, cur);
  }
  if (!facts.ok) { // последний рубеж: возвращаем всё
    for (const n of [...state.del]) { state.del.delete(n); out.restored.push({ n, why: 'факты не сходятся' }); }
    cur = build(text, st, state);
    facts = checkFacts(text, cur);
    out.reason = 'facts_unresolved';
  }
  out.after = cur; out.facts = facts;
  for (const n of state.del) out.diff.push({ type: 'delete', n, text: sents[n].text, reason: reasons[n] });
  for (const [n, r] of state.rep) out.diff.push({ type: 'replace', n, was: r.was, now: r.now });
  out.diff.sort((a, b) => a.n - b.n);
  out.status = cur === text ? 'unchanged' : 'dried';
  out.length_change = +(cur.length / text.length - 1).toFixed(3);
  out.lint_after = lint(cur).score;
  if (variant === 'B' && pairs.length) {
    out.copy = copyRate(cur, text, pairs.map((p) => p.human));
    out.copy.flag = out.copy.rate >= COPY_THRESHOLD || out.copy.run >= COPY_RUN;
  }
  out.cost = +out.cost.toFixed(6);
  return out;
}

module.exports = { dry, structure, numbered, build, parseJson, applyFragment, checkReplace, pickPairs, REASONS, MIN_RATIO, systemPrompt, userPrompt };
