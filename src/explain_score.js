'use strict';
// Прозрачный балл шаблонности (шаг 13). Считается КОДОМ из находок «Разбора» и линтера, без отдельных вызовов модели.
// Формула (одна, объяснимая):
//  1. Текст делится на части: абзац; абзацы короче 80 знаков склеиваются с соседним; подряд идущие пункты списка — одна часть.
//  2. Каждая находка получает вес пункта каталога (WEIGHTS: 3 — признак сильно разделяет AI и основателя по нашим замерам,
//     2 — заметно, 1 — остальное и там, где цифр нет). Один пункт засчитывается не больше 2 раз на весь текст.
//     Находки линтера берутся с его весом (1–3), если то же место или тот же пункт каталога уже найден «Разбором» — не дублируются.
//  3. Находка привязывается к части по позиции цитаты. Часть «отмечена», если в ней есть приём с весом 3 или не меньше двух приёмов.
//  4. Балл = 100 × (отмеченных частей / всех частей) × K  +  добавка за признаки всего текста (пункты 34, 38, 39: +5 за каждый, не больше двух).
//  5. Защита: меньше 4 разных пунктов (приёмов) — балл не выше 54, то есть не выше средней зоны («Много приёмов» только от 4 разных).
//  Вклад в балл: балл части делится между её находками пропорционально весам; добавка — отдельной строкой.
const E = require('./explain_fix');

const K = 1.0;                // коэффициент доли отмеченных частей (подбирается на dev)
// пороги зон подобраны на dev (eval/explain_score_dev.js): основателя в «много приёмов» — 1 из 24 (допуск было 2)
const ZONE_MID = 25, ZONE_HIGH = 45;
const CFG = { flagSum: 2, lintWeight: 0 }; // часть отмечена, если сумма весов приёмов в ней >= flagSum и есть либо приём весом 3, либо не меньше двух приёмов
const MIN_PART = 80, MAX_PER_SIGN = 2, MIN_DISTINCT_HIGH = 4;
const BONUS_SIGNS = [34, 38, 39], BONUS_EACH = 5, BONUS_MAX_ITEMS = 2;
const LABELS = { low: 'Почти нет шаблонных приёмов', mid: 'Есть приёмы, на которые стоит обратить внимание', high: 'Много шаблонных приёмов' };
// Веса: 3 — по каталогу признак сильно разделяет AI и основателя (п.1: 36/120 против 0/24; п.24: 65/120 против 1/24; п.34: 66/120 против 1/24);
// 2 — заметно (п.26: 18/120 против 0/24; п.29: 23/120 против 1/24); 1 — остальные пункты (цифр нет — вес 1).
// Вес 0 (признак НЕ засчитывается, в разборе остаётся): пункты, которые на dev у основателя встречаются не реже, чем у AI (доля AI < 1,3 доли основателя
// в находках «Разбора»: eval/explain_score_dev.js). Это подгонка под 24 dev-поста основателя (на перекрёстной проверке AUC против founder 0,78–0,82 вместо 0,90).
const ZERO = [3, 10, 12, 13, 14, 16, 19, 20, 23, 25, 27, 30, 32, 33, 37, 39, 44, 45, 47, 48, 49];
const WEIGHTS = { 1: 3, 24: 3, 34: 3, 26: 2, 29: 2 };
for (const n of ZERO) WEIGHTS[n] = 0;
const weightOf = (sign) => (sign in WEIGHTS ? WEIGHTS[sign] : 1);
// линтер: правило -> пункт каталога (для дублей) и короткое имя
const LINT_SIGN = { A15: 15, B03: 3, B06: 9, B09: 24, C02: 30, D04: 34 };
const LINT_NAME = { A13: 'не только… но и', A15: 'пустые связки', B03: 'вопрос и сразу ответ', B06: 'вывод-мораль', B09: 'призыв в конце', C02: 'эмодзи-маркеры', D03: 'рубленые предложения', D04: 'ровные абзацы' };

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const signName = (n) => lowerFirst(E.shortTitle(n));

