'use strict';
// Detectors for rules that have a "metric" instead of a regex pattern in rules.json.
// Each detector gets ctx = { text, norm, paragraphs, body, metrics } and its rule; it returns [{start, end, whole?, value?}].
// "body" = paragraphs without the trailing signature block ("@channel", "PS: ...", "Всем продаж").
const { wordCount, normalize } = require('./textparse');

const span = (a, b) => ({ start: a.start, end: b.end });
const lastOf = ps => ps[ps.length - 1];
// "?" at the very end, trailing emoji / spaces / "👇" do not count
const endsWithQuestion = s => /\?[\s\p{Extended_Pictographic}\uFE0F\u200D]*$/u.test(s);
// a line that starts with a list marker: emoji or a number in a box (the plain "1." marker is cut by parseText)
const startsWithMarker = l => l.bullet || /^(?:\p{Extended_Pictographic}|[0-9#*]\uFE0F?\u20E3)/u.test(l.text);
// words that turn a question to the audience ("А вы что думаете?")
const ADDRESSES_READER = /(?<![\p{L}])(?:вы|вас|вам|вами|ваш\p{L}*|как думаете|что думаете|поделитесь|пишите)(?![\p{L}])/iu;

// start of a sentence inside a paragraph: paragraph start, after . ! ? … : or after a line break
const SENT = '(?:^|[.!?…:]\\s+|\\n)';
const sentenceStart = (alts, tail = '(?![\\p{L}])') => new RegExp(SENT + '(?:и |а )?(?:' + alts + ')' + tail, 'iu');
// call to action in the last paragraph: imperative at a sentence start, "Хотите ...?", the pointer 👇, "в комментариях"
const CTA = new RegExp(sentenceStart('\\p{L}+(?:йте|ите|ьте|йтесь|итесь|ьтесь)|пишите|делитесь|ставьте|приходите|хотите|регистрируйся|приходи').source + '|👇|в комментариях', 'iu');
// generalising sentence in the last paragraph ("И главное: ...", "Поэтому ...", "Так что ...", "Что это значит для селлеров?")
const MORAL_SENTENCE = sentenceStart('главное|важно понимать|вывод|итог|в итоге|как итог|поэтому|так что|это значит|что это значит|решения должны|цель простая|проще говоря|иначе говоря|выводы? для');

const DETECTORS = {
  // line starts with a pictograph (not the very first line): need 2+ such lines to call it a list
  emoji_bullets({ body }) {
    const lines = body.flatMap(p => p.lines).slice(1), hits = [];
    for (const l of lines) {
      const m = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u.exec(l.text);
      if (m) hits.push({ start: l.start, end: l.start + m[0].length });
    }
    return hits.length >= 2 ? hits : [];
  },

  // a paragraph = one short line = one sentence ending with "?", with more text after it; need 2+.
  // Not counted: the first line (it is the post title), the last paragraph and questions to the reader.
  question_headings({ body }) {
    const hits = body.filter((p, i) => i > 0 && i < body.length - 1 && p.lines.length === 1 && p.sentences.length === 1 &&
      p.text.length <= 90 && endsWithQuestion(p.text) && !ADDRESSES_READER.test(p.text)).map(p => span(p, p));
    return hits.length >= 2 ? hits : [];
  },

  // question and a short answer in the same line: "Плохо? Не факт." (question up to 5 words, answer up to 6)
  question_answer({ body }) {
    const hits = [];
    for (const p of body) {
      p.sentences.forEach((s, i) => {
        const next = p.sentences[i + 1];
        if (next && next.line === s.line && s.words <= 5 && /\?[»"”')\]]*$/.test(s.text) && next.words <= 6) hits.push(span(s, next));
      });
    }
    return hits;
  },

  // 3+ consecutive one-line paragraphs of up to 100 chars
  one_liner_run({ body }) {
    const hits = [];
    let run = [];
    const flush = () => { if (run.length >= 3) hits.push(span(run[0], lastOf(run))); run = []; };
    for (const p of body) {
      if (p.lines.length === 1 && p.text.length <= 100) run.push(p); else flush();
    }
    flush();
    return hits;
  },

  // 3+ consecutive short lines (<= 6 words, ending with . ! …) inside one paragraph; list items do not count
  ladder({ body }) {
    const hits = [];
    for (const p of body) {
      let run = [];
      const flush = () => { if (run.length >= 3) hits.push(span(run[0], lastOf(run))); run = []; };
      for (const l of p.lines) {
        if (!startsWithMarker(l) && wordCount(l.text) <= 6 && /[.!…]$/.test(l.text)) run.push(l); else flush();
      }
      flush();
    }
    return hits;
  },

  // dashes " — " are normal Russian punctuation; only a high density counts. ONE whole-text finding.
  em_dash_density({ text, metrics }, rule) {
    if (metrics.em_dashes < rule.min_count || metrics.em_dash_per_1000 < rule.threshold) return [];
    return [{ start: 0, end: text.length, whole: true, value: metrics.em_dash_per_1000 }];
  },

  // last paragraph of the post is a moral or a call to action
  final_moral({ body }) {
    const p = lastOf(body);
    if (!p) return [];
    const start = /^(?:главное|помните|запомните|и помните|в итоге|итог|вывод|в конечном итоге|в конце концов|так что|в целом)(?![\p{L}])/iu;
    const anywhere = /ключ к успеху|вывод прост|не откладывайте|уже сегодня(?! в \d)|начните с|помните:/iu;
    const t = normalize(p.text);
    return start.test(t) || anywhere.test(t) || MORAL_SENTENCE.test(t) ? [span(p, p)] : [];
  },

  // last paragraph is a call to action: imperative at the start of a sentence ("Попробуйте", "Подключите"), "Хотите ...?", "пишите в комментариях", the 👇 pointer
  final_cta({ body }) {
    const p = lastOf(body);
    if (!p) return [];
    return CTA.test(normalize(p.text)) ? [span(p, p)] : [];
  },

  // last paragraph is a question to the reader
  final_question({ body }) {
    const p = lastOf(body);
    return p && endsWithQuestion(p.text) && ADDRESSES_READER.test(p.text) ? [span(p, p)] : [];
  }
};

// metric-vs-threshold rules (group D): one whole-text finding when the condition holds
function thresholdHits(rule, ctx) {
  const m = ctx.metrics;
  if (m.sentences < (rule.min_sentences || 0) || m.paragraphs < (rule.min_paragraphs || 0)) return [];
  const v = m[rule.metric];
  const hit = rule.op === '<' ? v < rule.threshold : v >= rule.threshold;
  return hit ? [{ start: 0, end: ctx.text.length, whole: true, value: v }] : [];
}

module.exports = { DETECTORS, thresholdHits };
