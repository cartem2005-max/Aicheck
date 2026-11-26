'use strict';
// Локальный прогон строк jsCode (ровно тех, что уходят в n8n) с поддельными $input/$json/$('Нода')/$getWorkflowStaticData.
// Сверка с функциями из src/: одинаковые баллы, находки, правка, сообщения. Без сети и денег.
//   node n8n/simulate.js        (exit code 1, если что-то не сошлось)
const fs = require('fs');
const path = require('path');
const { jsCode } = require('./build');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');
const { lint } = require('../src/linter');
const E = require('../src/explain_fix');
const S = require('../src/explain_score');
const { parseText, bodyParagraphs } = require('../src/textparse');
const { checkFacts } = require('../src/facts');

let ok = 0, bad = 0;
const check = (name, cond, detail) => { if (cond) ok++; else { bad++; console.log('FAIL:', name, detail === undefined ? '' : String(detail).slice(0, 300)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NL = String.fromCharCode(10);

// константы владельца и примера подставляются только здесь, в боевой сборке они пустые (их ставит ведущий)
const SUBS = [["const OWNER_CHAT_ID = 'YOUR_CHAT_ID';", "const OWNER_CHAT_ID = '42';"]];
// запуск Code-ноды: input — массив json входа, nodes — {имя ноды: [json]}, sd — staticData
function run(key, { input = [], nodes = {}, sd = {} } = {}) {
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const dollar = (name) => {
    if (!nodes[name]) throw new Error('нода не выполнялась: ' + name);
    return { first: () => wrap(nodes[name])[0], all: () => wrap(nodes[name]), item: wrap(nodes[name])[0] };
  };
  const $input = { first: () => wrap(input)[0], all: () => wrap(input), item: wrap(input)[0] };
  const fn = new Function('$input', '$json', '$', '$getWorkflowStaticData', jsCode(key, SUBS));
  return fn($input, input[0], dollar, () => sd).map((x) => x.json);
}

// тексты dev: AI-черновик, редакционный пост, пост основателя (только dev) + синтетический анонс с кликабельной ссылкой
const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const voice = D('voice_dev.json').labels, posts = D('posts.json');
const aiDev = D('ai_posts.json').filter((x) => x.split === 'dev' && x.text.length >= 900);
const ed = posts.filter((p) => voice[p.id] && voice[p.id].label === 'editorial' && p.text.length >= 700);
const fo = posts.filter((p) => voice[p.id] && voice[p.id].label === 'founder' && p.text.length >= 400);
const SYN = ['🎉 Новый раздел «Акции» в сервисе', '', 'Это действительно удобно и важно для каждого продавца. Раздел показывает, в каких акциях участвует товар.', '', '1️⃣ Видно, в каких акциях участвует товар.', '2️⃣ Видно, какая цена нужна для входа.', '3️⃣ Видно, как менялся бустинг.', '', 'Хотите попробовать? Зарегистрируйтесь по ссылке https://example.com/promo.', '', 'С 12 февраля в сервисе появился раздел «Акции».', '', 'Следите за новостями канала. Главное — не пропускать обновления.', '', '@kultura_analitiki'].join(NL);
const TEXTS = [['ai', aiDev[0].text], ['editorial', ed[1].text], ['founder', fo[0].text], ['synthetic', SYN]];
const ans = (t, usage) => ({ content: [{ type: 'text', text: t }], ...(usage ? { usage } : {}) });
const NOW = Date.UTC(2026, 10, 27, 7, 0, 0);
const realNow = Date.now; Date.now = () => NOW;
const PROG = { ok: true, result: { message_id: 61, chat: { id: 42 } } };

// ответ «модели» для разбора: для обычных текстов — подсказка по первому предложению тела (п.21), для синтетического — набор находок разных видов
function answerFor(kind, text) {
  if (kind === 'synthetic') {
    return { findings: [
      { quote: 'С 12 февраля в сервисе появился раздел «Акции».', sign: '16. Канцелярит', why: 'канцелярит', fix: 'В сервисе появился раздел «Акции».' },
      { quote: 'Это действительно удобно и важно для каждого продавца.', sign: '23. Усилители', why: 'усилитель без содержания', fix: 'Это удобно и важно для каждого продавца.' },
      { quote: 'Следите за новостями канала.', sign: '24. Призыв в конце', why: 'общий призыв', fix: '' },
      { quote: 'Раздел показывает, в каких акциях участвует товар.', sign: '22. Оценки без опоры', why: 'нет цифры', fix: '' },
    ] };
  }
  const body = bodyParagraphs(parseText(text));
  const first = body.length > 1 ? body[1].sentences[0] : body[0].sentences[0];
  return { findings: [{ quote: first.text, sign: '21. Абстракция вместо конкретики', why: 'нет примера', fix: '' }] };
}

const STATUS = {};
{
  const cat = run('PARSE', { input: [{ update_id: 2, message: { message_id: 4, chat: { id: 42 }, text: '/catalog' } }], sd: {} })[0];
  check('PARSE: /catalog → ответ со списком 50 пунктов, пункт 50 на месте', cat.route === 'reply' && /Все 50 приёмов/.test(cat.reply) && /\n50\. Ошибка или опечатка/.test(cat.reply) && cat.reply.length < 4096);
}
for (const [kind, raw] of TEXTS) {
  const tag = kind + ': ';
  const sdA = {}, sdB = {};
  // 1. разбор и лимиты
  const upd = { update_id: 1, message: { message_id: 3, chat: { id: 42 }, text: raw } };
  const routed = run('PARSE', { input: [upd], sd: sdA })[0];
  const expectRouted = B.route(upd, sdB, NOW);
  check(tag + 'разбор и лимиты = bot.route', same(routed, expectRouted) && routed.route === 'analyze' && sdA.count === 1 && same(sdA, sdB), JSON.stringify(routed).slice(0, 100));

  // 2. линтер: баллы и находки (после «Проверяю пост…»)
  const linted = run('LINT', { input: [PROG], nodes: { 'Разбор и лимиты': [routed], 'Проверяю пост…': [PROG] }, sd: { allow: [] } })[0];
  const direct = lintStep(routed.text);
  const r = lint(routed.text);
  check(tag + 'линтер: балл как у lint(), progress_id из «Проверяю пост…»', linted.lint.score === r.score && linted.lint.score === direct.lint.score && linted.progress_id === 61, linted.lint.score + ' vs ' + r.score);
  check(tag + 'линтер: места и оформление как у lintStep, только counted', same(linted.highlights, direct.highlights) && same(linted.layout, direct.layout) && linted.highlights.every((h) => r.findings.some((f) => f.counted && f.rule === h.rule)), JSON.stringify(linted.highlights).slice(0, 150));

  // 3. три запроса детектору
  const reqs = run('REQUESTS', { input: [linted] });
  check(tag + 'три запроса = bot.detectorRequests, модель и промпт', reqs.length === 3 && same(reqs, B.detectorRequests(routed.text)) && reqs[0].req.model === 'claude-sonnet-5-5' && reqs[0].req.messages[0].content.includes('Оценка: N'));

  // 4. среднее и зона
  let mid = [ans('Оценка: 40', { input_tokens: 500, output_tokens: 10 }), ans('Оценка: 35', { input_tokens: 500, output_tokens: 10 }), ans('Оценка: 45', { input_tokens: 500, output_tokens: 10 })];
  if (kind === 'synthetic') mid = [ans('Оценка: 62', { input_tokens: 500, output_tokens: 10 }), ans('Оценка: 58', { input_tokens: 500, output_tokens: 10 }), ans('Оценка: 60', { input_tokens: 500, output_tokens: 10 })]; // зона «много»: автоправки включены
  const sdS = {};
  const scored = run('SCORE', { input: mid, nodes: { 'Линтер и автоправки': [linted] }, sd: sdS })[0];
  const expS = B.scoreStep(mid);
  check(tag + 'среднее и зона = scoreStep (40 → mid; синтетический 60 → high)', scored.mean === (kind === 'synthetic' ? 60 : 40) && scored.zone === (kind === 'synthetic' ? 'high' : 'mid') && scored.need_shorten === true && scored.mean === expS.mean && scored.text === routed.text && scored.highlights.length === linted.highlights.length && scored.progress_id === 61);
  check(tag + 'usage попал в статистику (1500 вх., 30 вых.)', sdS.stats.days['2026-11-27'].in === 1500 && sdS.stats.days['2026-11-27'].out === 30);

  // E: таймаут модели (подставные ошибки HTTP-ноды) → «Оценка модели недоступна» + линтер
  const dead = run('SCORE', { input: [{ error: { message: 'timeout' } }, { error: { message: 'timeout' } }, { error: { message: 'timeout' } }], nodes: { 'Линтер и автоправки': [linted] }, sd: {} })[0];
  const deadMsg = run('COMPOSE', { input: [dead], sd: {} })[0];
  check(tag + 'E: таймаут → «Число посчитать не удалось», без кнопок и чистовика', dead.api_error === true && /Число посчитать не удалось/.test(deadMsg.html) && deadMsg.has_buttons === false && deadMsg.clean_parts.length === 0 && (linted.lint.tooShort || /Набор правил без нейросети дал \d+ из 100/.test(deadMsg.html)), deadMsg.html.slice(0, 200));
  const part2 = run('SCORE', { input: [ans('Оценка: 40'), { error: { message: 'timeout' } }, ans('Оценка: 50')], nodes: { 'Линтер и автоправки': [linted] }, sd: {} })[0];
  check(tag + 'E: пришло 2 из 3 → «Две оценки… Третья не пришла», не «три оценки»', part2.partial === true && /Две оценки \d+ и \d+, среднее \d+\. Третья не пришла/.test(run('COMPOSE', { input: [part2], sd: {} })[0].html));

  // 5. разбор и правки: запрос и применение
  const freq = run('FIX_REQ', { input: [scored] })[0];
  check(tag + 'запрос на разбор = explain_fix.buildRequest (каталог в system, 4000 токенов)', same(freq.fix_req, E.buildRequest(routed.text)) && freq.text === routed.text && freq.fix_req.max_tokens === 4000 && freq.fix_req.system.includes('Каталог приёмов'));
  const modelAnswer = answerFor(kind, routed.text);
  const sdAp = { allow: [] };
  const applied = run('FIX_APPLY', { input: [ans(JSON.stringify(modelAnswer), { input_tokens: 3200, output_tokens: 300 })], nodes: { 'Запрос на разбор': [freq] }, sd: sdAp })[0];
  const expApply = E.apply(routed.text, modelAnswer, { allow: [], links: undefined, noEdit: scored.mean < B.ZONE_MID, gate: true, mean: scored.mean });
  check(tag + 'правки = explain_fix.apply, факты целы', same(applied.fix, expApply) && checkFacts(routed.text, applied.fix.text).ok && !('fix_req' in applied), applied.fix && applied.fix.status);
  check(tag + 'usage разбора учтён', sdAp.stats.days['2026-11-27'].in === 3200 && sdAp.stats.days['2026-11-27'].out === 300);
  const failedFix = run('FIX_APPLY', { input: [{ error: { message: 'x' } }], nodes: { 'Запрос на разбор': [freq] }, sd: {} })[0];
  check(tag + 'ошибка разбора → fix_error, без падения', failedFix.fix_error === true && !failedFix.fix);
  const junkFix = run('FIX_APPLY', { input: [ans('не JSON')], nodes: { 'Запрос на разбор': [freq] }, sd: {} })[0];
  check(tag + 'не-JSON от модели → fix_error, без падения', junkFix.fix_error === true && !junkFix.fix);
  if (kind === 'synthetic') {
    const f = applied.fix.findings;
    check(tag + 'отклонение: правка, теряющая дату, не применена, но осталась признаком', f.some((x) => x.action === 'note' && /потеряно 12 февраля/.test(x.reason)) && applied.fix.fixed === 1, JSON.stringify(f.map((x) => [x.action, x.reason])));
    check(tag + 'удаление призыва — только вариант (в текст не вносится), «действительно» убрал код, подсказка по п.22 выдана', f.filter((x) => x.action === 'delete').length === 1 && f.filter((x) => x.action === 'replace').length === 0 && f.some((x) => x.action === 'hint') && applied.fix.auto.some((e) => e.kind === 'AMP') && applied.fix.text.includes('Следите за новостями'), JSON.stringify(f.map((x) => x.action)));
    // повтор для отклонённых (шаг 17): FIX_APPLY готовит запрос, FIX_RETRY применяет переделанное
    check(tag + 'повтор: есть отклонённое → need_retry, запрос на повтор = buildRetryRequest, в нём причина отказа', applied.need_retry === true && applied.retry_cands.length === 1 && same(applied.retry_req, E.buildRetryRequest(routed.text, modelAnswer, applied.retry_cands)) && /потеряно 12 февраля/.test(applied.retry_req.messages[2].content), JSON.stringify(applied.retry_cands));
    const redoJs = { findings: [{ quote: 'С 12 февраля в сервисе появился раздел «Акции».', sign: '16', why: 'канцелярит', fix: 'С 12 февраля в сервисе появился раздел «Акции».'.replace('появился раздел', 'есть раздел') }] };
    const sdRt = { allow: [] };
    const retried = run('FIX_RETRY', { input: [ans(JSON.stringify(redoJs), { input_tokens: 1500, output_tokens: 120 })], nodes: { 'Применить правки и проверить факты': [applied] }, sd: sdRt })[0];
    const expRetry = E.applyRetry(routed.text, modelAnswer, redoJs, applied.retry_cands, { allow: [], links: undefined, gate: true, mean: scored.mean });
    check(tag + 'повтор: результат = explain_fix.applyRetry, служебные поля убраны, usage повтора учтён', same(retried.fix, expRetry) && !('retry_req' in retried) && !('fix_js' in retried) && !('need_retry' in retried) && sdRt.stats.days['2026-11-27'].in === 1500, JSON.stringify(retried.fix.findings.map((x) => [x.action, x.reason, x.retried])));
    const keepRt = run('FIX_RETRY', { input: [{ error: { message: 'timeout' } }], nodes: { 'Применить правки и проверить факты': [applied] }, sd: {} })[0];
    check(tag + 'повтор: сбой HTTP-ноды → остаётся первый разбор, без падения', same(keepRt.fix, applied.fix) && !keepRt.fix_error);
    const badRt = run('FIX_RETRY', { input: [ans(JSON.stringify({ findings: [{ quote: 'С 12 февраля в сервисе появился раздел «Акции».', sign: '16', why: 'x', fix: 'В сервисе появился раздел «Акции».' }] }))], nodes: { 'Применить правки и проверить факты': [applied] }, sd: {} })[0];
    check(tag + 'повтор: переделанная снова отклонена (опять потеряна дата) → заметка, число правок прежнее', badRt.fix.fixed === applied.fix.fixed && badRt.fix.findings.some((x) => x.action === 'note' && /12 февраля/.test(x.reason || '')));
    check(tag + 'повтор: без отклонённого need_retry = false (живой текст и обычный текст)', run('FIX_APPLY', { input: [ans(JSON.stringify({ findings: [] }))], nodes: { 'Запрос на разбор': [freq] }, sd: {} })[0].need_retry === false);
    // живой текст: оценка модели < 30 → glue не применяет ни одной правки, сообщение — заметки, без чистовика
    const liveBase = { ...freq, mean: 12, zone: 'low', scores: [12, 12, 12], n_scores: 3 };
    const liveAp = run('FIX_APPLY', { input: [ans(JSON.stringify(modelAnswer))], nodes: { 'Запрос на разбор': [liveBase] }, sd: {} })[0];
    check(tag + 'живой текст (оценка 12): ноль правок, текст не изменён, находки остались', liveAp.fix.fixed === 0 && liveAp.fix.text === routed.text && liveAp.fix.found >= 3 && liveAp.fix.findings.every((x) => x.action === 'note' || x.action === 'hint'), JSON.stringify(liveAp.fix.findings.map((x) => x.action)));
    check(tag + 'живой текст: повтор не запрашивается (need_retry = false)', liveAp.need_retry === false && !liveAp.retry_req);
    const liveMsg = run('COMPOSE', { input: [{ ...liveAp, highlights: [], layout: [] }], sd: {} })[0];
    check(tag + 'живой текст (оценка 12): «Общее впечатление» с числом 12, «Проверка по списку», «Итог» из живых вариантов, подсказок автору на первом экране нет, без кнопок и чистовика', /оценил его на <b>12 из 100<\/b>/.test(liveMsg.html) && /<b>Проверка по списку<\/b>\n(?:Из 50 приёмов в тексте нашлось \d+\.|Ни одного приёма из списка не нашлось\.)/.test(liveMsg.html) && /<b>Итог<\/b>\n(?:Вообще почти не вижу признаков AI 😎|Похоже на живой текст\.|В целом звучит живо, но пара приёмов есть)/.test(liveMsg.html) && !/Заметил только это|Оценки без доказательств|Подсказки автору/.test(liveMsg.html.split('<blockquote')[0]) && liveMsg.has_buttons === false && liveMsg.clean_parts.length === 0);
    // высокая оценка (90) и только 2 разных пункта среди находок → средняя зона и пометка
    const two = { findings: modelAnswer.findings.filter((x) => /^2[24]\./.test(x.sign)) };
    const hiBase = { ...freq, ...B.scoreStep([ans('Оценка: 90'), ans('Оценка: 88'), ans('Оценка: 92')]) };
    const hiAp = run('FIX_APPLY', { input: [ans(JSON.stringify(two))], nodes: { 'Запрос на разбор': [hiBase] }, sd: {} })[0];
    const hiMsg = run('COMPOSE', { input: [{ ...hiAp, highlights: [], layout: [] }], sd: {} })[0];
    check(tag + 'оценка 90, приёмов меньше 3 → «Claude видит шаблонность в целом» (не «Очень похоже»), число 90 на месте', hiAp.fix.signs.length === 2 && (B.withCode(hiAp.fix.signs, hiAp.text).length < 3 ? /оценил его на <b>90 из 100<\/b>/.test(hiMsg.html) && /<b>Итог<\/b>\n(?:Claude видит шаблонность в целом, но конкретных приёмов мало|Очень похоже|Да тут вообще весь набор)/.test(hiMsg.html) : /<b>Итог<\/b>\n(?:Да тут вообще весь набор 😳|Очень похоже)/.test(hiMsg.html)), hiMsg.html.slice(0, 400));
  }

  // 6. сообщение
  const final = { ...applied, ...B.scoreStep(mid), highlights: linted.highlights, layout: linted.layout, lint: linted.lint };
  const sdC = {};
  const composed = run('COMPOSE', { input: [final], sd: sdC })[0];
  const expMsg = B.buildMessage(final);
  check(tag + 'сообщение = buildMessage, ≤ 4096, правит сообщение «Проверяю пост…» (progress_id)', composed.html === expMsg.html && composed.has_buttons === expMsg.has_buttons && composed.html.length <= 4096 && composed.progress_id === 61, composed.html.length);
  const lines0 = composed.html.split(NL);
  const zoneLine = lines0[0];
  const expT = S.scoreText(routed.text, applied.fix.findings, linted.lint_findings || []);
  check(tag + 'три части: «Общее впечатление» с оценкой модели (среднее трёх), «Проверка по списку», «Итог»; три числа только в подробностях, раскладки очков нет', !('tscore' in applied) && composed.html.startsWith('<b>Общее впечатление</b>\nClaude прочитал текст целиком и оценил его на <b>' + Math.round(scored.mean) + ' из 100</b>.') && composed.html.indexOf('<b>Проверка по списку</b>') > 0 && composed.html.indexOf('<b>Проверка по списку</b>') < composed.html.indexOf('<b>Итог</b>') && !/среднее трёх/.test(composed.html.split('<blockquote')[0]) && !composed.html.includes('Из чего сложилось'), zoneLine);
  check(tag + 'итог «Очень похоже» только при оценке >= 55 и >= 3 приёмах; «Живой текст» только при оценке < 30', (/<b>Итог<\/b>\nОчень похоже/.test(composed.html) ? scored.mean >= 55 : true) && (/<b>Итог<\/b>\n(?:Похоже на живой текст|Вообще почти не вижу)/.test(composed.html) ? scored.mean < 30 : true), composed.html.slice(0, 300));
  const cutAt = composed.html.indexOf('<b>Итог</b>');
  const head = composed.html.slice(0, cutAt >= 0 ? cutAt : composed.html.length);
  check(tag + 'первый экран: «Общее впечатление» и «Проверка по списку» до «Итога», «Итог» раньше правок', cutAt > 0 && head.includes('<b>Проверка по списку</b>') && (composed.html.indexOf('<b>Исправил сам') < 0 || composed.html.indexOf('<b>Итог</b>') < composed.html.indexOf('<b>Исправил сам')), head);
  STATUS[kind] = applied.fix.status + ' (находок ' + applied.fix.found + ', исправлено ' + applied.fix.fixed + ')';
  check(tag + 'D: «Исправил сам N мест» (только изменённые слова) / «Исправлять самому было нечего» после оценки', applied.fix.fixed && !applied.fix.noAuto ? /<b>Исправил сам \d+ (?:место|места|мест)<\/b>/.test(composed.html) && applied.fix.auto.length === applied.fix.fixed : /Исправлять самому было нечего|Сам ничего не менял/.test(composed.html) || scored.mean < B.ZONE_MID, lines0[0]);
  if (applied.fix.status === 'fixed') {
    const struck = applied.fix.edits.every((x) => composed.html.includes('<s>' + B.esc(String(x.del || x.quote).trim().slice(0, 30))));
    check(tag + '(1) убранное зачёркнуто, новое выделено, кнопки есть', struck && /Исправил сам/.test(composed.html) && composed.has_buttons === true);
    check(tag + 'D: результат с кнопками запомнен под chat_id:progress_id', sdC.results && sdC.results['42:61'] && sdC.results['42:61'].open === true);
    if (composed.btn_n >= 1) { // кнопки правок через jsCode: PARSE применяет кодом, APPLY_PARTS раскладывает сообщения
      const press = (data) => run('PARSE', { input: [{ callback_query: { id: 'q', data, from: { id: 42 }, message: { message_id: 61, chat: { id: 42 }, text: 'x' } } }], sd: sdC })[0];
      const p1 = press('fix:1');
      const items = run('APPLY_PARTS', { nodes: { 'Разбор и лимиты': [p1] } });
      const again = press('fix:1');
      // кнопки оставшихся правок под присланным текстом (через jsCode: APPLY_PARTS кладёт rm/rm_n/orig только на последнее сообщение)
      check(tag + 'APPLY_PARTS: rm, rm_n и orig только на последнем сообщении, на остальных rm_n = 0; orig = исходное сообщение 61', items.every((x, k) => (k < items.length - 1 ? x.rm_n === 0 : x.rm_n === p1.rm_n && JSON.stringify(x.rm) === JSON.stringify(p1.rm)) && x.orig === '61') && p1.orig === '61');
      if (composed.btn_n >= 2) {
        const pressFrom = (data) => run('PARSE', { input: [{ callback_query: { id: 'q2', data, from: { id: 42 }, message: { message_id: 99, chat: { id: 42 }, text: 'x' } } }], sd: sdC })[0];
        const nxt = pressFrom('fix:2:61');
        check(tag + 'кнопка из присланного текста «fix:2:61»: тот же результат 61, правки копятся (1 и 2), остаток rm = нерассмотренные', nxt.route === 'apply' && /Сейчас применены правки 1 и 2/.test(nxt.parts[0]) && nxt.rm.every((n) => n > 2) && nxt.rm_n === nxt.rm.length && (nxt.rm_n > 0 || nxt.parts[nxt.parts.length - 1] === 'Все правки применены.'));
      }
      check(tag + 'кнопки правок: нажатие → route apply, «Готово, применил правку 1», части = APPLY_PARTS, повтор → «уже применена» без сообщений', p1.route === 'apply' && p1.cb_id === 'q' && p1.parts[0] === 'Готово, применил правку 1. Вот текст:' && items.length === p1.parts.length && items.every((x) => x.chat_id === '42' && x.part.length <= 4096) && again.toast === 'Эта правка уже применена' && run('APPLY_PARTS', { nodes: { 'Разбор и лимиты': [again] } }).length === 0 && !JSON.stringify(composed).includes('"accept"'), JSON.stringify(p1).slice(0, 200));
    }
    const parts = run('CLEAN_PARTS', { nodes: { 'Собрать сообщение': [composed] } });
    check(tag + '(5) чистовик отдельными сообщениями без пометок', parts.length >= 1 && parts.every((p) => p.chat_id === composed.chat_id && !/<s>|<\/s>|<b>/.test(p.part) && p.part.length <= 4096) && parts.map((p) => p.part).join('').includes(B.esc(applied.fix.text.slice(0, 40))), JSON.stringify(parts).slice(0, 100));
  } else {
    check(tag + 'B: правок нет → без кнопок и чистовика', composed.has_buttons === false && run('CLEAN_PARTS', { nodes: { 'Собрать сообщение': [composed] } }).length === 0, composed.html.split(NL)[0]);
  }
}
check('(1)(5) хотя бы на одном тексте правка применена (зачёркнутое и чистовик проверены)', Object.values(STATUS).some((x) => x.startsWith('fixed')), JSON.stringify(STATUS));
console.log('правка по текстам:', JSON.stringify(STATUS));

// (3) подпись к картинке и пересланный пост — через настоящий jsCode
const body = TEXTS[1][1];
const cap = run('PARSE', { input: [{ message: { message_id: 1, chat: { id: 7 }, photo: [{}], caption: body } }], sd: {} })[0];
const fwd = run('PARSE', { input: [{ message: { message_id: 2, chat: { id: 7 }, forward_origin: { type: 'channel' }, forward_from_chat: { id: 1 }, text: body } }], sd: {} })[0];
const plain = run('PARSE', { input: [{ message: { message_id: 3, chat: { id: 7 }, text: body } }], sd: {} })[0];
check('(3) подпись к картинке даёт тот же результат, что обычный текст', cap.route === 'analyze' && cap.text === plain.text);
check('(3) пересланный пост даёт тот же результат', fwd.route === 'analyze' && fwd.text === plain.text);

// C: анонс с кликабельным «Записаться» (скрытая ссылка в entities) — сквозь все Code-ноды
const ANN = 'Анонс вебинара про аналитику маркетплейсов. ' + 'Расскажем, как читать отчёты по продажам и находить просадки. '.repeat(4) + 'Записаться на вебинар можно тут. Это действительно удобно и быстро для всех участников. Следите за новостями канала.';
const ents = [{ type: 'text_link', offset: ANN.indexOf('Записаться'), length: 10, url: 'https://example.com/reg?a=1&b=2' }];
const rA = run('PARSE', { input: [{ message: { message_id: 1, chat: { id: 9 }, text: ANN, entities: ents } }], sd: {} })[0];
check('C: PARSE кладёт скрытую ссылку в links', rA.route === 'analyze' && rA.links.length === 1 && rA.links[0].url === 'https://example.com/reg?a=1&b=2');
const lA = run('LINT', { input: [PROG], nodes: { 'Разбор и лимиты': [rA], 'Проверяю пост…': [PROG] }, sd: {} })[0];
const sA = run('SCORE', { input: [ans('Оценка: 60'), ans('Оценка: 60'), ans('Оценка: 60')], nodes: { 'Линтер и автоправки': [lA] }, sd: {} })[0];
const rqA = run('FIX_REQ', { input: [sA] })[0];
const apA = run('FIX_APPLY', { input: [ans(JSON.stringify({ findings: [{ quote: 'Записаться на вебинар можно тут.', sign: '24. Призыв в конце', why: 'призыв', fix: '' }, { quote: 'Анонс вебинара про аналитику маркетплейсов.', sign: '22. Оценки без опоры', why: 'нет цифры', fix: '' }, { quote: 'Это действительно удобно и быстро для всех участников.', sign: '23. Усилители', why: 'усилитель', fix: 'Это удобно и быстро для всех участников.' }] }))], nodes: { 'Запрос на разбор': [rqA] }, sd: {} })[0];
check('C: фрагмент с кликабельной «Записаться» не правится (пересечение со ссылкой), «действительно» рядом убрал код', apA.fix.fixed === 1 && apA.fix.auto[0].kind === 'AMP' && apA.fix.text.includes('Записаться на вебинар') && apA.fix.findings.some((k) => k.action === 'note' && /кликабельная ссылка/.test(k.reason)) && !apA.fix.text.includes('действительно удобно'));
const cA = run('COMPOSE', { input: [apA], sd: {} })[0];
const partsA = run('CLEAN_PARTS', { nodes: { 'Собрать сообщение': [cA] } });
check('C: в чистовике ссылка сохранена как <a href="…">Записаться</a>', partsA.length === 1 && partsA[0].part.includes('<a href="https://example.com/reg?a=1&amp;b=2">Записаться</a>'), JSON.stringify(partsA).slice(0, 200));

// F: ссылка, длина, пример, владелец
const lkRoute = run('PARSE', { input: [{ message: { chat: { id: 5 }, text: 'https://t.me/kultura_analitiki/987' } }], sd: {} })[0];
check('F: ссылка → fetch с адресом ?embed=1', lkRoute.route === 'fetch' && lkRoute.fetch_url === 'https://t.me/kultura_analitiki/987?embed=1');
check('F: чужой адрес не принимается', run('PARSE', { input: [{ message: { chat: { id: 5 }, text: 'https://evil.ru/t.me/chan/5' } }], sd: {} })[0].route !== 'fetch');
const emb = '<div class="tgme_widget_message_text js-message_text" dir="auto">' + B.esc(body).replace(/\n/g, '<br/>') + '</div>';
const lkOk = run('FROM_LINK', { input: [{ html: emb }], nodes: { 'Разбор и лимиты': [lkRoute] }, sd: {} })[0];
check('F: ссылка — текст достан, принят в проверку', lkOk.route === 'analyze' && lkOk.text === plain.text, lkOk.route);
const lkBad = run('FROM_LINK', { input: [{ error: { message: '404' } }], nodes: { 'Разбор и лимиты': [lkRoute] }, sd: {} })[0];
check('F: закрытая/недоступная → «Перешлите пост сюда»', lkBad.route === 'reply' && /Перешлите пост сюда/.test(lkBad.reply));
const shortIn = run('PARSE', { input: [{ message: { chat: { id: 5 }, text: 'Коротко ' + 'а'.repeat(300) } }], sd: {} })[0];
check('F: < 400 знаков → «Текст слишком короткий» без вызова модели', shortIn.route === 'reply' && /Текст слишком короткий/.test(shortIn.reply));
const longIn = run('PARSE', { input: [{ message: { chat: { id: 5 }, text: 'а'.repeat(5500) } }], sd: {} })[0];
check('F: > 5000 → длина и предел', longIn.route === 'reply' && /слишком длинный, это 5500 знаков, а можно до 5000/.test(longIn.reply));
const startIn = run('PARSE', { input: [{ message: { chat: { id: 5 }, text: '/start' } }], sd: {} })[0];
check('A: /start → приветствие с «Claude» и «Anthropic»', startIn.route === 'start' && /Claude/.test(startIn.reply) && /Anthropic/.test(startIn.reply));
const exIn = run('PARSE', { input: [{ callback_query: { id: 'q', data: 'example', from: { id: 5 }, message: { message_id: 9, chat: { id: 5 }, text: 'Привет' } } }], sd: {} })[0];
check('A: кнопка «Проверить пример» → route example и адрес поста', exIn.route === 'example' && exIn.fetch_url === 'https://t.me/kultura_analitiki/985?embed=1' && exIn.cb_id === 'q');

// G: длинный пост — сообщение ≤ 4096, чистовик частями
const paras = [];
for (let i = 0; i < 40; i++) paras.push('Абзац ' + i + '. Здесь написано довольно длинное предложение про работу раздела акций & <теги> для селлеров. Ещё одно предложение с пояснением.');
const bigText = paras.join(NL + NL);
const rg = [3, 20, 37].map((k) => { const s0 = bigText.indexOf('Ещё одно предложение', bigText.indexOf('Абзац ' + k + '.')); return { n: k, start: s0, end: s0 + 34, quote: 'Ещё одно предложение с пояснением.', reason: 'вода', covered_by: null, covered_by_quote: null }; });
const gItem = { chat_id: '42', progress_id: 61, text: bigText, ...B.scoreStep([ans('Оценка: 70'), ans('Оценка: 70'), ans('Оценка: 70')]), highlights: [], layout: [], fix: { status: 'fixed', text: bigText, length_change: -0.05, found: 3, fixed: 3, findings: rg.map((r, i) => ({ n: i + 1, quote: r.quote, sign: 23, title: 'Усилители', why: 'усилитель', fix: '', action: 'delete', reason: null })), edits: rg.map((r) => ({ start: r.start, end: r.end, ins: '' })) } };
{ // кофейный пост через jsCode: очевидные шаблоны находит код
  const CT = require('../tests/coffee_text');
  const cMsg = run('COMPOSE', { input: [{ chat_id: '42', progress_id: 61, text: CT, ...B.scoreStep([ans('Оценка: 91'), ans('Оценка: 90'), ans('Оценка: 92')]), highlights: [], layout: [], fix: E.apply(CT, { findings: [] }) }], sd: {} })[0];
  check('кофейный пост (jsCode): все 6 очевидных шаблонов и много смайликов названы, полный список в подробностях', [/Заголовок с числом/, /Вопрос-заход/, /Стрелка-указатель/, /Нумерация цифрами-эмодзи/, /Вопрос в конце ради ответов/, /Обещание удивить/, /Много смайликов/, /Весь список по пунктам/].every((r) => r.test(cMsg.html)) && cMsg.html.length <= 4096, cMsg.html.slice(0, 300));
}
const gMsg = run('COMPOSE', { input: [gItem], sd: {} })[0];
const gParts = run('CLEAN_PARTS', { nodes: { 'Собрать сообщение': [gMsg] } });
check('G: длинный ответ ≤ 4096, только изменённые фрагменты, & < > экранированы', gMsg.html.length <= 4096 && /Исправил сам 3 места/.test(gMsg.html) && gMsg.html.includes('&lt;теги&gt;') && (gMsg.html.match(/<s>Ещё/g) || []).length === 6, gMsg.html.length);
check('G: чистовик > 4096 разбит на части по ≤ 4096', gParts.length >= 2 && gParts.every((p) => p.part.length <= 4096));

// команды, исключения, кнопки, деньги (через jsCode)
const sdO = {};
check('I: /stats владельцу (chat 42 — константа в simulate) работает, чужому — отказ', /Статистика/.test(run('PARSE', { input: [{ message: { chat: { id: 42 }, text: '/stats' } }], sd: sdO })[0].reply) && /только для владельца/.test(run('PARSE', { input: [{ message: { chat: { id: 5 }, text: '/stats' } }], sd: {} })[0].reply));
run('PARSE', { input: [{ message: { chat: { id: 42 }, text: '/allow Хотите попробовать' } }], sd: sdO });
check('/allow через jsCode кладёт фразу в staticData', same(sdO.allow, ['хотите попробовать']));
const lintAllow = run('LINT', { input: [PROG], nodes: { 'Разбор и лимиты': [{ route: 'analyze', chat_id: '1', text: SYN }], 'Проверяю пост…': [PROG] }, sd: { allow: ['следите за новостями'] } })[0];
check('/allow: фраза не подсвечивается (линтер-нода читает staticData)', !lintAllow.highlights.some((h) => h.quote && h.quote.includes('Следите за новостями')));
const applyAllow = run('FIX_APPLY', { input: [ans(JSON.stringify({ findings: [{ quote: 'Следите за новостями канала.', sign: '24. Призыв в конце', why: 'призыв', fix: '' }] }))], nodes: { 'Запрос на разбор': [{ chat_id: '1', text: SYN, fix_req: {} }] }, sd: { allow: ['следите за новостями'] } })[0];
check('/allow: фраза не правится (нода разбора читает staticData)', !applyAllow.fix.edits.some((e) => e.quote.includes('Следите')) && applyAllow.fix.findings.some((f) => /списке исключений/.test(f.reason || '')));
const sdBtn = { results: { '1:9': { open: true } } };
const cbIn = { callback_query: { id: 'q', data: 'keep', from: { id: 1 }, message: { message_id: 9, chat: { id: 1 }, text: 'Привет', entities: [{ type: 'bold', offset: 0, length: 6 }] } } };
const cb1 = run('PARSE', { input: [cbIn], sd: sdBtn })[0];
const cb2 = run('PARSE', { input: [cbIn], sd: sdBtn })[0];
check('D: кнопка закрывает результат, повторное нажатие — «Уже закрыто»', cb1.route === 'callback' && cb1.new_html.startsWith('<b>Привет</b>') && cb2.already === true);
const sdMoney = {};
B.recordUsage(sdMoney, NOW, [{ usage: { input_tokens: 500000, output_tokens: 20000 } }]);
check('H: потолок $1 в сутки — отказ ДО вызова модели (через jsCode)', /На сегодня проверки закончились/.test(run('PARSE', { input: [{ message: { chat: { id: 5 }, text: body } }], sd: sdMoney })[0].reply));

// ежедневный: два запуска подряд, без дублей
const PAGE = '<div data-post="kultura_analitiki/101" class="x"><div class="tgme_widget_message_text js-message_text" dir="auto">' + B.esc(TEXTS[1][1]).replace(/\n/g, '<br/>') + '</div><time datetime="2026-11-26T08:00:00+00:00"></time></div>' +
  '<div data-post="kultura_analitiki/102" class="x"><div class="tgme_widget_message_text js-message_text" dir="auto">' + B.esc(TEXTS[0][1]).replace(/\n/g, '<br/>') + '</div><time datetime="2026-11-27T05:00:00+00:00"></time></div>';
const dsd = {};
const FETCH = 'Скачать страницу канала';
const p1 = run('D_PARSE', { input: [{ html: PAGE }], nodes: { [FETCH]: [{ html: PAGE }] }, sd: dsd });
check('ежедневный: первый запуск — только самый свежий пост', p1.length === 1 && p1[0].id === 102 && p1[0].text === TEXTS[0][1]);
const dreq = run('D_REQUESTS', { input: p1 });
check('ежедневный: три запроса на пост, балл линтера как у lint()', dreq.length === 3 && dreq[0].post.lint_score === lint(TEXTS[0][1]).score && same(dreq.map((x) => x.i), [0, 1, 2]));
const dig = run('D_DIGEST', { input: [ans('Оценка: 70'), ans('Оценка: 66'), ans('Оценка: 74')], nodes: { 'Линтер и запросы детектору': dreq }, sd: dsd })[0];
check('ежедневный: сводка с оценкой 70/100, lastPostId=102, только посты канала', /Оценка 70 из 100/.test(dig.html) && /<a href="https:\/\/t\.me\/kultura_analitiki\/102">[^<]*\p{L}[^<]*<\/a>/u.test(dig.html) && !/Пост 102/.test(dig.html) && dsd.lastPostId === 102 && dig.html.length <= 4096);
check('ежедневный: повторный запуск — новых постов нет (без дублей)', run('D_PARSE', { input: [{}], nodes: { [FETCH]: [{ html: PAGE }] }, sd: dsd }).length === 0);
const PAGE2 = PAGE + '<div data-post="kultura_analitiki/103" class="x"><div class="tgme_widget_message_text js-message_text" dir="auto">' + B.esc(TEXTS[2][1]).replace(/\n/g, '<br/>') + '</div></div>';
const p3 = run('D_PARSE', { input: [{}], nodes: { [FETCH]: [{ html: PAGE2 }] }, sd: dsd });
check('ежедневный: появился пост 103 — берём только его', p3.length === 1 && p3[0].id === 103);

Date.now = realNow;
console.log(`simulate: проверок ${ok + bad}, прошло ${ok}, упало ${bad}`);
process.exit(bad ? 1 : 0);
