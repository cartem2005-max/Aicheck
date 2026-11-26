'use strict';
// Dev-only statistics (no AI texts exist yet): how often each rule fires on founder vs editorial dev posts,
// score distribution per voice. Test posts are NOT used (except the three demo posts, printed at the end just to look).
// Run: node eval/dev_stats.js
const fs = require('fs');
const path = require('path');
const { lint } = require('../src/linter');

const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const posts = read('data/posts.json'), voice = read('data/voice_dev.json').labels, rules = read('src/rules.json');
const dev = posts.filter(p => voice[p.id]);
const groups = { founder: [], editorial: [], unclear: [] };
for (const p of dev) groups[voice[p.id].label].push({ id: p.id, r: lint(p.text) });

const pct = (n, d) => (d ? Math.round(100 * n / d) : 0) + '%';
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : '-'; };

console.log(`dev: founder ${groups.founder.length}, editorial ${groups.editorial.length}, unclear ${groups.unclear.length}\n`);
console.log('правило  founder  editorial   (доля постов, где сработало; E — не в балле)');
for (const rule of rules) {
  const fires = list => list.filter(x => x.r.findings.some(f => f.rule === rule.id)).length;
  const f = fires(groups.founder), e = fires(groups.editorial);
  console.log(`${rule.id.padEnd(7)}  ${(pct(f, groups.founder.length) + ' (' + f + ')').padEnd(10)} ${pct(e, groups.editorial.length)} (${e})`);
}
console.log('\nбалл (placeholder-веса и порог 30)      min  p25  медиана  p75  max   отмечено');
for (const g of ['founder', 'editorial', 'unclear']) {
  const sc = groups[g].map(x => x.r.score);
  console.log(`${g.padEnd(12)}${' '.repeat(26)}${[0, 0.25, 0.5, 0.75].map(p => String(q(sc, p)).padStart(4)).join(' ')}  ${String(Math.max(...sc)).padStart(4)}   ${groups[g].filter(x => x.r.flagged).length} из ${sc.length}`);
}
console.log('\nбаллы founder по возрастанию:', groups.founder.map(x => x.r.score).sort((a, b) => a - b).join(' '));
console.log('баллы editorial по возрастанию:', groups.editorial.map(x => x.r.score).sort((a, b) => a - b).join(' '));
console.log('\nдемо-посты (test, только посмотреть, не настраивать):');
for (const id of [1059, 960, 910]) {
  const r = lint(posts.find(p => p.id === id).text);
  console.log(`  ${id}: балл ${r.score}, правила: ${[...new Set(r.findings.filter(f => f.counted).map(f => f.rule))].join(' ')}`);
}
