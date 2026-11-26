'use strict';
// Step 6: tuning on DEV only (120 AI texts vs 60 dev channel posts). No LLM, no network. Test posts are never read.
// Run: node eval/tune.js           -> prints tables, writes eval/results/tune_dev.{md,json}
//      node eval/tune.js --write   -> also writes weights / counted:false + dropped_reason into src/rules.json
// Selection (PLAN section 5): a rule stays if AI-rate >= 2 x founder-rate and it fires in >= 5 AI texts.
// Weight 1/2/3 by strength of the difference (weightFor). C04/C05/D02/D03 are near-duplicates: at most two survive.
const fs = require('fs');
const path = require('path');
const { lint, SCORE_CONFIG } = require('../src/linter');

const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const WRITE = process.argv.includes('--write');
const MIN_AI = 5, MIN_RATIO = 2, MAX_FOUNDER_FPR = 0.15, NAIVE_AUC_GOAL = 0.85;
const DUP_GROUP = ['C04', 'C05', 'D02', 'D03'], DUP_KEEP = 2;

const posts = read('data/posts.json'), voice = read('data/voice_dev.json').labels;
const rulesAll = read('src/rules.json');
const ai = read('data/ai_posts.json').filter(x => x.split === 'dev');           // dev ONLY
const channel = posts.filter(p => voice[p.id]).map(p => ({ id: p.id, text: p.text, label: voice[p.id].label }));
const founder = channel.filter(p => p.label === 'founder'), editorial = channel.filter(p => p.label === 'editorial');
const MODELS = [...new Set(ai.map(x => x.model))].sort();

// lint everything once with the rules as they are; here only "which rules fired" matters (counted or not)
const A = ai.map(x => ({ ...x, r: lint(x.text) }));
const F = founder.map(x => ({ ...x, r: lint(x.text) })), E = editorial.map(x => ({ ...x, r: lint(x.text) }));
const fired = (item, id) => item.r.findings.some(f => f.rule === id);
const cnt = (list, id) => list.filter(x => fired(x, id)).length;
const pct = (n, d) => d ? Math.round(1000 * n / d) / 10 : 0;

const candidates = rulesAll.filter(r => r.group !== 'E');
const sub = pred => A.filter(pred);
const rows = rulesAll.map(r => {
  const nv = sub(x => x.prompt_type === 'naive'), hm = sub(x => x.prompt_type === 'human');
  const row = { id: r.id, group: r.group,
    ai_n: cnt(A, r.id), ai_pct: pct(cnt(A, r.id), A.length),
    naive_pct: pct(cnt(nv, r.id), nv.length), human_pct: pct(cnt(hm, r.id), hm.length),
    by_model: {}, founder_n: cnt(F, r.id), founder_pct: pct(cnt(F, r.id), F.length),
    editorial_n: cnt(E, r.id), editorial_pct: pct(cnt(E, r.id), E.length) };
  for (const m of MODELS) { const s = sub(x => x.model === m); row.by_model[m] = pct(cnt(s, r.id), s.length); }
  // ratio with a floor on the founder rate (0 of 24 is not "infinitely" different): floor = 0.5 post out of 24
  const fr = Math.max(row.founder_n, 0.5) / F.length;
  row.ratio = Math.round(100 * (row.ai_n / A.length) / fr) / 100;
  return row;
});
const byId = Object.fromEntries(rows.map(r => [r.id, r]));

