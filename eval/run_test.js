'use strict';
// Шаг 8, C1: линтер и базовый уровень (г) на test (72 AI + 36 постов канала). Запуск ОДИН раз после eval/FROZEN.md.
//   node eval/run_test.js [--split test]   (--split dev — репетиция конвейера; LLM_MOCK=1 KAN_OUT_DIR=<tmp> KAN_CACHE_DIR=<tmp> — без денег)
// Пишет eval/results/test_detect.md/json.
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { lint, SCORE_CONFIG } = require('../src/linter');
const { scoreAll, auc, thresholdAtFpr } = require('./baseline_ai');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.KAN_OUT_DIR || path.join(__dirname, 'results');
const args = process.argv.slice(2);
const SPLIT = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'test';
const THR = SCORE_CONFIG.threshold;
const BASELINE_THR = 30; // порог простого вопроса, выбранный на dev (baseline_dev.json): ложных на founder ≤15%
const DEMO = [1059, 960, 910];
const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : null);

function loadSet(split) {
  const posts = rd('data/posts.json'), sp = rd('data/split.json').split;
  const ai = rd('data/ai_posts.json').map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === split);
  const ch = posts.filter((p) => sp[p.id] === split && p.text.length >= 400);
  return { ai, ch };
}

function brief(r, n = 6) {
  const seen = new Set(), out = [];
  for (const f of r.findings) {
    if (!f.counted) continue;
    const k = f.rule + '|' + f.text; if (seen.has(k)) continue; seen.add(k);
    out.push(`${f.rule}${f.whole ? '' : ' «' + f.text.replace(/\s+/g, ' ').slice(0, 50) + '»'}`);
    if (out.length >= n) break;
  }
  return out.join('; ');
}

module.exports = { loadSet, brief, rd, DEMO, BASELINE_THR };

