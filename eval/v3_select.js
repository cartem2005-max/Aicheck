'use strict';
// Выборки шага 9 (v3 на dev). Только код, без LLM. Зёрна записаны в eval/V3_CRITERIA.md.
//   node eval/v3_select.js   -> печатает выборки
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'data');
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const SEEDS = { ai: 3101, editorial: 3102, noise: 5150 };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (arr, seed) => { const r = rng(seed); return arr.map((x) => [r(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); };

function select() {
  const ai = rj(path.join(D, 'ai_posts.json')).map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev' && x.text.length >= 400);
  const posts = rj(path.join(D, 'posts.json'));
  const labels = rj(path.join(D, 'voice_dev.json')).labels;
  const cache = rj(path.join(__dirname, 'results', 'cache', 'baseline_dev.json'));
  const old20 = new Set(Object.keys(rj(path.join(__dirname, 'results', 'rewrite_cache', 'gpt-6.1-terra.json'))).map(Number));
  const fresh = ai.filter((x) => !old20.has(x.idx));
  // 20 свежих AI: по 10 naive и human, зерно 3101
  const pick = (pt, n) => shuffle(fresh.filter((x) => x.prompt_type === pt), SEEDS.ai).slice(0, n);
  const ai20 = [...pick('naive', 10), ...pick('human', 10)].map((x) => ({ key: 'ai' + x.idx, kind: 'ai', idx: x.idx, source_id: x.source_id, prompt: x.prompt_type, model: x.model, text: x.text }));
  // 10 editorial dev: из тех, у кого в старом кэше baseline_dev оценка >= 40 («похоже на AI»), зерно 3102
  const ed = posts.filter((p) => labels[p.id] && labels[p.id].label === 'editorial' && p.text.length >= 400 && cache['p' + p.id] && cache['p' + p.id].ai_score >= 40);
  const ed10 = shuffle(ed, SEEDS.editorial).slice(0, 10).map((p) => ({ key: 'p' + p.id, kind: 'editorial', id: p.id, source_id: p.id, text: p.text }));
  // шум: 10 AI, 10 founder, 10 editorial (из всех dev >= 400 знаков), зерно 5150
  const founder = posts.filter((p) => labels[p.id] && labels[p.id].label === 'founder' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'founder', id: p.id, text: p.text }));
  const edAll = posts.filter((p) => labels[p.id] && labels[p.id].label === 'editorial' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'editorial', id: p.id, text: p.text }));
  const aiAll = ai.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', idx: x.idx, text: x.text }));
  const noise = [...shuffle(aiAll, SEEDS.noise).slice(0, 10), ...shuffle(founder, SEEDS.noise).slice(0, 10), ...shuffle(edAll, SEEDS.noise).slice(0, 10)];
  return { ai20, ed10, noise, founder, edAll, aiAll, old20: [...old20], ed_pool_ge40: ed.length };
}
module.exports = { select, SEEDS, rng, shuffle };
if (require.main === module) {
  const s = select();
  console.log('ai20 idx:', s.ai20.map((x) => x.idx).join(', '));
  console.log('ai20 source_id:', s.ai20.map((x) => x.source_id).join(', '));
  console.log('ed10 ids:', s.ed10.map((x) => x.id).join(', '), '(пул >=40:', s.ed_pool_ge40 + ')');
  console.log('noise:', s.noise.map((x) => x.key).join(', '));
  console.log('old20:', s.old20.join(', '));
}
