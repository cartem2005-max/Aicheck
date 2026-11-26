'use strict';
// Word lists for facts.js: months, weekdays, numbers in words, units, known marketplace names.
// Everything is matched on text where "ё" is already replaced with "е" (see normalize in textparse.js),
// with flags "iu" (case-insensitive, Unicode letters).

// ---------- months and weekdays: one regex source per item, order = number ----------
const MONTH_FORMS = ['январ[ьяеюи]', 'феврал[ьяеюи]', 'март[аеу]?', 'апрел[ьяеюи]', 'ма[йяеюи]', 'июн[ьяеюи]',
  'июл[ьяеюи]', 'август[аеу]?', 'сентябр[ьяеюи]', 'октябр[ьяеюи]', 'ноябр[ьяеюи]', 'декабр[ьяеюи]'];
const WEEKDAY_FORMS = ['понедельник\\p{L}*', 'вторник\\p{L}*', 'сред(?:а|ы|у|е|ой)', 'четверг\\p{L}*',
  'пятниц\\p{L}*', 'суббот\\p{L}*', 'воскресень\\p{L}*'];
const indexIn = (forms, word) => forms.findIndex(f => new RegExp('^' + f + '$', 'iu').test(word)) + 1;
const MONTH_RE = '(?:' + MONTH_FORMS.join('|') + ')';
const WEEKDAY_RE = '(?:' + WEEKDAY_FORMS.join('|') + ')';

// ---------- numbers written in words: [value, forms] ----------
const NUMBER_WORDS = [
  ['1', 'один(?!\\s+из(?![\\p{L}]))|одна|одно|одну|одного|одной'], ['2', 'два|две|двух|двум|двумя'],
  ['3', 'три|трех|трем|тремя'], ['4', 'четыре|четырех|четырем|четырьмя'], ['5', 'пять|пяти|пятью'],
  ['6', 'шесть|шести|шестью'], ['7', 'семь|семи|семью'], ['8', 'восемь|восьми|восемью'],
  ['9', 'девять|девяти|девятью'], ['10', 'десять|десяти|десятью'], ['11', 'одиннадцать|одиннадцати'],
  ['12', 'двенадцать|двенадцати'], ['100', 'сто|ста'], ['200', 'двести|двухсот'], ['300', 'триста|трехсот'],
  ['1000', 'тысяча|тысячу|тысячей'], ['2', 'пара|пару|пары|парой'], ['1.5', 'полтора|полторы|полутора']
];
const NUMBER_WORD_RE = '(?:' + NUMBER_WORDS.map(([, f]) => f).join('|') + ')';
const numberWordValue = w => (NUMBER_WORDS.find(([, f]) => new RegExp('^(?:' + f + ')$', 'iu').test(w)) || [])[0];

// ---------- scale right after a number: 5%, 3К, 2 млн, 70 миллиардов ----------
// "к" counts only when glued to the number ("3К"), otherwise it is the preposition "к".
const SCALE_RE = /^(?:\s?(%|(?:процент\p{L}*|тысяч\p{L}*|тыс\.?|миллион\p{L}*|млн|миллиард\p{L}*|млрд)(?![\p{L}]))|([кk])(?![\p{L}]))/iu;
function scaleKey(s) {
  s = s.toLowerCase();
  if (s === '%' || s.startsWith('процент')) return '%';
  if (s.startsWith('тыс')) return 'тыс';
  if (s.startsWith('миллион') || s.startsWith('млн')) return 'млн';
  if (s.startsWith('миллиард') || s.startsWith('млрд')) return 'млрд';
  return 'к';
}

// ---------- unit after a number: [canonical name, regex source] ----------
// A different unit means a different fact: "90 дней" is not "90 часов", "₽" is not "$".
const UNITS = [
  ['дн', '(?:дн(?:я|ей|ям|ями|ях)|день)(?![\\p{L}])'], ['ч', '(?:час(?:а|ов|ам|ами|ах)?|ч)(?![\\p{L}])'],
  ['мин', '(?:минут\\p{L}*|мин\\.?)(?![\\p{L}])'], ['нед', '(?:недел\\p{L}*|нед\\.?)(?![\\p{L}])'],
  ['мес', '(?:месяц\\p{L}*|мес\\.?)(?![\\p{L}])'], ['г', '(?:год(?:а|у|ом|е|ы|ов|ам|ах)?|лет)(?![\\p{L}])'],
  ['₽', '(?:руб\\p{L}*|р\\.|₽)'], ['$', '(?:\\$|долл\\p{L}*)'], ['шт', '(?:шт\\.?|штук\\p{L}*)(?![\\p{L}])'],
  ['раз', 'раз(?:а|ов|ам|ах)?(?![\\p{L}])']
].map(([name, src]) => [name, new RegExp('^\\s?' + src, 'iu')]);
// "34 990 ₽/мес", "в год": the period of a price or a rate is part of the fact
const PERIOD_RE = /^(?:\/|\s+в\s+|\s+за\s+)\s?(месяц\p{L}*|мес\.?|год\p{L}*|день|дн\p{L}*|недел\p{L}*|час\p{L}*)(?![\p{L}])/iu;
function periodKey(w) {
  w = w.toLowerCase();
  return w.startsWith('мес') ? 'мес' : w.startsWith('год') ? 'г' : w.startsWith('нед') ? 'нед' : w.startsWith('час') ? 'ч' : 'дн';
}

// ---------- known names (Latin and Cyrillic spelling count as the same name) ----------
const PLATFORMS = [
  ['ozon', 'ozon|озон\\p{L}{0,3}'], ['wb', 'wildberries|wb|вб|вайлдберриз\\p{L}*'],
  ['яндекс маркет', 'яндекс[ -]маркет\\p{L}*'], ['алиэкспресс', 'алиэкспресс\\p{L}*|aliexpress'],
  ['мегамаркет', 'мегамаркет\\p{L}*|megamarket'], ['мойсклад', 'мойсклад\\p{L}*|мой склад']
];
const PLATFORM_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PLATFORMS.map(([, f]) => `(${f})`).join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
// which platform matched: the index of the filled capture group
const platformKey = m => PLATFORMS[m.slice(1).findIndex(g => g !== undefined)][0];

module.exports = { MONTH_RE, WEEKDAY_RE, NUMBER_WORD_RE, SCALE_RE, UNITS, PERIOD_RE, PLATFORM_RE,
  monthIndex: w => indexIn(MONTH_FORMS, w), weekdayIndex: w => indexIn(WEEKDAY_FORMS, w),
  numberWordValue, scaleKey, periodKey, platformKey };
