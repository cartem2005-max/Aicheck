'use strict';
// Тесты src/shorten.js: подставной chat, без сети и денег.
const S = require('../src/shorten');
const { checkFacts } = require('../src/facts');

const TEXT = [
  '🎉 Новый раздел «Акции» в сервисе', '',
  'С 12 февраля в сервисе появился раздел «Акции». Это очень удобно и важно для каждого продавца. Раздел показывает, в каких акциях участвует товар. Иначе говоря, вы видите участие товара в акциях.', '',
  'Давайте разберёмся, как это работает. Откройте раздел и проверьте цены. Не обновляйте цены без проверки.', '',
  'Хотите попробовать? Зарегистрируйтесь по ссылке https://example.com/promo.', '',
  'Следите за новостями канала. Главное — не пропускать обновления.', '',
  '@kultura_analitiki',
].join('\n');
// 1 С 12 февраля… 2 Это очень удобно… 3 Раздел показывает… 4 Иначе говоря… 5 Давайте разберёмся… 6 Откройте… 7 Не обновляйте… 8 Хотите попробовать? 9 Зарегистрируйтесь… 10 Следите… 11 Главное…

const del = (...a) => ({ delete: a.map(([n, reason, covered_by]) => ({ n, reason, covered_by: covered_by === undefined ? null : covered_by })) });
const quotes = (r) => r.removed.map((x) => x.n);
const guards = (r) => Object.fromEntries(r.kept_by_guard.map((k) => [k.n, k.guard]));

