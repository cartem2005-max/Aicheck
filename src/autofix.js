'use strict';
// Mechanical fixes WITHOUT a model: what a regex can find, code cuts (step 6, "что ловится регуляркой — режем кодом").
// autofix(text) -> { text, changes: [{ rule, before, after }] }
// Only layout is touched: list markers and pointer emoji. Words, numbers, dates, names, links are never changed,
// so checkFacts(original, fixed) stays ok. Safe to run twice (the second run changes nothing).
//   C01  "1️⃣ Текст" -> "1. Текст" (keycap digits at the start of a line; 🔟 -> "10.")
//   C02  emoji list markers at the start of lines (2+ such lines, the first line of the post is its title and is kept):
//        a list item "🔹 Метрика" -> "— Метрика"; a sub-heading ("📌 Когда" followed by text in the same paragraph) -> the emoji is removed
//   B09  the pointer " 👇" at the end of a line is removed (the call to action itself stays: that is for the model / the author)
//   W01  3+ blank lines in a row -> one blank line; spaces at the end of lines are cut
const { parseText, bodyParagraphs } = require('./textparse');

const KEYCAP_LINE = /^([ \t]*)([0-9])️?⃣[ \t]*/;
const TEN_LINE = /^([ \t]*)\u{1F51F}[ \t]*/u;
const EMOJI_START = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)[ \t]*/u;
const POINTER = /[ \t]*\u{1F447}[\u{1F3FB}-\u{1F3FF}]?[ \t]*$/u;

function autofix(text) {
  const changes = [];
  const note = (rule, before, after) => { if (before !== after) changes.push({ rule, before, after }); };
  let lines = text.split('\n');

  // C01: keycap numbering
  lines = lines.map(l => {
    let out = l, m;
    if ((m = KEYCAP_LINE.exec(l))) out = `${m[1]}${m[2]}. ` + l.slice(m[0].length);
    else if ((m = TEN_LINE.exec(l))) out = `${m[1]}10. ` + l.slice(m[0].length);
    note('C01', l, out);
    return out;
  });

  // C02: emoji markers. Decided on the text after C01, with the same paragraph model the linter uses.
  const fixed1 = lines.join('\n');
  const body = bodyParagraphs(parseText(fixed1));
  const bodyLines = body.flatMap(p => p.lines.map((l, i) => ({ l, p, i })));
  const marked = bodyLines.slice(1).filter(x => EMOJI_START.test(x.l.text));
  if (marked.length >= 2) {
    // line start offsets in fixed1 -> line numbers
    const starts = []; let pos = 0;
    for (const l of lines) { starts.push(pos); pos += l.length + 1; }
    const lineNo = off => { let k = starts.length - 1; while (starts[k] > off) k--; return k; };
    for (const x of marked) {
      const n = lineNo(x.l.start), old = lines[n];
      const m = EMOJI_START.exec(old.trimStart());
      if (!m) continue;
      const indent = old.slice(0, old.length - old.trimStart().length);
      const rest = old.trimStart().slice(m[0].length);
      const next = x.p.lines[x.i + 1];
      const heading = !!next && !EMOJI_START.test(next.text);  // text follows in the same paragraph: it is a sub-heading, not an item
      lines[n] = heading ? indent + rest : `${indent}— ${rest}`;
      note('C02', old, lines[n]);
    }
  }

  // B09: the pointer at the end of a line
  lines = lines.map(l => {
    if (!POINTER.test(l)) return l;
    const out = l.replace(POINTER, '');
    note('B09', l, out);
    return out;
  });

  // W01: whitespace tidy
  const trimmed = lines.map(l => l.replace(/[ \t]+$/, ''));
  if (trimmed.some((l, i) => l !== lines[i])) note('W01', '(пробелы в конце строк)', '(убраны)');
  let out = trimmed.join('\n');
  const collapsed = out.replace(/\n{3,}/g, '\n\n');
  if (collapsed !== out) { note('W01', '(3+ пустых строк подряд)', '(одна пустая строка)'); out = collapsed; }
  return { text: out, changes };
}

module.exports = { autofix, KEYCAP_LINE, TEN_LINE };
