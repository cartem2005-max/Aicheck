'use strict';
// Fact extraction and check, no LLM.
// extractFacts(text) -> [{type, value, key, start, end}]   (key = normalized form used for comparison)
// checkFacts(original, rewritten) -> {ok, missing[], added[], warnings[], table[]}
//
// Fact types: date, month, weekday, number, url, mention, hashtag, quote, path, name, latin.
// Harmless reformatting gives the same key: 13.02.2026 = 13 февраля 2026, 5% = 5 процентов,
// 70 млрд = 70 миллиардов, "три месяца" = "3 месяца", Озон = Ozon.
// Simple choices: presence is checked as a SET (a fact met twice in the original needs to be met once).
// NOT caught by code (needs a human or a model): sign and negation flips ("+12%" -> "-12%", "выросла" -> "упала",
// "не удалятся" -> "удалятся"), and any change of meaning that does not touch a fact.
const { normalize } = require('./textparse');
const W = require('./facts_words');

const norm = s => normalize(s.toLowerCase()).replace(/\s+/g, ' ').trim();
const blankOut = (s, a, b) => s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
const STEM = 4; // Cyrillic names are compared by their first letters: Озон / Озоне / Озона, Культуре / Культуру

function extractFacts(text) {
  const facts = [];
  const base = normalize(text);      // same length as text, so all positions are valid in the original
  let work = base;                   // copy where already-extracted spans are blanked

  // take(re, type, keyFn, blank): find matches in `work`, record facts with positions and values from the original text
  function take(re, type, keyFn, blank = true) {
    for (const m of [...work.matchAll(re)]) {
      const g = m.groups && m.groups.v !== undefined ? m.groups.v : m[0];
      const start = m.index + m[0].indexOf(g), end = start + g.length;
      facts.push({ type, value: text.slice(start, end).trim(), key: type + ':' + keyFn(g, m), start, end });
      if (blank) work = blankOut(work, m.index, m.index + m[0].length);
    }
  }
  const add = (type, key, start, end) => facts.push({ type, value: text.slice(start, end), key: type + ':' + key, start, end });

  // 1. things whose digits/letters must not be re-read as numbers or words
  take(/(?:https?:\/\/|www\.|t\.me\/)[^\s)»”"]*[^\s)»”".,;:!?]/giu, 'url', v => v.toLowerCase());
  take(/@[A-Za-z0-9_]{4,}/g, 'mention', v => v.toLowerCase());
  take(/#[\p{L}\p{N}_]+/gu, 'hashtag', v => v.toLowerCase());
  work = work.replace(/[0-9#*]\uFE0F?\u20E3|\u{1F51F}/gu, m => ' '.repeat(m.length));       // a number in a box is a bullet, not a fact
  work = work.replace(/^([ \t]*)\d{1,2}[.)](?=\s)/gm, m => ' '.repeat(m.length));          // "1. " list numbering

  // 2. quotes and paths (kept in `work`: the words inside are also checked as numbers / latin words)
  take(/«(?<v>[^»\n]{1,300})»/g, 'quote', norm, false);
  take(/“(?<v>[^”\n]{1,300})”/g, 'quote', norm, false);
  take(/"(?<v>[^"\n]{1,300})"/g, 'quote', norm, false);
  // "кабинет Ozon → Настройки → API интеграции": last word before the arrow + all following steps.
  // All steps but the last are compared exactly; the last one only by its first word (the regex may grab a few extra words).
  take(/[\p{L}\p{N}-]+(?:\s*(?:→|->)\s*[^→\n.,;!?]+?(?=\s*(?:→|->)|[.,;!?\n]|$))+/gu, 'path', v => {
    const steps = v.split(/\s*(?:→|->)\s*/).map(norm);
    steps[steps.length - 1] = steps[steps.length - 1].split(' ')[0];
    return steps.join(' → ');
  }, false);

  // 3. names: known marketplaces, abbreviations, capitalized Cyrillic words in the middle of a sentence
  // a number in a box ("1\uFE0F\u20E3 Раз") opens a new line, like a list marker; quotes, paths, links are checked on their own, so they are hidden here
  let names = base.replace(/[0-9#*]\uFE0F?\u20E3|\u{1F51F}/gu, m => '\n' + ' '.repeat(m.length - 1));
  for (const f of facts) names = blankOut(names, f.start, f.end);
  for (const m of names.matchAll(W.PLATFORM_RE)) {
    add('name', W.platformKey(m), m.index, m.index + m[0].length);
    names = blankOut(names, m.index, m.index + m[0].length);
    work = blankOut(work, m.index, m.index + m[0].length);   // so that "Ozon" is not also a latin fact
  }
  extractNames(names, add);

  // 4. dates "13 февраля", "13.02.2026"; months and weekdays alone; then numbers; then latin words
  for (const m of [...work.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/g)]) {
    if (+m[1] > 31 || +m[2] > 12) continue;
    add('date', `${+m[1]}.${+m[2]}`, m.index, m.index + m[0].length);                       // 13.02.2026: the date 13.2 ...
    const yearAt = m.index + m[0].length - m[3].length;
    add('number', m[3].length === 2 ? '20' + m[3] : m[3], yearAt, yearAt + m[3].length);    // ... and the number 2026
    work = blankOut(work, m.index, m.index + m[0].length);
  }
  take(new RegExp(`(?<![\\d.])(\\d{1,2})\\s+(${W.MONTH_RE})(?![\\p{L}])`, 'giu'), 'date', (v, m) => `${+m[1]}.${W.monthIndex(m[2])}`);
  take(new RegExp(`(?<![\\p{L}])${W.MONTH_RE}(?![\\p{L}])`, 'giu'), 'month', v => W.monthIndex(v));
  take(new RegExp(`(?<![\\p{L}])${W.WEEKDAY_RE}(?![\\p{L}])`, 'giu'), 'weekday', v => W.weekdayIndex(v));
  const numbersFrom = facts.length;
  take(/\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu, 'number', v => v.replace(/ /g, '').replace(',', '.'), false);
  take(new RegExp(`(?<![\\p{L}\\p{N}])${W.NUMBER_WORD_RE}(?![\\p{L}\\p{N}])`, 'giu'), 'number', v => W.numberWordValue(v), false);
  attachUnits(facts.slice(numbersFrom), base, text);
  take(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g, 'latin', v => v, false);

  return facts.sort((a, b) => a.start - b.start);
}

// Names that are not in the list: "КАН", "ОЗЗ", "РнП", "Культуре Аналитики" (not at the start of a sentence).
function extractNames(names, add) {
  // a line written in CAPS is shouting, not names
  const shouting = new Set();
  for (const m of names.matchAll(/^.+$/gm)) {
    const letters = m[0].replace(/[^\p{L}]/gu, '');
    if (letters.length > 8 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.6) shouting.add(m.index);
  }
  const inShoutingLine = i => shouting.has(names.lastIndexOf('\n', i - 1) + 1);
  for (const m of names.matchAll(/(?<![\p{L}])(?:[А-Я]{2,6}|[А-Я][а-я][А-Я])(?![\p{L}])/gu)) {
    if (m[0] === 'ИИ' || inShoutingLine(m.index)) continue;
    add('name', m[0].toLowerCase(), m.index, m.index + m[0].length);
  }
  // text between the last sentence end (or line start, list number, emoji) and the word means: it opens a sentence
  const OPENS_SENTENCE = /(?:[.!?…:\n])[\s«"“(\[*•–—-]*[\p{Extended_Pictographic}\uFE0F\u200D\d.)\s]*$/u;
  for (const m of names.matchAll(/(?<![\p{L}\p{N}])[А-Я][а-я]{2,}(?![\p{L}])/gu)) {
    const from = Math.max(0, m.index - 40);
    const before = (from === 0 ? '\n' : '') + names.slice(from, m.index);
    if (OPENS_SENTENCE.test(before) || inShoutingLine(m.index)) continue;
    add('name', m[0].toLowerCase().slice(0, STEM), m.index, m.index + m[0].length);
  }
}

// "3К", "5%", "2 млн", "90 дней", "34 990 ₽/мес" change the value of a number, so they become part of its key.
// Only the scale (%, К, млн...) goes to the value text; the unit stays outside of it ("90", not "90 дней").
function attachUnits(numbers, base, text) {
  for (const f of numbers) {
    let rest = base.slice(f.end, f.end + 30), suffix = '';
    const sc = W.SCALE_RE.exec(rest);
    if (sc) { suffix += W.scaleKey(sc[1] || sc[2]); f.end += sc[0].length; f.value = text.slice(f.start, f.end).trim(); rest = rest.slice(sc[0].length); }
    const unit = W.UNITS.map(([name, re]) => [name, re.exec(rest)]).find(([, m]) => m);
    if (unit) {
      const per = W.PERIOD_RE.exec(rest.slice(unit[1][0].length));
      const isYear = unit[0] === 'г' && !suffix && /^(19|20)\d\d$/.test(f.key.slice(7));   // "2026 года" = "2026"
      if (!isYear) suffix += ' ' + unit[0] + (per ? '/' + W.periodKey(per[1]) : '');
    }
    f.key += suffix;
  }
}

const CHECK_ADDED = ['number', 'date', 'month', 'weekday', 'url', 'mention', 'hashtag']; // new facts of these types are errors
const WARN_ADDED = ['latin', 'name'];                                                    // new names: warning only, ok stays true

function checkFacts(original, rewritten) {
  const orig = extractFacts(original);
  const now = extractFacts(rewritten);
  const nowKeys = new Set(now.map(f => f.key));
  const flat = norm(rewritten).replace(/->/g, '→').replace(/\s*→\s*/g, ' → ');
  // quotes and paths may lose their quote marks / arrows formatting; accept verbatim wording
  const present = f => nowKeys.has(f.key) ||
    ((f.type === 'quote' || f.type === 'path') && flat.includes(f.key.slice(f.type.length + 1)));
  const table = orig.map(f => ({ type: f.type, value: f.value, present: present(f) }));
  const origKeys = new Set(orig.map(f => f.key));
  const origMonths = new Set(orig.filter(f => f.type === 'date').map(f => f.key.split('.')[1])); // "13 февраля" already holds the month
  const missing = table.filter(r => !r.present);
  const seen = new Set();
  const isNew = f => !origKeys.has(f.key) && !seen.has(f.key) && seen.add(f.key);
  const pick = f => ({ type: f.type, value: f.value });
  const added = now.filter(f => CHECK_ADDED.includes(f.type) && !(f.type === 'month' && origMonths.has(f.key.slice(6))) && isNew(f)).map(pick);
  const warnings = now.filter(f => WARN_ADDED.includes(f.type) && isNew(f)).map(pick);
  return { ok: !missing.length && !added.length, missing, added, warnings, table, total: orig.length };
}

module.exports = { extractFacts, checkFacts };
