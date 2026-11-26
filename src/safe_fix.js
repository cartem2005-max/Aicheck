'use strict';
// Автоправки (шаг 18, сужены в шаге 19): ТОЛЬКО то, где смысл не может пострадать, по закрытому списку, кодом и без модели.
//   LEAD  — шаблонный зачин в начале предложения («Важно отметить, что», «Не секрет, что», «Всё просто:»): снимается целиком, следующее слово с заглавной
//   CTA   — отдельное предложение-призыв без фактов («Пишите в комментариях 👇», «Ставьте реакцию», «Сохраняйте пост»): удаляется; вопрос перед ним остаётся
//   EXC   — «!» -> «.» только в предложении, которое «Разбор» отметил как п.10 (лозунг) или п.9 (мораль) и которое последнее в абзаце, не в первом абзаце, 6+ слов, не призыв и не вопрос
//   AMP   — чистые усилители «действительно», «по-настоящему» («очень» и «крайне» меняют степень: «крайне редко» -> «редко», не трогаем; «реально» тоже)
// Автоправки (закрытый список): шаблонные зачины, шаблонные призывы, «!» в лозунге или морали, усилители «действительно» и «по-настоящему».
// Цифры-эмодзи («1️⃣») в автоправки не входят: это вёрстка, а не признак нейросети; бот показывает их в «Оформлении».
// Включает автоправки не этот файл, а explain_fix.apply: только при зоне «много приёмов» (оценка >= 55 и >= 3 разных пункта); ниже они показываются как варианты.
// safeEdits(text, ctx) -> [{start, end, ins, kind, del, show}] без пересечений; ctx = {links, allow, prot, flag} (запрещённые диапазоны; flag — диапазоны, отмеченные «Разбором» как п.9/п.10).
// Всё остальное, что находит «Разбор» (антитезы, книжные слова, тройки…), сюда не попадает: это варианты для редактора.

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

// зачины. Первая группа — «контрастные»: они отвечают на предыдущую фразу, поэтому после отрицания в ней не снимаются
const LEAD_CONTRAST = '(?:проблема в другом|секрет в том|суть в том|дело в том|фишка в том|вот в ч[её]м (?:дело|штука))';
const LEAD_PLAIN = '(?:важно отметить|стоит отметить|не секрет|всё просто|все просто|суть проста)';
const LEAD_RE = new RegExp(`^(${LEAD_CONTRAST}|${LEAD_PLAIN})(?:,?\\s+что\\s+|\\s*[:,—–-]\\s*)(?=\\p{L})`, 'iu');
const LEAD_CONTRAST_RE = new RegExp(`^${LEAD_CONTRAST}$`, 'iu');
const NEG_PREV = /(?<![\p{L}\p{N}])(?:не|нет|без|никак|ни)(?![\p{L}\p{N}])/iu;

// призывы: предложение целиком (после снятия эмодзи и знаков) должно подойти под шаблон
const FILL = '(?:об\\s+этом|нам|мне|свои|свой|своим|вашим?|ваши|ваше|мысли|мнением?|опытом?|истории|идеи|вопросы|ответы|впечатления|что\\s+думаете)';
const CTA_RES = [
  new RegExp(`^(?:а\\s+)?(?:пишите|напишите|делитесь|поделитесь|расскажите|отвечайте)(?:\\s+${FILL}){0,3}\\s+в\\s+коммент\\p{L}*$`, 'u'),
  /^(?:ставьте|ставь|жмите|жми|кидайте)\s+(?:(?:свои|вашу|на)\s+)?(?:реакци\p{L}*|лайк\p{L}*|огонь\p{L}*|сердечк\p{L}*)(?:\s+(?:если\s+(?:понравилось|полезно|было\s+полезно|согласны)|под\s+постом|ниже))?$/u,
  /^(?:сохраняйте|сохраните|сохрани)\s+(?:этот\s+)?(?:пост|публикацию|себе|в\s+избранное)(?:\s+(?:себе|чтобы\s+не\s+потерять))?$/u,
  /^(?:пересылайте|перешлите)\s+(?:этот\s+)?(?:пост\s+|это\s+)?(?:коллегам|друзьям|знакомым)$/u,
];

const AMP_RE = /(?<![\p{L}\p{N}-])(действительно|по-настоящему)(?![\p{L}\p{N}-])/giu;
const IMPERATIVE = /(?<![\p{L}])[\p{L}]{2,}(?:йте|ите|ьте)(?![\p{L}])|(?<![\p{L}])(?:нужно|надо|необходимо|следует)\s+[\p{L}]+(?:ть|ться|ти)(?![\p{L}])/iu;
const TARGET_CTA = /(?<![\p{L}])(?:регистр\p{L}*|запиш\p{L}*|записыва\p{L}*|переход\p{L}*|перейд\p{L}*|ссылк\p{L}*|заполн\p{L}*|участв\p{L}*|подайте|заявк\p{L}*)/iu;