// weight by strength: ratio >= 6 -> 3, >= 3.5 -> 2, else 1 (ratio is already >= 2 for kept rules)
const weightFor = row => row.ratio >= 6 ? 3 : row.ratio >= 3.5 ? 2 : 1;
for (const r of candidates) {
  const row = byId[r.id];
  if (row.ai_n < MIN_AI) { row.keep = false; row.reason = `срабатывает только в ${row.ai_n} AI-текстах из ${A.length} (нужно ≥${MIN_AI})`; }
  else if (row.ratio < MIN_RATIO) { row.keep = false; row.reason = `AI ${row.ai_pct}% против founder ${row.founder_pct}% — отношение ${row.ratio} < ${MIN_RATIO}`; }
  else row.keep = true;
}
const dupKept = DUP_GROUP.filter(id => byId[id] && byId[id].keep).sort((a, b) => byId[b].ratio - byId[a].ratio || byId[b].ai_pct - byId[a].ai_pct);
for (const id of dupKept.slice(DUP_KEEP)) { byId[id].keep = false; byId[id].reason = `дублирует более сильные правила группы C04/C05/D02/D03 (оставлено максимум ${DUP_KEEP}), отношение ${byId[id].ratio}`; }
for (const r of candidates) if (byId[r.id].keep) byId[r.id].weight = weightFor(byId[r.id]);

const finalRules = rulesAll.map(r => {
  if (r.group === 'E') return r;
  const row = byId[r.id], out = { ...r };
  delete out.dropped_reason;
  if (row.keep) { out.weight = row.weight; delete out.counted; }
  else { out.counted = false; out.dropped_reason = row.reason; }
  return out;
});

// score of each text with the final rules; AUC; threshold
const cfg = { ...SCORE_CONFIG };
const scored = list => list.map(x => ({ ...x, score: lint(x.text, { rules: finalRules, config: cfg }).score }));
function auc(pos, neg) { // P(pos > neg) + 0.5 P(=); too-short texts (score null) are excluded
  const p = pos.filter(s => s !== null), n = neg.filter(s => s !== null);
  let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0;
  return p.length && n.length ? w / (p.length * n.length) : NaN;
}
const sA = scored(A), sF = scored(F), sE = scored(E);
const sc = l => l.map(x => x.score);
const maxFalse = Math.floor(MAX_FOUNDER_FPR * sF.filter(x => x.score !== null).length);
let threshold = 100;
for (let t = 1; t <= 100; t++) { if (sF.filter(x => x.score !== null && x.score >= t).length <= maxFalse) { threshold = t; break; } }
// margin: if the founder false-positive count does not change, move the threshold up by MARGIN points (a founder post scoring right below the line is luck)
const MARGIN = 3, falseAt = t => sF.filter(x => x.score !== null && x.score >= t).length;
const thresholdMin = threshold;
if (falseAt(threshold + MARGIN) === falseAt(threshold)) threshold += MARGIN;
const share = (list, t) => { const l = list.filter(x => x.score !== null); const n = l.filter(x => x.score >= t).length; return { n, of: l.length, pct: pct(n, l.length) }; };
const caught = t => ({
  all: share(sA, t),
  naive: share(sA.filter(x => x.prompt_type === 'naive'), t),
  human: share(sA.filter(x => x.prompt_type === 'human'), t),
  by_model: Object.fromEntries(MODELS.map(m => [m, share(sA.filter(x => x.model === m), t)])),
  founder_false: share(sF, t), editorial_flagged: share(sE, t)
});
const thresholdCurve = [];
for (let t = 5; t <= 60; t += 5) { const c = caught(t); thresholdCurve.push({ t, ai_pct: c.all.pct, naive_pct: c.naive.pct, human_pct: c.human.pct, founder_pct: c.founder_false.pct, editorial_pct: c.editorial_flagged.pct }); }
const aucs = {
  all_vs_founder: auc(sc(sA), sc(sF)),
  naive_vs_founder: auc(sc(sA.filter(x => x.prompt_type === 'naive')), sc(sF)),
  human_vs_founder: auc(sc(sA.filter(x => x.prompt_type === 'human')), sc(sF)),
  all_vs_editorial: auc(sc(sA), sc(sE)),
  editorial_vs_founder: auc(sc(sE), sc(sF))
};
for (const m of MODELS) aucs['model_' + m + '_vs_founder'] = auc(sc(sA.filter(x => x.model === m)), sc(sF));

