'use strict';
// Тесты шага 7: rewrite.js (с подставным chat, без сети и денег), подбор образцов, копирование, заезженные фразы.
const { rewrite, parseReply, newEnding } = require('../src/rewrite');
const { pickSamples, copyRate, loadPool, grams } = require('../src/samples');
const { worn, loadWorn } = require('../src/worn');
const { lint } = require('../src/linter');

const AI = [
  'Подключите ИИ-агента к данным магазина',
  '',
  'В сервисе появился MCP-сервер. Теперь ассистент работает с данными напрямую, без выгрузок и скриншотов.',
  '',
  'Как подключить за три шага:',
  '',
  '1️⃣ Откройте Профиль.',
  '2️⃣ Скопируйте токен.',
  '3️⃣ Вставьте его в клиент.',
  '',
  'Демодоступ на 7 дней бесплатный, подробности по ссылке https://example.com/demo и в @kultura_analitiki.',
  '',
  'Хотите попробовать? Подключайте агента и пишите в комментариях 👇',
].join('\n');

const GOOD = [
  'Подключите ИИ-агента к данным магазина',
  '',
  'В сервисе появился MCP-сервер. Теперь ассистент работает с данными напрямую, без выгрузок и скриншотов, а вопрос про маржу или остатки можно задать обычным языком и получить ответ по своим цифрам.',
  '',
  'Как подключить за три шага:',
  '1. Откройте Профиль.',
  '2. Скопируйте токен.',
  '3. Вставьте его в клиент.',
  '',
  'Демодоступ на 7 дней бесплатный, подробности по ссылке https://example.com/demo и в @kultura_analitiki.',
].join('\n');

const mkChat = (replies) => {
  const calls = [];
  const chat = async (a) => { calls.push(a); const r = replies[Math.min(calls.length - 1, replies.length - 1)]; return { text: r, model: a.model, cost: 0.01 }; };
  chat.calls = calls;
  return chat;
};