// предложения построчно: [{start, end, line}] — end включает конечные знаки, закрывающую кавычку и эмодзи-указатель
function sentences(text) {
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    const re = /[^.!?…]+(?:[.!?…]+[»"”)]*)?(?:[ \t]*[\p{Extended_Pictographic}\u{FE0F}]+)*/gu;
    let m;
    while ((m = re.exec(line))) {
      const lead = m[0].length - m[0].trimStart().length;
      const s = off + m.index + lead, e = off + m.index + m[0].trimEnd().length;
      if (e > s) out.push({ start: s, end: e, lineStart: off, lineEnd: off + line.length });
    }
    off += line.length + 1;
  }
  return out;
}
const insideQuotes = (text, pos) => (text.slice(0, pos).match(/«/g) || []).length > (text.slice(0, pos).match(/»/g) || []).length;
const wordsIn = (s) => s.match(/[\p{L}][\p{L}-]*/gu) || [];

function safeEdits(text, ctx = {}) {
  const hit = (list, a, b) => (list || []).some((r) => r.start < b && r.end > a);
  const lineOf = (a, b) => text.slice(text.lastIndexOf('\n', a - 1) + 1, (text.indexOf('\n', b) + 1 || text.length + 1) - 1);
  const allowed = (a, b) => !hit(ctx.links, a, b) && !hit(ctx.prot, a, b) && !(ctx.allow || []).map(norm).some((x) => x && norm(lineOf(a, b)).includes(x));
  const edits = [];
  const push = (e) => { if (allowed(e.start, e.end) && !edits.some((x) => x.start < e.end && x.end > e.start)) edits.push(e); };

  const sents = sentences(text);
  const firstParaEnd = text.indexOf(String.fromCharCode(10, 10)) < 0 ? text.length : text.indexOf(String.fromCharCode(10, 10));
  // последнее предложение абзаца (лозунг в конце), не заголовок
  const endsParagraph = (s) => text.slice(s.end, s.lineEnd).trim() === '' && (s.lineEnd >= text.length || text[s.lineEnd + 1] === String.fromCharCode(10));
  sents.forEach((s, i) => {
    const sent = text.slice(s.start, s.end);
    const plain = norm(sent.replace(EMOJI, ' ').replace(/[.!?…»"”)]+$/u, '').replace(/\s+/g, ' ').trim());
    const wholeLine = text.slice(s.lineStart, s.start).trim() === '' && text.slice(s.end, s.lineEnd).trim() === '';

    // LEAD: зачин в начале предложения, дальше в этом же предложении не меньше 3 слов
    const lm = LEAD_RE.exec(sent);
    if (lm) {
      const rest = sent.slice(lm[0].length);
      const prev = sents[i - 1] ? text.slice(sents[i - 1].start, sents[i - 1].end) : '';
      const contrast = LEAD_CONTRAST_RE.test(norm(lm[1]));
      if (wordsIn(rest).length >= 3 && !(contrast && NEG_PREV.test(norm(prev)))) {
        push({ start: s.start, end: s.start + lm[0].length, ins: '', kind: 'LEAD', del: sent.slice(0, lm[0].length).trim(), show: '' });
        return;
      }
    }
    // CTA: шаблонный призыв отдельным предложением
    if (plain && !/\d/.test(plain) && CTA_RES.some((r) => r.test(plain)) && !TARGET_CTA.test(plain)) {
      let a = s.start, b = s.end;
      if (wholeLine) { if (text[b] === '\n') b++; else while (a > 0 && text[a - 1] === '\n') a--; }
      push({ start: a, end: b, ins: '', kind: 'CTA', del: sent, show: '' });
      return;
    }
    // EXC: «!» в конце предложения, отмеченного «Разбором» как лозунг (п.10) или мораль (п.9): последнее предложение абзаца, не первый абзац, 6+ слов
    const em = /!(?=[»"”)]*$)/u.exec(sent);
    if (em && hit(ctx.flag, s.start, s.end) && !/!!|\?|!\s*[\p{Extended_Pictographic}]/u.test(sent) && sent.endsWith('!') && wordsIn(sent).length >= 6 && endsParagraph(s) && s.start >= firstParaEnd && !IMPERATIVE.test(norm(sent)) && !TARGET_CTA.test(norm(sent)) && !insideQuotes(text, s.end)) {
      push({ start: s.end - 1, end: s.end, ins: '.', kind: 'EXC', del: '!', show: '.' });
    }
  });

  // AMP: чистые усилители
  let m;
  AMP_RE.lastIndex = 0;
  while ((m = AMP_RE.exec(text))) {
    const a = m.index, b = a + m[0].length;
    const before = norm(text.slice(Math.max(0, a - 12), a)), after = text.slice(b, b + 3);
    if (/(?:^|[^\p{L}])(?:не|ни|и|так|вот|то|как)\s+$/u.test(before)) continue; // «не очень», «и действительно»: смысл другой
    if (/^\s*[,—–-]/.test(after) || /^\s+ли(?![\p{L}])/iu.test(text.slice(b, b + 5))) continue; // «Действительно, …» — согласие, «действительно ли»
    if (/^\s+(?:до|с|со|по|на|в|во|для|при|только|лишь|ещё|еще|без|у|к|от|из|за|через|после|в\s+течение|\d|один|одна|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|сутки|неделю|месяц|год|бессрочно|навсегда)(?![\p{L}])/iu.test(text.slice(b, b + 20))) continue; // «действительно до 30 ноября», «действительно два дня»: краткое прилагательное (срок, условие), не усилитель
    if (/^\s*(?:[.!?…;:)]|$)/u.test(text.slice(b, b + 3))) continue; // «Разрешение действительно.»: сказуемое в конце фразы, без него смысл пропадает
    if (insideQuotes(text, a)) continue;
    push({ start: a, end: b, ins: '', kind: 'AMP', del: m[0], show: '' });
  }
  return edits.sort((x, y) => x.start - y.start);
}

module.exports = { safeEdits, sentences, NEG_PREV, LEAD_CONTRAST_START: new RegExp('^' + LEAD_CONTRAST + '(?![\\p{L}])', 'iu') };
