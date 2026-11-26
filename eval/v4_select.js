'use strict';
// Выборки шага 12 (v4, переписывание словами основателя). Только код, без LLM. Зерно записано в eval/V4_STYLE_CRITERIA.md.
//   node eval/v4_select.js
const fs = require('fs');
const path = require('path');
const { select: v3select, shuffle } = require('./v3_select');
const SEED_AI = 4101;

function select() {
  const v3 = v3select();
  const ai = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ai_posts.json'), 'utf8')).map((x, i) => ({ ...x, idx: i }))
    .filter((x) => x.split === 'dev' && x.text.length >= 400);
  const rc = path.join(__dirname, 'results', 'rewrite_cache');
  const used = new Set(v3.ai20.map((x) => x.idx));
  for (const f of fs.readdirSync(rc).filter((f) => f.endsWith('.json'))) for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(rc, f), 'utf8')))) used.add(Number(k));
  const fresh = ai.filter((x) => !used.has(x.idx));
  const pick = (pt, n) => shuffle(fresh.filter((x) => x.prompt_type === pt), SEED_AI).slice(0, n);
  const ai20 = [...pick('naive', 10), ...pick('human', 10)].map((x) => ({ key: 'ai' + x.idx, kind: 'ai', idx: x.idx, source_id: x.source_id, prompt: x.prompt_type, model: x.model, text: x.text }));
  return { ai20, ed10: v3.ed10, fresh: fresh.length, excluded: [...used].sort((a, b) => a - b) };
}
module.exports = { select, SEED_AI };
if (require.main === module) {
  const s = select();
  console.log('fresh pool:', s.fresh, 'excluded:', s.excluded.length);
  console.log('ai20 idx:', s.ai20.map((x) => x.idx).join(', '));
  console.log('ai20 source_id:', s.ai20.map((x) => x.source_id).join(', '));
  console.log('ed10 ids:', s.ed10.map((x) => x.id).join(', '));
}
