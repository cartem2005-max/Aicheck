'use strict';
// Линтер для бота: подсвеченные места (только counted-правила) и предложения по оформлению (autofix НЕ применяется).
//   lintStep(text, maxPlaces) -> {lint:{score, tooShort, flagged}, highlights:[{rule, quote, reason, whole}], layout:[{rule, before, after}]}
const { lint } = require('./linter');
const { autofix } = require('./autofix');

// обрезка по границе слова: «…» не посреди слова
const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; let c = t.slice(0, n - 1); const i = c.lastIndexOf(' '); if (i >= n * 0.5) c = c.slice(0, i); return c.replace(/[\s,.;:—-]+$/, '') + '…'; };

// до maxPlaces мест: сначала локальные находки (тяжёлые правила первыми, не больше 2 на правило), потом «в целом»
function pickHighlights(findings, text, maxPlaces, allow = []) {
  const al = allow.map((a) => a.toLowerCase().replace(/ё/g, 'е'));
  const allowed = (f) => !f.whole && al.some((a) => a && text.slice(f.start, f.end).toLowerCase().replace(/ё/g, 'е').includes(a));
  const counted = findings.filter((f) => f.counted && !allowed(f));
  const used = {};
  const local = counted.filter((f) => !f.whole)
    .sort((a, b) => b.weight - a.weight || a.start - b.start)
    .filter((f) => { used[f.rule] = (used[f.rule] || 0) + 1; return used[f.rule] <= 2; })
    .slice(0, maxPlaces)
    .sort((a, b) => a.start - b.start);
  const whole = [];
  const seen = {};
  for (const f of counted) if (f.whole && !seen[f.rule]) { seen[f.rule] = 1; whole.push(f); }
  const out = local.map((f) => ({ rule: f.rule, quote: oneLine(text.slice(f.start, f.end), 140), reason: f.explanation, whole: false }));
  for (const f of whole) if (out.length < maxPlaces) out.push({ rule: f.rule, quote: null, reason: f.explanation, whole: true });
  return out;
}

function lintStep(text, maxPlaces = 5, allow = []) {
  const r = lint(text);
  const layout = autofix(text).changes.filter((c) => c.rule !== 'W01')
    .map((c) => ({ rule: c.rule, before: oneLine(c.before, 80), after: oneLine(c.after, 80) }));
  return {
    lint: { score: r.score, tooShort: r.tooShort, flagged: r.flagged },
    // все засчитываемые находки (для прозрачного балла, explain_score.js): позиции и вес, без текста
    lint_findings: r.findings.filter((f) => f.counted).map((f) => ({ rule: f.rule, start: f.start, end: f.end, weight: f.weight, whole: !!f.whole })),
    highlights: pickHighlights(r.findings, text, maxPlaces, allow),
    layout,
  };
}

module.exports = { lintStep, pickHighlights, oneLine };
