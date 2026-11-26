'use strict';
// Шаг «Разбор и правки» (заменил «Сократить», шаг 11): модель находит приёмы письма, типичные для нейросетей,
// и предлагает замену КАЖДОГО фрагмента; решает, что можно применить, и применяет КОД.
//   buildRequest(text)            -> тело запроса к Claude (без сети; его же шлёт HTTP-нода n8n)
//   parseJson(raw)                -> {findings:[...]} или null
//   apply(text, js, {allow,links})-> {status, text, findings, edits, found, fixed, ...}
//   explainFix(text, {chat,...})  -> то же + вызов модели (для проверки на dev; в n8n не используется)
// Модель возвращает {"findings":[{quote, sign, why, fix}]}, quote — ТОЧНАЯ подстрока текста.
// Код проверяет каждую находку: quote есть в тексте ровно 1 раз; fix не теряет и не добавляет фактов (checkFacts(quote, fix));
// отрицание/условие не появляется и не исчезает; фрагмент не пересекается с кликабельной ссылкой, /allow, заголовком, подписью;
// удалять целиком (fix="") можно только подводку, штамп, эмодзи-маркер, призыв в конце, и только если в quote нет факта,
// отрицания и целевого призыва, и quote — не единственное предложение абзаца с ключевым словом, которое встречается ниже.
// Не прошла проверку — остаётся «признаком» с причиной, текст не меняется. Потом checkFacts(оригинал, результат); при сбое — откат.
// Шаг 18: правки модели в текст НЕ вносятся. Автоматически применяет только код по закрытому списку (src/safe_fix.js: зачины, шаблонные призывы,
// «!» лозунга, чистые усилители, цифры-эмодзи). Замены модели, прошедшие whyNot, показываются редактору как «Можно заменить» (rec.variant);
// опция applyModel (старое поведение) нужна только тестам и экспериментам на dev.
const { parseText, bodyParagraphs, wordCount } = require('./textparse');
const { extractFacts, checkFacts } = require('./facts');
const { safeEdits, sentences, NEG_PREV, LEAD_CONTRAST_START } = require('./safe_fix');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4000;
const MAX_FINDINGS = 30;
const MIN_RATIO = 0.6;       // результат не короче 60% исходного
const MAX_GROW = 1.1;        // fix не длиннее quote больше чем на 10%
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const CATALOG = require('./signs_catalog');
// пункты каталога: {1: 'Антитеза «не X, а Y»…'}; sign в ответе модели = номер (и название) пункта
const ITEMS = {};
for (const m of CATALOG.matchAll(/^(\d{1,2})\. (.+)$/gm)) ITEMS[Number(m[1])] = m[2].trim();
const SHORT = require('./signs_short');
const shortTitle = (n) => SHORT[n] || '';
// пункты 21–22, 39–40, 48 и 50: текст не правим, пишем подсказку автору (модель не выдумывает пример или цифру)
const HINTS = { 21: 'Добавьте пример или цифру.', 22: 'Добавьте пример или цифру.', 39: 'Добавьте, что думаете вы и почему.', 40: 'Добавьте живой случай, например имя, дату или историю из практики.', 48: 'Довод слабо связан с главной мыслью, решать вам.', 50: 'Проверьте форму слова.' };
// пункты — свойство текста в целом или вёрстка/слабый сигнал: фрагментом не заменить, только отметить
const NO_EDIT = new Set([30, 31, 32, 33, 34, 35, 36, 37, 38, 41, 43, 44, 46]);
// целиком убирать можно только пустое: подводки, связки, вводные, штампы, усилители, призывы, обещания, отсылки без источника
const DELETABLE = new Set([4, 14, 15, 16, 17, 18, 23, 24, 25, 27, 28, 45]);
const ANTITHESIS = new Set([1, 2]); // «не» в таких фразах — часть приёма, при исправлении исчезает
// шаблонные зачины-подводки: снять их — и есть правка п.4/п.14
const LEADIN = /^(?:проблема в другом|секрет в том|суть (?:проста|в том)|главное\s*[—–-]|важно отметить|стоит отметить|дело в том|всё просто|все просто|фишка в том|вот в ч[её]м (?:дело|штука)|не секрет)[^\p{L}]*(?:что[,\s]+)?/iu;
const CTA_SIGNS = new Set([24, 25, 28]);
// автоправки включаются только при зоне «много приёмов» (как в bot_core.finalZone): оценка модели >= 55 и >= 3 разных пункта среди находок
const AUTO_MIN_MEAN = 55;
const AUTO_MIN_SIGNS = 3;
const AUTO_SIGN = { LEAD: 4, CTA: 24, EXC: 10, AMP: 23 }; // под каким пунктом показываем безопасную правку, когда она не применяется

const SYSTEM = `Ты редактор Telegram-канала сервиса аналитики для селлеров маркетплейсов. Тебе дают текст поста. Пройди по нему с каталогом приёмов письма, которые типичны для текстов нейросетей (каталог ниже), найди места, где приём заметен, и для каждого предложи замену фрагмента. Ты ищешь приёмы, а не факты: фактами, терминами, названиями, цифрами и ссылками не занимайся. Это не вердикт об авторстве: люди тоже так пишут.

Верни ТОЛЬКО JSON, без пояснений и без Markdown:
{"findings":[{"quote":"…","sign":"1. Антитеза","why":"…","fix":"…"}]}

Правила:
1. Пройди по каждому пункту каталога по порядку, с 1 по 50, и для каждого найденного приёма верни цитату. Верни все найденные места, на один пункт до 3 цитат, не больше ${MAX_FINDINGS} находок всего, самые важные первыми. Если приёмов нет, верни {"findings":[]}. Сомневаешься — не включай.
2. sign — номер и название пункта каталога («9. Вывод-мораль»). Только пункты из каталога.
3. quote — ТОЧНАЯ подстрока текста, скопированная символ в символ (с пунктуацией, ё, эмодзи): одно предложение или его часть, строго в пределах одной строки (без переносов и пустых строк). quote встречается в тексте ровно один раз.
4. why — до 15 слов простым языком: в чём приём.
5. fix — замена именно этого фрагмента: короче или такой же длины, тем же смыслом, на тех же словах и фактах, без новых данных. Грамматика должна позволять вставить fix на место quote без других правок. Если quote начинается с заглавной и заканчивается точкой, fix тоже. Если фрагмент можно просто убрать без потери смысла, fix — пустая строка "".
6. Для пунктов 21, 22, 39, 40, 48, 50 текст не правь и ничего не придумывай: fix — пустая строка, в why напиши, чего не хватает (пример, цифра, позиция автора, живой случай, опора для довода). Пункт 50: явную ошибку согласования, падежа или опечатку («мы отправляет») отметь как отдельную находку, quote — слово или короткий оборот с ошибкой, в why назови, что не так. Для пункта 39, 40 и других свойств текста в целом quote может быть началом подходящего абзаца или пустым.
7. Для пунктов 30, 31, 33–38, 41, 43, 44, 46 (вёрстка, ритм, слабый сигнал) fix оставь пустым: это только отметка.
8. В fix нельзя: опечатки, «))», многоточия, сленг, разговорные вставки, «живые» подделки под человека, новые числа, названия, ссылки, @теги. Не меняй и не убирай отрицания, условия и ограничения («не», «только», «если», «пока»), кроме самой конструкции «не X, а Y», которую ты превращаешь в прямое утверждение.
9. Не трогай ссылки и целевые призывы анонса (регистрация, ссылка на эфир, запись), заголовок и подпись поста.
10. Отбор. Не пропускай найденное: если приём в тексте есть, он должен быть в ответе. Отмечай настоящие приёмы (штамп, подводка, мораль, пустой усилитель, тройка, антитеза, шаблонный вопрос или призыв), а не обычные инструкции и условия по делу: «Если покупатели пишут…, сверьте…» — нормальная инструкция, а не антитеза п. 1 или 26. Для каждой находки, где правка уместна, обязательно дай fix: находка без замены почти бесполезна. Пустой fix "" (удалить фразу целиком) код принимает только для пунктов 4, 14–18, 23–25, 27, 28, 45, и только когда в фразе нет фактов, условий и инструкций. Для остальных пунктов (9, 11, 13, 26, 29 и др.) дай замену: ту же мысль короче и проще, на тех же словах и с теми же уточнениями («в карточке», «на Ozon»), либо не включай находку. Пункт 9 — это итоговая мораль или лозунг, а не любое предложение с выводом по делу.

# Правила замены, которые проверит код
Код отклонит замену, если нарушено любое из правил. Пиши fix так, чтобы он их проходил.
- Числа, названия, термины, ссылки, @теги остаются как есть, новых нет.
- Связки «хотя, но, однако, зато, потому что, поэтому, так как, а» остаются (кроме самой антитезы «не X, а Y»).
- Оговорки («может, многие, обычно, часто, почти, можно, иногда, бывает») остаются; «все, всегда, точно, каждый, любой» не добавляются.
- Условия и отрицания («если, когда, пока, только, не, без, нет, ни») остаются в том же составе; убрать можно только одно «не» в антитезе.
- Дополнения и предметы («загрузил нужные файлы») не выкидываются: из тройки убирай один пункт целиком, остальные оставь дословно.
- Событие то же: глагол цитаты остаётся (или его точный синоним). «Успела отразиться» не меняй на «пришли».
- Новых книжных слов нет («достоверно, осуществляет, является, данный, в рамках, обеспечивает, посредством, приобретать, истекший»). Лучше самое простое слово из цитаты.
- В fix не больше «:», «—», «;» и скобок, чем в quote.
- fix не длиннее quote, одна строка, конец и заглавная как в quote. Двоеточие в конце подводки остаётся.
- Чаще всего подходит минимальная правка: убрать пустое слово или оборот, а остальные слова цитаты оставить дословно. Не пересказывай фразу.

# Каталог

${CATALOG}`;

