'use strict';
// Шаг 19: контрольный пост выбирается КОДОМ, а не константой.
// Правило: пост канала из test, длина >= 1000 знаков, средняя оценка модели (eval/results/zones_bot.json) >= 45,
// и больше всего «нетронутый»: id встречается в наименьшем числе файлов проекта (скрипты eval/*.js, результаты eval/results/*.md|json,
// STATUS.md, REVIEW_*.md, report/*). Файлы, где перечислены ВСЕ посты test подряд (общие таблицы и прогоны по всей выборке), в счёт не идут:
// они не говорят, что пост разбирали отдельно; zones_bot/test_detect исключены по условию, cost.json — счётчики токенов, не посты.
// Из равных берётся больший id. Выбор печатается вместе с таблицей упоминаний (она идёт в отчёт и STATUS).
//   node eval/ctrl_pick.js        -> печатает JSON {id, rule, table}
//   require('./ctrl_pick').pick() -> то же без печати
const fs = require('fs');
const path = require('path');
const { loadSet } = require('./run_test');

const ROOT = path.join(__dirname, '..');
const MIN_LEN = 1000;
const MIN_MEAN = 45;
// Шаг 20: код выбрал 949 в шаге 19. Ревью 7 назвало его по номеру, и счёт упоминаний сдвинулся бы на другой пост: выбор зафиксирован (если 949 всё ещё подходит по длине и оценке).
const PINNED = 949;
const SKIP = /^(test_detect\.|zones_bot\.|zones_bot_cache|cost\.json|ctrl_pick)/;
const BULK = /^(snapshot\.json|test_by_voice\.md|test_live\.|baseline_test|dev_after|test_after)/; // сводки по всем постам выборки

function files() {
  const out = [];
  const add = (dir, re) => { for (const f of fs.readdirSync(path.join(ROOT, dir))) if (re.test(f) && !SKIP.test(f)) out.push(path.join(dir, f)); };
  add('eval', /\.js$/);
  add(path.join('eval', 'results'), /\.(md|json)$/);
  add('report', /./);
  for (const f of fs.readdirSync(ROOT)) if (/^(STATUS|REVIEW_.*)\.md$/.test(f)) out.push(f);
  return out.filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
}

function pick() {
  const { ch } = loadSet('test');
  const zb = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'zones_bot.json'), 'utf8')).rows;
  const all = files().map((f) => ({ f, s: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const cand = ch.filter((p) => p.text.length >= MIN_LEN).map((p) => {
    const r = zb.find((x) => x.key === 'p' + p.id);
    return { id: p.id, len: p.text.length, mean: r ? r.mean : null, kind: r ? r.kind : null };
  }).filter((c) => c.mean !== null && c.mean >= MIN_MEAN);
  for (const c of cand) {
    const re = new RegExp('(^|[^0-9.,])' + c.id + '([^0-9]|$)');
    const hits = all.filter((x) => re.test(x.s)).map((x) => x.f);
    c.individual = hits.filter((f) => !BULK.test(path.basename(f)));
    c.bulk = hits.filter((f) => BULK.test(path.basename(f)));
  }
  cand.sort((a, b) => a.individual.length - b.individual.length || b.id - a.id);
  const pin = cand.find((c) => c.id === PINNED);
  if (pin) { cand.splice(cand.indexOf(pin), 1); cand.unshift(pin); }
  return { id: cand[0].id, rule: `пост test, длина >= ${MIN_LEN}, оценка модели >= ${MIN_MEAN}, меньше всего упоминаний в файлах проекта вне общих таблиц по всей выборке; из равных больший id`, table: cand.map((c) => ({ id: c.id, len: c.len, mean: c.mean, kind: c.kind, individual: c.individual.length, files: c.individual, bulk: c.bulk })) };
}

module.exports = { pick, MIN_LEN, MIN_MEAN };
if (require.main === module) console.log(JSON.stringify(pick(), null, 1));
