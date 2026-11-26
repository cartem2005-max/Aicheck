'use strict';
// Общее для шага 9: оценщик «это нейросеть? 0–100» (промпт дословно из eval/baseline_ai.js) для любой модели, с повторами и кэшем.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('../src/llm');

const RES = path.join(__dirname, 'results');
const CACHE_FILE = path.join(RES, 'cache', 'v3_judge.json');
const SYSTEM = 'Ты эксперт по определению текстов, написанных нейросетью. Тебе дают пост для Telegram-канала сервиса аналитики для селлеров маркетплейсов.';
const USER = (t) => `${t}\n\n————\n\nЭтот текст написан нейросетью? Ответь числом от 0 до 100 (0 — точно человек, 100 — точно нейросеть). Формат ответа строго: «Оценка: N», без пояснений.`;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

let cache = null;
const load = () => { if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; } return cache; };
const save = () => { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); };

let spendCap = null; // абсолютный потолок cost.json для шага
const setCap = (usd) => { spendCap = usd; };
const guard = () => { if (spendCap !== null && llm.readCost().total_usd >= spendCap) throw new Error('потолок шага исчерпан'); };

async function askOnce(model, text, tag) {
  guard();
  const res = await llm.chat({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER(text.replace(/\s*@\w+\s*$/, '').trim()) }], max_tokens: 400, tag });
  const m = res.text.match(/Оценка:\s*(\d{1,3})/i) || res.text.match(/\b(\d{1,3})\b/);
  return m ? Math.min(100, Number(m[1])) : null;
}

// items: [{key, text}], reps: сколько повторов -> Map key -> [score,...]
async function judgeAll(model, items, reps, tag, conc = 4) {
  const c = load();
  const jobs = [];
  for (const it of items) for (let r = 0; r < reps; r++) jobs.push({ it, r, k: `${model}|${sha(it.text)}|${r}` });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (c[j.k] !== undefined && c[j.k] !== null) continue;
      try { c[j.k] = await askOnce(model, j.it.text, tag); save(); }
      catch (e) { console.log('ОШИБКА', j.it.key, e.message); if (/потолок|Бюджет/.test(e.message)) { next = jobs.length; } }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const out = new Map();
  for (const it of items) out.set(it.key, Array.from({ length: reps }, (_, r) => c[`${model}|${sha(it.text)}|${r}`]).filter((x) => x !== undefined && x !== null));
  return out;
}

function auc(pos, neg) {
  let w = 0; for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return pos.length && neg.length ? +(w / (pos.length * neg.length)).toFixed(3) : null;
}

module.exports = { judgeAll, askOnce, sha, mean, std, auc, setCap, SYSTEM, USER, RES };