if (require.main === module) (async () => {
  const t0 = llm.readCost().total_usd;
  const { ai, ch } = loadSet(SPLIT);
  const A = ai.map((x) => { const r = lint(x.text); return { key: 'ai' + x.idx, kind: 'ai', idx: x.idx, model: x.model, prompt: x.prompt_type, len: x.text.length, text: x.text, lint: r.score, r }; });
  const C = ch.map((p) => { const r = lint(p.text); return { key: 'p' + p.id, kind: 'channel', id: p.id, len: p.text.length, text: p.text, lint: r.score, r }; });
  const bs = await scoreAll('baseline_' + SPLIT, [...A, ...C].map((x) => ({ key: x.key, text: x.text })));
  const bmap = Object.fromEntries(bs.map((b) => [b.key, b.ai_score]));
  for (const x of [...A, ...C]) x.base = bmap[x.key];

  const C33 = C.filter((x) => !DEMO.includes(x.id));
  const scored = (l) => l.filter((x) => x.lint !== null);
  const cut = (l, f) => { const s = scored(l).filter(f); const k = s.filter((x) => x.lint >= THR).length; return { caught: k, of: s.length, pct: pct(k, s.length) }; };
  const col = (l, k) => l.map((x) => x[k]);
  const lintD = {
    threshold: THR,
    n_ai: A.length, n_ai_scored: scored(A).length, n_ai_short: A.length - scored(A).length,
    auc_all_vs_36: auc(col(A, 'lint'), col(C, 'lint')), auc_all_vs_33: auc(col(A, 'lint'), col(C33, 'lint')),
    auc_naive_vs_36: auc(col(A.filter((x) => x.prompt === 'naive'), 'lint'), col(C, 'lint')),
    auc_human_vs_36: auc(col(A.filter((x) => x.prompt === 'human'), 'lint'), col(C, 'lint')),
    caught_all: cut(A, () => true), caught_naive: cut(A, (x) => x.prompt === 'naive'), caught_human: cut(A, (x) => x.prompt === 'human'),
    by_model: Object.fromEntries([...new Set(A.map((x) => x.model))].sort().map((m) => [m, cut(A, (x) => x.model === m)])),
    by_model_prompt: Object.fromEntries([...new Set(A.map((x) => x.model + '/' + x.prompt))].sort().map((m) => [m, cut(A, (x) => x.model + '/' + x.prompt === m)])),
    len_lt600: cut(A, (x) => x.len < 600), len_ge600: cut(A, (x) => x.len >= 600),
    false_36: { flagged: C.filter((x) => x.lint >= THR).length, of: C.length }, false_33: { flagged: C33.filter((x) => x.lint >= THR).length, of: C33.length },
    flagged_posts: C.filter((x) => x.lint >= THR).map((x) => ({ id: x.id, score: x.lint, demo: DEMO.includes(x.id), why: brief(x.r) })),
    channel_scores: C.map((x) => ({ id: x.id, score: x.lint })),
  };
  const bsetA = A, bsetC = C;
  const baseD = {
    judge: require('./baseline_ai').JUDGE, threshold_from_dev: BASELINE_THR,
    auc_all_vs_36: auc(col(bsetA, 'base'), col(bsetC, 'base')), auc_all_vs_33: auc(col(bsetA, 'base'), col(C33, 'base')),
    auc_naive_vs_36: auc(col(A.filter((x) => x.prompt === 'naive'), 'base'), col(C, 'base')),
    auc_human_vs_36: auc(col(A.filter((x) => x.prompt === 'human'), 'base'), col(C, 'base')),
    caught_all: { caught: A.filter((x) => x.base >= BASELINE_THR).length, of: A.length },
    caught_naive: { caught: A.filter((x) => x.prompt === 'naive' && x.base >= BASELINE_THR).length, of: A.filter((x) => x.prompt === 'naive').length },
    caught_human: { caught: A.filter((x) => x.prompt === 'human' && x.base >= BASELINE_THR).length, of: A.filter((x) => x.prompt === 'human').length },
    caught_ge400: { caught: scored(A).filter((x) => x.base >= BASELINE_THR).length, of: scored(A).length },
    false_36: { flagged: C.filter((x) => x.base >= BASELINE_THR).length, of: C.length }, false_33: { flagged: C33.filter((x) => x.base >= BASELINE_THR).length, of: C33.length },
    flagged_posts: C.filter((x) => x.base >= BASELINE_THR).map((x) => ({ id: x.id, ai_score: x.base })),
    own_threshold_at_fpr15_on_36: thresholdAtFpr(col(A, 'base'), col(C, 'base'), 0.15),
    means: { ai: +(col(A, 'base').reduce((s, v) => s + v, 0) / A.length).toFixed(1), channel: +(col(C, 'base').reduce((s, v) => s + v, 0) / C.length).toFixed(1) },
  };
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `test_detect${SPLIT === 'test' ? '' : '_' + SPLIT}.json`), JSON.stringify({ split: SPLIT, linter: lintD, baseline: baseD, spent_usd: spent,
    rows: [...A, ...C].map(({ text, r, ...x }) => x) }, null, 1));

  const cl = (o) => `${o.caught} из ${o.of} (${o.pct ?? pct(o.caught, o.of)}%)`;
  const fl = (o) => `${o.flagged} из ${o.of} (${pct(o.flagged, o.of)}%)`;
  let md = `# Test: обнаружение, линтер против простого вопроса (шаг 8, split ${SPLIT})

Порог линтера ${THR} (заморожен, FROZEN.md). Простой вопрос (г): ${baseD.judge}, «это нейросеть? 0–100», порог ${BASELINE_THR} взят с dev (ложных на founder ≤15%), на test не подгонялся. AI-текстов ${A.length}, из них короче 400 знаков (линтер не оценивает) ${lintD.n_ai_short}. Постов канала ${C.length}, без демо-постов 1059/960/910 — ${C33.length}. На test голос не размечен: «ложные» = все посты канала, в том числе редакторские.

| метрика | линтер | простой вопрос (г) |
|---|---|---|
| AUC: AI против 36 постов канала | ${lintD.auc_all_vs_36} | ${baseD.auc_all_vs_36} |
| AUC: AI против 33 постов (без демо) | ${lintD.auc_all_vs_33} | ${baseD.auc_all_vs_33} |
| AUC naive / human (против 36) | ${lintD.auc_naive_vs_36} / ${lintD.auc_human_vs_36} | ${baseD.auc_naive_vs_36} / ${baseD.auc_human_vs_36} |
| пойман AI, всего (знаменатель — все 72) | ${lintD.caught_all.caught} из ${A.length} (${pct(lintD.caught_all.caught, A.length)}%); среди ≥400 знаков ${cl(lintD.caught_all)} | ${cl(baseD.caught_all)} |
| naive | ${cl(lintD.caught_naive)} | ${cl(baseD.caught_naive)} |
| human | ${cl(lintD.caught_human)} | ${cl(baseD.caught_human)} |
| ложных на постах канала, 36 | ${fl(lintD.false_36)} | ${fl(baseD.false_36)} |
| ложных на постах канала, 33 (без 1059/960/910) | ${fl(lintD.false_33)} | ${fl(baseD.false_33)} |

Разрезы линтера (пойман AI среди оценённых):
- по длине: до 600 знаков — ${cl(lintD.len_lt600)}; от 600 — ${cl(lintD.len_ge600)}
${Object.entries(lintD.by_model).map(([m, v]) => `- модель-генератор ${m}: ${cl(v)}`).join('\n')}
${Object.entries(lintD.by_model_prompt).map(([m, v]) => `- ${m}: ${cl(v)}`).join('\n')}

## Посты канала, которые отметил линтер (балл ≥ ${THR})

Подпись: не знаем, ошибка это или текст с помощью AI.

${lintD.flagged_posts.length ? '| пост | балл | демо-пост | находки |\n|---|---|---|---|\n' + lintD.flagged_posts.map((p) => `| ${p.id} | ${p.score} | ${p.demo ? 'да' : ''} | ${p.why} |`).join('\n') : '(нет)'}

Простой вопрос отметил (≥${BASELINE_THR}): ${baseD.flagged_posts.map((p) => `${p.id} (${p.ai_score})`).join(', ') || 'нет'}.
Средняя оценка «AI» у простого вопроса: AI-тексты ${baseD.means.ai}, посты канала ${baseD.means.channel}. Свой порог простого вопроса на test при ложных ≤15% (для справки, не основной): ${baseD.own_threshold_at_fpr15_on_36 ? `${baseD.own_threshold_at_fpr15_on_36.t}, пойман ${baseD.own_threshold_at_fpr15_on_36.tp}/${baseD.own_threshold_at_fpr15_on_36.n_pos}` : '-'}.
Расход этого запуска: $${spent}.
`;
  fs.writeFileSync(path.join(OUT, `test_detect${SPLIT === 'test' ? '' : '_' + SPLIT}.md`), md);
  console.log(md);
})();
