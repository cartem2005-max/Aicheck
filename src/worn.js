'use strict';
// «Заезженные» фразы основателя: список живёт в src/prompts/voice.md (раздел «Нельзя переносить»).
// worn(text, original) -> фразы из списка, которые есть в тексте, но не было в оригинале.
const fs = require('fs');
const path = require('path');

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\- ]+/gu, ' ').replace(/\s+/g, ' ').trim();

function loadWorn(file = path.join(__dirname, 'prompts', 'voice.md')) {
  const md = fs.readFileSync(file, 'utf8');
  const part = md.split(/^## Нельзя переносить[^\n]*\n/m)[1] || '';
  const list = [...part.matchAll(/^- «([^»]+)»/gm)].map((m) => m[1]);
  return [...new Set(list)].map((p) => ({ phrase: p, key: norm(p) })).filter((x) => x.key);
}

function worn(text, original = '', list = loadWorn()) {
  const t = ' ' + norm(text) + ' ', o = ' ' + norm(original) + ' ';
  return list.filter((x) => t.includes(' ' + x.key) && !o.includes(' ' + x.key)).map((x) => x.phrase);
}

module.exports = { loadWorn, worn, norm };
