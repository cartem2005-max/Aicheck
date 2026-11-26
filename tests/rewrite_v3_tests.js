'use strict';
// Тесты v3 (src/rewrite_v3.js): подставной chat, без сети и денег.
const { dry, structure, numbered, build, parseJson, applyFragment, checkReplace, pickPairs, REASONS } = require('../src/rewrite_v3');
const { checkFacts } = require('../src/facts');

const TEXT = [
  '🎉 Новый раздел «Акции» в сервисе',
  '',
  'С 12 февраля в сервисе появился раздел «Акции». Это очень удобно и важно для каждого продавца.',
  '',
  'Что видно в разделе:',
  '• в каких акциях участвует товар;',
  '• какая цена нужна для входа;',
  '• как менялся бустинг.',
  '',
  'Мы подготовили видео-обзор. Он доступен на YouTube. Смотрите по ссылке https://example.com/promo сегодня.',
  '',
  'Хотите попробовать? Подключайте демо на 7 дней и принимайте решения на основе данных!',
  '',
  '@kultura_analitiki',
].join('\n');

const mk = (obj) => {
  const calls = [];
  const chat = async (a) => { calls.push(a); return { text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: a.model, cost: 0.01 }; };
  chat.calls = calls;
  return chat;
};

module.exports = async function run(check) {
  // структура и нумерация
  const st = structure(TEXT);
  const num = numbered(st);
  check('v3: заголовок и подпись защищены [—]', /^\[—\] 🎉/.test(num) && /\[—\] @kultura_analitiki$/.test(num), num.slice(-40));
  check('v3: предложения пронумерованы с 1', /\[1\] С 12 февраля/.test(num) && /\[2\] Это очень/.test(num));
  check('v3: build без правок возвращает исходный текст', build(TEXT, st, { del: new Set(), rep: new Map() }) === TEXT);

  // parseJson и applyFragment
  check('v3: parseJson вынимает JSON из ```', JSON.stringify(parseJson('```json\n{"delete":[]}\n```')) === '{"delete":[]}');
  check('v3: parseJson мусор → null', parseJson('нет') === null && parseJson('{сломано') === null);
  check('v3: applyFragment заменяет фрагмент', applyFragment('Это очень удобно и важно.', 'очень удобно и важно', 'удобно') === 'Это удобно.');
  check('v3: applyFragment нет фрагмента → null', applyFragment('Текст.', 'нет', 'x') === null);
  check('v3: applyFragment сохраняет точку', applyFragment('Мы подготовили видео-обзор.', 'Мы подготовили', 'Готов') === 'Готов видео-обзор.');

  // checkReplace
  check('v3: замена A — только короче', checkReplace('A', 'Это очень удобно.', 'очень удобно', 'очень удобно сильно', 'Это очень удобно сильно.') !== null);
  check('v3: замена A — новое слово отклонено', checkReplace('A', 'Это очень удобно для продавцов.', 'очень удобно', 'супервыгодно', 'Это супервыгодно для продавцов.') !== null);
  check('v3: замена — новое число отклонено', /новый факт/.test(checkReplace('B', 'Доступно давно.', 'давно', 'с 5 марта', 'Доступно с 5 марта.') || ''));
  check('v3: замена — потеря факта отклонена', /потерян/.test(checkReplace('A', 'С 12 февраля есть раздел.', 'С 12 февраля есть', 'Есть', 'Есть раздел.') || ''));
  check('v3: замена B — первое лицо отклонено', checkReplace('B', 'Это важно знать.', 'Это важно знать', 'Я считаю важным', 'Я считаю важным.') === 'первое лицо');
  check('v3: замена B — многоточие отклонено', checkReplace('B', 'Это важно.', 'Это важно', 'Важно...', 'Важно....') !== null);
  check('v3: замена OK', checkReplace('A', 'Это очень удобно и важно.', 'очень удобно и важно', 'удобно', 'Это удобно.') === null);

  // А: удаления с причинами, замена, факты на месте
  const chatA = mk({ delete: [{ n: 2, reason: 'вода' }, { n: 7, reason: 'пустая связка' }, { n: 10, reason: 'призыв' }], replace: [{ n: 1, was: 'С 12 февраля в сервисе появился', now: 'С 12 февраля появился' }] });
  const a = await dry(TEXT, { variant: 'A', chat: chatA });
  check('v3 A: статус dried', a.status === 'dried', a.status + ' ' + a.after);
  check('v3 A: один вызов модели', chatA.calls.length === 1 && a.calls === 1);
  check('v3 A: факты ок', checkFacts(TEXT, a.after).ok && a.facts.ok, JSON.stringify(a.facts.missing));
  check('v3 A: вычеркнутое предложение исчезло', !/очень удобно/.test(a.after) && !/Хотите попробовать/.test(a.after), a.after);
  check('v3 A: diff с причинами', a.diff.filter((d) => d.type === 'delete').every((d) => REASONS.includes(d.reason)) && a.diff.length >= 3, JSON.stringify(a.diff.map((d) => d.n)));
  check('v3 A: подпись и заголовок целы', a.after.startsWith('🎉 Новый раздел') && a.after.endsWith('@kultura_analitiki'));

  // факт в удалённом предложении возвращает КОД
  const chatF = mk({ delete: [{ n: 9, reason: 'повтор' }, { n: 10, reason: 'призыв' }, { n: 11, reason: 'призыв' }], replace: [] });
  const f = await dry(TEXT, { variant: 'A', chat: chatF });
  check('v3: предложение с URL/числом возвращено кодом', f.facts.ok && /example\.com\/promo/.test(f.after) && /7 дней/.test(f.after), f.after);
  check('v3: возврат записан в restored', f.restored.length >= 2, JSON.stringify(f.restored));

  // причина не из списка, защищённый и несуществующий номера отклонены
  const chatBad = mk({ delete: [{ n: 2, reason: 'красота' }, { n: 99, reason: 'вода' }, { n: 10, reason: 'призыв' }], replace: [{ n: 3, was: 'нет такого', now: 'x' }] });
  const b = await dry(TEXT, { variant: 'A', chat: chatBad });
  check('v3: чужая причина отклонена', b.rejected.some((r) => /причина/.test(r.why)) && /Это очень удобно/.test(b.after));
  check('v3: несуществующий номер отклонён', b.rejected.some((r) => r.n === 99));
  check('v3: замена с несуществующим фрагментом отклонена', b.rejected.some((r) => r.type === 'replace'));

  // подводка к списку: список вычеркнут целиком, подводка уходит
  const chatL = mk({ delete: [{ n: 3, reason: 'очевидное' }, { n: 4, reason: 'очевидное' }, { n: 5, reason: 'очевидное' }, { n: 6, reason: 'вода' }], replace: [] });
  const l = await dry(TEXT, { variant: 'A', chat: chatL });
  check('v3: подводка к вычеркнутому списку убрана', !/Что видно в разделе/.test(l.after) && !/^•\s*$/m.test(l.after), l.after);
  check('v3: после вычёркивания нет тройных переносов', !/\n{3,}/.test(l.after));
  // последний пункт списка: «;» → «.»
  const chatL2 = mk({ delete: [{ n: 6, reason: 'очевидное' }], replace: [] });
  const l2 = await dry(TEXT, { variant: 'A', chat: chatL2 });
  check('v3: хвост списка закрыт точкой', /• какая цена нужна для входа\.$/m.test(l2.after), l2.after);

  // длина: не короче 60%
  const chatAll = mk({ delete: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, reason: 'вода' })), replace: [] });
  const al = await dry(TEXT, { variant: 'A', chat: chatAll });
  check('v3: длина не короче 60%', al.after.length / TEXT.length >= 0.6 && al.facts.ok, String(al.after.length / TEXT.length));

  // не JSON: текст не меняется, не падение
  const e = await dry(TEXT, { variant: 'A', chat: mk('не json') });
  check('v3: не-JSON → status error, текст без изменений', e.status === 'error' && e.after === TEXT);

  const u = await dry(TEXT, { variant: 'A', chat: mk({ delete: [], replace: [] }) });
  check('v3: пустые списки → unchanged', u.status === 'unchanged' && u.after === TEXT);

  // Б: пары в промпте, замена применена, копирование считается
  const pairsFake = [
    { id: 1, score: 0.1, ai: 'AI версия один', human: 'Человек написал один' },
    { id: 2, score: 0.1, ai: 'AI версия два', human: 'Человек написал два' },
    { id: 3, score: 0.1, ai: 'AI три', human: 'Человек три' },
  ];
  const chatB = mk({ delete: [{ n: 10, reason: 'призыв' }], replace: [{ n: 2, was: 'Это очень удобно и важно для каждого продавца', now: 'Продавцам это нужно' }] });
  const bb = await dry(TEXT, { variant: 'B', chat: chatB, pairs: pairsFake });
  const userMsg = chatB.calls[0].messages.find((m) => m.role === 'user').content;
  check('v3 B: в промпте 3 пары', (userMsg.match(/Пример \d\./g) || []).length === 3 && /Человек написал два/.test(userMsg));
  check('v3 B: замена применена, факты ок', /Продавцам это нужно/.test(bb.after) && bb.facts.ok, bb.after);
  check('v3 B: флаг копирования считается', bb.copy && typeof bb.copy.flag === 'boolean');
  const chatA2 = mk({ delete: [], replace: [] });
  await dry(TEXT, { variant: 'A', chat: chatA2 });
  check('v3 A: пар в промпте нет', !/Пример 1\./.test(chatA2.calls[0].messages.find((m) => m.role === 'user').content));

  const chatB2 = mk({ delete: [], replace: [{ n: 2, was: 'очень удобно и важно', now: 'нужно уже с 5 марта' }] });
  const b2 = await dry(TEXT, { variant: 'B', chat: chatB2, pairs: pairsFake });
  check('v3 B: новое число в замене отклонено', b2.rejected.length === 1 && b2.after === TEXT, JSON.stringify(b2.rejected));

  // пары: источник исключён, только dev
  const pp = pickPairs('Платная почта Яндекс, лимит на отправку писем и цена Ozon', { sourceId: 1014 });
  const split = require('../data/split.json').split;
  check('v3: пары — до 3, источник исключён', pp.length === 3 && !pp.some((x) => x.id === 1014), JSON.stringify(pp.map((x) => x.id)));
  check('v3: пары только из dev', pp.every((x) => split[x.id] === 'dev'), JSON.stringify(pp.map((x) => split[x.id])));

  // реальные AI-тексты dev: пустая правка ничего не ломает
  const ai = require('../data/ai_posts.json').filter((x) => x.split === 'dev');
  let allOk = true;
  for (const x of ai.slice(0, 40)) { const r = await dry(x.text, { variant: 'A', chat: mk({ delete: [], replace: [] }) }); if (r.after !== x.text) allOk = false; }
  check('v3: пустая правка на 40 AI dev не меняет текст', allOk);
};