// части: [{start, end}]
function splitParts(text) {
  const raw = [];
  const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  let m;
  while ((m = re.exec(text))) raw.push({ start: m.index, end: m.index + m[0].replace(/\s+$/, '').length });
  if (!raw.length) return [];
  const isList = (p) => /^\s*(?:\d{1,2}[.)]|[*•–—-]|[\u{1F300}-\u{1FAFF}☀-➿⭐️]|\d️?⃣)/u.test(text.slice(p.start, p.end));
  const a = [];
  for (const p of raw) { const last = a[a.length - 1]; if (last && last.list && isList(p)) last.end = p.end; else a.push({ ...p, list: isList(p) }); }
  const len = (p) => p.end - p.start;
  const out = [];
  let carry = null;
  for (const p of a) {
    const cur = carry ? { start: carry.start, end: p.end } : { start: p.start, end: p.end };
    if (len(cur) < MIN_PART) { carry = cur; continue; }
    carry = null; out.push(cur);
  }
  if (carry) { if (out.length) out[out.length - 1].end = carry.end; else out.push(carry); }
  return out;
}

// model: findings из explain_fix.apply (с start/end/sign/quote); lintFindings: [{rule, start, end, weight, whole}] (только counted)
function scoreText(text, model, lintFindings) {
  const parts = splitParts(text);
  const items = []; // {key, label, sign|null, weight, start, rule}
  for (const f of model || []) items.push({ src: 'model', sign: f.sign, label: signName(f.sign), weight: weightOf(f.sign), start: f.start, end: f.end });
  const have = new Set(items.map((x) => x.sign));
  for (const f of lintFindings || []) {
    const sign = LINT_SIGN[f.rule] || null;
    if (sign && have.has(sign)) continue;
    if (!f.whole && items.some((x) => x.start >= 0 && x.start < f.end && x.end > f.start)) continue; // то же место
    items.push({ src: 'lint', sign, rule: f.rule, label: sign ? signName(sign) : (LINT_NAME[f.rule] || f.rule), weight: CFG.lintWeight || f.weight || 1, start: f.whole ? -1 : f.start, end: f.end });
  }
  // текст-уровень: пункты 34, 38, 39
  const bonusItems = [];
  const part = [];
  const used = {};
  for (const it of items) {
    if (BONUS_SIGNS.includes(it.sign)) { if (!it.weight) continue; if (!bonusItems.some((b) => b.sign === it.sign)) bonusItems.push(it); continue; }
    if (!it.weight) continue; // вес 0: признак не засчитывается (см. WEIGHTS)
    if (it.start < 0) continue; // без позиции (подсказка «в целом»): к части не привязать
    used[it.label] = (used[it.label] || 0) + 1;
    if (used[it.label] > MAX_PER_SIGN) continue;
    let pi = parts.findIndex((p) => it.start >= p.start && it.start < p.end + 1);
    if (pi < 0) pi = parts.length - 1;
    (part[pi] = part[pi] || []).push(it);
  }
  const bonus = bonusItems.slice(0, BONUS_MAX_ITEMS);
  const flagged = [];
  parts.forEach((p, i) => { const a = part[i] || []; if (a.reduce((t, x) => t + x.weight, 0) >= CFG.flagSum && (a.some((x) => x.weight >= 3) || a.length >= 2)) flagged.push(i); });
  const perPart = parts.length ? 100 * K / parts.length : 0;
  const contrib = {};
  for (const i of flagged) {
    const a = part[i], sw = a.reduce((s, x) => s + x.weight, 0);
    for (const x of a) contrib[x.label] = (contrib[x.label] || 0) + perPart * x.weight / sw;
  }
  for (const b of bonus) contrib[b.label] = (contrib[b.label] || 0) + BONUS_EACH;
  let raw = Object.values(contrib).reduce((s, v) => s + v, 0);
  const distinct = new Set(items.filter((x) => x.weight > 0 && x.start >= 0 || BONUS_SIGNS.includes(x.sign)).map((x) => x.sign || x.rule)).size;
  let score = Math.min(100, raw), capped = false;
  if (distinct < MIN_DISTINCT_HIGH && score > ZONE_HIGH - 1) { score = ZONE_HIGH - 1; capped = true; }
  score = Math.round(score);
  const zone = score < ZONE_MID ? 'low' : score < ZONE_HIGH ? 'mid' : 'high';
  const list = Object.entries(contrib).map(([label, v]) => ({ label, points: Math.round(v), n: items.filter((x) => x.label === label).length })).filter((x) => x.points > 0).sort((a, b) => b.points - a.points);
  return { score, zone, label: LABELS[zone], parts: parts.length, flagged: flagged.length, bonus: bonus.length * BONUS_EACH, bonus_labels: bonus.map((b) => b.label), distinct, capped, contribs: list, n_items: items.length };
}

module.exports = { CFG, K, ZONE_MID, ZONE_HIGH, WEIGHTS, weightOf, splitParts, scoreText, LABELS };