// ---- proposals: cheap regex candidates mined on dev (NOT in rules.json, not in the score). For the "what to add" list.
const PROPOSALS = [
  ['контраст «…, а не …»', /[,—–] а не /i],
  ['«Если у вас / вы / вам»', /если (?:у вас|вы|вам)/i],
  ['«видно / заметно»', /видно|заметно|заметн/i],
  ['«Хотите …»', /хотите/i],
  ['«в комментариях»', /в комментариях/i],
  ['«не нужно / не придётся / не надо»', /не (?:нужно|придется|надо)/i],
  ['«обычно»', /обычно/i],
  ['«тем / тех, кто»', /(?:тем|тех), кто/i],
  ['начало предложения «Так …»', /(?:^|[.!?\n]\s*)так (?!как|что)/i],
  ['строки списка с «;» в конце', /;\s*\n/],
  ['нет ни «!», ни «?», ни «…», ни «:», ни «;», ни «))»', null]
];
const noPunct = t => !/[!?…:;]|\.\.\.|\)\)/.test(t);
const prop = PROPOSALS.map(([name, re]) => {
  const test = re ? (t => re.test(t.replace(/ё/g, 'е'))) : noPunct;
  const n = l => l.filter(x => test(x.text)).length;
  const nv = A.filter(x => x.prompt_type === 'naive'), hm = A.filter(x => x.prompt_type === 'human');
  return { name, naive: n(nv), naive_of: nv.length, human: n(hm), human_of: hm.length, founder: n(F), founder_of: F.length, editorial: n(E), editorial_of: E.length };
});

const result = {
  _doc: 'DEV only. 120 AI texts (Claude Haiku/Sonnet/Opus 5.5 x naive/human) vs founder 24 / editorial 30 dev posts (voice_dev.json). Rule fires = at least one finding.',
  n: { ai: A.length, founder: F.length, editorial: E.length, ai_too_short: sA.filter(x => x.score === null).length },
  criteria: { min_ai_texts: MIN_AI, min_ratio: MIN_RATIO, founder_fpr_limit: MAX_FOUNDER_FPR, note: 'founder rate floored at 0.5 post when computing the ratio' },
  proposals: prop, rows, config: cfg, threshold, threshold_min: thresholdMin, caught: caught(threshold), thresholdCurve, auc: aucs,
  kept: rows.filter(r => r.keep).map(r => ({ id: r.id, weight: r.weight })),
  dropped: rows.filter(r => r.keep === false).map(r => ({ id: r.id, reason: r.reason })),
  score_dist: { founder: sc(sF).sort((a, b) => a - b), editorial: sc(sE).sort((a, b) => a - b),
    ai_naive: sc(sA.filter(x => x.prompt_type === 'naive')).sort((a, b) => a - b), ai_human: sc(sA.filter(x => x.prompt_type === 'human')).sort((a, b) => a - b) }
};