module.exports = async function run(check) {
  // --- parseReply
  const p = parseReply('Текст поста.\n\nВторой абзац **жирный**.\n<правки>\n— а → б → зачем\n</правки>');
  check('parseReply: теги вырезаны', !/правки/.test(p.text) && p.text === 'Текст поста.\n\nВторой абзац жирный.', JSON.stringify(p.text));
  check('parseReply: правки сохранены', p.changes === '— а → б → зачем');
  check('parseReply: незакрытый тег', !/правки/.test(parseReply('Текст.\n<правки>\n— х').text));
  check('parseReply: «Вот текст:» убирается', parseReply('Вот правленый текст:\n\nПост.').text === 'Пост.');

  // --- исходный AI-текст отмечен, образец «хорошего» ответа — нет
  const l0 = lint(AI);
  check('rewrite: тестовый AI-текст выше порога', l0.score >= 15, String(l0.score));
  check('rewrite: тестовый хороший текст ниже порога', lint(GOOD).score < 15, String(lint(GOOD).score));

  // --- чисто: LLM не вызывается
  const chatNever = mkChat(['не должно вызываться']);
  const clean = await rewrite(GOOD, { chat: chatNever });
  check('rewrite: чистый текст — status clean', clean.status === 'clean', clean.status);
  check('rewrite: чистый текст — LLM не вызван', chatNever.calls.length === 0);
  check('rewrite: чистый текст не тронут', clean.after === GOOD);

  // --- коротко
  const short = await rewrite('Короткий пост про Ozon, 12 февраля.', { chat: chatNever });
  check('rewrite: короткий текст — status short', short.status === 'short' && chatNever.calls.length === 0);

  // --- успех с первого круга, теги вырезаны
  const chat1 = mkChat([GOOD + '\n<правки>\n— финал-призыв убран → зачем\n</правки>']);
  const ok = await rewrite(AI, { chat: chat1, model: 'm-test' });
  check('rewrite: status fixed', ok.status === 'fixed', ok.status + ' ' + (ok.reason || ''));
  check('rewrite: один вызов', chat1.calls.length === 1 && ok.rounds.length === 1);
  check('rewrite: после — без тегов', !/правки/.test(ok.after));
  check('rewrite: балл упал ниже порога', ok.score_after < 15 && ok.score_before >= 15, `${ok.score_before} -> ${ok.score_after}`);
  check('rewrite: факты ок', ok.facts.ok === true);
  check('rewrite: правки модели возвращены', /финал-призыв/.test(ok.changes));
  check('rewrite: стоимость и модель', ok.cost === 0.01 && ok.model === 'm-test');
  const userMsg = chat1.calls[0].messages[1].content;
  check('rewrite: промпт содержит находки, факты и образцы', /B09/.test(userMsg) && /https:\/\/example\.com\/demo/.test(userMsg) && /Образец 1/.test(userMsg));
  check('rewrite: карточка голоса в system-промпте', /Карточка голоса/.test(chat1.calls[0].messages[0].content) && /Нельзя переносить/.test(chat1.calls[0].messages[0].content));
  check('rewrite: 1️⃣ заменено кодом до модели', !/1️⃣/.test(userMsg.split('# Черновик')[1]));

  // --- потеряны факты -> один повтор -> успех
  const bad = GOOD.replace('https://example.com/demo', 'ссылке').replace('7 дней', '10 дней');
  const chat2 = mkChat([bad, GOOD]);
  const retry = await rewrite(AI, { chat: chat2 });
  check('rewrite: повтор при потере фактов', retry.status === 'fixed' && chat2.calls.length === 2 && retry.rounds[0].retried === true, retry.status);
  const retryMsg = chat2.calls[1].messages.slice(-1)[0].content;
  check('rewrite: повтор получает перечень потерянного', /Потеряно/.test(retryMsg) && /example\.com/.test(retryMsg));
  check('rewrite: facts_first_ok = false, facts_ok = true', retry.rounds[0].facts_first_ok === false && retry.rounds[0].facts_ok === true);

  // --- факты не вернулись -> человеку
  const chat3 = mkChat([bad]);
  const human = await rewrite(AI, { chat: chat3 });
  check('rewrite: факты не прошли -> human/facts', human.status === 'human' && human.reason === 'facts', human.status + human.reason);
  check('rewrite: после неудачи ровно 2 вызова (без второго круга)', chat3.calls.length === 2);

  // --- балл не опустился: два круга, потом человеку
  const chat4 = mkChat([AI.replace('Хотите попробовать?', 'Хотите попробовать сегодня?')]);
  const stuck = await rewrite(AI, { chat: chat4 });
  check('rewrite: не опустился -> 2 круга -> human/score', stuck.status === 'human' && stuck.reason === 'score' && stuck.rounds.length === 2, stuck.status + stuck.reason + stuck.rounds.length);

  // --- длина вне ±15% -> повтор с указанием длины
  const chat5 = mkChat([GOOD.slice(0, 250) + '\n\nhttps://example.com/demo @kultura_analitiki 7', GOOD]);
  await rewrite(AI, { chat: chat5, lenTol: 0.15 });
  check('rewrite: проверка длины запускает повтор', chat5.calls.length === 2 && /Длина/.test(chat5.calls[1].messages.slice(-1)[0].content), String(chat5.calls.length));

  // --- концовка: дописанное предложение, которого нет в черновике
  check('концовка: хороший текст без новых предложений', newEnding(AI, GOOD).length === 0, JSON.stringify(newEnding(AI, GOOD)));
  const withTail = GOOD + '\n\nЭто единственный сервис с такой возможностью на рынке.';
  check('концовка: дописанное предложение ловится', newEnding(AI, withTail).length === 1, JSON.stringify(newEnding(AI, withTail)));
  const chat6 = mkChat([withTail, GOOD]);
  const tail = await rewrite(AI, { chat: chat6, lenTol: 0.5, lenDown: 0.5 });
  check('rewrite: новая концовка -> повтор с указанием предложения', tail.status === 'fixed' && chat6.calls.length === 2 && /единственный сервис/.test(chat6.calls[1].messages.slice(-1)[0].content), tail.status);
  const chat7 = mkChat([withTail]);
  const tail2 = await rewrite(AI, { chat: chat7, lenTol: 0.5, lenDown: 0.5 });
  check('rewrite: концовка не исправлена -> human/ending', tail2.status === 'human' && tail2.reason === 'ending', tail2.status + tail2.reason);

  // --- подбор образцов
  const pool = loadPool();
  check('образцы: пул — только founder dev, 22 поста', pool.length === 22, String(pool.length));
  const q = 'Ozon изменил комиссии и предельную цену в акциях для продавцов';
  const s1 = pickSamples(q, {});
  check('образцы: 3 штуки, по убыванию близости', s1.length === 3 && s1[0].score >= s1[1].score && s1[1].score >= s1[2].score);
  check('образцы: самый близкий по теме — пост про предельную цену (1014)', s1[0].id === 1014, JSON.stringify(s1.map((x) => x.id)));
  check('образцы: подпись канала срезана', s1.every((s) => !/@kultura_analitiki\s*$/.test(s.text)));
  check('образцы: excludeId исключает пост-источник', !pickSamples(q, { excludeId: 1014 }).some((s) => s.id === 1014));
  check('образцы: детерминированно', JSON.stringify(pickSamples('Ozon комиссии', {}).map((x) => x.id)) === JSON.stringify(pickSamples('Ozon комиссии', {}).map((x) => x.id)));
  check('образцы: посты-анонсы не в пуле', !pool.some((x) => x.id === 946 || x.id === 1000));
  check('образцы: подбор зависит от темы', pickSamples('Яндекс почта платная, email сервисы за рубежом', {})[0].id !== pickSamples('предельная цена Ozon акции', {})[0].id);

  // --- копирование
  const orig = 'Сегодня вышло обновление сервиса для селлеров на маркетплейсах. Подробности ниже.';
  const sam = [{ text: 'Ну что же, юрики направо, физики налево, в поддержку распространения интернета, как говорится.' }];
  const copied = copyRate('Сегодня вышло обновление. Юрики направо, физики налево, в поддержку распространения интернета, ага.', orig, sam);
  check('копирование: чужая цепочка ловится', copied.rate > 0.2 && copied.run >= 6, JSON.stringify(copied));
  const own = copyRate(orig, orig, sam);
  check('копирование: фразы самого оригинала не считаются', own.rate === 0 && own.run === 0);
  check('копирование: 4-граммы', grams('раз два три четыре пять').length === 2);

  // --- заезженные фразы
  check('заезженные: список загружен из voice.md', loadWorn().length >= 30);
  check('заезженные: ловит новую фразу', worn('Ну что же, посмотрим.', 'Посмотрим.').includes('Ну что же'));
  check('заезженные: фраза из оригинала — не считается', worn('Ну что же, посмотрим.', 'Ну что же, посмотрим.').length === 0);
};
