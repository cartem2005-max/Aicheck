'use strict';
// Задача A: реальные ответы бота (тот же конвейер: линтер, 3 оценки, «Разбор и правки», прозрачный балл, buildMessage).
//   node eval/bot_examples.js -> eval/results/bot_examples.md (+ bot_examples.json: кэш, повтор бесплатный с --reuse)
const fs = require('fs');
const path = require('path');
const llm = require('../src/llm');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');
const E = require('../src/explain_fix');
const { stripMarkdown } = require('../src/clean');

const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const OUT = path.join(__dirname, 'results');
const CAP = 0.5;
const REFRESH = ((process.argv.find((a) => a.startsWith('--refresh=')) || '').slice(10).split(',')).filter(Boolean); // ключи, для которых «Разбор» зовём заново (оценки берутся из кэша)
const RERETRY = process.argv.includes('--reretry'); // повтор для отклонённых вызвать заново (первый ответ из кэша)
const REUSE = process.argv.includes('--reuse') ? JSON.parse(fs.readFileSync(path.join(OUT, 'bot_examples.json'), 'utf8')) : null;

function toMd(html) {
  let s = html;
  s = s.replace(/<blockquote[^>]*>/g, '\n[[BQ]]').replace(/<\/blockquote>/g, '[[/BQ]]\n');
  s = s.replace(/<b>/g, '**').replace(/<\/b>/g, '**').replace(/<s>/g, '~~').replace(/<\/s>/g, '~~').replace(/<i>/g, '_').replace(/<\/i>/g, '_');
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)').replace(/<[^>]+>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // раскрыть blockquote: каждая строка с «> »
  s = s.replace(/\[\[BQ\]\]([\s\S]*?)\[\[\/BQ\]\]/g, (m, inner) => inner.split('\n').map((l) => '> ' + l).join('\n'));
  return s.trim();
}

