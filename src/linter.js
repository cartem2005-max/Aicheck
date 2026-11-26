'use strict';
// Linter without LLM: lint(text) -> { score, flagged, tooShort, findings[], metrics }
// Rules live in rules.json (regex "pattern" or a named "metric" detector, see detectors.js).
// Text parsing lives in textparse.js. Positions (start/end) are JS string indices (UTF-16) in the ORIGINAL text.
const { normalize, parseText, bodyParagraphs, computeMetrics } = require('./textparse');
const { DETECTORS, thresholdHits } = require('./detectors');

let DEFAULT_RULES = [];
try { DEFAULT_RULES = require('./rules.json'); } catch (e) { /* n8n build inlines the rules */ }

// Score settings. PLACEHOLDERS: scale/threshold are chosen on dev data (step 6); weights live in rules.json.
//   minLength  - shorter texts are not scored at all (tooShort), the bot answers "слишком коротко для оценки"
//   maxPerRule - one sign repeated 10 times must not give 10 points: at most this many findings per rule are counted
const SCORE_CONFIG = { scale: 10, threshold: 15, minLength: 400, maxPerRule: 2 };
const TOO_SHORT_MESSAGE = 'Слишком коротко для оценки: меньше 400 знаков, надёжно судить нельзя.';

// ---------- score: THE ONLY PLACE where the score is computed ----------
// score = (sum of weights of counted findings per 1000 chars) / scale * 100, capped at 100.
// A finding is counted if its rule is counted (not group E), and only the first maxPerRule findings of each rule.
function computeScore(findings, length, cfg = SCORE_CONFIG) {
  const used = {};
  let total = 0;
  for (const f of findings) {
    if (!f.counted) continue;
    used[f.rule] = (used[f.rule] || 0) + 1;
    if (used[f.rule] <= cfg.maxPerRule) total += f.weight;
  }
  const per1000 = total / (Math.max(length, cfg.minLength) / 1000);
  return Math.min(100, Math.round(100 * per1000 / cfg.scale));
}

function regexHits(rule, ctx) {
  // "raw" rules (emoji, punctuation) match anywhere; word rules must start and end at a word boundary
  // (the usual \b does not work with Cyrillic, so lookbehind / lookahead on letters and digits)
  const src = rule.raw ? rule.pattern : `(?<![\\p{L}\\p{N}])(?:${rule.pattern})(?![\\p{L}\\p{N}])`;
  const re = new RegExp(src, 'giu');
  return [...ctx.norm.matchAll(re)].filter(m => m[0].length).map(m => ({ start: m.index, end: m.index + m[0].length }));
}

function lint(text, options = {}) {
  const rules = options.rules || DEFAULT_RULES;
  const cfg = { ...SCORE_CONFIG, ...(options.config || {}) };
  const paragraphs = parseText(text);
  const body = bodyParagraphs(paragraphs);
  const metrics = computeMetrics(text, body);
  const ctx = { text, norm: normalize(text), paragraphs, body, metrics };
  const findings = [];
  for (const rule of rules) {
    let hits;
    if (rule.pattern) hits = regexHits(rule, ctx);
    else if (rule.op) hits = thresholdHits(rule, ctx);
    else hits = DETECTORS[rule.metric](ctx, rule);
    for (const h of hits) {
      findings.push({ rule: rule.id, group: rule.group, start: h.start, end: h.end, whole: !!h.whole,
        text: h.whole ? '(весь текст)' : text.slice(h.start, h.end), value: h.value,
        weight: rule.weight, counted: rule.counted !== false, explanation: rule.explanation, fix: rule.fix });
    }
  }
  findings.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
  if (text.length < cfg.minLength) {
    return { score: null, flagged: false, tooShort: true, message: TOO_SHORT_MESSAGE, findings, metrics, config: cfg };
  }
  const score = computeScore(findings, text.length, cfg);
  return { score, flagged: score >= cfg.threshold, tooShort: false, findings, metrics, config: cfg };
}

module.exports = { lint, computeScore, SCORE_CONFIG, DEFAULT_RULES };