module.exports = async function run(check) {
  const p = S.prepare(TEXT);
  check('shorten: 11 предложений, заголовок и подпись защищены', p.total === 11 && /^\[—\] 🎉/.test(p.numbered) && /\[—\] @kultura_analitiki$/.test(p.numbered), p.numbered.slice(0, 80));
  const rq = S.buildRequest(TEXT);
  check('shorten: запрос — Sonnet, between_tools, effort low, 1500 токенов', rq.model === 'claude-sonnet-5-5' && rq.thinking.type === 'between_tools' && rq.output_config.effort === 'low' && rq.max_tokens === 1500 && rq.messages[0].content.includes('[1] С 12 февраля'));

  // пустая правка — нормальный ответ
  let r = S.apply(TEXT, del());
  check('shorten: пустой список → unchanged, текст тот же', r.status === 'unchanged' && r.text === TEXT && !r.removed.length);

  // вода без фактов удаляется; обязательные поля результата
  r = S.apply(TEXT, del([2, 'вода'], [5, 'пустая подводка']));
  check('shorten: вода и подводка удалены', JSON.stringify(quotes(r)) === '[2,5]' && !r.text.includes('очень удобно') && !r.text.includes('Давайте разберёмся'), JSON.stringify(quotes(r)));
  check('shorten: removed содержит цитату и причину', r.removed[0].quote === 'Это очень удобно и важно для каждого продавца.' && r.removed[0].reason === 'вода' && r.removed[0].covered_by_quote === null);
  check('shorten: факты на месте, текст короче', checkFacts(TEXT, r.text).ok && r.text.length < TEXT.length && r.length_change < 0);

  // повтор требует covered_by
  r = S.apply(TEXT, del([4, 'повтор']));
  check('shorten: повтор без covered_by остаётся', !r.removed.length && guards(r)[4] === 'повтор без covered_by', JSON.stringify(r.kept_by_guard));
  r = S.apply(TEXT, del([4, 'повтор', 3]));
  check('shorten: повтор с covered_by удаляется, цитата «где уже сказано»', JSON.stringify(quotes(r)) === '[4]' && r.removed[0].covered_by === 3 && r.removed[0].covered_by_quote.startsWith('Раздел показывает'), JSON.stringify(r.removed));
  r = S.apply(TEXT, del([4, 'повтор', 4]));
  check('shorten: covered_by на себя не годится', !r.removed.length);
  r = S.apply(TEXT, del([4, 'повтор', 3], [3, 'вода']));
  check('shorten: если «уже сказано» удалено само — оба остаются', !r.removed.some((x) => x.n === 4) && /тоже удаляется/.test(guards(r)[4] || ''), JSON.stringify(r.kept_by_guard));

  // гарды
  r = S.apply(TEXT, del([1, 'вода']));
  check('shorten: гард — факт (дата)', !r.removed.length && /^факт/.test(guards(r)[1]), JSON.stringify(r.kept_by_guard));
  r = S.apply(TEXT, del([7, 'вода']));
  check('shorten: гард — отрицание', guards(r)[7] === 'отрицание, ограничение или условие');
  r = S.apply(TEXT, del([6, 'очевидное']));
  check('shorten: гард — инструкция', guards(r)[6] === 'инструкция');
  r = S.apply(TEXT, del([9, 'призыв']));
  check('shorten: гард — ссылка (и целевой призыв) не удаляются', !r.removed.length && !!guards(r)[9], JSON.stringify(r.kept_by_guard));
  r = S.apply(TEXT, del([11, 'мораль']));
  check('shorten: гард — «не пропускать» (отрицание) у морали', guards(r)[11] === 'отрицание, ограничение или условие');
  r = S.apply(TEXT, del([10, 'призыв']));
  check('shorten: призыв без фактов и ссылок удаляется (исключение из гардов)', JSON.stringify(quotes(r)) === '[10]' && !r.text.includes('Следите за новостями'), JSON.stringify(r.kept_by_guard));
  check('shorten: «вы видите» не считается инструкцией', S.guardFor('Иначе говоря, вы видите участие товара в акциях.', 'повтор') === null);
  check('shorten: целевой призыв анонса не трогаем', S.guardFor('Записывайтесь на вебинар.', 'призыв') === 'целевой призыв анонса');
  r = S.apply(TEXT, del([1, 'ерунда']));
  check('shorten: причина не из списка', guards(r)[1] === 'причина не из списка');
  r = S.apply(TEXT, del([99, 'вода']));
  check('shorten: несуществующий номер игнорируется', r.status === 'unchanged');

  // не больше трети предложений
  r = S.apply(TEXT, del([2, 'вода'], [5, 'пустая подводка'], [10, 'призыв'], [8, 'призыв'], [4, 'повтор', 3]));
  check('shorten: не больше трети (3 из 11)', r.removed.length <= 3, JSON.stringify(quotes(r)));

  // автоправки вёрстки не применяются, идут отдельным списком
  const L = ['Заголовок поста про акции', '', 'Что нового в сервисе:', '1️⃣ Раздел акций показывает участие товара.', '2️⃣ Цены обновляются раз в сутки.', '3️⃣ Есть выгрузка в таблицу для всех тарифов.', '', 'Мы рады, что вы с нами. Спасибо вам за это очень сильно.'].join('\n');
  r = S.apply(L, del([6, 'вода']));
  check('shorten: вёрстка не меняется, предложение по оформлению есть', r.text.includes('1️⃣') && r.layout_suggestions.some((x) => x.rule === 'C01' && x.after.startsWith('1.')), JSON.stringify(r.layout_suggestions));

  // полный путь с подставным chat
  const mk = (obj) => { const f = async (a) => { f.calls.push(a); return { text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: a.model, cost: 0.01 }; }; f.calls = []; return f; };
  const chat = mk('```json\n{"delete":[{"n":2,"reason":"вода","covered_by":null},{"n":1,"reason":"вода","covered_by":null}]}\n```');
  r = await S.shorten(TEXT, { chat });
  check('shorten(): один вызов, правка применена, гард вернул дату', chat.calls.length === 1 && chat.calls[0].model === 'claude-sonnet-5-5' && quotes(r).join() === '2' && /^факт/.test(guards(r)[1]), JSON.stringify([quotes(r), r.kept_by_guard]));
  r = await S.shorten(TEXT, { chat: mk('не json') });
  check('shorten(): мусор от модели → status error, текст не тронут', r.status === 'error' && r.text === TEXT);
  r = await S.shorten('Коротко.\n\n@x', { chat: mk('{"delete":[]}') });
  check('shorten(): нечего нумеровать → empty', r.status === 'empty');
};
