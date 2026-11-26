'use strict';
// Прогон текстов русских моделей (GigaChat, Алиса) через конвейер бота. node eval/ru_llm_run.js -> eval/results/ru_llm.md (+ru_llm.json кэш, --reuse)
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');
const E = require('../src/explain_fix');
const { stripMarkdown } = require('../src/clean');
const OUT = path.join(__dirname, 'results');
const CAP = 0.3;
const CACHE = path.join(OUT, 'ru_llm.json');
const REUSE = process.argv.includes('--reuse') && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : [];
const plain = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

(async () => {
  const items = [];
  for (const [m, p] of [['GigaChat', 'gigachat'], ['Алиса AI', 'alice']]) for (let i = 1; i <= 3; i++) items.push({ key: `${p}_${i}`, model: m, text: stripMarkdown(fs.readFileSync(path.join(OUT, 'ru_llm', `${p}_${i}.txt`), 'utf8')) });
  const t0 = llm.readCost().total_usd;
  const rows = [];
  for (const it of items) {
    const prev = REUSE.find((x) => x.key === it.key);
    if (prev) { rows.push(prev); continue; }
    const li = lintStep(it.text, 5, []);
    const scores = [];
    for (let i = 0; i < 3; i++) {
      const rq = B.detectorRequest(it.text);
      const res = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, rq.messages[0]], max_tokens: 400, tag: 'ru_llm_det' });
      const sc = B.parseScore({ content: [{ type: 'text', text: res.text }] });
      if (sc !== null) scores.push(sc);
    }
    const sstep = B.scoreStep(scores.map((s) => ({ content: [{ type: 'text', text: 'Оценка: ' + s }] })));
    const live = typeof sstep.mean === 'number' && sstep.mean < B.ZONE_MID;
    const call = async (messages, tag) => llm.chat({ model: E.MODEL, messages: [{ role: 'system', content: tag === 'ru_llm_retry' ? E.SYSTEM_RETRY : E.SYSTEM }, ...messages], max_tokens: E.MAX_TOKENS, tag });
    const raw = (await call([{ role: 'user', content: '# Пост' + String.fromCharCode(10, 10) + it.text }], 'ru_llm_fix')).text;
    const js = E.parseJson(raw);
    let fx = E.apply(it.text, js, { noEdit: live, gate: true, mean: sstep.mean });
    const cands = live ? [] : E.retryCandidates(fx);
    let raw2;
    if (cands.length) {
      raw2 = (await call(E.buildRetryRequest(it.text, js, cands).messages, 'ru_llm_retry')).text;
      fx = E.applyRetry(it.text, js, E.parseJson(raw2), cands, { noEdit: live, gate: true, mean: sstep.mean });
    }
    const msg = B.buildMessage({ chat_id: '1', progress_id: 1, text: it.text, ...li, ...sstep, ...(fx && fx.status !== 'error' ? { fix: fx } : { fix_error: true }) });
    const h = plain(msg.html);
    const mN = h.match(/нашлось (\d+)/);
    const verdict = (h.match(/Итог\n([^\n]+)/) || [])[1] || '?';
    const chkBlock = (h.match(/Проверка по списку\n[^\n]*\n([\s\S]*?)(?:\n\n|$)/) || [])[1] || '';
    const top = chkBlock.split('\n').filter((l) => /^\d+\./.test(l)).slice(0, 3);
    const fz = B.finalZone(sstep.mean, fx.findings, true, fx.signs);
    rows.push({ key: it.key, model: it.model, scores, mean: sstep.mean, zone: fz.zone, verdict, N: mN ? +mN[1] : 0, top, status: fx.status, html: msg.html });
    const spent = llm.readCost().total_usd - t0;
    console.log(it.key, scores, sstep.mean, verdict, 'N', mN && mN[1], '$' + spent.toFixed(3));
    if (spent > CAP) { console.log('потолок'); break; }
  }
  fs.writeFileSync(CACHE, JSON.stringify(rows, null, 1));
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  const ZB = JSON.parse(fs.readFileSync(path.join(OUT, 'zones_bot.json'), 'utf8')).rows;
  const avg = (k) => { const v = ZB.filter((r) => r.kind === k && typeof r.mean === 'number').map((r) => r.mean); return `${(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1)} (N=${v.length})`; };
  let md = `# Тексты русских моделей через бота\n\nТот же конвейер, что в боте: линтер, три оценки детектора, «Разбор» с повтором, buildMessage. Тексты: GigaChat (giga.chat) и Алиса AI (alice.yandex.ru), 26.11.2026, один запрос: три поста для канала сервиса аналитики для селлеров. В gigachat_3 убрано упоминание города, остальное не менялось. Новые вызовы модели, расход $${spent}.\n\n| Текст | Модель | Оценка (три числа, среднее) | Итог бота | Приёмов найдено | Главные приёмы |\n|---|---|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.key} | ${r.model} | ${r.scores.join(', ')}; среднее ${r.mean} | ${r.verdict} | ${r.N} | ${r.top.join('<br>').replace(/\|/g, '/') || '—'} |\n`;
  md += `\nДля сравнения (eval/results/zones_bot.md, средняя оценка трёх вызовов): тексты Claude (test, 72 шт.) — ${avg('ai')}; личные посты основателя канала — ${avg('founder')}; редакционные посты — ${avg('editorial')}.\n\n## Выводы\n\nTODO\n`;
  fs.writeFileSync(path.join(OUT, 'ru_llm.md'), md);
  console.log('расход', spent);
})().catch((e) => { console.log('ОШИБКА', String(e.stack || e.message).replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
