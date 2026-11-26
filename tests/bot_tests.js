'use strict';
// Тесты src/bot_core.js и src/bot_lint.js (логика Code-нод n8n), без сети и денег.
const fs = require('fs');
const B = require('../src/bot_core');
const { lintStep } = require('../src/bot_lint');
const E = require('../src/explain_fix');
const S = require('../src/explain_score');

const LONG = 'Сегодня в сервисе обновился раздел акций. '.repeat(12).trim();
const upd = (text, chat = 42) => ({ message: { message_id: 5, chat: { id: chat }, text } });
const ans = (t, usage) => ({ content: [{ type: 'text', text: t }], ...(usage ? { usage } : {}) });
const NL = String.fromCharCode(10);

module.exports = async function run(check) {
  const NOW = Date.UTC(2026, 10, 27, 7, 0, 0);
  B.CFG.owner = '42'; B.CFG.example = 987;

  // разбор и лимиты
  let sd = {};
  const st = B.route(upd('/start'), sd, NOW);
  check('A: /start → route start, текст: Claude (Anthropic), пример, «или пришлите»', st.route === 'start' && /Claude/.test(st.reply) && /Anthropic/.test(st.reply) && /пример/.test(st.reply) && /Пришлите текст/.test(st.reply), st.reply);
  check('бот: /help — справка со всеми командами', ['/start', '/subscribe', '/unsubscribe', '/stats', '/allow', '/disallow', '/help', 't.me/канал/123'].every((c) => B.HELP.includes(c)));
  check('бот: /subscribe и /unsubscribe', B.route(upd('/subscribe'), sd, NOW).route === 'subscribe' && B.route(upd('/unsubscribe'), sd, NOW).route === 'unsubscribe');
  check('бот: неизвестная команда → справка', /Не знаю/.test(B.route(upd('/foo'), sd, NOW).reply));
  // копия владельцу: коротко кто, что и ответ бота; свои сообщения владельца не дублируем
  const fromU = (text, id) => ({ message: { message_id: 9, chat: { id }, from: { id, first_name: 'Иван', username: 'ivan_x' }, text } });
  const ot = B.ownerTurn(fromU('/start', 77), B.route(fromU('/start', 77), {}, NOW));
  check('копия владельцу: /start от чужого — имя, ник, id, что написал и что ответил бот', /Иван \(@ivan_x, id 77\)/.test(ot) && /Написал: \/start/.test(ot) && /Бот: приветствие/.test(ot), ot);
  check('копия владельцу: сообщения самого владельца не дублируются', B.ownerTurn(fromU('/start', 42), B.route(fromU('/start', 42), {}, NOW)) === null);
  check('копия владельцу: разбор текста не шлём на этапе приёма (придёт отдельной сводкой)', B.ownerTurn(fromU(LONG, 77), B.route(fromU(LONG, 77), {}, NOW)) === null);
  const oaHtml = ['<b>Итог</b>', 'Местами похоже на текст нейросети.', '', '<b>Общее впечатление</b>', 'Claude прочитал текст целиком и оценил его на <b>41 из 100</b>.', '', '<b>Проверка по списку</b>', 'Из 50 приёмов в тексте нашлось 2.', '1. «Сегодня в сервисе»', 'Повтор.', '2. «раздел акций»', 'Канцелярит.', '', '<b>Предлагаю заменить 1 место</b>'].join(NL);
  const oa = B.ownerAnalysis(fromU(LONG, 77), { text: LONG }, oaHtml);
  check('копия владельцу: разбор — длина текста, итог, оценка, число приёмов и замен, первые места', /Прислал текст \(\d+ знаков\)/.test(oa) && /Бот: Местами похоже на текст нейросети\. Оценка 41\. Приёмов 2, замен предложил 1, сам исправил 0\./.test(oa) && /1\. «Сегодня в сервисе» Повтор/.test(oa), oa);
  // 26.11: текст с заголовками приходит как rich_message без поля text
  const rich = B.route({ message: { message_id: 6, chat: { id: 43 }, rich_message: { blocks: [{ type: 'heading', text: 'Заголовок', size: 2 }, { type: 'paragraph', text: LONG }, { type: 'paragraph', text: '' }] } } }, {}, NOW);
  check('бот: rich_message с заголовками разбирается как текст', rich.route === 'analyze' && rich.text.startsWith('Заголовок' + NL + NL + 'Сегодня'), JSON.stringify(rich).slice(0, 120));
  check('бот: не текст → отказ', /Пришлите текст/.test(B.route({ message: { chat: { id: 1 }, photo: [] } }, sd, NOW).reply));
  check('F: короче 400 → «слишком короткий», без вызова модели, счётчики не растут', /Текст слишком короткий, нужно хотя бы 400 знаков/.test(B.route(upd('Коротко ' + 'а'.repeat(300)), sd, NOW).reply) && !sd.count && !sd.stats);
  check('F: длиннее 5000 → длина и предел', /слишком длинный, это 5001 знаков, а можно до 5000/.test(B.route(upd('а'.repeat(5001)), sd, NOW).reply));
  const a = B.route(upd(LONG), sd, NOW);
  check('бот: нормальный текст → analyze, счётчик 1', a.route === 'analyze' && a.chat_id === '42' && a.used_today === 1 && sd.count === 1);
  sd.count = 50;
  check('бот: 51-я проверка за сутки на весь бот → лимит', /бот уже сделал 50 проверок/.test(B.route(upd(LONG, 7), sd, NOW).reply) && sd.count === 50);
  check('бот: на следующие сутки (МСК) счётчик сброшен', B.route(upd(LONG), sd, NOW + 24 * 3600e3).route === 'analyze' && sd.count === 1);
  check('бот: сутки считаются по Москве (21:30 UTC уже завтра)', B.mskDay(Date.UTC(2026, 10, 26, 21, 30)) === '2026-11-27');

  // H: деньги и лимит на человека — до вызова модели
  const sdU = {};
  for (let i = 0; i < 10; i++) check('H: проверка ' + (i + 1) + ' из 10 на человека проходит', B.route(upd(LONG, 7), sdU, NOW).route === 'analyze');
  check('H: 11-я проверка одного человека → отказ без вызова', /сегодня уже сделали 10 проверок/.test(B.route(upd(LONG, 7), sdU, NOW).reply) && sdU.count === 10);
  check('H: другому человеку можно', B.route(upd(LONG, 8), sdU, NOW).route === 'analyze');
  const sdO = {};
  let ownerOk = true;
  for (let i = 0; i < 12; i++) ownerOk = ownerOk && B.route(upd(LONG, 42), sdO, NOW).route === 'analyze';
  check('H: владельцу лимит на человека не мешает (12 проверок)', ownerOk);
  const sdM = {};
  B.recordUsage(sdM, NOW, [{ usage: { input_tokens: 400000, output_tokens: 20000 } }]); // 0.8 + 0.2 = $1.0
  check('H: дневной потолок $1 → отказ до вызова', /На сегодня проверки закончились/.test(B.route(upd(LONG, 8), sdM, NOW).reply));
  check('H: на следующий день потолок снят', B.route(upd(LONG, 8), sdM, NOW + 24 * 3600e3).route === 'analyze');
  const sdMon = { stats: { days: { '2026-11-01': { checks: 5, in: 4000000, out: 200000 }, '2026-11-02': { checks: 5, in: 4000000, out: 200000 }, '2026-11-03': { checks: 5, in: 4000000, out: 200000 } } } };
  check('H: месячный потолок $10 (3 дня по $10 при пустом сегодня) → отказ', /На этот месяц проверки закончились/.test(B.route(upd(LONG, 8), sdMon, NOW).reply));

  // I: владелец
  check('I: /stats и /allow — только владельцу', /только для владельца/.test(B.route(upd('/stats', 8), {}, NOW).reply) && /только для владельца/.test(B.route(upd('/allow фраза', 8), {}, NOW).reply) && /Статистика/.test(B.route(upd('/stats', 42), {}, NOW).reply));

  // D: кнопки привязаны к результату
  const sdD = {};
  B.registerResult(sdD, '42', '9', NOW);
  const cbU = (data, mid = 9) => ({ callback_query: { id: 'q1', data, from: { id: 42 }, message: { message_id: mid, chat: { id: 42 }, text: 'Жирный и обычный', entities: [{ type: 'bold', offset: 0, length: 6 }] } } });
  const cb = B.route(cbU('accept'), sdD, NOW);
  check('D: accept → ответ, <b> сохранён, подпись «Принято», результат закрыт', cb.route === 'callback' && cb.cb_id === 'q1' && cb.new_html.startsWith('<b>Жирный</b> и обычный') && /Принято/.test(cb.new_html) && sdD.results['42:9'].open === false, cb.new_html);
  const cb2 = B.route(cbU('keep'), sdD, NOW);
  check('D: повторное нажатие → «Вы уже выбрали», ничего не меняется', cb2.already === true && cb2.toast === 'Вы уже выбрали' && !/Принято|Оставлено/.test(cb2.new_html));
  check('D: keep на незнакомом сообщении работает', /Оставлено как было/.test(B.route(cbU('keep', 77), sdD, NOW).new_html));
  for (let i = 0; i < 250; i++) B.registerResult(sdD, '1', String(i), NOW);
  check('D: хранится не больше ~200 результатов', Object.keys(sdD.results).length === 200);
  const ex = B.route(cbU('example'), {}, NOW);
  check('A: кнопка «Проверить пример» → fetch поста канала с EXAMPLE_POST_ID, ответ на нажатие', ex.route === 'example' && ex.fetch_url === 'https://t.me/kultura_analitiki/987?embed=1' && ex.cb_id === 'q1' && ex.chat_id === '42');
  B.CFG.example = 0;
  check('A: пример не настроен → понятный ответ', /не готов/.test(B.route(cbU('example'), {}, NOW).toast));
  B.CFG.example = 987;
  check('бот: entitiesToHtml экранирует и вкладывает', B.entitiesToHtml('a<b бж', [{ type: 'bold', offset: 0, length: 6 }, { type: 'italic', offset: 2, length: 2 }]) === '<b>a&lt;<i>b </i>бж</b>');
  check('callback: blockquote expandable и <s> сохраняются при снятии кнопок', B.entitiesToHtml('ab cd', [{ type: 'expandable_blockquote', offset: 0, length: 2 }, { type: 'strikethrough', offset: 3, length: 2 }]) === '<blockquote expandable>ab</blockquote> <s>cd</s>');

  // детектор
  const rq = B.detectorRequests(LONG + ' @chan');
  check('детектор: пять запросов, промпт без подписи @…', rq.length === 5 && rq[0].req.model === 'claude-sonnet-5-5' && !rq[0].req.messages[0].content.includes('@chan') && rq[0].req.messages[0].content.includes('Оценка: N'));
  const st1 = B.scoreStep([ans('40'), ans('45'), ans('50'), ans('90'), ans('10')]);
  check('оценка: три близкие — среднее трёх, лишние два не учитываются', st1.mean === 45 && st1.scores.length === 3 && !st1.unstable, JSON.stringify(st1));
  const st2 = B.scoreStep([ans('62'), ans('22'), ans('72'), ans('40'), ans('55')]);
  check('оценка: разброс трёх >= 30 — медиана пяти и пометка', st2.mean === 55 && st2.unstable && st2.scores.length === 5, JSON.stringify(st2));
  check('детектор: разбор «Оценка: N»', B.parseScore(ans('Оценка: 72')) === 72 && B.parseScore(ans('55')) === 55 && B.parseScore({ error: { message: 'x' } }) === null && B.parseScore(ans('нет')) === null);
  check('зоны: границы 30 и 55', B.zoneOf(29.9) === 'low' && B.zoneOf(30) === 'mid' && B.zoneOf(54.9) === 'mid' && B.zoneOf(55) === 'high');
  let sc = B.scoreStep([ans('Оценка: 30'), ans('Оценка: 35'), ans('Оценка: 30')]);
  check('зона: среднее 31.7 → mid, нужна правка, не partial', sc.mean === 31.7 && sc.zone === 'mid' && sc.need_shorten && !sc.api_error && !sc.partial);
  sc = B.scoreStep([ans('Оценка: 12'), { error: {} }, ans('Оценка: 15')]);
  check('E: два ответа из трёх → partial, «по 2 из 3»', sc.partial === true && sc.n_scores === 2 && sc.zone === 'low');
  sc = B.scoreStep([{ error: {} }, { error: {} }, { error: {} }]);
  check('E: ни одного ответа → api_error', sc.api_error === true && sc.n_scores === 0);

  // сообщение
  const TEXT = [
    '🎉 Новый раздел «Акции» в сервисе', '',
    'С недавних пор в сервисе появился раздел «Акции». Это действительно удобно и важно для каждого продавца. Раздел показывает, в каких акциях участвует товар.', '',
    '1️⃣ Видно, в каких акциях участвует товар.', '2️⃣ Видно, какая цена нужна для входа.', '3️⃣ Видно, как менялся бустинг.', '',
    'Хотите попробовать? Зарегистрируйтесь по ссылке https://example.com/promo.', '',
    'Следите за новостями канала. Главное — не пропускать обновления.', '', '@kultura_analitiki'].join(NL);
  const li = lintStep(TEXT);
  const F = (o) => ({ quote: o.q, sign: o.s, why: o.w || 'приём', fix: o.f });
  const fixAns = { findings: [
    F({ q: 'Это действительно удобно и важно для каждого продавца.', s: '22. Оценки без опоры', w: 'оценка без цифры' }),
    F({ q: 'Следите за новостями канала.', s: '24. Призыв в конце', f: '' }),
    F({ q: 'Главное — не пропускать обновления.', s: '9. Вывод-мораль', w: 'вывод-лозунг', f: 'Обновления лучше не пропускать.' }),
  ] };
  const sh = E.apply(TEXT, fixAns);
  const item = { chat_id: '1', progress_id: 6, text: TEXT, ...li, ...B.scoreStep([ans('Оценка: 72'), ans('Оценка: 66'), ans('Оценка: 80')]), fix: sh, tscore: S.scoreText(TEXT, sh.findings, li.lint_findings) };
  const msg = B.buildMessage(item);
  const lines0 = msg.html.split(NL);
  check('разбор: 3 находки; автоправка 1 (усилитель, кодом; цифры-эмодзи больше не автоправка); находки модели в текст не вносятся: 1 подсказка, замена и удаление только как варианты', sh.found === 3 && sh.fixed === 1 && sh.auto.length === 1 && sh.findings[0].action === 'hint' && sh.findings[1].action === 'delete' && sh.findings[2].action === 'replace' && sh.findings.every((f) => f.start >= 0) && sh.text.includes('Следите за новостями канала. Главное — не пропускать обновления.') && !sh.text.includes('действительно'), JSON.stringify(sh.findings.map((f) => f.action)));
  check('D: три части — «Общее впечатление» с числом, «Проверка по списку» с «Из 50 приёмов нашлось N», «Итог»; старого счётчика «Нашёл N мест» нет', lines0[0] === '<b>Итог</b>' && lines0[3] === '<b>Общее впечатление</b>' && lines0[4] === 'Claude прочитал текст целиком и оценил его на <b>73 из 100</b>. Это его ощущение, насколько текст похож на текст нейросети.' && /<b>Проверка по списку<\/b>\nИз 50 приёмов в тексте нашлось \d+\./.test(msg.html) && /<b>Итог<\/b>\nОчень похоже на текст нейросети\. Я бы внимательно пригляделся к этому тексту 🧐/.test(msg.html) && !/Нашёл \d+ мест/.test(msg.html), lines0.slice(0, 6).join(' | '));
  check('D: «Исправил сам 1 место» — только изменённые слова с маленьким контекстом, не всё предложение', msg.html.includes('<b>Исправил сам 1 место</b>') && msg.html.includes('1. …раздел «Акции». Это <s>действительно</s> удобно и важно…') && !msg.html.includes('<b>1.</b>') && !/Исправил сам[^]*Раздел показывает, в каких акциях участвует товар[^]*Предлагаю заменить/.test(msg.html.split('<blockquote')[0]));
  check('D: «Предлагаю заменить 2 места» — цитата и ниже одно предложение; подсказка автору (п.22) не на первом экране, а в «Подробностях»', msg.html.includes('<b>Предлагаю заменить 2 места</b>') && msg.html.includes('«Следите за новостями канала.»\nМожно убрать.') && msg.html.includes('«Главное — не пропускать обновления.»\nМожно заменить на «Обновления лучше не пропускать.»') && !/Оценки без доказательств/.test(msg.html.split('<blockquote')[0]) && /<b>Подсказки автору<\/b>\n1\. «Это действительно удобно и важно для каждого продавца.»\nОценки без доказательств\./.test(msg.html) && !/ — /.test(msg.html.split('<blockquote')[0].replace(/«[^»]*»/g, '')) && msg.html.indexOf('Исправил сам') < msg.html.indexOf('Предлагаю заменить') && msg.html.indexOf('Проверка по списку') < msg.html.indexOf('Исправил сам'));
  check('D: пост с зачёркнутым — внутри «Подробностей» (blockquote), только автоправки; замены модели в нём нет', msg.html.includes('<b>Пост с правками</b>') && msg.html.indexOf('<blockquote') < msg.html.indexOf('<b>Пост с правками</b>') && msg.html.includes('Это <s>действительно</s> удобно') && !msg.html.includes('<s>Следите') && msg.clean_parts.length === 1);
  // кнопки применения замен: номера в тексте = кнопки; нажатие применяет кодом, без модели
  const btnTexts = msg.buttons.flat().map((b) => b.text);
  check('кнопки правок: «Применить правку 1», «2» и «Применить все правки»; «Принять»/«Оставить» нет', msg.has_buttons && msg.btn_n === 2 && JSON.stringify(btnTexts) === JSON.stringify(['Применить правку 1', 'Применить правку 2', 'Применить все правки']) && /<b>Предлагаю заменить 2 места<[/]b>\n1\. /.test(msg.html) && !/Принять|Оставить/.test(JSON.stringify(msg.buttons)), JSON.stringify(btnTexts));
  const sdF = {};
  B.registerResult(sdF, '42', '77', NOW, msg.payload);
  const press = (data, sdX = sdF) => B.route({ callback_query: { id: 'qf', data, from: { id: 42 }, message: { message_id: 77, chat: { id: 42 }, text: 'Результат' } } }, sdX, NOW);
  const f1 = press('fix:1'), f2 = press('fix:2'), f1b = press('fix:1');
  const outTxt = (r) => r.parts.slice(1).join('');
  check('кнопка 1: ответ сразу (cb_id, toast), «Готово, применил правку 1. Вот текст:», в тексте замена 1 и автоправка, замены 2 ещё нет', f1.route === 'apply' && f1.cb_id === 'qf' && !!f1.toast && f1.parts[0] === 'Готово, применил правку 1. Вот текст:' && !outTxt(f1).includes('Следите за новостями') && outTxt(f1).includes('Главное — не пропускать обновления.') && !outTxt(f1).includes('действительно'), f1.parts.join('|').slice(0, 300));
  check('кнопка 2 после 1: в тексте обе замены (накопительно), в шапке «правки 1 и 2»', /применил правку 2\. Сейчас применены правки 1 и 2\./.test(f2.parts[0]) && !outTxt(f2).includes('Следите за новостями') && outTxt(f2).includes('Обновления лучше не пропускать.') && !outTxt(f2).includes('Главное — не пропускать'), f2.parts.join('|').slice(0, 300));
  check('повтор кнопки 1: «Эта правка уже применена», нового сообщения нет', f1b.toast === 'Эта правка уже применена' && f1b.already === true && f1b.parts.length === 0);
  const fAll = press('fix:all');
  check('«все» после 1 и 2: «Все правки уже применены», без сообщения', fAll.toast === 'Все правки уже применены' && fAll.parts.length === 0);
  const sdA = {}; B.registerResult(sdA, '42', '77', NOW, msg.payload);
  const fa = press('fix:all', sdA);
  check('«применить все» сразу: обе замены, «Готово, применил все правки.», факты целы', fa.parts[0] === 'Готово, применил все правки. Вот текст:' && !outTxt(fa).includes('Следите за новостями') && outTxt(fa).includes('Обновления лучше не пропускать.') && sdA.results['42:77'].applied.join() === '1,2');
  const sdB = {}; B.registerResult(sdB, '42', '77', NOW, msg.payload); press('fix:2', sdB);
  const fb = press('fix:all', sdB);
  check('«все» после 2: применяется только оставшаяся (1)', /применил все правки/.test(fb.parts[0]) && sdB.results['42:77'].applied.join() === '1,2');
  const ov = { ...msg.payload, suggs: [{ start: 10, end: 40, ins: 'a' }, { start: 30, end: 60, ins: 'b' }], auto: [], applied: [] };
  const sdO2 = {}; B.registerResult(sdO2, '42', '77', NOW, ov);
  const o1 = press('fix:1', sdO2), o2 = press('fix:2', sdO2);
  check('пересечение замен: вторая не применяется, «Эту правку не получилось применить автоматически, поправьте вручную», сообщения нет', o1.parts.length > 0 && o2.toast === 'Эту правку не получилось применить автоматически, поправьте вручную' && o2.parts.length === 0 && sdO2.results['42:77'].applied.join() === '1');
  const bad = { ...msg.payload, suggs: [{ start: msg.payload.text.indexOf('Следите'), end: msg.payload.text.indexOf('Следите') + 5, ins: 'Лучше 2027' }], auto: [], applied: [] };
  const sdBad = {}; B.registerResult(sdBad, '42', '77', NOW, bad);
  check('проверка фактов не прошла (добавилось число) → «не получилось применить автоматически», текст не выдан', /не получилось применить автоматически/.test(press('fix:1', sdBad).toast) && press('fix:1', sdBad).parts.length === 0);
  // кнопки под присланным текстом: оставшиеся правки того же результата, ключ — исходное сообщение (77), нажатия копятся
  const sdR = {}; B.registerResult(sdR, '42', '77', NOW, msg.payload);
  const pressFrom = (data, mid, sdX) => B.route({ callback_query: { id: 'qr', data, from: { id: 42 }, message: { message_id: mid, chat: { id: 42 }, text: 'Готово, применил правку 1. Вот текст:' } } }, sdX, NOW);
  const r1 = press('fix:1', sdR);
  check('после правки 1 остаётся правка 2: rm = [2], rm_n = 1, orig = номер исходного сообщения, «Все правки применены» ещё нет', JSON.stringify(r1.rm) === '[2]' && r1.rm_n === 1 && r1.orig === '77' && !r1.parts.includes('Все правки применены.'));
  const r2 = pressFrom('fix:2:77', 90, sdR);
  check('кнопка из присланного текста «fix:2:77» (message_id 90) → тот же результат 42:77, правки 1 и 2 накоплены, кнопок нет, последняя строка «Все правки применены.»', r2.route === 'apply' && /Сейчас применены правки 1 и 2/.test(r2.parts[0]) && sdR.results['42:77'].applied.join() === '1,2' && r2.rm_n === 0 && r2.rm.length === 0 && r2.parts[r2.parts.length - 1] === 'Все правки применены.');
  const sdR2 = {}; B.registerResult(sdR2, '42', '77', NOW, msg.payload);
  const rAll = pressFrom('fix:all:77', 91, sdR2);
  check('«fix:all:77» из присланного текста применяет все, кнопок нет, строка «Все правки применены.»', /применил все правки/.test(rAll.parts[0]) && rAll.rm_n === 0 && rAll.parts[rAll.parts.length - 1] === 'Все правки применены.');
  const rAgain = pressFrom('fix:1:77', 92, sdR2);
  check('повтор уже применённой правки из присланного текста → «Эта правка уже применена», без сообщений', rAgain.toast === 'Эта правка уже применена' && rAgain.parts.length === 0);
  const three = { ...msg.payload, text: 'Одна фраза про акции. Вторая фраза про цены. Третья фраза про остатки. Четвёртая фраза про отзывы.', links: [], auto: [], applied: [], suggs: [['Одна фраза', 'Первая фраза'], ['Вторая фраза', 'Другая фраза'], ['Третья фраза', 'Иная фраза']].map(([a, b]) => ({ start: 'Одна фраза про акции. Вторая фраза про цены. Третья фраза про остатки. Четвёртая фраза про отзывы.'.indexOf(a), end: 'Одна фраза про акции. Вторая фраза про цены. Третья фраза про остатки. Четвёртая фраза про отзывы.'.indexOf(a) + a.length, ins: b })) };
  const sdT = {}; B.registerResult(sdT, '42', '77', NOW, three);
  const t2 = pressFrom('fix:2:77', 90, sdT);
  check('из трёх правок применена вторая → остаются 1 и 3 (rm = [1, 3]), кнопки только для них', JSON.stringify(t2.rm) === '[1,3]' && t2.rm_n === 2 && t2.orig === '77');
  check('нет сохранённого результата → «устарела», без падения', /устарела/.test(press('fix:1', {}).toast));
  const one = { ...msg.payload, suggs: msg.payload.suggs.slice(0, 1) };
  check('одна замена → одна кнопка, «Применить все» нет; без замен кнопок нет', B.buildMessage({ ...item, fix: { ...sh, findings: sh.findings.filter((f) => f.sign === 22) } }).buttons.flat().every((b) => !/все/.test(b.text)) && B.buildMessage({ ...item, fix: E.apply(TEXT, { findings: [] }) }).buttons.length === 0 && one.suggs.length === 1);
  check('сообщение: оговорка про «оценка после правки может снизиться» убрана, «Применил N правок» нет', !/может снизиться/.test(msg.html) && !/Применил/.test(msg.html));
  check('C: чистовик = исходный текст + безопасные автоправки; предложения модели (удалить «Следите…», заменить «Главное — …») в него не попали', msg.clean_parts.length === 1 && !/<s>|<b>/.test(msg.clean_parts[0]) && msg.clean_parts[0].includes('Следите за новостями канала.') && msg.clean_parts[0].includes('Главное — не пропускать обновления.') && msg.clean_parts[0].includes('1️⃣ Видно') && !msg.clean_parts[0].includes('действительно удобно'));
  check('сообщение: порядок блоков — итог, общее впечатление, проверка по списку, автоправки, можно заменить, одна «Подробности»; старых «Где именно»/«Ответ модели»/«Правку не применял» нет', msg.html.indexOf('<b>Итог</b>') === 0 && msg.html.indexOf('<b>Итог</b>') < msg.html.indexOf('Общее впечатление') && msg.html.indexOf('Общее впечатление') < msg.html.indexOf('Проверка по списку') && msg.html.indexOf('Проверка по списку') < msg.html.indexOf('Исправил сам') && (msg.html.match(/<b>Подробности<\/b>/g) || []).length === 1 && !/Где именно|Ответ модели|Правку не применял/.test(msg.html));
  check('сообщение: валидный HTML (нет сырых < внутри текста поста)', !/<(?!\/?(?:b|i|a|code|pre|u|s|blockquote)[ >])/.test(msg.html.replace(/&lt;/g, '')));
  check('C: без автоправок чистовик не присылаем; опечатка п.50 — в сообщении с правильной формой, в чистовике только текст поста', (() => {
    const T50 = 'Каждое утро менеджер открывает отчёты и ищет, где просели продажи. Это занимает час. Тогда никто не ищет цифры, вы проверяет выводы и принимает решение. Результат лежит в одной таблице, с ним удобно работать всей команде магазина.';
    const f50 = E.apply(T50, { findings: [{ quote: 'вы проверяет выводы', sign: '50. Ошибка или опечатка', why: 'согласование', fix: '' }] });
    const none = B.buildMessage({ chat_id: '1', progress_id: 1, text: T50, ...B.scoreStep([ans('Оценка: 40'), ans('Оценка: 40'), ans('Оценка: 40')]), highlights: [], layout: [], fix: f50 });
    const T50b = T50 + ' Всё действительно просто.';
    const f50b = E.apply(T50b, { findings: [{ quote: 'вы проверяет выводы', sign: '50. Ошибка или опечатка', why: 'согласование', fix: '' }] });
    const yes = B.buildMessage({ chat_id: '1', progress_id: 1, text: T50b, ...B.scoreStep([ans('Оценка: 40'), ans('Оценка: 40'), ans('Оценка: 40')]), highlights: [], layout: [], fix: f50b });
    return none.clean_parts.length === 0 && !none.has_buttons && /Ещё заметил опечатку: «вы проверяет выводы», правильно «вы проверяете»/.test(none.html) && yes.clean_parts.length === 1 && /^Перед публикацией проверьте: «вы проверяете/.test(yes.pre_note) && !none.pre_note && !/Перед публикацией/.test(yes.clean_parts[0]) && yes.clean_parts[0].startsWith('Каждое утро менеджер') && /Ещё заметил опечатку: «вы проверяет выводы», правильно «вы проверяете»/.test(yes.html) && !yes.clean_parts[0].includes('действительно');
  })());
  check('п.50: правильная форма «вы проверяете выводы и принимаете решение» — отдельной строкой «Ещё заметил опечатку»', (() => {
    const T = 'Каждое утро менеджер открывает отчёты и ищет, где просели продажи. Это занимает час. Тогда никто не ищет цифры, вы проверяет выводы и принимает решение. Результат лежит в одной таблице, с ним удобно работать всей команде магазина.';
    const f = E.apply(T, { findings: [{ quote: 'Тогда никто не ищет цифры, вы проверяет выводы и принимает решение.', sign: '50. Ошибка или опечатка', why: 'согласование', fix: '' }] });
    const m = B.buildMessage({ chat_id: '1', progress_id: 1, text: T, ...B.scoreStep([ans('Оценка: 40'), ans('Оценка: 40'), ans('Оценка: 40')]), highlights: [], layout: [], fix: f });
    return /Ещё заметил опечатку: «Тогда никто не ищет цифры, вы проверяет выводы и принимает решение\.», правильно «вы проверяете выводы и принимаете решение»/.test(m.html.split('<blockquote')[0]);
  })());
  check('«, а не» без находки п.1 у модели — заметка про противопоставление; если п.1 есть — не дублируем', (() => {
    const T = 'Смотрите динамику, а не разовые замеры. Каждое утро менеджер открывает отчёты и ищет, где просели продажи. Это занимает час, а результат лежит в одной таблице для всей команды магазина.';
    const sc = B.scoreStep([ans('Оценка: 40'), ans('Оценка: 40'), ans('Оценка: 40')]);
    const none = B.buildMessage({ chat_id: '1', progress_id: 1, text: T, ...sc, highlights: [], layout: [], fix: E.apply(T, { findings: [] }) });
    const has = B.buildMessage({ chat_id: '1', progress_id: 1, text: T, ...sc, highlights: [], layout: [], fix: E.apply(T, { findings: [{ quote: 'Смотрите динамику, а не разовые замеры.', sign: '1. Антитеза', why: 'антитеза', fix: 'Смотрите динамику.' }] }) });
    return /<b>Проверка по списку<[/]b>\nИз 50 приёмов в тексте нашлось \d+\.\n1\. «Смотрите динамику, а не разовые замеры\.»\nПротивопоставление/.test(none.html) && (has.html.split("<blockquote")[0].match(/разовые замеры/g) || []).length === 1;
  })());
  check('/help и /start: список автоправок один и совпадает с кодом, цифр-эмодзи в нём нет', (() => {
    const h = B.HELP || '', st = B.START || '';
    // список AUTO_LIST сверяем с видами автоправок safe_fix по смыслу: зачин, призыв, восклицательный знак, усилитель; цифр-эмодзи нет
    const kinds = ['LEAD', 'CTA', 'EXC', 'AMP'].filter((k) => fs.readFileSync(require('path').join(__dirname, '..', 'src', 'safe_fix.js'), 'utf8').includes("kind: '" + k + "'"));
    const meaning = (t) => /Важно отметить/.test(t) && /Пишите в комментариях/.test(t) && /восклицательн/.test(t) && /«действительно»/.test(t) && /«по-настоящему»/.test(t);
    return meaning(B.AUTO_LIST || '') && h.includes(B.AUTO_LIST) && st.length > 0 && kinds.length === 4 && !/цифры-эмодзи|Цифры-эмодзи/.test(h + st);
  })());
  check('линтер-подсветка без дублей: место, уже названное моделью, не повторяется в «Ещё я заметил»', msg.html.indexOf('Ещё я заметил') < 0 || msg.html.slice(msg.html.indexOf('Ещё я заметил'), msg.html.indexOf('</blockquote>')).indexOf('«Следите за новостями канала.') < 0);
  const noPlace = B.buildMessage({ ...item, highlights: [], fix: E.apply(TEXT, { findings: [] }), layout: [] });
  check('B: разбор ничего не нашёл, но в тексте есть безопасное → «Исправил сам 1 место», блока «Предлагаю заменить» нет', /Исправил сам 1 место/.test(noPlace.html) && !/Предлагаю заменить/.test(noPlace.html) && !noPlace.has_buttons && noPlace.clean_parts.length === 1, noPlace.html.slice(0, 220));
  const quiet = B.buildMessage({ ...item, text: LONG, highlights: [], layout: [], fix: E.apply(LONG, { findings: [] }) });
  check('B: ни находок, ни безопасных правок, оценка 73 → «Ни одного приёма из списка», «Исправлять самому было нечего», итог «видит шаблонность в целом», без кнопок и чистовика', /Сам ничего не менял: безопасных автоправок/.test(quiet.html) && /Из 50 приёмов|Ни одного приёма из списка не нашлось/.test(quiet.html) && /Claude видит шаблонность в целом, но конкретных приёмов мало/.test(quiet.html) && !quiet.has_buttons && quiet.clean_parts.length === 0, quiet.html.slice(0, 420));
  const low = B.buildMessage({ ...item, ...B.scoreStep([ans('Оценка: 12'), ans('Оценка: 15'), ans('Оценка: 12')]), fix: undefined });
  const lowErr = B.buildMessage({ ...item, ...B.scoreStep([ans('Оценка: 12'), ans('Оценка: 15'), ans('Оценка: 12')]), fix_error: true, fix: undefined, tscore: undefined });
  check('сообщение: модель низко, проверка текста не удалась → «Подробно проверить текст не получилось», число на месте, итог про пару приёмов (код нашёл 2 шаблона), без кнопок', /Подробно проверить текст не получилось/.test(lowErr.html) && /оценил его на <b>13 из 100<[/]b>/.test(lowErr.html) && /<b>Итог<\/b>\nВ целом звучит живо, но пара приёмов есть/.test(lowErr.html) && !low.has_buttons && low.clean_parts.length === 0, lowErr.html.slice(0, 600));
  // прозрачный балл: формула и защиты
  const mk = (n, sign, text) => Array.from({ length: n }, (_, i) => ({ sign, start: text.indexOf('Фраза ' + (i + 1)), end: text.indexOf('Фраза ' + (i + 1)) + 7 }));
  const T6 = [1, 2, 3, 4, 5, 6].map((i) => 'Фраза ' + i + ' ' + 'слово '.repeat(20)).join(String.fromCharCode(10, 10));
  const two = S.scoreText(T6, [...mk(1, 1, T6), ...mk(1, 24, T6).map((x) => ({ ...x, start: T6.indexOf('Фраза 2'), end: T6.indexOf('Фраза 2') + 7 }))], []);
  check('балл: две сильные находки (вес 3) в двух частях из шести → 33 и не выше средней зоны', S.splitParts(T6).length === 6 && two.score === 33 && two.zone === 'mid' && two.flagged === 2, JSON.stringify(two));
  const sameSign = S.scoreText(T6, [1, 2, 3].map((i) => ({ sign: 1, start: T6.indexOf('Фраза ' + i), end: T6.indexOf('Фраза ' + i) + 7 })), []);
  check('балл: один пункт засчитывается не больше 2 раз', sameSign.flagged === 2 && sameSign.contribs.length === 1 && sameSign.contribs[0].points === 33, JSON.stringify(sameSign));
  const full = S.scoreText(T6, [4, 5, 6, 8, 9, 11, 15, 17, 18, 21, 22, 28].map((sg, i) => { const st = T6.indexOf('Фраза ' + (Math.floor(i / 2) + 1)) + (i % 2) * 8; return { sign: sg, start: st, end: st + 6 }; }), []);
  check('балл: все шесть частей отмечены двумя приёмами по весу 1, 12 разных пунктов → 100, «много приёмов»', full.flagged === 6 && full.distinct === 12 && full.score === 100 && full.zone === 'high', JSON.stringify(full));
  const capped = S.scoreText('Фраза 1 ' + 'слово '.repeat(30), [{ sign: 1, start: 0, end: 7 }, { sign: 24, start: 8, end: 12 }], []);
  check('балл: два приёма в единственной части — 100 по доле, но потолок: не выше средней зоны', capped.score === 44 && capped.capped === true && capped.zone === 'mid', JSON.stringify(capped));
  // защита «два оборота → 90»: высокая оценка модели, но находок разных пунктов меньше 3 → средняя зона и пояснение
  const P2 = TEXT.replace(/[0-9]️?⃣ /g, '');
  const hi2 = B.buildMessage({ ...item, text: P2, ...B.scoreStep([ans('Оценка: 90'), ans('Оценка: 88'), ans('Оценка: 92')]), fix: E.apply(P2, { findings: [F({ q: 'Это действительно удобно и важно для каждого продавца.', s: '22. Оценки без опоры', w: 'без цифры' }), F({ q: 'Следите за новостями канала.', s: '24. Призыв в конце', w: 'призыв', f: '' })] }) });
  check('зона: оценка модели 90, но приёмов меньше 3 → «Claude видит шаблонность в целом, но конкретных приёмов мало», число 90 сохранено, «Очень похоже» нет', /оценил его на <b>90 из 100<[/]b>/.test(hi2.html) && /Claude видит шаблонность в целом, но конкретных приёмов мало\. Перечитайте текст сами\./.test(hi2.html) && !/Очень похоже на текст нейросети|весь набор/.test(hi2.html), hi2.html.slice(0, 500));
  const hi3 = B.buildMessage({ ...item, ...B.scoreStep([ans('Оценка: 55'), ans('Оценка: 55'), ans('Оценка: 55')]) });
  check('зона: оценка 55 и три и более приёмов → «Очень похоже… 🧐»', /<b>Итог<\/b>\nОчень похоже на текст нейросети\. Я бы внимательно пригляделся к этому тексту 🧐/.test(hi3.html) && !/видит шаблонность в целом/.test(hi3.html));
  check('зона: границы 29.9/30/54.9/55 без находок', B.finalZone(29.9, [], false).zone === 'low' && B.finalZone(30, [], false).zone === 'mid' && B.finalZone(54.9, [], false).zone === 'mid' && B.finalZone(55, [], false).zone === 'high' && B.finalZone(55, [], true).zone === 'mid');
  check('зона: многоточия и «))» на зону не влияют (только оценка модели и число приёмов)', B.finalZone(40, [], false, []).zone === 'mid' && B.finalZone(40, [], false, [], 'Ну вот так... и всё').zone === 'mid' && B.finalZone(40, [], false, []).live === undefined && B.liveMarks === undefined);
  // живой текст: оценка модели < 30 → ноль правок, находки только заметками, не больше 3
  const liveFx = E.apply(TEXT, { findings: [F({ q: 'Это действительно удобно и важно для каждого продавца.', s: '22. Оценки без опоры' }), F({ q: 'Следите за новостями канала.', s: '24. Призыв в конце', f: '' }), F({ q: 'Главное — не пропускать обновления.', s: '9. Вывод-мораль', f: 'Обновления лучше не пропускать.' }), F({ q: 'Хотите попробовать?', s: '3. Вопрос и сразу ответ', f: '' })] }, { noEdit: true });
  check('живой текст: noEdit → 0 правок, текст не изменён', liveFx.fixed === 0 && liveFx.text === TEXT && liveFx.status === 'unchanged' && liveFx.edits.length === 0 && liveFx.findings.every((f) => f.action !== 'replace' && f.action !== 'delete'), JSON.stringify(liveFx.findings.map((f) => f.action)));
  const liveMsg = B.buildMessage({ ...item, ...B.scoreStep([ans('Оценка: 8'), ans('Оценка: 10'), ans('Оценка: 6')]), fix: liveFx });
  check('живой текст 8: три части, итог «пара приёмов» (5 приёмов в списке), чистовика и кнопок нет, «Пост с правками» нет, подсказки автору не на первом экране', /оценил его на <b>8 из 100<[/]b>/.test(liveMsg.html) && /<b>Проверка по списку<\/b>\nИз 50 приёмов в тексте нашлось \d/.test(liveMsg.html) && /<b>Итог<\/b>\nВ целом звучит живо, но пара приёмов есть, их можно поправить\./.test(liveMsg.html) && !/Заметил только это|Исправил сам|Предлагаю заменить|Оценки без доказательств/.test(liveMsg.html.split('<blockquote')[0]) && /Подсказки автору/.test(liveMsg.html) && !liveMsg.has_buttons && liveMsg.clean_parts.length === 0 && !/Пост с правками/.test(liveMsg.html), liveMsg.html.slice(0, 700));
const T12 = 'Каждое утро менеджер открывает отчёты и ищет, где просели продажи. Это занимает час. Тогда никто не ищет цифры, вы проверяет выводы и принимает решение. Результат лежит в одной таблице, с ним удобно работать всей команде магазина.';
  const live12 = B.buildMessage({ chat_id: '1', progress_id: 1, text: T12, ...B.scoreStep([ans('Оценка: 12'), ans('Оценка: 12'), ans('Оценка: 12')]), highlights: [], layout: [], fix: E.apply(T12, { findings: [F({ q: 'Это занимает час.', s: '22. Оценки без опоры', w: 'без цифры' }), F({ q: 'вы проверяет выводы', s: '50. Ошибка или опечатка', w: 'согласование', f: '' })] }, { noEdit: true }) });
  const live12top = live12.html.split('<blockquote')[0];
  check('живой текст 12 с опечаткой и подсказкой: ниже 20 и приёмов нет → «Вообще почти не вижу признаков AI 😎», опечатка отдельной строкой, подсказок автору на первом экране нет, а в «Подробностях» есть', /<b>Итог<[/]b>\nВообще почти не вижу признаков AI 😎/.test(live12top) && /Ещё заметил опечатку: «вы проверяет выводы», правильно «вы проверяете»/.test(live12top) && !/Оценки без доказательств|Подсказки автору/.test(live12top) && /<b>Подсказки автору<[/]b>/.test(live12.html) && !live12.has_buttons, live12top);
  const none22 = B.buildMessage({ ...item, text: LONG, ...B.scoreStep([ans('Оценка: 22'), ans('Оценка: 22'), ans('Оценка: 22')]), highlights: [], layout: [], fix: E.apply(LONG, { findings: [] }) });
  check('текст 22 без находок: «Ни одного приёма из списка не нашлось», «Похоже на живой текст», «конкретных мест не нашёл» больше нет', /Ни одного приёма из списка не нашлось\./.test(none22.html) && /<b>Итог<\/b>\nПохоже на живой текст\./.test(none22.html) && !/Конкретных мест не нашёл/.test(none22.html), none22.html.slice(0, 400));
  const mean = (n) => B.scoreStep([ans('Оценка: ' + n), ans('Оценка: ' + n), ans('Оценка: ' + n)]);
  const x6 = E.apply(TEXT, { findings: [F({ q: 'Следите за новостями канала.', s: '24. Призыв в конце', f: '' }), F({ q: 'Главное — не пропускать обновления.', s: '9. Вывод-мораль', f: 'Обновления лучше не пропускать.' }), F({ q: 'Хотите попробовать?', s: '3. Вопрос и сразу ответ', f: '' }), F({ q: 'Это действительно удобно и важно для каждого продавца.', s: '23. Усилители', f: '' })] });
  const m65 = B.buildMessage({ ...item, ...mean(65), fix: x6 });
  check('65 с шестью приёмами: «Очень похоже… 🧐»', /<b>Итог<\/b>\nОчень похоже на текст нейросети\. Я бы внимательно пригляделся к этому тексту 🧐/.test(m65.html), m65.html.slice(0, 500));
  const m91 = B.buildMessage({ ...item, ...mean(91), fix: x6 });
  check('91 и три и более приёмов: «Да тут вообще весь набор 😳»', /<b>Итог<\/b>\nДа тут вообще весь набор 😳/.test(m91.html), m91.html.slice(0, 500));
  const m70 = B.buildMessage({ ...item, text: LONG, ...mean(70), highlights: [], layout: [], fix: E.apply(LONG, { findings: [F({ q: 'Сегодня в сервисе обновился раздел акций.', s: '24. Призыв в конце', f: '' })] }) });
  check('70 с одним приёмом: «видит шаблонность в целом», «Очень похоже» нет', /<b>Итог<\/b>\nClaude видит шаблонность в целом, но конкретных приёмов мало\. Перечитайте текст сами\./.test(m70.html) && !/Очень похоже/.test(m70.html), m70.html.slice(0, 500));
  const m15 = B.buildMessage({ ...item, text: LONG, ...mean(15), highlights: [], layout: [], fix: E.apply(LONG, { findings: [] }) });
  check('оценка ниже 20 и приёмов 0: «Вообще почти не вижу признаков AI 😎»; 25 и 0 приёмов — просто «Похоже на живой текст»', /Вообще почти не вижу признаков AI 😎/.test(m15.html) && !/Вообще почти не вижу/.test(none22.html));
  const onlyHints = B.buildMessage({ ...item, fix: E.apply(TEXT, { findings: [F({ q: 'Это действительно удобно и важно для каждого продавца.', s: '22', w: 'без цифры' })] }) });
  check('только подсказки автору (и безопасные автоправки): «Предлагаю заменить» нет, подсказка только в «Подробностях» под «Подсказки автору»', onlyHints.fix_ok === undefined && !/Предлагаю заменить/.test(onlyHints.html) && /<b>Подсказки автору<[/]b>/.test(onlyHints.html) && !/Оценки без доказательств/.test(onlyHints.html.split('<blockquote')[0]) && onlyHints.clean_parts.length === 1 && !/Следите/.test(onlyHints.html.split('<blockquote')[0]));
  const dotted = B.buildMessage({ ...item, fix_error: true, fix: undefined });
  check('сообщение: сбой проверки не роняет, исходник сохранён', /Подробно проверить текст не получилось/.test(dotted.html) && !dotted.has_buttons);


  // ---- шаг 16: сообщение — применённые пары, «Ещё стоит посмотреть», одна «Подробности», /catalog ----
  const ET = ['📌 Первый пункт про акции, он идёт в разделе сервиса для продавцов.', '', '💡 Второй пункт про цены, он идёт ниже в сервисе для продавцов.', '', '✅ Третий пункт про остатки, он идёт последним в этом посте для продавцов.', '',
    'Это действительно важный раздел для всех. Это действительно удобный раздел для всех. Это действительно быстрый раздел для всех.', '', 'Что нового в разделе? Что нового с ценами? Что нового с остатками?'].join(NL);
  const efs = [['📌 Первый пункт про акции, он идёт в разделе сервиса для продавцов.', '30. Эмодзи в начале строк'], ['💡 Второй пункт про цены, он идёт ниже в сервисе для продавцов.', '30. Эмодзи в начале строк'],
    ['Это действительно важный раздел для всех.', '23. Усилители', 'Это важный раздел для всех.'], ['Это действительно удобный раздел для всех.', '23. Усилители', 'Это удобный раздел для всех.'], ['Это действительно быстрый раздел для всех.', '23. Усилители', 'Это быстрый раздел для всех.'],
    ['Что нового в разделе?', '32. Вопросы-подзаголовки', 'Что нового в разделе:'], ['Что нового с ценами?', '32. Вопросы-подзаголовки', 'Что нового с ценами:'], ['Что нового с остатками?', '32. Вопросы-подзаголовки', 'Что нового с остатками:']]
    .map(([q, s, f]) => F({ q, s, f: f || '' }));
  const efx = E.apply(ET, { findings: efs });
  const emM = B.buildMessage({ chat_id: '1', progress_id: 1, text: ET, ...li, ...B.scoreStep([ans('Оценка: 60'), ans('Оценка: 62'), ans('Оценка: 61')]), highlights: [], layout: [{ rule: 'C02', before: '📌 Первый', after: '— Первый' }], fix: efx });
  const emTop = emM.html.split('<blockquote')[0];
  check('сообщение: три эмодзи-заметки — одна строка «Эмодзи в начале строк, 3 раза. Возможно, это стиль канала, решать вам.», предложения заменить эмодзи на тире нет', (emTop.match(/Эмодзи в начале строк/g) || []).length === 1 && /Эмодзи в начале строк, 3 раза\. Возможно, это стиль канала, решать вам\./.test(emTop) && !/Эмодзи в начале строки|→ «— Первый/.test(emM.html), emTop);
  check('сообщение: три «Подзаголовки-вопросы» — один пункт «Таких мест ещё 2»; три усилителя исправлены кодом (3 пары)', /Подзаголовки-вопросы\. Таких мест ещё 2\./.test(emTop) && (emTop.match(/Подзаголовки-вопросы/g) || []).length === 1 && /Исправил сам 3 места/.test(emTop), emTop);
  const efx2 = E.apply(ET, { findings: efs.slice(5).map((f) => ({ ...f, sign: '3. Вопрос и сразу ответ' })) });
  const em2 = B.buildMessage({ chat_id: '1', progress_id: 1, text: ET, ...li, ...B.scoreStep([ans('Оценка: 60'), ans('Оценка: 62'), ans('Оценка: 61')]), highlights: [], layout: [], fix: efx2 });
  const det2 = em2.html.slice(em2.html.indexOf('<blockquote'));
  check('сообщение: замены без варианта — один раз, человеческими словами, в «Подробностях», без «пункт N», «sentinel»', /Почему не предлагаю замену/.test(det2) && (em2.html.match(/больше двоеточий/g) || []).length === 1 && !/пункт \d|sentinel|п\.\d/.test(em2.html), det2);
  const many = Array.from({ length: 7 }, (_, i) => 'Фраза номер ' + (i + 1) + ' про раздел сервиса действительно важна для всех.');
  const MT = many.join(NL + NL);
  const mfx = E.apply(MT, { findings: many.map((q, i) => F({ q, s: '23. Усилители', f: 'Фраза номер ' + (i + 1) + ' про раздел сервиса важна для всех.' })) });
  const mm = B.buildMessage({ chat_id: '1', progress_id: 1, text: MT, ...li, ...B.scoreStep([ans('Оценка: 60'), ans('Оценка: 62'), ans('Оценка: 61')]), highlights: [], layout: [], fix: mfx });
  check('сообщение: все 7 автоправок (усилитель «действительно») есть в списке «было → стало», не «…и ещё N»', mfx.fixed === 7 && /Исправил сам 7 мест/.test(mm.html) && (mm.html.split('<blockquote')[0].match(/<s>действительно<[/]s>/g) || []).length === 7 && !/…и ещё/.test(mm.html.split('<blockquote')[0]), mm.html.slice(0, 300));
  const cat = B.route({ message: { message_id: 1, chat: { id: 9 }, text: '/catalog' } }, {}, NOW);
  check('/catalog: список 50 пунктов короткими названиями, /help его упоминает', cat.route === 'reply' && /Все 50 приёмов/.test(cat.reply) && /\n50\. Ошибка или опечатка/.test(cat.reply) && /\n1\. Противопоставление/.test(cat.reply) && cat.reply.length < 4096 && /\/catalog/.test(B.HELP) && /50 шаблонных приёмов/.test(B.HELP));

  // ---- очень шаблонный пост (кофе): очевидные шаблоны ловим кодом, без модели ----
  {
    const CT = require('./coffee_text');
    const cf = E.apply(CT, { findings: [F({ q: 'Эспрессо крепче на вкус.', s: '48. Довод, который не держит', w: 'довод' })] });
    check('п.48 не ставится на короткое утвердительное предложение-факт «Эспрессо крепче на вкус.»', cf.findings.length === 0 && cf.dropped.some((d) => /короткий факт/.test(d.why)), JSON.stringify(cf.findings));
    const lead = E.apply(CT, { findings: [F({ q: 'Задумывались ли вы, сколько секретов скрывается за привычным ароматом?', s: '25. Вопрос ради вовлечения', f: '' })] });
    check('«Задумывались ли вы…» не считается «вопросом читателю по делу»', lead.findings.length === 1 && !/по делу/.test(lead.findings[0].reason || ''), JSON.stringify(lead.findings));
    const cm = B.buildMessage({ chat_id: '1', progress_id: 1, text: CT, ...lintStep(CT, 5), ...B.scoreStep([ans('Оценка: 91'), ans('Оценка: 90'), ans('Оценка: 92')]), fix: E.apply(CT, { findings: [] }) });
    const top = cm.html.split('<blockquote')[0];
    check('кофейный пост: названы все 6 очевидных шаблонов и много смайликов, без модели', [/Заголовок с числом и громким обещанием/, /Вопрос-заход/, /Стрелка-указатель/, /Нумерация цифрами-эмодзи/, /Вопрос в конце ради ответов/, /Обещание удивить/, /Много смайликов, \d+ на пост/].every((r) => r.test(top)), top);
    check('кофейный пост: «Общее впечатление» 91, «Из 50 приёмов нашлось N», итог «весь набор 😳» первым, очевидные шаблоны первыми', /^<b>Итог<\/b>/.test(cm.html) && /<b>Общее впечатление<\/b>\nClaude прочитал текст целиком и оценил его на <b>91 из 100<\/b>\./.test(cm.html) && /<b>Проверка по списку<\/b>\nИз 50 приёмов в тексте нашлось \d+\.\n1\. «☕️ 3 факта/.test(top) && /<b>Итог<\/b>\nДа тут вообще весь набор 😳/.test(top) && top.indexOf('Заголовок с числом') < top.indexOf('Вопрос-заход'), top);
    check('кофейный пост: полный список по пунктам каталога в «Подробностях», без «…и ещё N»', /<b>Весь список по пунктам<\/b>[^]*\n4\. Шаблонная подводка\./.test(cm.html) && /\n37\. Шаблонный заголовок\./.test(cm.html) && !/…и ещё/.test(cm.html), cm.html.slice(cm.html.indexOf('Весь список')));
  }

  // G: длинный ответ
  const big = [];
  for (let i = 0; i < 40; i++) big.push(`Абзац ${i}. Здесь написано довольно длинное предложение про работу раздела акций & <теги> для селлеров. Ещё одно предложение с пояснением.`);
  const bigText = big.join(NL + NL);
  const rr = [];
  for (const k of [3, 20, 37]) { const s0 = bigText.indexOf('Ещё одно предложение', bigText.indexOf('Абзац ' + k + '.')); rr.push({ n: k, start: s0, end: s0 + 'Ещё одно предложение с пояснением.'.length, quote: 'Ещё одно предложение с пояснением.', reason: 'вода', covered_by: null, covered_by_quote: null }); }
  const fakeShort = { status: 'fixed', text: bigText, length_change: -0.05, found: 3, fixed: 3, findings: rr.map((r, i) => ({ n: i + 1, quote: r.quote, sign: 9, title: 'Вывод-мораль', why: 'вывод', fix: '', action: 'delete', reason: null })), edits: rr.map((r) => ({ start: r.start, end: r.end, ins: '' })) };
  const bm = B.buildMessage({ ...item, text: bigText, fix: fakeShort });
  check('G: не длиннее 4096 знаков даже для огромного поста', bm.html.length <= 4096 && bm.html.length > 1000, String(bm.html.length));
  check('G: показаны только изменённые фрагменты, зачёркнутое на месте', (bm.html.match(/<s>Ещё/g) || []).length === 6 && !bm.html.includes('Абзац 10.'), bm.html.slice(0, 200));
  check('G: теги закрыты, & < > экранированы', (bm.html.match(/<s>/g) || []).length === (bm.html.match(/<\/s>/g) || []).length && !/&(?!amp;|lt;|gt;|quot;)/.test(bm.html) && bm.html.includes('&lt;теги&gt;'));
  check('G: чистовик >4096 разбит на части по ≤4096', bm.clean_parts.length >= 2 && bm.clean_parts.every((p) => p.length <= 4096), JSON.stringify(bm.clean_parts.map((p) => p.length)));
  check('cutEsc: режет по границе абзаца', B.cutEsc('Первый абзац.' + NL + NL + 'Второй абзац длинный.', 20) === 'Первый абзац.…');
  const sm = B.marked('Раз. Два. Три.', [{ start: 5, end: 9 }], 14);
  check('marked: <s> вокруг удалённого', sm === 'Раз. <s>Два.</s> Три.', sm);

  // C: кликабельные ссылки
  const ANN = 'Анонс вебинара про аналитику маркетплейсов. ' + 'Расскажем, как читать отчёты по продажам и находить просадки. '.repeat(4) + 'Записаться на вебинар можно тут. Это действительно удобно и быстро для всех участников. Следите за новостями канала.';
  const aOff = ANN.indexOf('Записаться');
  const entsA = [{ type: 'text_link', offset: aOff, length: 'Записаться'.length, url: 'https://example.com/reg?a=1&b=2' }];
  const ra = B.route({ message: { message_id: 1, chat: { id: 9 }, text: ANN, entities: entsA } }, {}, NOW);
  check('C: text_link из entities → links с адресом', ra.route === 'analyze' && ra.links.length === 1 && ra.links[0].url === 'https://example.com/reg?a=1&b=2' && ra.links[0].text === 'Записаться', JSON.stringify(ra).slice(0, 200));
  const rc = B.route({ message: { message_id: 1, chat: { id: 9 }, caption: ANN, caption_entities: entsA, photo: [{}] } }, {}, NOW);
  check('C: caption_entities тоже читаются', rc.links && rc.links.length === 1);
  const shl = E.apply(ra.text, { findings: [{ quote: 'Записаться на вебинар можно тут.', sign: '24. Призыв в конце', why: 'призыв', fix: '' }, { quote: 'Это действительно удобно и быстро для всех участников.', sign: '23. Усилители', why: 'пустая оценка', fix: 'Это удобно и быстро для всех участников.' }] }, { links: ra.links });
  check('C: предложение с кликабельной ссылкой не правится, «действительно» рядом убирает код', shl.fixed === 1 && shl.auto[0].kind === 'AMP' && shl.findings.length === 1 && shl.findings[0].action === 'note' && /кликабельная ссылка/.test(shl.findings[0].reason) && shl.text.includes('Записаться'), JSON.stringify(shl.findings.map((f) => [f.action, f.reason])));
  const itL = { chat_id: '9', progress_id: 3, text: ra.text, links: ra.links, ...B.scoreStep([ans('Оценка: 60'), ans('Оценка: 60'), ans('Оценка: 60')]), highlights: [], layout: [], fix: shl };
  const ml = B.buildMessage(itL);
  check('C: в чистовике ссылка сохранена как <a href> (с экранированием &)', ml.clean_parts[0].includes('<a href="https://example.com/reg?a=1&amp;b=2">Записаться</a>') && !ml.clean_parts[0].includes('действительно удобно'), ml.clean_parts[0].slice(-300));
  check('C: небезопасные схемы (javascript:) в чистовике не превращаются в ссылки', !B.cleanHtml('Нажми тут', [{ start: 6, end: 9, url: 'javascript:alert(1)', text: 'тут' }]).includes('<a'));
  const em = B.parseEmbed('<div class="tgme_widget_message_text js-message_text">Анонс. <a href="https://example.com/r?x=1&amp;y=2">Записаться</a> тут<br/>Конец</div>');
  check('C: ссылки из embed-страницы (скрытые <a href>) разобраны', em.text === 'Анонс. Записаться тут' + NL + 'Конец' && em.links.length === 1 && em.links[0].url === 'https://example.com/r?x=1&y=2' && em.text.slice(em.links[0].start, em.links[0].end) === 'Записаться', JSON.stringify(em));

  // F: ссылка t.me
  const lk = B.route(upd('https://t.me/kultura_analitiki/987'), {}, NOW);
  check('F: ссылка t.me/канал/id → fetch, адрес собран из проверенных частей', lk.route === 'fetch' && lk.fetch_url === 'https://t.me/kultura_analitiki/987?embed=1' && lk.fetch_channel === 'kultura_analitiki' && lk.fetch_id === '987', JSON.stringify(lk));
  check('F: t.me/s/канал/id и http', B.route(upd('http://t.me/s/some_chan/5?single'), {}, NOW).fetch_url === 'https://t.me/some_chan/5?embed=1');
  check('F: чужой формат не принимается как ссылка (подмена адреса, лишнее)', ['https://t.me/chan/1/../../x', 'https://t.me/chan/12?embed=1 http://evil.ru', 'https://evil.ru/t.me/chan/5', 'https://t.me/+AbCdEf/5', 'https://t.me/c/123/5', 'https://t.me/ab/5'].every((u) => B.route(upd(u), {}, NOW).route !== 'fetch'));
  const EMB = '<div class="tgme_widget_message_text js-message_text" dir="auto">' + 'Текст поста из ссылки. '.repeat(20) + '<br/>Вторая строка &amp; конец</div>';
  const fl = B.fromLink(lk, { html: EMB }, {}, NOW);
  check('fromLink: текст достан и принят в проверку', fl.route === 'analyze' && fl.text.includes('Вторая строка & конец') && fl.source_url === 'https://t.me/kultura_analitiki/987', JSON.stringify(fl).slice(0, 120));
  check('F: закрытая/недоступная → «Перешлите пост сюда»', /Перешлите пост сюда/.test(B.fromLink(lk, { html: '<div>Post not found</div>' }, {}, NOW).reply) && /Перешлите пост сюда/.test(B.fromLink(lk, { error: { message: 'x' } }, {}, NOW).reply));
  check('fromLink: короткий пост → отказ по длине', /слишком короткий|только разбираю тексты/.test(B.fromLink(lk, { html: '<div class="tgme_widget_message_text">Коротко</div>' }, {}, NOW).reply));
  const cap = B.route({ message: { message_id: 1, chat: { id: 7 }, photo: [{}], caption: LONG } }, {}, NOW);
  check('подпись к картинке проверяется как текст', cap.route === 'analyze' && cap.text === LONG);
  const fwd = B.route({ message: { message_id: 1, chat: { id: 7 }, forward_origin: { type: 'channel' }, text: LONG } }, {}, NOW);
  check('пересланный пост проверяется как текст', fwd.route === 'analyze');
  check('картинка без подписи → отказ', B.route({ message: { chat: { id: 7 }, photo: [{}] } }, {}, NOW).route === 'reply');

  // /stats, /allow, /disallow (владелец)
  const sdx = {};
  B.route(upd(LONG), sdx, NOW);
  B.recordUsage(sdx, NOW, [{ usage: { input_tokens: 100000, output_tokens: 10000 } }, { error: {} }]);
  const stt = B.route(upd('/stats'), sdx, NOW).reply;
  check('/stats: сегодня 1, за месяц 1, стоимость $0.300', /Сегодня проверок 1 из 50/.test(stt) && /В этом месяце проверок 1/.test(stt) && stt.includes('$0.300'), stt);
  check('/allow без аргумента: пустой список', /пока нет/.test(B.route(upd('/allow'), sdx, NOW).reply));
  B.route(upd('/allow Хотите попробовать'), sdx, NOW);
  check('/allow: фраза в staticData в нижнем регистре, список', JSON.stringify(sdx.allow) === '["хотите попробовать"]' && /хотите попробовать/.test(B.route(upd('/allow'), sdx, NOW).reply));
  check('/allow повторно → уже есть', /уже в исключениях/.test(B.route(upd('/allow хотите попробовать'), sdx, NOW).reply));
  B.route(upd('/disallow ХОТИТЕ попробовать'), sdx, NOW);
  check('/disallow убирает', sdx.allow.length === 0);
  check('/disallow без аргумента / чужая фраза', /Напишите \/disallow и фразу/.test(B.route(upd('/disallow'), sdx, NOW).reply) && /в исключениях нет/.test(B.route(upd('/disallow нет такой'), sdx, NOW).reply));
  const li2 = lintStep(TEXT, 5, ['следите за новостями']);
  check('/allow: подсветка фразы пропадает', li.highlights.some((h) => h.quote && h.quote.includes('Следите за новостями')) && !li2.highlights.some((h) => h.quote && h.quote.includes('Следите за новостями')));
  const sh2 = E.apply(TEXT, { findings: [{ quote: 'Следите за новостями канала.', sign: '24', why: 'призыв', fix: '' }] }, { allow: ['следите за новостями'] });
  check('/allow: фраза не правится', !sh2.edits.some((e) => e.quote.includes('Следите')) && /списке исключений/.test(sh2.findings[0].reason), JSON.stringify(sh2.findings));
  check('линтер для бота: только counted, не больше 5 мест', li.highlights.length <= 5 && li.highlights.every((h) => h.reason && (h.whole || h.quote)));
  check('линтер для бота: оформление — предложение (C01), текст не менялся', li.layout.some((x) => x.rule === 'C01') && TEXT.includes('1️⃣'));

  // ежедневный
  const PAGE = '<div data-post="kultura_analitiki/101" class="x"><div class="tgme_widget_message_text js-message_text" dir="auto">Первый &amp; пост<br/>вторая строка <b>жирно</b></div><time datetime="2026-11-26T08:00:00+00:00"></time><span class="tgme_widget_message_views">1.2K</span></div>' +
    '<div data-post="kultura_analitiki/102" class="x"><div class="tgme_widget_message_text js-message_text" dir="auto">Второй пост ' + 'слово '.repeat(80) + '</div><time datetime="2026-11-27T05:00:00+00:00"></time></div>' +
    '<div data-post="kultura_analitiki/103" class="x"><div class="tgme_widget_message_photo"></div></div>';
  const posts = B.parsePosts(PAGE);
  check('разбор t.me/s: два поста с текстом, по убыванию id, &amp; и <br> разобраны', posts.length === 2 && posts[0].id === 102 && posts[1].text === 'Первый & пост' + NL + 'вторая строка жирно' && posts[1].views === '1.2K' && posts[1].date.startsWith('2026-11-26'), JSON.stringify(posts[1]));
  const dsd = {};
  check('новые посты: первый запуск — только самый свежий', JSON.stringify(B.newPosts(posts, dsd).map((p) => p.id)) === '[102]');
  const reqs = B.dailyRequests(B.newPosts(posts, dsd), (t) => lintStep(t));
  check('ежедневный: три запроса на пост, мета поста приложена', reqs.length === 3 && reqs[0].post.url === 'https://t.me/kultura_analitiki/102' && reqs[0].req.model === 'claude-sonnet-5-5');
  const d1 = B.digest(reqs, [ans('Оценка: 40'), ans('Оценка: 35'), ans('Оценка: 45')], dsd, NOW);
  check('сводка: пост, оценка, ссылка; lastPostId=102; только пост канала', /<a href="https:\/\/t\.me\/kultura_analitiki\/102">[^<]*\p{L}[^<]*<\/a>/u.test(d1.html) && !/Пост 102/.test(d1.html) && /40 из 100/.test(d1.html) && dsd.lastPostId === 102 && d1.html.length <= 4096 && !d1.html.includes(LONG.slice(0, 30)), d1.html);
  check('повторный запуск: новых постов нет (без дублей)', B.newPosts(posts, dsd).length === 0);
  const more = [{ id: 105, date: null, views: null, text: 'х'.repeat(300) }, { id: 104, date: null, views: null, text: 'у'.repeat(300) }, ...posts];
  check('новые посты после первого запуска: только id > 102, по возрастанию', JSON.stringify(B.newPosts(more, dsd).map((p) => p.id)) === '[104,105]');
  const six = [101, 102, 103, 104, 105, 106].map((id) => ({ id }));
  check('новых больше пяти: берём пять самых старых, шестой придёт завтра', JSON.stringify(B.newPosts(six, { lastPostId: 100 }).map((p) => p.id)) === '[101,102,103,104,105]');
  const sd2 = { lastPostId: 100 };
  const rq2 = B.dailyRequests(more.slice(0, 2).reverse(), (t) => lintStep(t));
  const d2 = B.digest(rq2, [ans('Оценка: 40'), ans('Оценка: 40'), ans('Оценка: 40'), { error: {} }, { error: {} }, { error: {} }], sd2, NOW);
  check('сводка: упавший пост не «съедается» (lastPostId = id-1) и помечен', d2.failed === 1 && sd2.lastPostId === 104, JSON.stringify([d2.failed, sd2.lastPostId]));
};
