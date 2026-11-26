'use strict';
// Базовый уровень (г): простой вопрос модели «этот текст написан нейросетью? 0–100» без чек-листа (шаг 8).
// Оценщик — claude-sonnet-5-5, effort low. Сравнивается с линтером (балл при том же наборе текстов, ≥400 знаков).
//   node eval/baseline_ai.js   -> dev: 120 AI + 24 founder + 30 editorial; пишет eval/results/baseline_dev.md/json
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { lint, SCORE_CONFIG } = require('../src/linter');

const RES = path.join(__dirname, 'results');
const CACHE = process.env.KAN_CACHE_DIR || path.join(RES, 'cache');
const JUDGE = 'claude-sonnet-5-5';
const SYSTEM = 'Ты эксперт по определению текстов, написанных нейросетью. Тебе дают пост для Telegram-канала сервиса аналитики для селлеров маркетплейсов.';
const USER = (t) => `${t}\n\n————\n\nЭтот текст написан нейросетью? Ответь числом от 0 до 100 (0 — точно человек, 100 — точно нейросеть). Формат ответа строго: «Оценка: N», без пояснений.`;

async function askAI(text, tag) {
  const res = await llm.chat({ model: JUDGE, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER(text.replace(/\s*@\w+\s*$/, '').trim()) }], max_tokens: 400, tag });
  const m = res.text.match(/Оценка:\s*(\d{1,3})/i) || res.text.match(/\b(\d{1,3})\b/);
  return { ai_score: m ? Math.min(100, Number(m[1])) : null, cost: res.cost };
}