const USER = (text) => '# Пост\n\n' + text;

function buildRequest(text) {
  return {
    model: MODEL, max_tokens: MAX_TOKENS,
    thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
    system: SYSTEM, messages: [{ role: 'user', content: USER(text) }],
  };
}

function parseJson(raw) {
  const t = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const a = t.search(/[{[]/);
  if (a < 0) return null;
  const b = t.lastIndexOf(t[a] === '{' ? '}' : ']');
  if (b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return Array.isArray(j) ? { findings: j } : j; } catch { return null; }
}

// ---------------- проверки ----------------
const NEG = /(?<![\p{L}\p{N}])(?:не|нет|без|кроме|только|если|когда|пока|нельзя|ни|нигде|никогда)(?![\p{L}\p{N}])/iu;
const LINK = /https?:\/\/|www\.|t\.me\/|@[\p{L}\p{N}_]|→|->/iu;
const TARGET_CTA = /(?<![\p{L}])(?:регистр\p{L}*|запиш\p{L}*|записыва\p{L}*|переход\p{L}*|перейд\p{L}*|ссылк\p{L}*|заполн\p{L}*|участв\p{L}*|подайте|заявк\p{L}*)/iu;
const FAKE_LIVE = /\){2,}|\.{3,}|…|!{2,}|\?{2,}|[\u{1F600}-\u{1F64F}]|(?<![\p{L}])(?:короче|блин|типа|ну|капец|жесть|хрень|офигенн\p{L}*)(?![\p{L}])/iu;
// оговорки-смягчения и слова категоричности: правка не должна делать утверждение сильнее, чем в оригинале
const HEDGE = /(?<![\p{L}])(?:многие|многих|некоторые|некоторых|часто|обычно|иногда|почти|может|могут|можно|скорее|возможно|вероятно|как правило|бывает|вроде бы|вроде|кажется|похоже|якобы|будто)(?![\p{L}])/giu;
const CATEG = /(?<![\p{L}])(?:все|всех|всегда|никогда|каждый|каждого|любой|любого|точно|гарантирован\p{L}*)(?![\p{L}])/iu;
const IMPERATIVE = /(?<![\p{L}])(?<!(?<![\p{L}])вы\s+)(?!давайте(?![\p{L}]))[\p{L}]{2,}(?:йте|ите|ьте)(?![\p{L}])|(?<![\p{L}])(?:нужно|надо|необходимо|следует)\s+[\p{L}]+(?:ть|ться|ти)(?![\p{L}])/iu;
const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[*•–—-])\s+/;

const negCount = (s) => (norm(s).match(new RegExp(NEG.source, 'giu')) || []).length;
// набор слов-условий и отрицаний: {слово: сколько раз}; сравниваем по составу, а не по количеству
const negBag = (s) => { const b = {}; for (const w of norm(s).match(new RegExp(NEG.source, 'giu')) || []) b[w] = (b[w] || 0) + 1; return b; };
const bagEq = (a, b) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); for (const w of k) if ((a[w] || 0) !== (b[w] || 0)) return false; return true; };
// антитеза: из набора можно убрать только одно «не» (всё остальное должно остаться)
const bagMinusOneNe = (q, f) => { const k = new Set([...Object.keys(q), ...Object.keys(f)]); let removed = 0; for (const w of k) { const d = (q[w] || 0) - (f[w] || 0); if (d < 0) return false; if (d > 0) { if (w !== 'не' || d > 1) return false; removed += d; } } return removed === 1; };
const wordsOf = (s) => norm(s).match(/[\p{L}][\p{L}-]*/gu) || [];
const stemOf = (w) => w.slice(0, Math.min(w.length, 5));
const STOP = new Set(['просто', 'только', 'это', 'эти', 'этот', 'того', 'тому', 'чтобы', 'что', 'как', 'так', 'для', 'при', 'про', 'над', 'под', 'или', 'тоже', 'даже', 'еще', 'все', 'есть', 'быть', 'было', 'была', 'были', 'будет', 'нужно', 'надо', 'можно', 'уже', 'лишь', 'вот', 'там', 'тут', 'его', 'их', 'ваш', 'ваши', 'вам', 'вас', 'нас', 'нам', 'они', 'она', 'оно', 'тем', 'чем', 'кто', 'где', 'если', 'когда', 'пока', 'ради']);
const VERBISH = /(?:ть|ться|тся|ется|ются|ет|ют|ит|ут|ат|ят|ешь|ишь|ем|им|ли|ло|ла|ал|ил|ул|ся|сь)$/;
// слова из отбрасываемой части антитезы («не X», «, а не X»), которых не осталось во всём тексте после правки: это информация, а не риторика
function lostInAntithesis(text, f) {
  const after = norm(text.slice(0, f.start) + ' ' + f.fix + ' ' + text.slice(f.end));
  const stems = new Set(wordsOf(after).map(stemOf));
  for (const m of norm(f.quote).matchAll(/(?<![\p{L}\p{N}])не(?![\p{L}\p{N}])\s+(?:просто\s+)?([^,.;:!?\n]+)/gu)) {
    const seg = m[1].split(/\s+(?:а|но)\s+/)[0];
    for (const w of wordsOf(seg)) {
      if (w.length < 4 || STOP.has(w) || VERBISH.test(w)) continue;
      if (!stems.has(stemOf(w))) return w;
    }
  }
  return null;
}
// п.23 усилители: убрать можно только чистые усилители; «реально» и всё прочее не трогаем
const CLEAN_AMPLIFIERS = new Set(['действительно', 'по-настоящему', 'очень', 'крайне']);
function amplifierProblem(f) {
  const fb = {};
  for (const w of wordsOf(f.fix)) fb[w] = (fb[w] || 0) + 1;
  for (const w of wordsOf(f.quote)) {
    if (fb[w]) { fb[w]--; continue; }
    if (!CLEAN_AMPLIFIERS.has(w)) return w;
  }
  return null;
}

