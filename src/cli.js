'use strict';
// Demo CLI: node src/cli.js lint <postId|file>   |   node src/cli.js facts <postId|file>
const fs = require('fs');
const path = require('path');
const { lint } = require('./linter');

function load(arg) {
  if (fs.existsSync(arg)) return fs.readFileSync(arg, 'utf8');
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'posts.json'), 'utf8'));
  const p = posts.find(x => String(x.id) === String(arg));
  if (!p) throw new Error('нет такого поста: ' + arg);
  return p.text;
}

function printLint(text) {
  const r = lint(text);
  if (r.tooShort) console.log(`${r.message} (знаков: ${text.length}). Находки всё равно показаны ниже.`);
  else console.log(`балл: ${r.score} (порог ${r.config.threshold}, ${r.flagged ? 'ОТМЕЧЕН' : 'чисто'}), знаков: ${text.length}`);
  console.log('метрики:', JSON.stringify(r.metrics));
  for (const f of r.findings) {
    const pos = f.whole ? 'весь текст' : `${f.start}-${f.end}`;
    const t = f.text.replace(/\n/g, '↵');
    console.log(`  ${f.rule}${f.counted ? ' ' : '*'} [${pos}] ${t.length > 70 ? t.slice(0, 70) + '…' : t}${f.value !== undefined ? ' (значение ' + f.value + ')' : ''}`);
  }
  console.log(`  (* = группа E, живой голос, в балл не входит; в балл идёт не больше ${r.config.maxPerRule} находок каждого правила)`);
}

function printFacts(text) {
  const { extractFacts, checkFacts } = require('./facts');
  const facts = extractFacts(text);
  console.log(`фактов: ${facts.length}`);
  for (const f of facts) console.log(`  ${f.type.padEnd(8)} [${f.start}-${f.end}] ${f.value}`);
  const show = (title, rewritten) => {
    const c = checkFacts(text, rewritten);
    const list = a => a.map(f => f.type + ':' + f.value).join(' | ') || '-';
    console.log(`${title}: ok=${c.ok}; потеряно: ${list(c.missing)}; добавлено: ${list(c.added)}; предупреждения: ${list(c.warnings)}`);
  };
  show('сам с собой', text);
  // demo substitutions only where the fragment exists (post 1059); on other posts they would be fake
  if (text.includes('всего 90 дней')) show('подмена 90 -> 60', text.replace('всего 90 дней', 'всего 60 дней'));
  if (text.includes('Выпустил, подключил')) show('выдуманное число', text.replace('Выпустил, подключил', 'Выпустил за 15 минут, подключил'));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'lint') printLint(load(arg)); else if (cmd === 'facts') printFacts(load(arg));
else console.log('usage: node src/cli.js lint|facts <postId|file>');
