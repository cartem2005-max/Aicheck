'use strict';
// Тесты шага 12: styleRewrite с подставным chat (без сети и денег).
const { styleRewrite, buildMessages, check: chk, parseReply } = require('../src/style_rewrite');
const { pickSamples } = require('../src/samples');

const AI = [
  '🚀 Новая функция в сервисе',
  '',
  'В сервисе появился MCP-сервер. Это не просто выгрузка, а новый уровень работы с данными магазина. Теперь ассистент работает с данными напрямую, без выгрузок и скриншотов.',
  '',
  'Демодоступ на 7 дней бесплатный, подробности по ссылке https://example.com/demo и в @kultura_analitiki.',
  '',
  'Хотите попробовать? Подключайте агента и пишите в комментариях 👇',
].join('\n');
const GOOD = 'Новая функция в сервисе\n\nВ сервисе появился MCP-сервер. Ассистент работает с данными напрямую, без выгрузок и скриншотов, вопросы про остатки и маржу задаются обычным языком.\n\nДемодоступ на 7 дней бесплатный, подробности по ссылке https://example.com/demo и в @kultura_analitiki.';
const mkChat = (replies) => {
  const calls = [];
  const chat = async (a) => { calls.push(a); const r = replies[Math.min(calls.length - 1, replies.length - 1)]; return { text: r, model: a.model, cost: 0.01 }; };
  chat.calls = calls;
  return chat;
};

module.exports = async function run(check) {
  // промпт: образцы, факты, запреты, диапазон длины
  const samples = pickSamples(AI, { k: 4 });
  check('стиль: 4 образца', samples.length === 4);
  const msgs = buildMessages(AI, samples);
  check('стиль: в промпте факты, образцы и «Нельзя переносить»', /https:\/\/example\.com\/demo/.test(msgs[1].content) && /Образец 4:/.test(msgs[1].content) && /Нельзя переносить/.test(msgs[0].content));
  check('стиль: в промпте диапазон 70–110%', msgs[1].content.includes(String(Math.round(AI.length * 0.7))) && msgs[1].content.includes(String(Math.round(AI.length * 1.1))));
  check('стиль: пометка «только как образец»', /только как образец/i.test(msgs[1].content));

  check('стиль: parseReply режет Markdown и «Вот текст:»', parseReply('Вот текст:\n\n**Заголовок**\n\nТело').startsWith('Заголовок'));

  // хороший ответ: один вызов
  const c1 = mkChat([GOOD]);
  const r1 = await styleRewrite(AI, { chat: c1, sourceId: null });
  check('стиль: хороший ответ — status ok, один вызов', r1.status === 'ok' && c1.calls.length === 1 && !r1.retried, JSON.stringify([r1.status, r1.reasons]));
  check('стиль: в вызове нет утечки адреса и thinking задаёт шлюз', c1.calls[0].model === 'claude-sonnet-5-5');
  check('стиль: исходный пост-источник исключается из образцов', !(await styleRewrite(AI, { chat: mkChat([GOOD]), sourceId: samples[0].id })).samples.some((s) => s.id === samples[0].id));

  // потеря факта -> один повтор -> исправлено
  const lost = GOOD.replace('https://example.com/demo', 'по ссылке');
  const c2 = mkChat([lost, GOOD]);
  const r2 = await styleRewrite(AI, { chat: c2 });
  check('стиль: потеря факта — повтор и ok', c2.calls.length === 2 && r2.retried && r2.status === 'ok' && /Потеряно/.test(c2.calls[1].messages[c2.calls[1].messages.length - 1].content));
  // потеря факта и во втором — «человеку»
  const c3 = mkChat([lost]);
  const r3 = await styleRewrite(AI, { chat: c3 });
  check('стиль: факт не вернулся — status human/facts, текст отдан', r3.status === 'human' && r3.reason === 'facts' && r3.after.length > 0 && c3.calls.length === 2);
  // добавленный факт
  const added = GOOD.replace('напрямую', 'напрямую уже с 12 февраля');
  const r4 = await styleRewrite(AI, { chat: mkChat([added]) });
  check('стиль: добавленная дата ловится', r4.status === 'human' && r4.facts.added.length > 0);
  // длина вне диапазона
  const short = 'Новая функция.\n\nMCP-сервер, ссылка https://example.com/demo @kultura_analitiki, 7 дней.';
  const c5 = mkChat([short, short]);
  const r5 = await styleRewrite(AI, { chat: c5 });
  check('стиль: слишком коротко — повтор, затем length', c5.calls.length === 2 && r5.reasons.includes('length') && /Длина/.test(c5.calls[1].messages[c5.calls[1].messages.length - 1].content));
  // заезженная фраза: повтор с перечнем
  const wornT = GOOD.replace('В сервисе появился', 'Ну что же, в сервисе появился');
  const c6 = mkChat([wornT, GOOD]);
  const r6 = await styleRewrite(AI, { chat: c6 });
  check('стиль: заезженная фраза — повтор и ok', r6.retried && r6.status === 'ok' && /Запрещённые/.test(c6.calls[1].messages[c6.calls[1].messages.length - 1].content));
  const r6b = await styleRewrite(AI, { chat: mkChat([wornT]) });
  check('стиль: заезженная осталась — human/worn', r6b.status === 'human' && r6b.reason === 'worn' && r6b.worn.includes('Ну что же'));
  // копирование образца: берём реальную цепочку из ближайшего образца
  const chain = samples[0].text.split(/\s+/).slice(5, 14).join(' ');
  const c = chk(AI, GOOD + '\n\n' + chain, samples);
  check('стиль: копирование образца ловится', c.copy.flag && c.reasons.includes('copy'), JSON.stringify(c.copy));
  check('стиль: чистый текст — без флагов', chk(AI, GOOD, samples).ok);
  // 1️⃣ чинится кодом (autofix)
  const r7 = await styleRewrite(AI, { chat: mkChat([GOOD.replace('Демодоступ', '1️⃣ Демодоступ')]) });
  check('стиль: цифра-эмодзи превращается в «1.»', !/1️⃣/.test(r7.after));
};