function occurrences(text, q) {
  let n = 0, i = -1, first = -1;
  while ((i = text.indexOf(q, i + 1)) >= 0) { if (!n) first = i; n++; }
  return { n, first };
}

// абзац (блок до пустой строки), в котором лежит позиция
function paragraphAt(text, pos) {
  let a = text.lastIndexOf('\n\n', pos); a = a < 0 ? 0 : a + 2;
  let b = text.indexOf('\n\n', pos); if (b < 0) b = text.length;
  return { a, b };
}

// запрещённые для правок диапазоны: заголовок (одна короткая строка в начале), подпись в конце
function protectedRanges(text) {
  const parsed = parseText(text);
  const body = new Set(bodyParagraphs(parsed));
  const out = [];
  parsed.forEach((p, i) => {
    const heading = i === 0 && p.lines.length === 1 && wordCount(p.text) <= 12 && !/[.!…]$/.test(p.text.trim()); // заголовок без точки в конце; первая короткая фраза с точкой — обычный текст
    if (!body.has(p) || heading) out.push({ start: p.start, end: p.end, why: heading ? 'Это заголовок поста' : 'Это подпись к посту' });
  });
  return out;
}

// Ключевые слова quote (≥6 букв, основа 5 знаков), которые встречаются ниже абзаца и которые больше нигде в этом абзаце не звучат.
function lonelyKeyword(text, start, end) {
  const { a, b } = paragraphAt(text, start);
  const other = norm(text.slice(a, start) + ' ' + text.slice(end, b));
  const below = norm(text.slice(b));
  for (const m of text.slice(start, end).matchAll(/[\p{L}]{6,}/gu)) {
    const stem = norm(m[0]).slice(0, 5);
    const re = new RegExp('(?<![\\p{L}])' + stem, 'u');
    if (re.test(below) && !re.test(other)) return m[0];
  }
  return null;
}

// служебные и «водяные» основы, потеря которых смысла не меняет (вводные, связки, усилители, штампы)
const STOP5 = new Set(['котор', 'также', 'более', 'кроме', 'потом', 'чтобы', 'этого', 'такой', 'такие', 'таким', 'всего', 'очень', 'крайн', 'дейст', 'по-на', 'важно', 'стоит', 'отмет', 'именн', 'проще', 'получ', 'итоге', 'главн', 'самом', 'деле', 'конеч', 'просто', 'други', 'можно', 'нужно', 'будет', 'сейча', 'всегд', 'каждо', 'резул']);
// ---- защиты шага 16 (замечания ревью 4 и Astra) ----
// союзы-связки: если пропали из замены, вторая часть фразы начинает спорить с первой («хотя» → точка)
const CONNECT = [['хотя', /(?<![\p{L}-])хотя(?![\p{L}-])/gu], ['но', /(?<![\p{L}-])но(?![\p{L}-])/gu], ['однако', /(?<![\p{L}-])однако(?![\p{L}-])/gu], ['зато', /(?<![\p{L}-])зато(?![\p{L}-])/gu],
  ['потому что', /(?<![\p{L}-])потому\s+что(?![\p{L}-])/gu], ['поэтому', /(?<![\p{L}-])поэтому(?![\p{L}-])/gu], ['так как', /(?<![\p{L}-])так\s+как(?![\p{L}-])/gu], ['а', /(?<![\p{L}-])а(?![\p{L}-])/gu]];
function lostConnective(q, fx, anti) {
  const nq = norm(q), nf = norm(fx);
  for (const [name, re] of CONNECT) {
    if (anti && (name === 'а' || name === 'но')) continue; // в «не X, а Y» эти союзы — часть приёма
    if ((nq.match(re) || []).length > (nf.match(re) || []).length) return name;
  }
  return null;
}
// книжные слова: если замена их приносит, а в исходной фразе их не было — правка делает текст книжнее
const BOOKISH = /(?<![\p{L}-])(?:достоверн\p{L}*|осуществ\p{L}*|являет\p{L}*|являю\p{L}*|данн(?:ый|ая|ое|ого|ому|ым|ой|ую|ых|ыми)|в рамках|обеспеч\p{L}*|посредством|произв(?!одител|одств)\p{L}*|приобрет\p{L}*|функционир\p{L}*|предоставл\p{L}*|истекш\p{L}*|вследствие|ввиду|реализов\p{L}*)/giu;
function bookishAdded(q, fx) {
  const have = new Set((norm(q).match(BOOKISH) || []).map((w) => w.slice(0, 5)));
  for (const w of norm(fx).match(BOOKISH) || []) if (!have.has(w.slice(0, 5))) return w;
  return null;
}
// перечисление: число однородных членов по запятым и «и/или»
const itemCount = (s) => 1 + (s.match(/,/g) || []).length + (norm(s).match(/(?<![\p{L}])(?:и|или)(?![\p{L}])/gu) || []).length;
// вопрос читателю с конкретным предметом («А вы уже замечали расхождения в соинвесте?»): шаблонное «Как вам?» можно убрать, это — нет
const GENERIC_Q = new Set(['хотите', 'хочешь', 'попробовать', 'попробуйте', 'пробовали', 'думаете', 'думаешь', 'мнение', 'мнении', 'мнения', 'опыт', 'опыта', 'опытом', 'опыте', 'интересно', 'согласны', 'нравится', 'понравилось', 'полезно', 'комментариях', 'комментарии', 'пишите', 'делитесь', 'расскажите', 'напишите']);
const BAIT_Q = /задумывались ли вы|знали ли вы|а вы знали|вы когда-нибудь|представьте,? что|^\s*а (?:какой|какая|какое|какие)|что думаете|как думаете|согласны\?|больше всего|чаще всего/;
function concreteQuestion(q) {
  for (const sent of q.split(/(?<=\?)/)) {
    if (!sent.includes('?')) continue;
    const n = norm(sent);
    if (BAIT_Q.test(n)) continue; // заходы и вопросы-приманки никогда не «вопрос по делу»
    if (/замечал|сталкивал|как у вас/.test(n)) return true;
    if ((n.match(/[\p{L}]{5,}/gu) || []).some((w) => !GENERIC_Q.has(w) && !/^ваш/.test(w))) return true;
  }
  return false;
}
// глаголы-события: инфинитив, прошедшее, часть настоящего; модальные и вспомогательные не считаем
const AUX = /^(?:усп|смог|смож|мож|мог|стал|став|стан|нач|был|быть|буд|хоте|хоч|долж)/;
const SYN = [['дела', 'сдела'], ['польз', 'испол'], ['показ', 'видн'], ['нужн', 'необх'], ['получ', 'прихо'], ['помог', 'помоч']];
function verbStems(s) {
  const out = new Set();
  for (const w of wordsOf(s)) {
    if (w.length < 5 || AUX.test(w)) continue;
    const inf = /[аяеиоуы]ть(?:ся)?$|ти(?:сь)?$|чь$/.test(w);
    const past = /(?:ла|ло|ли|лся|лась|лось|лись)$/.test(w) ? w.replace(/(?:ла|ло|ли|лся|лась|лось|лись)$/, '').length >= 4 : /[^сш]л$/.test(w) && w.length >= 5;
    const pres = /(?:ется|ются|ится|ятся|ается|яется|уется|ует|уют|ают|яют)$/.test(w);
    if (inf || past || pres) out.add(stemOf(w));
  }
  return out;
}
const sameRoot = (a, b) => a === b || SYN.some(([x, y]) => (a.startsWith(x) && b.startsWith(y)) || (a.startsWith(y) && b.startsWith(x)));
// был один глагол-событие, стал другой («отразиться» → «пришли»): описывается другое событие
function verbShift(q, fx) {
  const qv = [...verbStems(q)], fv = [...verbStems(fx)];
  if (!qv.length) return false;
  const fxAll = new Set(wordsOf(fx).map(stemOf)), qAll = new Set(wordsOf(q).map(stemOf));
  const lostV = qv.filter((v) => !fxAll.has(v) && !fv.some((x) => sameRoot(v, x)));
  const newV = fv.filter((v) => !qAll.has(v) && !qv.some((x) => sameRoot(v, x)));
  return lostV.length > 0 && newV.length > 0;
}
// сколько слов исходной фразы и замены не совпало (для замен «одно слово на другое»)
function changedWords(q, fx) {
  const fb = {};
  for (const w of wordsOf(fx)) fb[w] = (fb[w] || 0) + 1;
  let lost = 0;
  for (const w of wordsOf(q)) { if (fb[w]) fb[w]--; else lost++; }
  const added = Object.values(fb).reduce((a, b) => a + b, 0);
  return Math.max(lost, added);
}
const WORD_SWAP_SIGNS = new Set([16, 17, 47, 49]); // здесь замена глагола — суть правки (при небольшом числе изменённых слов)

