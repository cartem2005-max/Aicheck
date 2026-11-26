'use strict';
// Регрессия: баллы всех 288 текстов (192 AI + 96 постов канала от 400 знаков) против снимка eval/results/snapshot.json.
//   node eval/regress.js --write   сохранить снимок (после заморозки правил)
//   node eval/regress.js           сравнить: печатает тексты, у которых сменился балл или вердикт (выше / ниже порога 15); код выхода 1, если что-то изменилось
const fs = require('fs');
const path = require('path');
const { lint, SCORE_CONFIG } = require('../src/linter');

const ROOT = path.join(__dirname, '..');
const SNAP = process.env.KAN_SNAPSHOT || path.join(__dirname, 'results', 'snapshot.json');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

function current() {
  const sp = rd('data/split.json').split;
  const out = {};
  rd('data/ai_posts.json').forEach((x, i) => { const s = lint(x.text).score; out['ai:' + i] = { split: x.split, score: s, flagged: s !== null && s >= SCORE_CONFIG.threshold }; });
  for (const p of rd('data/posts.json')) { if (!sp[p.id]) continue; const s = lint(p.text).score; out['post:' + p.id] = { split: sp[p.id], score: s, flagged: s !== null && s >= SCORE_CONFIG.threshold }; }
  return out;
}

if (require.main === module) {
  const cur = current();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(SNAP, JSON.stringify({ threshold: SCORE_CONFIG.threshold, created: new Date().toISOString(), n: Object.keys(cur).length, texts: cur }));
    console.log('снимок записан:', Object.keys(cur).length, 'текстов');
  } else {
    const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    let moved = 0, flips = 0;
    for (const [k, v] of Object.entries(snap.texts)) {
      const c = cur[k];
      if (!c) { console.log('нет текста', k); moved++; continue; }
      if (c.score !== v.score) { moved++; if (c.flagged !== v.flagged) { flips++; console.log(`ВЕРДИКТ СМЕНИЛСЯ ${k} (${v.split}): ${v.score} -> ${c.score}`); } else console.log(`балл ${k}: ${v.score} -> ${c.score}`); }
    }
    console.log(`текстов ${Object.keys(cur).length}; изменился балл у ${moved}; сменился вердикт у ${flips}`);
    process.exit(moved ? 1 : 0);
  }
}
module.exports = { current };
