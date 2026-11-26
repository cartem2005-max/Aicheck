'use strict';
// Проверка «Сократить» на 5 реальных текстах dev (3 AI-черновика + 2 редакционных поста), ~$0,1.
//   node eval/shorten_dev.js   -> eval/results/shorten_dev.md/json. Test не открывается.
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const { shorten } = require('../src/shorten');
const { checkFacts } = require('../src/facts');

(async () => {
  const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
  const ai = D('ai_posts.json').map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev' && x.text.length >= 900);
  const posts = D('posts.json'), voice = D('voice_dev.json').labels;
  const ed = posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 700);
  const items = [
    ...[0, Math.floor(ai.length / 3), Math.floor(2 * ai.length / 3)].map((k) => ({ key: 'ai' + ai[k].idx, kind: 'ai', text: ai[k].text })),
    ...[1, Math.min(6, ed.length - 1)].map((k) => ({ key: 'p' + ed[k].id, kind: 'editorial', text: ed[k].text })),
  ];
  const t0 = llm.readCost().total_usd;
  const rows = [];
  for (const it of items) {
    const r = await shorten(it.text, { tag: 'shorten_dev' });
    rows.push({ ...it, r });
    console.log(it.key, r.status, 'удалено', r.removed.length, 'оставлено гардом', r.kept_by_guard.length, 'факты', checkFacts(it.text, r.text).ok);
  }
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  let md = `# «Сократить» на 5 текстах dev\n\nSonnet 5.5, thinking between_tools, effort low, один вызов на текст. Расход ${spent} $.\n\n| текст | вид | знаков | удалено | оставлено гардом | короче на | факты |\n|---|---|---|---|---|---|---|\n`;
  for (const { key, kind, text, r } of rows) md += `| ${key} | ${kind} | ${text.length} | ${r.removed.length} | ${r.kept_by_guard.length} | ${r.length_change ? Math.round(-100 * r.length_change) + '%' : '0%'} | ${checkFacts(text, r.text).ok ? 'ok' : 'НЕТ'} |\n`;
  md += '\nПодробно по каждому тексту:\n';
  for (const { key, r } of rows) {
    md += `\n## ${key} (${r.status})\n`;
    for (const x of r.removed) md += `- удалено [${x.n}] «${x.quote}» — ${x.reason}${x.covered_by_quote ? ' — уже сказано: «' + x.covered_by_quote + '»' : ''}\n`;
    for (const x of r.kept_by_guard) md += `- оставлено гардом [${x.n}] «${x.quote}» (${x.reason}) — ${x.guard}\n`;
    if (!r.removed.length && !r.kept_by_guard.length) md += '- правка пустая\n';
    if (r.layout_suggestions.length) md += `- оформление: ${r.layout_suggestions.length} предложений\n`;
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'shorten_dev.md'), md);
  fs.writeFileSync(path.join(__dirname, 'results', 'shorten_dev.json'), JSON.stringify(rows.map(({ key, kind, text, r }) => ({ key, kind, text, ...r })), null, 1));
  console.log(md.split('\n').slice(0, 12).join('\n'));
})().catch((e) => { console.log('ОШИБКА', e.message.replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