// уточнение «в карточке», «на Ozon» не выкидываем: предлог со словом, которого нет в замене (вводные «в итоге», «в целом» можно)
const FILLER_PP = /^(?:в результате|в итоге|в целом|в общем|в принципе|в конце концов|на самом деле|по сути|по факту|по большому счёту)$/;
function lostComplement(q, fx) {
  const fxStems = new Set(wordsOf(fx).map(stemOf));
  for (const m of norm(q).matchAll(/(?<![\p{L}])(в|на|из|по|для|со?|от|за|при|через|между)\s+(\p{L}{4,})/gu)) {
    if (FILLER_PP.test(m[1] + ' ' + m[2]) || FILLER_PP.test(m[0])) continue;
    const prep = new RegExp('(?<![\\p{L}])' + m[1] + '(?![\\p{L}])', 'gu');
    if ((norm(fx).match(prep) || []).length >= (norm(q).match(prep) || []).length) continue; // предлог остался: это замена слова на слово, не потеря уточнения
    if (!fxStems.has(stemOf(m[2]))) return m[0];
  }
  return null;
}
// «Прямая корреляция врёт: чек…» — до двоеточия стоит не одно слово-ярлык («Вывод:»), а смысл: убирать нельзя
function lostHead(q, fx) {
  const i = q.indexOf(':'); if (i < 0) return null;
  const head = wordsOf(q.slice(0, i));
  if (head.length < 3) return null;
  const fxStems = new Set(wordsOf(fx).map(stemOf));
  for (const w of head) if (w.length >= 4 && !STOP.has(w) && !fxStems.has(stemOf(w))) return w;
  return null;
}

// ---- защиты шага 19 (замечания ревью 6 и Astra) ----
// слова времени: «теперь», «уже», «раньше», «ещё», «снова», «пока» несут смысл («после апреля»), в варианте их терять нельзя
const TIME_WORDS = [['теперь', /(?<![\p{L}-])теперь(?![\p{L}-])/gu], ['уже', /(?<![\p{L}-])уже(?![\p{L}-])/gu], ['раньше', /(?<![\p{L}-])раньше(?![\p{L}-])/gu],
  ['ещё', /(?<![\p{L}-])еще(?![\p{L}-])/gu], ['снова', /(?<![\p{L}-])снова(?![\p{L}-])/gu], ['пока', /(?<![\p{L}-])пока(?![\p{L}-])/gu]];
function lostTimeWord(q, fx) {
  const nq = norm(q), nf = norm(fx);
  for (const [name, re] of TIME_WORDS) if ((nq.match(re) || []).length > (nf.match(re) || []).length) return name;
  return null;
}
// перечисление «А, Б или В» / «А, Б и В»: запятая, союз «и/или» и 3+ члена; в варианте членов должно остаться не меньше
function enumShrunk(q, fx) {
  const nq = norm(q).replace(/«[^»]*»/gu, '');
  if (!/,/.test(nq) || !/(?<![\p{L}])(?:и|или)(?![\p{L}])/u.test(nq)) return false;
  return itemCount(q) >= 3 && itemCount(fx) < itemCount(q);
}
// вариант почти целиком повторяет соседнее предложение: 60% и больше смысловых слов варианта (основы по 5 знаков) уже есть в соседнем
const contentStems = (s) => [...new Set((norm(s).match(/[\p{L}][\p{L}-]{3,}/gu) || []).map((w) => w.slice(0, 5)).filter((w) => !STOP5.has(w)))];
function dupNeighbor(text, f, fx) {
  const own = contentStems(fx);
  if (own.length < 4) return null;
  const all = sentences(text);
  const before = all.filter((x) => x.end <= f.start).pop(), after = all.find((x) => x.start >= f.end);
  for (const nb of [before, after]) {
    if (!nb) continue;
    const ns = new Set(contentStems(text.slice(nb.start, nb.end)));
    if (own.filter((w) => ns.has(w)).length / own.length >= 0.6) return text.slice(nb.start, nb.end).trim();
  }
  return null;
}

