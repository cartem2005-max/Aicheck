'use strict';
// Regression tests: node tests/run.js   (exit code 1 if anything fails)
const fs = require('fs');
const path = require('path');
const { lint } = require('../src/linter');
const { extractFacts, checkFacts } = require('../src/facts');
const { stripMarkdown } = require('../src/clean');

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const cases = read('cases.json');
const posts = read('../data/posts.json');
const split = read('../data/split.json').split;
const postText = id => posts.find(p => p.id === id).text;
const rules = read('../src/rules.json');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else { failed++; console.log('FAIL:', name, detail || ''); }
}
const ids = (r) => [...new Set(r.findings.map(f => f.rule))];
const keys = facts => facts.map(f => `${f.type}:${f.value}`);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// 1. every rule: fires on its example, stays quiet on its counter-example
for (const c of cases.rules) {
  check(`${c.rule} срабатывает: ${c.fires.slice(0, 30)}`, ids(lint(c.fires)).includes(c.rule), JSON.stringify(ids(lint(c.fires))));
  check(`${c.rule} молчит: ${c.quiet.slice(0, 30)}`, !ids(lint(c.quiet)).includes(c.rule), JSON.stringify(ids(lint(c.quiet))));
}
for (const r of rules) check(`у правила ${r.id} есть пример`, cases.rules.some(c => c.rule === r.id));

// 2. every finding's positions must point at its text in the original (dev posts only, ids from split.json)
for (const p of posts.filter(x => split[x.id] === 'dev')) {
  for (const f of lint(p.text).findings.filter(x => !x.whole)) {
    check(`позиция ${p.id}/${f.rule}`, p.text.slice(f.start, f.end) === f.text, `${f.start}-${f.end}`);
  }
}

// 3. real posts: expected findings with positions, verdicts
for (const c of cases.posts) {
  const text = postText(c.post), r = lint(text);
  if (c.rule) {
    const got = r.findings.filter(f => f.rule === c.rule);
    check(`пост ${c.post} ${c.rule}: ${c.starts.length} шт.`, got.length === c.starts.length, `найдено ${got.length}`);
    c.starts.forEach((s, i) => {
      const f = got[i];
      check(`пост ${c.post} ${c.rule} #${i + 1} позиция`, f && text.indexOf(s) === f.start && f.text.startsWith(s) && text.slice(f.start, f.end) === f.text,
        f ? `${f.start}: ${f.text.slice(0, 30)}` : 'нет');
    });
  }
  if ('flagged' in c) check(`пост ${c.post} flagged=${c.flagged}`, r.flagged === c.flagged, `балл ${r.score}`);
}

// 3b. behaviours: metrics, absent rules, counts, short texts, score cap
for (const c of cases.behaviors) {
  const text = c.text !== undefined ? c.text : postText(c.post);
  const r = lint(text, c.onlyRules ? { rules: rules.filter(x => c.onlyRules.includes(x.id)) } : {});
  for (const [k, v] of Object.entries(c.metrics || {})) check(`«${c.name}» метрика ${k}=${v}`, r.metrics[k] === v, String(r.metrics[k]));
  for (const id of c.noRules || []) check(`«${c.name}» нет ${id}`, !ids(r).includes(id), 'лишнее срабатывание');
  for (const id of c.hasRules || []) check(`«${c.name}» есть ${id}`, ids(r).includes(id), JSON.stringify(ids(r)));
  for (const [id, n] of Object.entries(c.count || {})) check(`«${c.name}» ${id}×${n}`, r.findings.filter(f => f.rule === id).length === n, String(r.findings.filter(f => f.rule === id).length));
  if (c.tooShort) check(`«${c.name}» tooShort, балл null, не отмечен`, r.tooShort === true && r.score === null && r.flagged === false, JSON.stringify([r.tooShort, r.score, r.flagged]));
  if (c.score !== undefined) check(`«${c.name}» балл ${c.score}`, r.score === c.score, String(r.score));
}

// 3c. Markdown of model answers is stripped
for (const c of cases.clean) check(`«${c.name}»`, stripMarkdown(c.text) === c.out, JSON.stringify(stripMarkdown(c.text)));

// 4. facts extraction
for (const c of cases.facts) {
  const k = keys(extractFacts(c.text || postText(c.post)));
  for (const want of c.has || []) check(`факты «${c.name}» есть ${want}`, k.includes(want), 'нет');
  for (const no of c.hasNot || []) check(`факты «${c.name}» нет ${no}`, !k.includes(no), 'лишний');
}

// 5. facts check (original vs rewritten)
for (const c of cases.checks) {
  const orig = c.orig || postText(c.post);
  let rew = c.rewritten !== undefined ? c.rewritten : orig;
  for (const [a, b] of c.replace || []) {
    check(`проверка «${c.name}»: фрагмент найден`, rew.includes(a), a);
    rew = rew.replace(a, b);
  }
  const r = checkFacts(orig, rew);
  check(`проверка «${c.name}» ok=${c.ok}`, r.ok === c.ok, JSON.stringify({ missing: keys(r.missing), added: keys(r.added) }));
  if (c.missing) check(`проверка «${c.name}» потеряно`, sameSet(keys(r.missing), c.missing), JSON.stringify(keys(r.missing)));
  if (c.added) check(`проверка «${c.name}» добавлено`, sameSet(keys(r.added), c.added), JSON.stringify(keys(r.added)));
  if (c.warnings) check(`проверка «${c.name}» предупреждения`, sameSet(keys(r.warnings), c.warnings), JSON.stringify(keys(r.warnings)));
}

// 6. autofix: mechanical fixes, facts stay intact, second run changes nothing
const { autofix } = require('../src/autofix');
const aiDev = read('../data/ai_posts.json').filter(x => x.split === 'dev'); // dev only
for (const c of cases.autofix) {
  const r = autofix(c.text);
  check(`autofix «${c.name}»`, r.text === c.out, JSON.stringify(r.text));
  check(`autofix «${c.name}» правила`, JSON.stringify(r.changes.map(x => x.rule)) === JSON.stringify(c.rules), JSON.stringify(r.changes.map(x => x.rule)));
  check(`autofix «${c.name}» повторно ничего не меняет`, autofix(r.text).changes.length === 0);
  check(`autofix «${c.name}» факты`, checkFacts(c.text, r.text).ok);
}
check('autofix: пост 1059 — факты на месте', checkFacts(postText(1059), autofix(postText(1059)).text).ok);
for (const x of aiDev) {
  const r = autofix(x.text);
  check(`autofix AI dev ${x.source_id}/${x.model}/${x.prompt_type}: факты`, checkFacts(x.text, r.text).ok);
  check(`autofix AI dev ${x.source_id}/${x.model}/${x.prompt_type}: идемпотентно`, autofix(r.text).text === r.text);
}

// 7. rewrite.js, образцы, копирование (подставной chat, без сети и денег)
require('./rewrite_tests')(check).then(() => require('./rewrite_v3_tests')(check)).then(() => require('./shorten_tests')(check)).then(() => require('./explain_fix_tests')(check)).then(() => require('./bot_tests')(check)).then(() => require('./safe_fix_tests')(check)).then(() => require('./style_rewrite_tests')(check)).then(() => {
  console.log(`\nтестов: ${passed + failed}, прошло: ${passed}, упало: ${failed}`);
  process.exit(failed ? 1 : 0);
}).catch(e => { console.log('FAIL: тесты шага 7 упали с ошибкой', e); process.exit(1); });
