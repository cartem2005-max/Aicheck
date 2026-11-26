'use strict';
// Step 1: fixed dev/test split of channel posts (seed 42). Run once; reruns must give the same result.
const fs = require('fs');
const path = require('path');

const SEED = 42;
const MIN_LEN = 400;           // only posts of 400+ characters take part in evaluation
const TEST_SIZE = 36;          // dev = 96 - 36 = 60
const FORCED_TEST = [1059, 960, 910]; // demo posts, always in test

// mulberry32: tiny seeded random generator (same seed -> same sequence)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSplit(posts) {
  const ids = posts.filter(p => p.text.length >= MIN_LEN).map(p => p.id).sort((a, b) => a - b);
  const pool = ids.filter(id => !FORCED_TEST.includes(id));
  const rand = rng(SEED);
  for (let i = pool.length - 1; i > 0; i--) {          // Fisher-Yates shuffle
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const test = new Set([...FORCED_TEST, ...pool.slice(0, TEST_SIZE - FORCED_TEST.length)]);
  const split = {};
  for (const id of ids) split[id] = test.has(id) ? 'test' : 'dev';
  return split;
}

const root = path.join(__dirname, '..');
const posts = JSON.parse(fs.readFileSync(path.join(root, 'data', 'posts.json'), 'utf8'));
const split = makeSplit(posts);
const out = { seed: SEED, min_length: MIN_LEN, forced_test: FORCED_TEST, split };
const file = path.join(root, 'data', 'split.json');
const json = JSON.stringify(out, null, 1);
const counts = Object.values(split).reduce((c, v) => (c[v] = (c[v] || 0) + 1, c), {});

if (fs.existsSync(file)) {
  const same = fs.readFileSync(file, 'utf8') === json;
  console.log(same ? 'split.json уже есть и совпадает с пересчётом (разбиение воспроизводимо)' : 'ОШИБКА: split.json отличается от пересчёта, не перезаписываю');
  if (!same) process.exit(1);
} else {
  fs.writeFileSync(file, json);
  console.log('split.json создан');
}
console.log('dev/test:', counts, 'sha-like check: ', require('crypto').createHash('sha256').update(json).digest('hex').slice(0, 12));