// соседние предложения: два до цитаты и два после (через абзацы)
function neighbors(text, f) {
  const all = sentences(text);
  const before = all.filter((x) => x.end <= f.start).slice(-2).reverse(), after = all.filter((x) => x.start >= f.end).slice(0, 2);
  const t = (x) => text.slice(x.start, x.end).trim();
  return { prev: before[0] ? t(before[0]) : '', next: after[0] ? t(after[0]) : '', next2: after.map(t) };
}
const shortQuestion = (s) => /\?[\s\p{Extended_Pictographic}\uFE0F]*$/u.test(s) && (s.match(/[\p{L}][\p{L}-]*/gu) || []).length <= 3;
const CONCESSIVE = /^(?:казалось бы|конечно|допустим|да,|согласен|понятно)(?![\p{L}])/iu;
const BUT_START = /^[«"\s]*(?:но|однако|а)(?![\p{L}])/iu;

// почему замену применять нельзя (строка) или null; sentinel-проверки, общие для замены и удаления
function whyNot(text, f, ctx) {
  const q = f.quote, fx = f.fix;
  const hit = (list) => list.find((r) => r.start < f.end && r.end > f.start);
  const lk = hit(ctx.links || []); if (lk) return 'Здесь кликабельная ссылка';
  const pr = hit(ctx.prot); if (pr) return pr.why;
  const al = (ctx.allow || []).map(norm).find((a) => a && norm(q).includes(a)); if (al) return 'Эта фраза в списке исключений';
  if (NO_EDIT.has(f.sign)) return 'Это про оформление или ритм всего текста, одной заменой тут не обойтись, решать вам';
  if (LINK.test(q)) return 'Здесь ссылка, адрес или имя пользователя';
  if (TARGET_CTA.test(norm(q)) && CTA_SIGNS.has(f.sign)) return 'Это главный призыв анонса';
  if ((f.sign === 24 || f.sign === 25) && q.includes('?') && concreteQuestion(q)) return 'Это вопрос читателю по делу, убирать его или нет, решать вам';
  // контрастный зачин («Проблема в другом…») отвечает на предыдущую фразу: после отрицания в ней его не снимаем (то же условие, что в автоправках)
  if (f.start >= 0 && LEAD_CONTRAST_START.test(norm(q)) && NEG_PREV.test(norm(neighbors(text, f).prev))) return 'Зачин отвечает на предыдущую фразу, без него связь пропадёт';
  if (fx !== '') {
    if (fx === q) return 'Замена ничем не отличается от исходного текста';
    if (/:$/.test(q) && !/:$/.test(fx)) return 'Без двоеточия список или пояснение ниже повиснет';
    if (/\n/.test(fx)) return 'Замена получилась в несколько строк';
    if (fx.length > q.length * MAX_GROW + 2) return 'Замена длиннее исходного текста';
    if (FAKE_LIVE.test(fx) && !FAKE_LIVE.test(q)) return 'Замена изображает живую речь многоточием, сленгом или повтором знаков';
    // подводка-интрига (п.4) и вводные (п.14): если замена = та же фраза без шаблонного зачина — это и есть правка, пропускаем
    if ((f.sign === 4 || f.sign === 14) && LEADIN.test(q)) {
      const bare = q.replace(LEADIN, '');
      if (norm(bare).replace(/[^\p{L}\p{N}]/gu, '') === norm(fx).replace(/[^\p{L}\p{N}]/gu, '')) return null;
    }
    const c = checkFacts(q, fx);
    const anti = ANTITHESIS.has(f.sign);
    // в антитезе отброшенная половина «не для того, чтобы «…»» может содержать кавычки: это риторика, не факт
    const realMissing = anti ? c.missing.filter((m) => m.type !== 'quote') : c.missing;
    if (realMissing.length || c.added.length) return 'Замена меняет факты, ' + [...realMissing.map((m) => 'потеряно ' + m.value), ...c.added.map((m) => 'добавлено ' + m.value)].slice(0, 3).join(', ');
    const bq = negBag(q), bf = negBag(fx);
    if (anti ? !bagMinusOneNe(bq, bf) : !bagEq(bq, bf)) return 'Замена меняет отрицание или условие';
    if (anti) { const lost = lostInAntithesis(text, f); if (lost) return `Вместе с отброшенной частью ушло бы «${lost}», а это уже информация`; }
    if (f.sign === 23) { const w = amplifierProblem(f); if (w) return `Вместе с усилителем ушло бы слово «${w}», и смысл мог бы сдвинуться`; }
    // смягчения («многие», «может», «обычно»…) не выкидываем: иначе правка усиливает категоричность
    const hedges = (s) => (norm(s).match(HEDGE) || []).length;
    if (hedges(fx) < hedges(q)) return 'Пропала бы оговорка вроде «многие», «может» или «обычно», и утверждение стало бы жёстче';
    if (CATEG.test(norm(fx)) && !CATEG.test(norm(q))) return 'Появилось бы «все» или «всегда», и утверждение стало бы жёстче';
    // правка не должна добавлять тяжёлых знаков (п. 49)
    const heavy = (s) => (s.match(/[:;—–()]/g) || []).length;
    if (heavy(fx) > heavy(q)) return 'В замене больше двоеточий, тире или скобок, чем было';
    // смысловые слова (от 5 букв, сравнение по основе из 5 букв) не должны пропадать из самой цитаты: иначе теряется суть
    // («подключил нужные инструменты» → «подключил»). То, что слово есть ниже по тексту, потерю не отменяет.
    // Антитезе разрешено отбросить отвергнутую половину, но не больше половины смысловых слов.
    const stems = (s) => (norm(s).match(/\p{L}{5,}/gu) || []).map((w) => w.slice(0, 5));
    const inFx = new Set(stems(fx));
    const own = [...new Set(stems(q))].filter((s) => !STOP5.has(s));
    const lost = own.filter((s) => !inFx.has(s));
    // замена слова на слово (синоним) не потеря: вычитаем новые смысловые слова замены
    const added = [...inFx].filter((s) => !STOP5.has(s) && !own.includes(s)).length;
    if (own.length && Math.max(0, lost.length - added) / own.length > (anti ? 0.5 : 0.34)) return 'Замена выкидывает важные слова, и смысл потерялся бы';
    // для приёмов, где суть не в вычёркивании слов (мораль, повтор, пересказ…), не теряем ни одного смыслового слова: «новые замеры» → «замеры» нельзя
    const LENIENT = anti || DELETABLE.has(f.sign) || WORD_SWAP_SIGNS.has(f.sign) || f.sign === 5 || f.sign === 26;
    if (!LENIENT && lost.length - added > 0) return 'Замена выкидывает важные слова, и смысл потерялся бы';
    // союз-связка не должен пропасть: иначе вторая часть начнёт спорить с первой
    const lc = lostConnective(q, fx, anti); if (lc) return `В замене пропало «${lc}», и связь между частями фразы потерялась бы`;
    if (!anti) { const lc2 = lostComplement(q, fx); if (lc2) return `В замене пропало «${lc2}», и часть смысла потерялась бы`; }
    { const lh = lostHead(q, fx); if (lh) return `До двоеточия стоит смысл фразы, и «${lh}» пропало бы`; }
    // замена не должна делать текст книжнее
    const bk = bookishAdded(q, fx); if (bk) return `Замена стала бы книжнее, в ней появилось «${bk}»`;
    // тройка: сокращать перечисление, а не выкидывать дополнение
    if (f.sign === 5 && itemCount(fx) >= itemCount(q) && lost.length) return 'Замена теряет слова и не сокращает перечисление, часть смысла пропала бы';
    // тот же глагол-событие: «отразиться» не заменяем на «пришли»
    if (!anti && (!WORD_SWAP_SIGNS.has(f.sign) || changedWords(q, fx) > 3) && verbShift(q, fx)) return 'В замене другой глагол, и смысл сдвинулся бы';
    if (enumShrunk(q, fx)) return 'В замене в перечне меньше пунктов, и открытый список стал бы закрытым';
    { const tw = lostTimeWord(q, fx); if (tw) return `В замене пропало «${tw}», и время в тексте изменилось бы`; }
    { const dn = dupNeighbor(text, f, fx); if (dn) return 'Замена почти повторяет соседнюю фразу «' + dn.slice(0, 50) + (dn.length > 50 ? '…' : '') + '»'; }
    return null;
  }
  // удаление целиком
  if (f.start >= 0) {
    const nb = neighbors(text, f);
    if (shortQuestion(nb.prev)) return 'Рядом короткий вопрос «' + nb.prev.slice(0, 30) + '», без этой фразы он остался бы без ответа';
    if (shortQuestion(nb.next)) return 'Следом идёт короткий вопрос, он опирается на эту фразу';
    if (CONCESSIVE.test(norm(q)) && nb.next2.some((x) => BUT_START.test(x))) return 'Это уступка вроде «Казалось бы», а следующая фраза с «Но» или «Однако» спорит с ней и без неё потеряет опору';
  }
  if (/:$/.test(q)) return 'Это подводка к списку или пояснению, без неё текст ниже повиснет';
  if (!DELETABLE.has(f.sign)) return 'Без этой фразы абзац не держится, нужна ваша замена';
  if (f.sign === 23) { const w = amplifierProblem(f); if (w) return `Вместе с усилителем ушло бы слово «${w}», и смысл мог бы сдвинуться`; }
  const facts = extractFacts(q);
  if (facts.length) return 'Во фразе есть факт, ' + facts.slice(0, 3).map((x) => x.value).join(', ');
  if (NEG.test(norm(q))) return 'Во фразе есть отрицание, ограничение или условие';
  if (IMPERATIVE.test(norm(q)) && !CTA_SIGNS.has(f.sign)) return 'Во фразе есть инструкция для читателя';
  const kw = lonelyKeyword(text, f.start, f.end);
  if (kw) return `Без этой фразы слово «${kw}» ниже по тексту осталось бы без пояснения`;
  return null;
}

// ---------------- фильтры находок кодом (шаг 18, замечания ревью 5 и Astra) ----------------
// служебные слова: находка, которая сводится к одному такому слову, редактору не нужна («его данные» → «данные», «уже успела» → «успела»)
const SERVICE = new Set([...STOP, 'ее', 'её', 'ваша', 'ваше', 'вашу', 'вашей', 'всем', 'весь', 'всех', 'всё', 'именно', 'самый', 'самое', 'вообще', 'ли', 'бы', 'же', 'то', 'даже', 'лишь', 'результате', 'итоге', 'целом', 'общем', 'принципе', 'в', 'и', 'а', 'но', 'на']);
function serviceOnly(f) {
  const qw = wordsOf(f.quote);
  if (qw.length && qw.length <= 2 && qw.every((w) => SERVICE.has(w))) return true;
  if (f.fix === undefined || f.fix === '') return false;
  const fb = {};
  for (const w of wordsOf(f.fix)) fb[w] = (fb[w] || 0) + 1;
  const diff = [];
  for (const w of wordsOf(f.quote)) { if (fb[w]) fb[w]--; else diff.push(w); }
  for (const [w, n] of Object.entries(fb)) for (let i = 0; i < n; i++) diff.push(w);
  return diff.length === 1 && SERVICE.has(diff[0]);
}
// за вопросом-подзаголовком идёт список или инструкция: это нормальный заголовок раздела, не приём
const KEYCAP_ITEM = /^\s*(?:[0-9]\uFE0F?\u20E3|\u{1F51F})/u;
const isWholeLine = (text, f) => { const a = text.lastIndexOf('\n', f.start - 1) + 1, b = text.indexOf('\n', f.end); return text.slice(a, b < 0 ? text.length : b).trim() === f.quote.trim(); };
function followedByInstruction(text, end) {
  const lines = text.slice(end).replace(/^\s+/, '').split('\n').slice(0, 3);
  return lines.some((l) => LIST_LINE.test(l) || KEYCAP_ITEM.test(l)) || IMPERATIVE.test(norm(lines[0] || '').split(/[.!?]/)[0]);
}
const quoteInQuotes = (text, f) => f.start >= 0 && (/[«»"„“”]/.test(f.quote) || (text.slice(0, f.start).match(/«/g) || []).length > (text.slice(0, f.start).match(/»/g) || []).length || (text.slice(0, f.start).match(/"/g) || []).length % 2 === 1);
const sentenceOf = (text, f) => { const s = sentences(text).find((x) => x.start <= f.start && x.end > f.start); return s ? text.slice(s.start, s.end) : f.quote; };
// цифра, «например» или «→» в этом и соседних абзацах (±2): пример или цифра уже есть, подсказка «нужен пример» лишняя
function exampleNearby(text, f) {
  if (f.start < 0) return false;
  const paras = []; let off = 0;
  for (const p of text.split(/\n\s*\n/)) { const a = text.indexOf(p, off); paras.push({ a, b: a + p.length, p }); off = a + p.length; }
  const i = paras.findIndex((x) => f.start >= x.a && f.start <= x.b);
  if (i < 0) return false;
  return paras.slice(Math.max(0, i - 2), i + 3).some((x) => /\d|→|(?<![\p{L}])например(?![\p{L}])/iu.test(x.p.replace(/[0-9#*]\uFE0F?\u20E3/gu, '')));
}
// п.20 «осторожные оговорки» без самой оговорки и п.9 «мораль» на факте с датой — ошибки разбора (пост про ключи Ozon, 26.11)
const HEDGE_MARK = /(?<![\p{L}])(?:стоит|имеет смысл|может|могут|можно|возможно|вероятно|пожалуй|скорее|по возможности|желательно|рекомендуе|в некотор|в какой-то|в целом|как правило|обычно|иногда|отчасти|в принципе|по сути|не всегда|не обязательно|при необходимости|если нужно|если потребуется|лучше|вроде|кажется|похоже|пока неясно|неясно|не факт|не исключ|под вопросом|гипотез|требу[а-я]* (?:отдельной )?провер)/iu;
const MORAL_MARK = /(?<![\p{L}])(?:итог|главн|вывод|помни|запомн|важн|стоит|нужн|надо|не забыва|всегда|никогда|лучше|проще|просто|секрет|правило|чем кажется)/iu;
// цитата целиком внутри «…» (чья-то прямая речь): перед ней кавычка открыта, внутри цитаты кавычек нет
const insideSpeech = (text, f) => {
  if (f.start < 0 || /[«»]/.test(f.quote)) return false;
  const before = text.slice(0, f.start);
  return (before.match(/«/g) || []).length > (before.match(/»/g) || []).length;
};
const OPINION = /(?<![\p{L}])(?:мне кажется|по-моему|по моему|я думаю|я считаю|как по мне|на мой взгляд|я уверен|мне думается)(?![\p{L}])/iu;
function filterFinding(text, f) {
  if (!f.hint && insideSpeech(text, f)) return 'это чужая прямая речь в кавычках, автор её не писал';
  if (f.sign === 34 && f.start >= 0 && (f.quote.match(/[.!?…](?=\s|$)/g) || []).length <= 1) return 'пункт 34 про длину абзацев, на одно предложение не ставится';
  if ([4, 9, 14, 20].includes(f.sign) && OPINION.test(norm(f.quote))) return 'личное мнение автора — живой признак, а не шаблон';
  if (f.sign === 47 && wordsOf(f.quote).length < 3) return 'ярлык «книжное слово» на цитате короче трёх слов';
  if (f.sign === 47 && quoteInQuotes(text, f)) return 'ярлык «книжное слово» на тексте в кавычках';
  if ((f.sign === 21 || f.sign === 22) && f.start >= 0 && (IMPERATIVE.test(norm(f.quote)) || IMPERATIVE.test(norm(sentenceOf(text, f))))) return 'предложение-инструкция, а не абстракция';
  if ((f.sign === 21 || f.sign === 22) && /\d/.test(f.quote)) return 'в цитате есть цифра';
  if ((f.sign === 21 || f.sign === 22) && exampleNearby(text, f)) return 'пример или цифра есть в соседних абзацах';
  if (f.sign === 39 && f.start >= 0 && (f.quote.match(/[.!?…](?=\s|$)/g) || []).length <= 1) return 'пункт 39 про текст в целом, на одно предложение не ставится';
  if ((f.sign === 32 || (f.sign === 3 && f.quote.length <= 70 && isWholeLine(text, f))) && f.start >= 0 && followedByInstruction(text, f.end)) return 'за вопросом идёт инструкция или список';
  if (!f.hint && serviceOnly(f)) return 'сводится к одному служебному слову';
  if (f.hint && (f.sign === 21 || f.sign === 22) && /\d/.test(f.quote)) return 'в цитате есть цифра';
  if (f.sign === 20 && !HEDGE_MARK.test(norm(f.quote))) return 'нет слова-оговорки';
  if (f.sign === 9 && /\d/.test(f.quote) && !MORAL_MARK.test(norm(f.quote))) return 'факт с числом или датой, а не мораль';
  return null;
}

// ---------------- применение правок ----------------
const isUp = (c) => !!c && c.toLowerCase() !== c.toUpperCase() && c === c.toUpperCase();
const isLow = (c) => !!c && c.toLowerCase() !== c.toUpperCase() && c === c.toLowerCase();

// замена с мелкой подгонкой: конец и заглавная буква как в quote
function tidyFix(text, f) {
  let fx = f.fix;
  if (!fx) return fx;
  const q = f.quote;
  const tail = /[.!?]+$/.exec(q);
  if (tail && !/[.!?…]$/.test(fx)) fx = fx.replace(/[,;:\s]+$/, '') + tail[0];
  if (isUp(q[0]) && isLow(fx[0])) fx = fx[0].toUpperCase() + fx.slice(1);
  return fx;
}

// edits: [{start, end, ins}] без пересечений; ins '' = удаление. -> новый текст
function build(text, edits) {
  let s = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    const before = s.slice(0, e.start), after = s.slice(e.end);
    if (e.ins) { s = before + e.ins + after; continue; }
    const startOfSentence = /(?:^|\n)[ \t]*$|[.!?…][»"”)]*[ \t]+$/.test(before);
    let b = before, a = after;
    if (/[ \t]$/.test(b) && /^[ \t]/.test(a)) a = a.replace(/^[ \t]+/, '');      // пробел с двух сторон: один лишний
    else if (/[ \t]$/.test(b) && /^[,.;:!?\n]|^$/.test(a)) b = b.replace(/[ \t]+$/, ''); // перед знаком или концом строки
    else if (/(?:^|\n)$/.test(b) && /^[ \t]/.test(a)) a = a.replace(/^[ \t]+/, '');  // в начале строки
    if (startOfSentence && isLow(a[0])) a = a[0].toUpperCase() + a.slice(1);
    s = b + a;
  }
  return s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

// ---------------- применение ответа модели ----------------
function apply(text, js, opts = {}) {
  const out = { status: null, text, findings: [], edits: [], found: 0, fixed: 0, dropped: [], rolled_back: [] };
  if (!js || !Array.isArray(js.findings)) { out.status = 'error'; return out; }
  const prot = protectedRanges(text);
  const ctx = { links: opts.links || [], allow: opts.allow || [], prot };
  const list = [];
  for (const d of js.findings.slice(0, MAX_FINDINGS + 2)) {
    const quote = d && typeof d.quote === 'string' ? d.quote.trim() : '';
    const signRaw = String((d && d.sign) || '').trim();
    const num = Number((/^\s*(?:п\.?\s*)?(\d{1,2})/.exec(signRaw) || [])[1]);
    const sign = ITEMS[num] ? num : null;
    const fixRaw = d && typeof d.fix === 'string' ? d.fix.trim() : '';
    const why = String((d && d.why) || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!sign) { out.dropped.push({ quote, why: 'пункт не из каталога: ' + signRaw.slice(0, 30) }); continue; }
    if (quote.includes('\n') && !HINTS[sign]) { out.dropped.push({ quote: quote.slice(0, 60).split('\n').join(' '), why: 'цитата занимает несколько строк' }); continue; }
    if (sign === 48 && (quote.match(/[\p{L}\p{N}-]+/gu) || []).length <= 6 && !/лучше|хуже|важн|главн|нужн|надо|должн|всегда|никогда|очень|самый|самая|самое|только|невозможн|любой|каждый/i.test(quote)) { out.dropped.push({ quote, why: 'короткий факт, не довод' }); continue; }
    if ((sign === 1 || sign === 2) && !/(?:^|[^\p{L}])не(?:[^\p{L}]|$)/iu.test(quote)) { out.dropped.push({ quote, why: 'нет отрицания, это не противопоставление' }); continue; }
    if (quote.length > 400) { out.dropped.push({ quote: quote.slice(0, 60), why: 'слишком длинная цитата' }); continue; }
    const occ = quote ? occurrences(text, quote) : { n: 0, first: -1 };
    if (HINTS[sign]) { // подсказка автору: правки нет; цитата необязательна (свойство текста в целом)
      list.push({ quote: occ.n ? quote : '', sign, why, fix: '', start: occ.n ? occ.first : -1, end: occ.n ? occ.first + quote.length : -1, dup: false, hint: true });
      continue;
    }
    if (!quote) { out.dropped.push({ quote, why: 'пустая цитата' }); continue; }
    if (!occ.n) { out.dropped.push({ quote, why: 'цитаты нет в тексте' }); continue; }
    list.push({ quote, sign, why, fix: fixRaw, start: occ.first, end: occ.first + quote.length, dup: occ.n > 1 });
  }
  out.filtered = [];
  for (let i = list.length - 1; i >= 0; i--) { const why = filterFinding(text, list[i]); if (why) { out.filtered.push({ quote: list[i].quote, sign: list[i].sign, why }); list.splice(i, 1); } }
  // автоправки кодом по закрытому списку (safe_fix); в живом тексте (noEdit) не применяются.
  // Шаг 19: применяются только при зоне «много приёмов» (оценка модели >= 55 и >= 3 разных пункта среди находок; это же число считает bot_core.finalZone через out.signs).
  // Иначе (gate) безопасные правки показываются как варианты. Без opts.gate/opts.mean (тесты, эксперименты) условие не проверяется.
  out.signs = [...new Set(list.filter((f) => f.start >= 0 && f.sign !== 50).map((f) => f.sign))];
  const gated = !!opts.gate || opts.mean !== undefined;
  const autoOk = !gated || (typeof opts.mean === 'number' && opts.mean >= AUTO_MIN_MEAN && out.signs.length >= AUTO_MIN_SIGNS);
  const flag = list.filter((f) => (f.sign === 9 || f.sign === 10) && f.start >= 0).map((f) => ({ start: f.start, end: f.end }));
  const cand = opts.noEdit || opts.noAuto ? [] : safeEdits(text, { ...ctx, flag });
  const auto = autoOk ? cand : [];
  out.auto_off = cand.length > 0 && !autoOk;
  const asVariants = [];
  if (out.auto_off) {
    const WHY = { LEAD: 'шаблонный зачин', CTA: 'шаблонный призыв', EXC: 'лозунг с «!»', AMP: 'пустой усилитель' };
    const all = sentences(text);
    const bySent = new Map(); // все безопасные правки одного предложения — одним вариантом
    for (const e of cand) {
      const sn = all.find((x) => x.start <= e.start && x.end >= e.end) || all.find((x) => x.start <= e.start && x.end > e.start);
      if (!sn) continue;
      if (!bySent.has(sn.start)) bySent.set(sn.start, { sn, es: [] });
      bySent.get(sn.start).es.push(e);
    }
    for (const { sn, es } of bySent.values()) {
      const quote = text.slice(sn.start, sn.end);
      const fix = es.some((e) => e.kind === 'CTA') ? '' : build(quote, es.map((e) => ({ start: e.start - sn.start, end: Math.min(e.end, sn.end) - sn.start, ins: e.ins }))).trim();
      asVariants.push({ quote, sign: AUTO_SIGN[es[0].kind], why: WHY[es[0].kind], fix, start: sn.start, end: sn.end, dup: false, safe: true });
    }
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].hint && list[i].start >= 0 && asVariants.some((v) => v.start < list[i].end && v.end > list[i].start)) { out.filtered.push({ quote: list[i].quote, sign: list[i].sign, why: 'совпадает с безопасной правкой (показана как вариант)' }); list.splice(i, 1); }
    list.push(...asVariants);
  }
  for (let i = list.length - 1; i >= 0; i--) { // находка на том же месте, что и автоправка, — дубль
    if (!list[i].hint && list[i].start >= 0 && auto.some((e) => e.start < list[i].end && e.end > list[i].start)) { out.filtered.push({ quote: list[i].quote, sign: list[i].sign, why: 'уже исправлено автоматически' }); list.splice(i, 1); }
  }
  list.sort((a, b) => (a.start < 0) - (b.start < 0) || a.start - b.start);
  // пересечения: оставляем первую, вторая уходит в «отброшено»
  const kept = [];
  for (const f of list) {
    const prev = kept.filter((x) => x.start >= 0).pop();
    if (f.start >= 0 && prev && f.start < prev.end) { out.dropped.push({ quote: f.quote, why: 'пересекается с другой находкой' }); continue; }
    kept.push(f);
  }
  const cut = kept.slice(0, MAX_FINDINGS);
  const edits = auto.map((e, k) => ({ i: -1 - k, start: e.start, end: e.end, ins: e.ins, auto: e }));
  cut.forEach((f, i) => {
    const bad = f.hint || f.safe ? null : opts.noEdit ? 'живой текст: правки не применяются' : f.dup ? 'цитата встречается в тексте больше одного раза' : whyNot(text, f, ctx);
    const rec = { n: i + 1, quote: f.quote, sign: f.sign, title: shortTitle(f.sign), why: f.why, fix: f.fix, start: f.start, end: f.end, action: 'note', reason: bad, rejected: !!bad && !f.hint && !opts.noEdit && !NO_EDIT.has(f.sign) };
    if (f.hint) { rec.action = 'hint'; rec.hint = HINTS[f.sign]; rec.reason = null; }
    else if (!bad) {
      rec.action = f.fix === '' ? 'delete' : 'replace';
      rec.fix = tidyFix(text, f);
      if (rec.fix === f.quote) { rec.action = 'note'; rec.reason = 'Замена ничем не отличается от исходного текста'; rec.rejected = true; out.findings.push(rec); return; }
      rec.variant = rec.fix; // проверенный вариант для редактора, в текст не вносится
      if (opts.applyModel) edits.push({ i: rec.n - 1, start: f.start, end: f.end, ins: rec.fix });
    }
    out.findings.push(rec);
  });
  // итог: checkFacts(оригинал, результат); при сбое откатываем правки, в которых потерян/добавлен факт, потом все
  const roll = (idx, why) => { if (idx < 0) return; const k = out.findings[idx]; if (k.action !== 'note') { out.rolled_back.push({ quote: k.quote, why }); k.action = 'note'; k.reason = why; k.rejected = true; } };
  let cur = edits.slice();
  const render = () => build(text, cur);
  let res = render();
  for (let i = 0; i < 6 && cur.length; i++) {
    const c = checkFacts(text, res);
    if (c.ok && res.length / text.length >= MIN_RATIO) break;
    const vals = [...c.missing.map((m) => m.value), ...c.added.map((m) => m.value)];
    let any = false;
    if (!c.ok) {
      for (const e of [...cur]) {
        const near = text.slice(e.start, e.end) + ' ' + e.ins;
        if (vals.some((v) => near.includes(v))) { roll(e.i, 'После правки не сходятся числа и названия, например ' + vals.slice(0, 2).join(', ')); cur = cur.filter((x) => x !== e); any = true; }
      }
    } else { const e = cur[cur.length - 1]; roll(e.i, 'После правки текст стал бы слишком коротким'); cur = cur.slice(0, -1); any = true; }
    if (!any) { for (const e of cur) roll(e.i, 'Факты не сходятся'); cur = []; }
    res = render();
  }
  out.edits = cur.map((e) => ({ start: e.start, end: e.end, ins: e.ins, quote: text.slice(e.start, e.end), kind: e.auto ? e.auto.kind : 'model', del: e.auto ? e.auto.del : undefined, show: e.auto ? e.auto.show : undefined }));
  out.auto = out.edits.filter((e) => e.kind !== 'model');
  out.text = cur.length ? res : text;
  // куда показывать: «можно заменить» (suggest), «ещё стоит посмотреть» (note), оставлено намеренно (left)
  const LEFT = /кликабельная ссылка|заголовок|подпись|исключение редакции|целевой призыв|вопрос читателю по делу|больше одного раза|ссылка, @|замена совпадает/;
  for (const r of out.findings) r.kind = r.hint || NO_EDIT.has(r.sign) ? 'note' : (r.reason && LEFT.test(r.reason) ? 'left' : 'suggest');
  out.found = out.findings.length;
  out.fixed = cur.length;
  out.status = cur.length ? 'fixed' : 'unchanged';
  out.length_change = +(out.text.length / text.length - 1).toFixed(3);
  out.facts_ok = checkFacts(text, out.text).ok;
  return out;
}

// ---------------- повтор для отклонённых (шаг 17) ----------------
// Один дополнительный вызов той же модели: «эти замены код отклонил по таким причинам, предложи новые для тех же цитат».
// Не повторяем то, что модель исправить не может: ссылки, заголовок, /allow, целевой призыв, вопрос по делу, повтор цитаты.
const NO_RETRY = /кликабельная ссылка|заголовок|подпись|исключение редакции|целевой призыв|вопрос читателю по делу|больше одного раза|ссылка, @|замена совпадает/;
const MAX_RETRY = 5;
function retryCandidates(out) {
  return (out.findings || []).filter((f) => f.rejected && f.reason && !NO_RETRY.test(f.reason) && !f.hint).slice(0, MAX_RETRY)
    .map((f) => ({ quote: f.quote, sign: f.sign, fix: f.fix, reason: f.reason }));
}
const SYSTEM_RETRY = SYSTEM.slice(0, SYSTEM.indexOf('# Каталог')).trim(); // каталог для повтора не нужен: пункты уже названы
const RETRY_USER = (cands) => '# Повтор\n\nЭти замены код отклонил по таким причинам:\n\n' +
  cands.map((c, i) => `${i + 1}. quote: «${c.quote}»\n   твоя замена: ${c.fix === '' ? '(удалить фразу)' : '«' + c.fix + '»'}\n   причина: ${c.reason}`).join('\n\n') +
  '\n\nПредложи новые замены для этих же цитат, соблюдая «Правила замены, которые проверит код». Если лучше не трогать, верни fix "". Минимальная правка: убрать пустое слово или оборот, остальное дословно. Верни ТОЛЬКО JSON того же формата {"findings":[{"quote":"…","sign":"…","why":"…","fix":"…"}]}, только для этих цитат, quote без изменений.';
function buildRetryRequest(text, js, cands) {
  return { model: MODEL, max_tokens: MAX_TOKENS, thinking: { type: 'between_tools' }, output_config: { effort: 'low' }, system: SYSTEM_RETRY,
    messages: [{ role: 'user', content: USER(text) }, { role: 'assistant', content: JSON.stringify({ findings: js.findings }) }, { role: 'user', content: RETRY_USER(cands) }] };
}
// js — первый ответ модели, js2 — повтор, cands — что повторяли; результат тот же, что у apply, у переделанных rec.retried = true
function applyRetry(text, js, js2, cands, opts = {}) {
  const redo = new Map();
  for (const d of (js2 && Array.isArray(js2.findings) ? js2.findings : [])) {
    const q = d && typeof d.quote === 'string' ? d.quote.trim() : '';
    if (q && cands.some((c) => c.quote === q) && typeof d.fix === 'string' && d.fix.trim() !== '') redo.set(q, d.fix.trim()); // "" = «лучше не трогать»: остаётся прежнее отклонение
  }
  const merged = { findings: (js.findings || []).map((d) => {
    const q = d && typeof d.quote === 'string' ? d.quote.trim() : '';
    return redo.has(q) ? { ...d, fix: redo.get(q) } : d;
  }) };
  const r = apply(text, merged, opts);
  for (const f of r.findings) if (redo.has(f.quote)) f.retried = true;
  r.retried = redo.size;
  return r;
}

// только для проверки на dev (в n8n вызов делает HTTP-нода)
async function explainFix(text, opts = {}) {
  const chat = opts.chat || require('./llm').chat;
  const res = await chat({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER(text) }], max_tokens: MAX_TOKENS, tag: opts.tag || 'explain_fix' });
  const r = apply(text, parseJson(res.text), { allow: opts.allow, links: opts.links });
  r.cost = res.cost; r.raw = res.text;
  const cands = retryCandidates(r);
  if (!opts.noRetry && !opts.noEdit && cands.length) {
    const js = parseJson(res.text), rq = buildRetryRequest(text, js, cands);
    const res2 = await chat({ model: MODEL, messages: [{ role: 'system', content: SYSTEM_RETRY }, ...rq.messages], max_tokens: MAX_TOKENS, tag: (opts.tag || 'explain_fix') + '_retry' });
    const r2 = applyRetry(text, js, parseJson(res2.text), cands, { allow: opts.allow, links: opts.links });
    r2.cost = (res.cost || 0) + (res2.cost || 0); r2.raw = res.text; r2.raw2 = res2.text; r2.first_fixed = r.fixed;
    return r2;
  }
  return r;
}

module.exports = { SYSTEM_RETRY, retryCandidates, buildRetryRequest, applyRetry, SHORT, MODEL, MAX_TOKENS, MAX_FINDINGS, ITEMS, HINTS, shortTitle, SYSTEM, buildRequest, parseJson, apply, explainFix, build, whyNot, lonelyKeyword };
