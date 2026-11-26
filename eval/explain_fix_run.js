'use strict';
// Шаг 11: полный конвейер бота на живых моделях: линтер, три оценки шаблонности, «Разбор и правки», сообщение бота.
// Посты канала 985, 1001, 893, 1059, 1055 и 5 AI-текстов dev. Бюджет ≤ $0,4.
//   node eval/explain_fix_run.js  -> eval/results/explain_fix_run.json/.md
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');
const E = require('../src/explain_fix');
const { checkFacts } = require('../src/facts');

const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const CAP = 0.4;
const REUSE = process.argv.includes('--reuse') ? JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'explain_fix_run.json'), 'utf8')) : null;

(async () => {
  const posts = D('posts.json');
  const ai = D('ai_posts.json').map((x, i) => ({ ...x, idx: i })).filter((x) => x.split === 'dev' && x.text.length >= 900);
  const items = [
    ...[985, 1001, 893, 1059, 1055].map((id) => ({ key: 'p' + id, kind: 'post', text: posts.find((p) => p.id === id).text })),
    ...[0, 1, 2, 3, 4].map((k) => { const x = ai[Math.floor(k * ai.length / 5)]; return { key: 'ai' + x.idx, kind: 'ai', text: x.text }; }),
  ];
  const t0 = llm.readCost().total_usd;
  const rows = [];
  for (const it of items) {
    const li = lintStep(it.text, 5, []);
    const scores = [];
    const prev = REUSE ? REUSE.find((x) => x.key === it.key) : null; // --reuse: баллы детектора из прошлого прогона (экономия)
    if (prev) scores.push(...prev.scores);
    for (let i = 0; i < (prev ? 0 : 3); i++) {
      const rq = B.detectorRequest(it.text);
      const res = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, rq.messages[0]], max_tokens: 400, tag: 'explain_fix_run_det' });
      const sc = B.parseScore({ content: [{ type: 'text', text: res.text }] });
      if (sc !== null) scores.push(sc);
    }
    const z = scores.length ? B.meanZone(scores) : null;
    let fx = null;
    if (z && z.zone !== 'low') fx = await E.explainFix(it.text, { tag: 'explain_fix_run' });
    const msg = z ? B.buildMessage({ chat_id: '1', progress_id: 1, text: it.text, ...li, ...B.scoreStep(scores.map((s) => ({ content: [{ type: 'text', text: 'Оценка: ' + s }] }))), ...(fx ? { fix: fx } : {}) }) : null;
    rows.push({ ...it, li, scores, z, fx, msg });
    const spent = llm.readCost().total_usd - t0;
    console.log(it.key, 'балл', z && z.mean, fx ? `находок ${fx.found}, исправлено ${fx.fixed}` : 'разбор не вызывался', '$' + spent.toFixed(3));
    if (spent > CAP) { console.log('потолок бюджета'); break; }
  }
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  let md = `# Шаг 11: «Разбор и правки» на 10 текстах (живые модели)\n\nSonnet 5.5, три оценки шаблонности + один разбор на текст. Расход ${spent} $.\n\n| текст | знаков | шаблонность | находок | исправлено | отклонено кодом | отброшено | факты |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const f = r.fx;
    md += `| ${r.key} | ${r.text.length} | ${r.z ? r.z.mean + ' (' + r.scores.join(', ') + ')' : '-'} | ${f ? f.found : '-'} | ${f ? f.fixed : '-'} | ${f ? f.findings.filter((x) => x.action === 'note').length : '-'} | ${f ? f.dropped.length : '-'} | ${f ? (checkFacts(r.text, f.text).ok ? 'ok' : 'НЕТ') : '-'} |\n`;
  }
  for (const r of rows) {
    md += `\n## ${r.key} (${r.z ? r.z.mean : '-'}/100)\n`;
    if (!r.fx) { md += '- разбор не вызывался\n'; continue; }
    for (const x of r.fx.findings) {
      md += `- ${x.n}. п.${x.sign} ${x.title}: «${x.quote}» — ${x.why}\n`;
      md += x.action === 'replace' ? `  - ПРАВКА → «${x.fix}»\n` : x.action === 'delete' ? '  - ПРАВКА → убрано\n' : x.action === 'hint' ? `  - подсказка автору: ${x.hint}\n` : `  - код отклонил: ${x.reason}\n`;
    }
    for (const d of r.fx.dropped) md += `- отброшено кодом: «${d.quote}» — ${d.why}\n`;
    if (r.fx.rolled_back.length) md += `- откат итоговой сверкой: ${JSON.stringify(r.fx.rolled_back)}\n`;
    if (r.fx.status === 'fixed') md += `\nТекст после правок:\n\n\`\`\`\n${r.fx.text}\n\`\`\`\n`;
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'explain_fix_run.md'), md);
  fs.writeFileSync(path.join(__dirname, 'results', 'explain_fix_run.json'), JSON.stringify(rows.map((r) => ({ key: r.key, kind: r.kind, text: r.text, scores: r.scores, fx: r.fx, msg_html: r.msg && r.msg.html })), null, 1));
  console.log('расход', spent);
})().catch((e) => { console.log('ОШИБКА', String(e.message).replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
