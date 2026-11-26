'use strict';
// Подбор образцов: 3 поста основателя (только dev, data/voice_dev.json), ближайшие по теме к тексту.
// TF-IDF по основам слов (первые 5 букв), косинус. Без эмбеддингов и сети.
//   pickSamples(text, {k, excludeId, pool}) -> [{id, score, text}]   (text — без подписи канала, до maxChars)
//   copyRate(result, original, samples) -> {rate, run, grams, copied}  — доля 4-грамм слов результата, которые есть в образцах
const fs = require('fs');
const path = require('path');

const STOP = new Set(('это как что так вот для или при все его ещё еще был была были быть есть нет уже только если когда тоже может можно ' +
  'очень будет будут чтобы который которые которая также этот эти этой этом того тому свой своих наш наши ваш ваши там тут чем где').split(' '));
const STEM = 5;
const words = (s) => (s.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || []);
const stems = (s) => words(s).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, STEM));

// посты-анонсы (чужие конференции, эфиры) как образец стиля не годятся
const EXCLUDE = new Set([946, 1000]);

let POOL = null;
function loadPool() {
  if (POOL) return POOL;
  const root = path.join(__dirname, '..', 'data');
  const posts = JSON.parse(fs.readFileSync(path.join(root, 'posts.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'voice_dev.json'), 'utf8')).labels;
  POOL = posts.filter((p) => labels[p.id] && labels[p.id].label === 'founder' && !EXCLUDE.has(p.id))
    .map((p) => ({ id: p.id, text: p.text }));
  return POOL;
}

function cleanSample(text, maxChars = 1400) {
  const t = text.replace(/\s*@\w+\s*$/, '').trim();
  if (t.length <= maxChars) return t;
  const paras = t.split(/\n\s*\n/);
  let out = '';
  for (const p of paras) { if (out && (out + '\n\n' + p).length > maxChars) break; out += (out ? '\n\n' : '') + p; }
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

function pickSamples(text, { k = 3, excludeId = null, pool = loadPool(), maxChars = 1400 } = {}) {
  const docs = pool.map((p) => ({ p, tf: count(stems(p.text)) }));
  const df = {};
  for (const d of docs) for (const w of Object.keys(d.tf)) df[w] = (df[w] || 0) + 1;
  const N = docs.length;
  const idf = (w) => Math.log((N + 1) / ((df[w] || 0) + 0.5));
  const vec = (tf) => { const v = {}; let n = 0; for (const [w, c] of Object.entries(tf)) { const x = (1 + Math.log(c)) * idf(w); v[w] = x; n += x * x; } return { v, n: Math.sqrt(n) || 1 }; };
  const q = vec(count(stems(text)));
  const scored = docs.filter((d) => d.p.id !== excludeId).map((d) => {
    const dv = vec(d.tf);
    let dot = 0;
    for (const [w, x] of Object.entries(q.v)) if (dv.v[w]) dot += x * dv.v[w];
    return { id: d.p.id, score: +(dot / (q.n * dv.n)).toFixed(4), text: cleanSample(d.p.text, maxChars) };
  });
  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  return scored.slice(0, k);
}

function count(arr) { const o = {}; for (const w of arr) o[w] = (o[w] || 0) + 1; return o; }

// ---------- проверка на копирование ----------
const grams = (s, n = 4) => { const w = words(s); const out = []; for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' ')); return out; };

// Доля 4-грамм результата, которые есть в образцах и НЕТ в оригинале (фразы самого оригинала — не заимствование;
// факты и их окружение попадают в оригинал, поэтому не считаются). run — самая длинная общая цепочка слов с образцами.
function copyRate(result, original, samples) {
  const own = new Set(grams(original));
  const sam = new Set(samples.flatMap((s) => grams(typeof s === 'string' ? s : s.text)));
  const g = grams(result);
  const copied = g.filter((x) => sam.has(x) && !own.has(x));
  const rw = words(result), ow = new Set(grams(original, 3)), sw = samples.map((s) => words(typeof s === 'string' ? s : s.text));
  let run = 0;
  for (const sv of sw) {
    const idx = new Map();
    sv.forEach((w, i) => { if (!idx.has(w)) idx.set(w, []); idx.get(w).push(i); });
    for (let i = 0; i < rw.length; i++) for (const j of idx.get(rw[i]) || []) {
      let l = 0; while (i + l < rw.length && j + l < sv.length && rw[i + l] === sv[j + l]) l++;
      if (l > run && l >= 4 && !ow.has(rw.slice(i, i + 3).join(' '))) run = l;
    }
  }
  return { rate: g.length ? +(copied.length / g.length).toFixed(4) : 0, run, grams: g.length, copied: [...new Set(copied)].slice(0, 10) };
}

// Порог «пародия / копирование»: см. STATUS.md (раздел «Шаг 7»), считался на парах «пост основателя vs 3 других».
const COPY_THRESHOLD = 0.03; // доля 4-грамм; у разных постов основателя между собой 0–0,2% (22 поста, 3 ближайших), порог в 15 раз выше
const COPY_RUN = 6;          // или общая цепочка из 6+ слов подряд

module.exports = { pickSamples, copyRate, loadPool, cleanSample, COPY_THRESHOLD, COPY_RUN, stems, grams };