const f3 = x => (Number.isNaN(x) ? 'н/д' : x.toFixed(3));
let md = `# Настройка на dev (шаг 6)\n\nТолько dev: ${A.length} AI-текстов (Claude Haiku/Sonnet/Opus 5.5 × промпты naive/human) против ${F.length} постов founder и ${E.length} editorial. Test не открывался.\nПравило срабатывает, если нашлась хотя бы одна находка. Отбор: в AI минимум вдвое чаще, чем у founder (у founder минимум 0,5 поста из ${F.length}), и минимум в ${MIN_AI} AI-текстах; C04/C05/D02/D03 — максимум два.\n\n`;
md += `## Таблица правил (доля текстов, где сработало, %; в скобках число текстов)\n\n| правило | AI всего | naive | human | ${MODELS.join(' | ')} | founder | editorial | отн. | решение |\n|---|---|---|---|${MODELS.map(() => '---').join('|')}|---|---|---|---|\n`;
for (const r of rows) {
  const dec = r.group === 'E' ? 'не в балле (E)' : r.keep ? `вес ${r.weight}` : 'отброшено';
  md += `| ${r.id} | ${r.ai_pct} (${r.ai_n}) | ${r.naive_pct} | ${r.human_pct} | ${MODELS.map(m => r.by_model[m]).join(' | ')} | ${r.founder_pct} (${r.founder_n}) | ${r.editorial_pct} (${r.editorial_n}) | ${r.ratio} | ${dec} |\n`;
}
md += `\n## Отброшенные правила (остались в rules.json с counted:false)\n\n${result.dropped.map(d => `- **${d.id}** — ${d.reason}`).join('\n')}\n`;
const c = result.caught;
md += `\n## Порог\n\nФормула: сумма весов (не больше ${cfg.maxPerRule} находок на правило) на 1 000 знаков / scale ${cfg.scale} × 100, потолок 100. Порог — наименьший, при котором ложных на founder dev не больше 15% (до ${maxFalse} из ${c.founder_false.of}): ${thresholdMin}; плюс запас ${MARGIN}, если число ложных не растёт (на самом краю стоит пост founder): **${threshold}**.\n\n`;
md += `- ложные на founder: ${c.founder_false.n} из ${c.founder_false.of} (${c.founder_false.pct}%)\n- editorial отмечено (не ошибки, отдельно): ${c.editorial_flagged.n} из ${c.editorial_flagged.of} (${c.editorial_flagged.pct}%)\n- пойманные AI: ${c.all.n} из ${c.all.of} (${c.all.pct}%); naive ${c.naive.n}/${c.naive.of} (${c.naive.pct}%); human ${c.human.n}/${c.human.of} (${c.human.pct}%)\n- по модели: ${MODELS.map(m => `${m} ${c.by_model[m].n}/${c.by_model[m].of} (${c.by_model[m].pct}%)`).join('; ')}\n`;
md += `\n| порог | AI всего % | naive % | human % | founder ложных % | editorial % |\n|---|---|---|---|---|---|\n${thresholdCurve.map(t => `| ${t.t} | ${t.ai_pct} | ${t.naive_pct} | ${t.human_pct} | ${t.founder_pct} | ${t.editorial_pct} |`).join('\n')}\n`;
md += `\n## AUC балла (dev; веса и порог подобраны на тех же данных, цифры оптимистичны)\n\n${Object.entries(aucs).map(([k, v]) => `- ${k}: ${f3(v)}`).join('\n')}\n`;
if (aucs.naive_vs_founder < NAIVE_AUC_GOAL) md += `\n**AUC на naive ${f3(aucs.naive_vs_founder)} < ${NAIVE_AUC_GOAL}** — контрольная точка плана не пройдена, см. STATUS.md (раздел «Шаг 6»).\n`;
md += `\nБаллы по возрастанию:\n- founder: ${result.score_dist.founder.join(' ')}\n- editorial: ${result.score_dist.editorial.join(' ')}\n- AI naive: ${result.score_dist.ai_naive.join(' ')}\n- AI human: ${result.score_dist.ai_human.join(' ')}\n`;
md += `
## Кандидаты в новые правила (на dev найдены регулярками, в rules.json не добавлены)

| признак | AI naive | AI human | founder | editorial |
|---|---|---|---|---|
${prop.map(p => `| ${p.name} | ${p.naive}/${p.naive_of} | ${p.human}/${p.human_of} | ${p.founder}/${p.founder_of} | ${p.editorial}/${p.editorial_of} |`).join('\n')}
`;
fs.mkdirSync(path.join(root, 'eval/results'), { recursive: true });
fs.writeFileSync(path.join(root, 'eval/results/tune_dev.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(root, 'eval/results/tune_dev.md'), md);
if (WRITE) {
  const lp = path.join(root, 'src/linter.js');
  fs.writeFileSync(lp, fs.readFileSync(lp, 'utf8').replace(/threshold: [0-9]+/, 'threshold: ' + threshold));
  fs.writeFileSync(path.join(root, 'src/rules.json'), '[\n  ' + finalRules.map(r => JSON.stringify(r)).join(',\n  ') + '\n]\n');
  console.log('src/rules.json обновлён\n');
}
console.log(md);
