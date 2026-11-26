'use strict';
// Text structure for the linter: lines -> paragraphs -> sentences, plus metrics (group D).
// All positions are JS string indices (UTF-16) in the ORIGINAL text.

// \uFE0F = emoji variation selector, \u20E3 = combining keycap ("1" + FE0F + 20E3 gives 1 in a box)
const KEYCAP = /[0-9#*]\uFE0F?\u20E3|\u{1F51F}/gu;
const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const wordCount = s => (s.replace(KEYCAP, ' ').match(WORD) || []).length;

// Same length as the input, so offsets stay valid: ё -> е, any "wide" space (NBSP, thin, narrow) -> plain space.
const normalize = t => t.replace(/ё/g, 'е').replace(/Ё/g, 'Е').replace(/[\u00A0  \u202F]/g, ' ');

// List marker at the start of a line: "1." "2)" "*" "•" "–" "—" "-". It is not a sentence.
const LIST_MARKER = /^(?:\d{1,2}[.)]|[*•–—-])[ \t]+/;
// Abbreviations after which a dot does NOT end the sentence ("т. е.", "2026 г.", "тыс.", "PS.")
const ABBREVIATIONS = new Set(['т', 'д', 'п', 'г', 'гг', 'руб', 'тыс', 'млн', 'млрд', 'др', 'пр', 'ул', 'им', 'см', 'напр', 'рис', 'стр', 'ps', 'p', 's']);

// Lines -> paragraphs (blocks separated by blank lines) -> sentences (split at . ! ? … and at line end).
function parseText(text) {
  const paragraphs = [];
  let pos = 0, cur = null;
  for (const raw of text.split('\n')) {
    const t = raw.trimEnd();
    if (t.trim() === '') { cur = null; }
    else {
      let start = pos + (t.length - t.trimStart().length), body = t.trim();
      const marker = LIST_MARKER.exec(body);
      if (marker) { start += marker[0].length; body = body.slice(marker[0].length); }
      const line = { start, end: pos + t.length, text: body, bullet: !!marker };
      if (!cur) { cur = { lines: [], sentences: [] }; paragraphs.push(cur); }
      cur.lines.push(line);
      for (const s of splitSentences(line)) cur.sentences.push(s);
    }
    pos += raw.length + 1;
  }
  for (const p of paragraphs) {
    p.start = p.lines[0].start; p.end = p.lines[p.lines.length - 1].end;
    p.text = text.slice(p.start, p.end);
  }
  return paragraphs;
}

function splitSentences(line) {
  const out = [], re = /[.!?…]+[»"”')\]]*(?=\s|$)/g;
  let s = 0, m;
  const push = (a, b) => {
    const str = line.text.slice(a, b);
    if (/[\p{L}\p{N}]/u.test(str)) out.push({ start: line.start + a, end: line.start + b, words: wordCount(str), text: str, line });
  };
  while ((m = re.exec(line.text))) {
    if (m[0] === '.' && isAbbreviation(line.text.slice(0, m.index))) continue; // "т. е." is not a sentence end
    push(s, m.index + m[0].length); s = re.lastIndex;
  }
  push(s, line.text.length);
  return out;
}

// the word right before the dot: a known abbreviation or a single letter ("А. Иванов", "т. е.")
function isAbbreviation(before) {
  const w = /([\p{L}]+)$/u.exec(before);
  return !!w && (w[1].length === 1 || ABBREVIATIONS.has(w[1].toLowerCase()));
}

// ---------- signatures ("@channel", "#tag", "PS: ...", "Всем продаж 🙌") ----------
const isSignatureLine = l => /^[@#]|^P\.?S(?![\p{L}])/iu.test(l.text) ||
  (wordCount(l.text) <= 2 && /\p{Extended_Pictographic}/u.test(l.text)); // short line with an emoji: "Всем продаж 🙌"
const isSignature = p => p.lines.every(isSignatureLine);

// paragraphs without the trailing signature block: only this part is measured and judged
function bodyParagraphs(paragraphs) {
  let n = paragraphs.length;
  while (n > 1 && isSignature(paragraphs[n - 1])) n--;
  return paragraphs.slice(0, n);
}

// ---------- metrics (group D) ----------
// Em dash as punctuation: " — " or " – " in the middle of a line (a dash at line start is a list marker, not counted).
const DASH = /(?<=\S)[ ][—–][ ]/g;

function computeMetrics(text, body) {
  const sents = body.flatMap(p => p.sentences);
  const lens = sents.map(s => s.words);
  const n = lens.length;
  const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const std = n ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const pw = body.map(p => p.sentences.reduce((a, s) => a + s.words, 0));
  const pmean = pw.length ? pw.reduce((a, b) => a + b, 0) / pw.length : 0;
  const pstd = pw.length ? Math.sqrt(pw.reduce((a, b) => a + (b - pmean) ** 2, 0) / pw.length) : 0;
  const dashes = (normalize(text).match(DASH) || []).length;
  return {
    chars: text.length, paragraphs: body.length, sentences: n,
    words_mean: +mean.toFixed(2), words_std: +std.toFixed(2), words_cv: mean ? +(std / mean).toFixed(3) : 0,
    one_sentence_paragraph_share: body.length ? +(body.filter(p => p.sentences.length === 1).length / body.length).toFixed(3) : 0,
    paragraph_words_cv: pmean ? +(pstd / pmean).toFixed(3) : 0,
    short_sentence_share: n ? +(lens.filter(l => l < 5).length / n).toFixed(3) : 0,
    em_dashes: dashes, em_dash_per_1000: +(dashes / Math.max(text.length, 1) * 1000).toFixed(2)
  };
}

module.exports = { wordCount, normalize, parseText, bodyParagraphs, isSignature, computeMetrics, DASH };