// items: [{key, text}] -> [{key, ai_score}] с кэшем
async function scoreAll(name, items, conc = 4) {
  const file = path.join(CACHE, name + '.json');
  fs.mkdirSync(CACHE, { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет кэша */ }
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      if (cache[it.key]) continue;
      try { cache[it.key] = await askAI(it.text, 'base_' + name); fs.writeFileSync(file, JSON.stringify(cache)); }
      catch (e) { console.log('ОШИБКА', it.key, e.message); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return items.map((it) => ({ ...it, ai_score: cache[it.key] ? cache[it.key].ai_score : null }));
}

function auc(pos, neg) {
  const p = pos.filter((s) => s !== null && s !== undefined), n = neg.filter((s) => s !== null && s !== undefined);
  let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0;
  return p.length && n.length ? +(w / (p.length * n.length)).toFixed(3) : null;
}
// наименьший порог t (флаг: балл >= t), при котором ложных на negatives не больше maxFpr; возвращает {t, fpr, tpr}
function thresholdAtFpr(posS, negS, maxFpr = 0.15) {
  const p = posS.filter((s) => s !== null), n = negS.filter((s) => s !== null);
  const cand = [...new Set([...p, ...n, 101])].sort((a, b) => a - b);
  for (const t of cand) {
    const fp = n.filter((s) => s >= t).length;
    if (fp / n.length <= maxFpr) return { t, fp, fpr: +(fp / n.length).toFixed(3), tp: p.filter((s) => s >= t).length, tpr: +(p.filter((s) => s >= t).length / p.length).toFixed(3), n_pos: p.length, n_neg: n.length };
  }
  return null;
}
const lintScore = (t) => lint(t).score;

module.exports = { JUDGE, askAI, scoreAll, auc, thresholdAtFpr, lintScore, SCORE_CONFIG };

if (require.main === module) (async () => {
  const t0 = llm.readCost().total_usd;
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8'));
  const voice = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'voice_dev.json'), 'utf8')).labels;
  const ai = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ai_posts.json'), 'utf8')).map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev');
  const items = [
    ...ai.map((x) => ({ key: 'ai' + x.idx, kind: 'ai', prompt: x.prompt_type, model: x.model, text: x.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'founder' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'founder', text: p.text })),
    ...posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 400).map((p) => ({ key: 'p' + p.id, kind: 'editorial', text: p.text })),
  ];
  const rs = await scoreAll('baseline_dev', items);
  for (const r of rs) r.lint = lintScore(r.text);
  const sel = (f) => rs.filter(f);
  const long = (r) => r.text.length >= 400;
  const A = sel((r) => r.kind === 'ai' && long(r)), F = sel((r) => r.kind === 'founder'), E = sel((r) => r.kind === 'editorial');
  const col = (l, k) => l.map((r) => r[k]);
  const res = {};
  for (const [name, key, thr] of [['baseline', 'ai_score', null], ['linter', 'lint', SCORE_CONFIG.threshold]]) {
    const o = {
      auc_all: auc(col(A, key), col(F, key)),
      auc_naive: auc(col(A.filter((r) => r.prompt === 'naive'), key), col(F, key)),
      auc_human: auc(col(A.filter((r) => r.prompt === 'human'), key), col(F, key)),
      auc_vs_editorial: auc(col(A, key), col(E, key)),
      at_fpr15: thresholdAtFpr(col(A, key), col(F, key), 0.15),
    };
    if (thr !== null) o.at_fixed_threshold = thresholdAtFpr(col(A, key), col(F, key), 1) && (() => { const fp = F.filter((r) => r[key] >= thr).length, tp = A.filter((r) => r[key] >= thr).length; return { t: thr, fp, n_neg: F.length, tp, n_pos: A.length, editorial_flagged: E.filter((r) => r[key] >= thr).length, n_editorial: E.length }; })();
    const t = (o.at_fpr15 || {}).t;
    if (t !== undefined) {
      o.by_prompt = Object.fromEntries(['naive', 'human'].map((p) => [p, A.filter((r) => r.prompt === p && r[key] >= t).length + '/' + A.filter((r) => r.prompt === p).length]));
      o.editorial_flagged_at_t = E.filter((r) => r[key] >= t).length + '/' + E.length;
    }
    res[name] = o;
  }
  res.baseline_means = { ai: +(col(A, 'ai_score').reduce((s, x) => s + x, 0) / A.length).toFixed(1), founder: +(col(F, 'ai_score').reduce((s, x) => s + x, 0) / F.length).toFixed(1), editorial: +(col(E, 'ai_score').reduce((s, x) => s + x, 0) / E.length).toFixed(1) };
  res.unanswered = rs.filter((r) => r.ai_score === null).length;
  res.n = { ai_ge400: A.length, ai_all: ai.length, founder: F.length, editorial: E.length };
  res.spent_usd = +(llm.readCost().total_usd - t0).toFixed(4);
  res.judge = JUDGE;
  fs.writeFileSync(path.join(RES, 'baseline_dev.json'), JSON.stringify({ summary: res, rows: rs.map(({ text, ...r }) => r) }, null, 1));
  const f = (o) => (o ? `порог ${o.t}: пойман AI ${o.tp}/${o.n_pos} (${(100 * o.tpr).toFixed(1)}%), ложных на founder ${o.fp}/${o.n_neg} (${(100 * o.fpr).toFixed(1)}%)` : '-');
  const md = `# Базовый уровень (г) против линтера на dev (шаг 8)

Оценщик ${JUDGE}, вопрос «Этот текст написан нейросетью? Ответь числом от 0 до 100» без чек-листа. Выборка: AI-тексты dev от 400 знаков (${res.n.ai_ge400} из ${res.n.ai_all}), founder ${res.n.founder}, editorial ${res.n.editorial}. Без ответа: ${res.unanswered}.

| метрика | простой вопрос (г) | линтер (порог 15) |
|---|---|---|
| AUC: AI против founder | ${res.baseline.auc_all} | ${res.linter.auc_all} |
| AUC naive | ${res.baseline.auc_naive} | ${res.linter.auc_naive} |
| AUC human | ${res.baseline.auc_human} | ${res.linter.auc_human} |
| AUC: AI против editorial | ${res.baseline.auc_vs_editorial} | ${res.linter.auc_vs_editorial} |
| при ложных на founder ≤15% | ${f(res.baseline.at_fpr15)} | ${f(res.linter.at_fpr15)} |
| naive / human пойманы (при этом пороге) | ${JSON.stringify(res.baseline.by_prompt)} | ${JSON.stringify(res.linter.by_prompt)} |
| editorial отмечено (при этом пороге) | ${res.baseline.editorial_flagged_at_t} | ${res.linter.editorial_flagged_at_t} |

Линтер при фиксированном пороге ${SCORE_CONFIG.threshold}: пойман AI ${res.linter.at_fixed_threshold.tp}/${res.linter.at_fixed_threshold.n_pos}, ложных на founder ${res.linter.at_fixed_threshold.fp}/${res.linter.at_fixed_threshold.n_neg}, editorial отмечено ${res.linter.at_fixed_threshold.editorial_flagged}/${res.linter.at_fixed_threshold.n_editorial}.
Средняя оценка «это AI»: AI ${res.baseline_means.ai}, founder ${res.baseline_means.founder}, editorial ${res.baseline_means.editorial}.
Оговорки: порог линтера подобран на этих же dev-текстах, порог простого вопроса выбирается тут же по тем же founder-постам — оба оптимистичны одинаково. Расход ${res.spent_usd} $.
`;
  fs.writeFileSync(path.join(RES, 'baseline_dev.md'), md);
  console.log(md);
})();
