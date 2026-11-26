'use strict';
// Переписывание (шаг 7): autofix -> lint -> если балл < порога «чисто» -> LLM-правка (до 2 кругов) -> проверка фактов и длины.
//   rewrite(text, {model, fallback, sourceId, chat, maxRounds, lenTol, threshold}) ->
//   {status: 'clean'|'short'|'fixed'|'human', reason, before, after, score_before, score_after, facts, changes, rounds, cost, model, ...}
// Решения «править или нет» и «получилось или нет» принимает код (линтер и checkFacts), не модель.
const fs = require('fs');
const path = require('path');
const { lint, SCORE_CONFIG } = require('./linter');
const { autofix } = require('./autofix');
const { checkFacts, extractFacts } = require('./facts');
const { stripMarkdown } = require('./clean');
const { pickSamples, copyRate, COPY_THRESHOLD, COPY_RUN, grams } = require('./samples');
const { worn } = require('./worn');
const { parseText, bodyParagraphs } = require('./textparse');
const PROMPT_VERSION = 'v2'; // v1: длина ±15%, концовку не проверяли; v2: концовка проверяется кодом, длина +15% / −25% (удаление призыва или морали укорачивает текст)
const llm = require('./llm');

const PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'rewrite.md'), 'utf8');
const VOICE = fs.readFileSync(path.join(__dirname, 'prompts', 'voice.md'), 'utf8').trim();
const [SYSTEM_T, USER_T] = PROMPT.split('---USER---');

const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));

// Ответ модели -> чистый текст поста + список правок. Теги <правки> вырезаются (в том числе незакрытый).
function parseReply(raw) {
  let changes = '';
  let t = raw.replace(/<правки>([\s\S]*?)(<\/правки>|$)/i, (_, c) => { changes = c.trim(); return ''; });
  t = t.replace(/<\/?правки>/gi, '');
  t = stripMarkdown(t.trim());
  t = t.replace(/^(вот|ниже)[^\n]{0,60}:\s*\n+/i, '').trim(); // «Вот правленый текст:» на всякий случай
  return { text: t, changes };
}

// длины абзацев в словах — для правила D04 (складность): модели нужна конкретика, а не «сделай неровнее»
function paragraphWords(text) {
  return bodyParagraphs(parseText(text)).map((p) => p.sentences.reduce((a, s) => a + s.words, 0));
}

function describeFindings(r, limit = 12, text = '') {
  const seen = new Set();
  const lines = [];
  for (const f of r.findings) {
    if (!f.counted) continue;
    const key = f.rule + '|' + f.text;
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = f.whole ? '(весь текст' + (f.value !== undefined ? `, значение ${f.value}` : '') + ')' : '«' + f.text.replace(/\s+/g, ' ').slice(0, 160) + '»';
    let extra = '';
    if (f.rule === 'D04' && text) {
      const pw = paragraphWords(text);
      extra = ` Сейчас абзацев ${pw.length}, слов в них: ${pw.join(', ')}. Обязательно измени разбивку: слей два соседних абзаца в один длинный и выдели одну короткую мысль (до 8 слов) в отдельный абзац, чтобы самый длинный был минимум втрое длиннее самого короткого.`;
    }
    lines.push(`- ${f.rule} ${quote}: ${f.explanation} Как исправить: ${f.fix}${extra}`);
    if (lines.length >= limit) break;
  }
  return lines.join('\n') || '- (отдельных мест нет, правь по карточке голоса)';
}

const factList = (text) => extractFacts(text).map((f) => `- ${f.value}`).join('\n') || '- (нет)';

function buildMessages(cur, orig, lr, samples, threshold) {
  const L = orig.length;
  const vars = {
    VOICE, SCORE: lr.score, THRESHOLD: threshold, FINDINGS: describeFindings(lr, 12, cur),
    FACTS: factList(orig), LEN: cur.length, LEN_MIN: Math.round(L * 0.75), LEN_MAX: Math.round(L * 1.15),
    SAMPLES: samples.map((s, i) => `Образец ${i + 1}:\n${s.text}`).join('\n\n———\n\n'), TEXT: cur,
  };
  return [{ role: 'system', content: fill(SYSTEM_T, vars).trim() }, { role: 'user', content: fill(USER_T, vars).trim() }];
}

// Концовка: предложения последнего абзаца, которых нет в черновике. Модели обходят правила B06/B09 (их смотрят только в последнем
// абзаце), дописывая в конец «нейтральную» фразу — часто с выдуманным утверждением. Новую концовку считаем ошибкой и просим убрать.
function newEnding(orig, cand) {
  const body = bodyParagraphs(parseText(cand));
  const last = body[body.length - 1];
  if (!last) return [];
  return last.sentences.filter((s) => {
    if (s.words < 3) return false;
    const n = s.words >= 5 ? 3 : 2;
    const g = grams(s.text, n);
    if (!g.length) return false;
    const have = new Set(grams(orig, n));
    return g.filter((x) => have.has(x)).length / g.length < 0.5;
  }).map((s) => s.text.trim());
}