(async () => {
  const posts = D('posts.json');
  const ai = D('ai_posts.json').filter((x) => x.split === 'test' && x.text.length >= 900);
  const naive = ai.find((x) => x.prompt_type === 'naive');
  const human = ai.find((x) => x.prompt_type === 'human');
  const P = (id) => posts.find((p) => p.id === id).text;
  const src = (id) => `пост канала, https://t.me/kultura_analitiki/${id}`;
  const items = [
    { key: 'p985', title: 'Пост 985 (кнопка-пример)', src: src(985), text: P(985) },
    { key: 'p910', title: 'Пост 910 (основатель)', src: src(910), text: P(910) },
    { key: 'p1059', title: 'Пост 1059', src: src(1059), text: P(1059) },
    { key: 'p1029', title: 'Пост 1029 (редакционный, эмодзи-маркеры)', src: src(1029), text: P(1029) },
    { key: 'ai_naive', title: 'AI-текст test, naive', src: `AI-текст, data/ai_posts.json (test), ${naive.model}, промпт naive, источник поста ${naive.source_id}`, text: naive.text },
    { key: 'ai_human', title: 'AI-текст test, human', src: `AI-текст, data/ai_posts.json (test), ${human.model}, промпт human, источник поста ${human.source_id}`, text: human.text },
  ];
  const cs = path.join(OUT, 'chatgpt_sample.txt');
  const ZB = JSON.parse(fs.readFileSync(path.join(OUT, 'zones_bot.json'), 'utf8')).rows;
  // контрольный пост выбирает КОД (eval/ctrl_pick.js): пост test, длина >= 1000, оценка модели >= 45, меньше всего упоминаний в файлах проекта; оценки из eval/zones_bot.js
  const PICK = require('./ctrl_pick').pick();
  const CTRL = PICK.id;
  const CTRL_KIND = (ZB.find((r) => r.key === 'p' + CTRL) || {}).kind;
  if (fs.existsSync(cs)) items.push({ key: 'chatgpt', title: 'Текст из ChatGPT', src: 'eval/results/chatgpt_sample.txt', text: stripMarkdown(fs.readFileSync(cs, 'utf8')) });

  items.push({ key: 'ctrl' + CTRL, title: `Контрольный пост ${CTRL} (${CTRL_KIND === 'founder' ? 'основатель' : 'редакция'}, test; выбран кодом, в разработке бота по нему «Разбор» не запускали)`, src: src(CTRL), text: P(CTRL), scores: ZB.find((r) => r.key === 'p' + CTRL).scores });
  const t0 = llm.readCost().total_usd;
  const rows = [];
  for (const it of items) {
    const prev = REUSE && REUSE.find((x) => x.key === it.key);
    const li = lintStep(it.text, 5, []);
    let scores = it.scores ? it.scores.slice() : prev ? prev.scores : [];
    if (!prev && !it.scores) for (let i = 0; i < 3; i++) {
      const rq = B.detectorRequest(it.text);
      const res = await llm.chat({ model: rq.model, messages: [{ role: 'system', content: rq.system }, rq.messages[0]], max_tokens: 400, tag: 'bot_examples_det' });
      const sc = B.parseScore({ content: [{ type: 'text', text: res.text }] });
      if (sc !== null) scores.push(sc);
    }
    const sstep = B.scoreStep(scores.map((s) => ({ content: [{ type: 'text', text: 'Оценка: ' + s }] })));
    const live = typeof sstep.mean === 'number' && sstep.mean < B.ZONE_MID; // оценка модели < 30: правки не применяем
    const refresh = REFRESH.includes(it.key) || REFRESH.includes('all');
    const call = async (messages, tag) => llm.chat({ model: E.MODEL, messages: [{ role: 'system', content: tag === 'bot_examples_retry' ? E.SYSTEM_RETRY : E.SYSTEM }, ...messages], max_tokens: E.MAX_TOKENS, tag });
    let raw = prev && !refresh ? prev.raw : null, raw2 = prev && !refresh && !RERETRY ? prev.raw2 : undefined;
    if (raw == null) raw = (await call([{ role: 'user', content: '# Пост' + String.fromCharCode(10, 10) + it.text }], 'bot_examples_fix')).text;
    const js = E.parseJson(raw);
    let fx = E.apply(it.text, js, { noEdit: live, gate: true, mean: sstep.mean });
    const first = { found: fx.found, fixed: fx.fixed, rejected: fx.findings.filter((f) => f.rejected).length };
    const cands = live ? [] : E.retryCandidates(fx);
    if (cands.length) {
      if (raw2 === undefined) raw2 = (await call(E.buildRetryRequest(it.text, js, cands).messages, 'bot_examples_retry')).text;
      fx = E.applyRetry(it.text, js, E.parseJson(raw2), cands, { noEdit: live, gate: true, mean: sstep.mean });
    }
    fx.raw = raw; fx.raw2 = raw2; fx.first = first; fx.cands = cands.length;
    const msg = B.buildMessage({ chat_id: '1', progress_id: 1, text: it.text, ...li, ...sstep, ...(fx && fx.status !== 'error' ? { fix: fx } : { fix_error: true }) });
    rows.push({ key: it.key, scores, raw: fx.raw, raw2: fx.raw2, first: fx.first, msg_html: msg.html, clean_parts: msg.clean_parts, pre_note: msg.pre_note });
    const spent = llm.readCost().total_usd - t0;
    console.log(it.key, 'оценка модели', sstep.mean, 'зона', B.finalZone(sstep.mean, fx.findings, true, fx.signs).zone, fx.status, `находок ${fx.found} автоправок ${fx.fixed} вариантов ${fx.findings.filter((f) => f.kind === 'suggest' && f.action !== 'note').length}`, '$' + spent.toFixed(3));
    it.msg = msg; it.fx = fx; it.scores = scores;
    if (spent > CAP) { console.log('потолок'); break; }
  }
  const spent = +(llm.readCost().total_usd - t0).toFixed(4);
  let md = `# Реальные ответы бота (задача A)\n\nТот же конвейер, что в боте (шаги 18–19): линтер, три оценки модели, «Разбор» и повтор для отклонённых, зона по оценке модели и числу разных пунктов, buildMessage. Автоматически код применяет только безопасное (зачины, шаблонные призывы, «!» в лозунге или морали, усилители «действительно» и «по-настоящему») и только при зоне «много приёмов» (оценка 55 и выше и 3 разных приёма); ниже это показано вариантами. Всё остальное — «Можно заменить» (только с готовым вариантом) и «Ещё стоит посмотреть». Три оценки модели и ответы «Разбора» взяты из кэша; применение (код) прогнано заново. Для контрольного поста оценки из таблицы зон, «Разбор» вызван новый. Контрольный пост выбран кодом (eval/ctrl_pick.js), в разработке бота по нему «Разбор» не запускали; в общих таблицах по всей выборке test он есть. HTML Telegram переведён в markdown: ~~зачёркнуто~~, **новое/жирное**, цитата раскрыта.\n`;
  for (const it of items) {
    if (!it.msg) continue;
    md += `\n---\n\n## ${it.title}\n\nИсточник: ${it.src}\n\n### Исходный текст\n\n${it.text.split('\n').map((l) => '> ' + l).join('\n')}\n\n### Сообщение бота\n\n${toMd(it.msg.html)}\n`;
    if (it.msg.clean_parts.length) md += `\n### Чистовик (второе сообщение)\n\n${it.msg.pre_note ? 'Отдельным сообщением перед чистовиком: ' + toMd(it.msg.pre_note) + '\n\n' : ''}${it.msg.clean_parts.map(toMd).join('\n\n')}\n`;
    else md += '\n### Чистовик\n\nНе присылается: правок нет.\n';
  }
  fs.writeFileSync(path.join(OUT, 'bot_examples.md'), md);
  fs.writeFileSync(path.join(OUT, 'bot_examples.json'), JSON.stringify(rows, null, 1));
  console.log('расход', spent);
})().catch((e) => { console.log('ОШИБКА', String(e.stack || e.message).replace(/https?:\/\/\S+/g, '<адрес>')); process.exit(1); });