function problems(orig, cand, lenTol, lenDown = lenTol) {
  const facts = checkFacts(orig, cand);
  const ratio = cand.length / orig.length;
  const lenOk = ratio <= 1 + lenTol && ratio >= 1 - lenDown;
  const parts = [];
  if (facts.missing.length) parts.push('Потеряно (вернуть дословно): ' + facts.missing.map((m) => m.value).join('; '));
  if (facts.added.length) parts.push('Добавлено лишнее (убрать): ' + facts.added.map((m) => m.value).join('; '));
  if (!lenOk) parts.push(`Длина ${cand.length} знаков, нужно ${Math.round(orig.length * (1 - lenDown))}–${Math.round(orig.length * (1 + lenTol))}.`);
  const ending = newEnding(orig, cand);
  if (ending.length) parts.push('В последнем абзаце есть предложения, которых нет в черновике (удали их, ничего нового в конец не дописывай): ' + ending.map((e) => '«' + e + '»').join(' '));
  return { facts, lenOk, ratio, ending, ok: facts.ok && lenOk && !ending.length, message: parts.join('\n') };
}

async function rewrite(text, opts = {}) {
  const { model = 'claude-sonnet-5-5', fallback, sourceId = null, maxRounds = 2, lenTol = 0.15, lenDown = 0.25, maxTokens = 3000 } = opts;
  const chat = opts.chat || llm.chat;
  const threshold = opts.threshold ?? SCORE_CONFIG.threshold;
  const lintOpts = { config: { threshold } };
  const out = { prompt_version: PROMPT_VERSION, status: null, reason: null, before: text, after: text, model, cost: 0, rounds: [], changes: '', calls: 0 };

  const l0 = lint(text, lintOpts);
  out.score_before = l0.score;
  if (l0.tooShort) { out.status = 'short'; out.score_after = null; out.facts = null; return out; }

  // 1. механика кодом
  const af = autofix(text);
  out.autofix = af.changes;
  let cur = af.text;
  let lr = lint(cur, lintOpts);
  out.score_autofix = lr.score;
  out.after = cur;
  out.score_after = lr.score;
  out.facts = checkFacts(text, cur);
  if (lr.score < threshold) { out.status = 'clean'; out.reason = af.changes.length ? 'autofix' : 'below_threshold'; return out; }

  // 2. LLM-круги
  const samples = pickSamples(text, { excludeId: sourceId });
  out.samples = samples.map((s) => ({ id: s.id, score: s.score }));
  for (let round = 1; round <= maxRounds; round++) {
    const rr = { round, score_in: lr.score, retried: false };
    const messages = buildMessages(cur, text, lr, samples, threshold);
    let res = await chat({ model, fallback, messages, max_tokens: maxTokens, tag: opts.tag || 'rewrite' });
    out.cost += res.cost; out.calls++; out.model = res.model;
    let parsed = parseReply(res.text);
    let cand = autofix(parsed.text).text;
    let pr = problems(text, cand, lenTol, lenDown);
    rr.facts_first_ok = pr.facts.ok; rr.len_first_ok = pr.lenOk;
    if (!pr.ok) {
      rr.retried = true; rr.problems = pr.message;
      const retry = messages.concat([{ role: 'assistant', content: res.text },
        { role: 'user', content: 'В твоей версии есть ошибки.\n' + pr.message + '\nИсправь только это, остальные правки сохрани. Верни весь текст целиком и блок <правки>.' }]);
      res = await chat({ model, fallback, messages: retry, max_tokens: maxTokens, tag: (opts.tag || 'rewrite') + '_retry' });
      out.cost += res.cost; out.calls++; out.model = res.model;
      parsed = parseReply(res.text);
      cand = autofix(parsed.text).text;
      pr = problems(text, cand, lenTol, lenDown);
    }
    rr.facts_ok = pr.facts.ok; rr.len_ratio = +pr.ratio.toFixed(3);
    const l = lint(cand, lintOpts);
    rr.score = l.score; rr.chars = cand.length;
    out.rounds.push(rr);
    out.after = cand; out.score_after = l.score; out.facts = pr.facts; out.changes = parsed.changes;
    if (!pr.ok) { out.status = 'human'; out.reason = !pr.facts.ok ? 'facts' : !pr.lenOk ? 'length' : 'ending'; break; }
    if (l.score !== null && l.score < threshold) { out.status = 'fixed'; break; }
    cur = cand; lr = l;
  }
  if (!out.status) { out.status = 'human'; out.reason = 'score'; }

  // 3. копирование образцов и заезженные фразы
  out.copy = copyRate(out.after, text, samples);
  out.copy.flag = out.copy.rate >= COPY_THRESHOLD || out.copy.run >= COPY_RUN;
  out.worn = worn(out.after, text);
  out.length_change = +(out.after.length / text.length - 1).toFixed(3);
  out.cost = +out.cost.toFixed(6);
  return out;
}

module.exports = { newEnding, rewrite, parseReply, describeFindings, buildMessages, problems };
