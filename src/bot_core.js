'use strict';
// Логика Code-нод бота и ежедневной проверки (без сети; в n8n её склеивает n8n/build.js в jsCode).
// Бот: route -> [fromLink] -> (lintStep из bot_lint.js) -> detectorRequests -> scoreStep -> (explain_fix.js) -> buildMessage -> cleanParts.
// Ежедневный: parsePosts -> newPosts -> dailyRequests -> digest.
const { stripMarkdown } = require('./clean');
const SHORT = require('./signs_short');
const { build: buildText } = require('./explain_fix');
const { checkFacts } = require('./facts');

// ---------- константы, которые подставляет ведущий ----------
const OWNER_CHAT_ID = 'YOUR_CHAT_ID'; // chat_id владельца (строкой): /stats и /allow только ему, на него не действует лимит на пользователя
const EXAMPLE_POST_ID = 985;  // id поста канала для кнопки «Проверить пример» (выбран по eval/results/example_pick.md)
const EXAMPLE_CHANNEL = 'kultura_analitiki';
const CFG = { owner: OWNER_CHAT_ID, example: EXAMPLE_POST_ID }; // тесты меняют CFG, боевой код — константы выше

// ---------- настройки ----------
const MIN_CHARS = 400, MAX_CHARS = 5000, DAILY_LIMIT = 50, USER_DAILY = 10, TG_LIMIT = 4096;
const DAY_USD_CAP = 1, MONTH_USD_CAP = 10;
const PRICE_IN = 2, PRICE_OUT = 10; // $ за млн токенов, Sonnet 5.5
const MAX_ALLOW = 50, MAX_ALLOW_LEN = 100, KEEP_RESULTS = 200, KEEP_PAYLOAD = 60;
// Границы зон выбраны ТОЛЬКО по dev (baseline_dev + noise_dev, среднее трёх вызовов Sonnet), test не открывался:
//   меньше 30 — «признаков мало» (dev: 22 из 24 постов основателя, один вызов; среднее трёх: 9 из 10; AI ниже 30: 6 из 120)
//   30..54    — «есть признаки, посмотреть»
//   55 и выше — «похоже на текст нейросети» (dev: AI 76 из 120 при одном вызове, 9 из 10 при среднем трёх; основатель 1 из 24)
const ZONE_MID = 30, ZONE_HIGH = 55;
const LABELS = { low: 'Почти нет шаблонных приёмов', mid: 'Есть места, которые стоит перечитать', high: 'Много шаблонных приёмов' };
const DISCLAIMER = 'Это подсказка. Такой текст мог написать и человек.';
// простые формулировки вместо пояснений из rules.json (rules.json заморожен, там двоеточия, скобки и тире)
const RULE_PLAIN = { "A01": "Дежурное вступление, которое ни о чём не говорит.", "A02": "Фраза сообщает, что мысль важная, вместо того чтобы это показать.", "A03": "Канцелярская вводная фраза.", "A04": "Громкая фраза, которая не говорит, что именно и как влияет.", "A05": "Штамп, который заявляет очевидное вместо факта.", "A06": "Шаблонная завлекалка в начале.", "A07": "Шаблонная связка перед выводом, который чаще всего повторяет сказанное.", "A08": "Школьная концовка, которая сообщает, что текст кончается.", "A09": "Раздутая формула вместо простого слова.", "A10": "Рекламный штамп без содержания, не сказано, какие именно возможности.", "A11": "Расплывчатая рекламная метафора.", "A12": "Бодрая концовка с обещанием, которое нечем подкрепить.", "A13": "Оборот «не только, но и», который растягивает мысль ради объёма.", "A14": "Канцелярские слова вместо простых.", "A15": "Шаблонные связки между абзацами, которые не добавляют смысла.", "A16": "Дружеская фраза-заготовка, которой имитируют разговор.", "A17": "Громкое вступление про мир или эпоху, пафос без конкретики.", "B01": "Оборот «не просто это, а то», противопоставление ради красоты.", "B02": "Риторическая пара, в которой сначала отрицают то, чего никто не утверждал.", "B03": "Вопрос и сразу короткий ответ, театральная пауза.", "B04": "Три однородных слова подряд, нейросети почти всегда перечисляют по три.", "B05": "Подводка-интрига перед мыслью, которую можно сказать сразу.", "B06": "Финальная мораль, которая пересказывает текст.", "B07": "Финальный вопрос к читателю, шаблонная концовка для вовлечения.", "B08": "Отрицание того, что никто не утверждал, ради красивого поворота.", "B09": "Призыв в последнем абзаце, так часто заканчивают шаблонные рекламные посты.", "C01": "Список из цифр-эмодзи, так чаще оформляют нейросети, чем люди.", "C02": "Строки списка начинаются с эмодзи.", "C03": "Вопросы-подзаголовки отдельной строкой, текст разбит как по шаблону.", "C04": "Несколько абзацев из одной строки подряд, рубленый ритм.", "C05": "Лесенка из коротких строк ради эффекта.", "C06": "Много тире на 1000 знаков, это частый признак машинного текста.", "D01": "Предложения почти одной длины, а человек пишет то длинно, то коротко.", "D02": "Много абзацев из одного предложения.", "D03": "Много очень коротких предложений, ритм рубленый.", "D04": "Абзацы почти одной длины, а у живого автора они разные." };
const plainReason = (p) => RULE_PLAIN[p.rule] || String(p.reason || '').split(/\s*[:(—]/)[0];
const HEADLINE = { low: 'Почти не похоже на текст нейросети', mid: 'Местами похоже на текст нейросети', high: 'Очень похоже на текст нейросети' };
const PAT_SIGN = { 1: 37, 2: 4, 3: 4, 4: 31, 5: 25, 6: 28, 7: 30 };
const AUTO_SIGN = { LEAD: 4, CTA: 24, EXC: 10, AMP: 23 };
const LAYOUT_LABELS = { C01: 'Цифры-эмодзи вместо обычных цифр', C02: 'Эмодзи в начале строки', B09: 'Указатель 👇' };

// Промпт детектора — дословно из eval/baseline_ai.js
const DETECTOR_MODEL = 'claude-sonnet-5-5';
const DETECTOR_SYSTEM = 'Ты эксперт по определению текстов, написанных нейросетью. Тебе дают пост для Telegram-канала сервиса аналитики для селлеров маркетплейсов.';
const DETECTOR_USER = (t) => `${t}\n\n————\n\nЭтот текст написан нейросетью? Ответь числом от 0 до 100 (0 — точно человек, 100 — точно нейросеть). Формат ответа строго: «Оценка: N», без пояснений.`;

const sentence = (s) => { const t = String(s || '').trim().replace(/[\s.:;,—-]+$/, ''); return !t ? '' : t[0].toUpperCase() + t.slice(1) + (/…$/.test(t) ? '' : '.'); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mskDay = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);

// автоправки: один закрытый список на /start и /help, совпадает с src/safe_fix.js; включаются при оценке 55+ и трёх разных приёмах
// тексты бота пишем так, как сам бот советует писать: простые слова, точка и запятая, без перечислений в скобках
const AUTO_LIST = 'фразы вроде «Важно отметить, что» в начале предложения, хвосты вроде «Пишите в комментариях», лишние восклицательные знаки и слова «действительно» и «по-настоящему»';
const WHO = 'Ваш текст я отправляю на проверку в Claude, это нейросеть компании Anthropic.';
const START = [
  '<b>Привет, я смотрю, не звучит ли ваш пост как текст нейросети</b>',
  'Пришлите текст, ссылку на пост или перешлите сам пост. Я покажу места, на которые стоит посмотреть, и подскажу, чем их заменить. Сам я правлю только то, что точно не испортит смысл. Остальное решаете вы.',
  'Я только разбираю тексты. Поболтать или ответить на вопросы не смогу, на любое сообщение отвечаю разбором.',
  WHO,
  'Можно начать с примера. Нажмите кнопку ниже, и я проверю один из постов канала «Культура Аналитики».',
].join('\n\n');

const HELP = [
  '<b>Как пользоваться</b>',
  'Пришлите текст поста длиной от 400 до 5000 знаков. Можно переслать пост или прислать ссылку вида t.me/канал/123 на пост из публичного канала.',
  'В ответе будет число от 0 до 100. Чем оно выше, тем сильнее текст похож на написанный нейросетью. Ниже я покажу конкретные места и предложу, чем их заменить.',
  `Сам я убираю только ${AUTO_LIST}. Остальное правите вы. Если я что-то поменял, пришлю готовый текст отдельным сообщением. Цифры, даты, ссылки и названия я сверяю, чтобы ничего не потерялось.`,
  'Всего я знаю 50 шаблонных приёмов. Полный список по команде /catalog.',
  DISCLAIMER,
  WHO,
  '/start. Приветствие и пример.\n/subscribe. Раз в сутки, в 10 утра по Москве, присылаю сводку по новым постам канала «Культура Аналитики».\n/unsubscribe. Отписаться.\n/catalog. Список всех 50 приёмов.\n/help. Эта справка.\n\nВ ответе три части. Итог, общее впечатление Claude и проверка по списку из 50 приёмов.',
].join('\n\n');

// /catalog: короткие названия всех пунктов каталога
function catalogHtml() {
  const rows = Object.keys(SHORT).map(Number).sort((a, b) => a - b).map((n) => `${n}. ${esc(SHORT[n])}`);
  return `<b>Все ${rows.length} приёмов</b>\n\n${rows.join('\n')}\n\n<i>Это только поводы перечитать текст. Пятидесятый пункт про ошибки и опечатки, на число он не влияет.</i>`;
}

// ---------- Telegram: сущности -> HTML ----------
function entitiesToHtml(text, entities) {
  const opens = {}, closes = {};
  const SIMPLE = { bold: ['b'], italic: ['i'], underline: ['u'], strikethrough: ['s'], code: ['code'], pre: ['pre'], blockquote: ['blockquote'], expandable_blockquote: ['blockquote', ' expandable'], spoiler: ['tg-spoiler'] };
  const tag = (e) => SIMPLE[e.type] || (e.type === 'text_link' && e.url ? ['a', ` href="${escAttr(e.url)}"`] : null);
  const list = (entities || []).filter((e) => tag(e)).sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (const e of list) {
    const t = tag(e), end = e.offset + e.length;
    (opens[e.offset] = opens[e.offset] || []).push(`<${t[0]}${t[1] || ''}>`);
    (closes[end] = closes[end] || []).unshift(`</${t[0]}>`);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    if (closes[i]) out += closes[i].join('');
    if (opens[i]) out += opens[i].join('');
    if (i < text.length) out += esc(text[i]);
  }
  return out;
}

// ---------- кликабельные ссылки: защита от удаления и сохранение в чистовике ----------
// rich_message Telegram (текст с заголовками, вставленный из редактора): блоки -> обычный текст, абзацы через пустую строку
function richText(rm) {
  const out = [];
  const walk = (b) => {
    if (!b || typeof b !== 'object') return;
    if (typeof b.text === 'string' && b.text.trim()) out.push(b.type === 'list_item' ? '- ' + b.text.trim() : b.text.trim());
    for (const k of ['blocks', 'items', 'children']) if (Array.isArray(b[k])) b[k].forEach(walk);
  };
  walk(rm);
  return out.join('\n\n');
}

// entities Telegram (text_link — скрытая ссылка, url — видимая) -> [{start, end, url, text}] по тексту после очистки Markdown
function linksFromEntities(raw, cleaned, entities) {
  const out = [];
  for (const e of entities || []) {
    if (e.type !== 'text_link' && e.type !== 'url') continue;
    const frag = raw.slice(e.offset, e.offset + e.length);
    const url = e.type === 'text_link' ? e.url : frag;
    if (!url || !frag.trim()) continue;
    let start = cleaned === raw ? e.offset : cleaned.indexOf(frag);
    if (start < 0) continue;
    out.push({ start, end: start + frag.length, url, text: frag });
  }
  return out.sort((a, b) => a.start - b.start);
}
// чистовик в HTML: текст экранирован, ссылки восстановлены по тексту якоря (предложения со ссылками не удаляются, якорь остаётся)
function cleanHtml(text, links) {
  let out = '', pos = 0;
  for (const l of (links || []).filter((x) => /^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(x.url))) {
    const i = text.indexOf(l.text, pos);
    if (i < 0) continue;
    out += esc(text.slice(pos, i)) + `<a href="${escAttr(l.url)}">${esc(l.text)}</a>`;
    pos = i + l.text.length;
  }
  return out + esc(text.slice(pos));
}
// чистовик частями по ≤4000 знаков HTML, по границам абзацев
function splitHtml(html, max) {
  const parts = [];
  let rest = html;
  while (rest.length > max) {
    const cand = [rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max)].find((i) => i > max * 0.4);
    const cut = cand === undefined ? max : cand;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------- деньги, лимиты, статистика (staticData) ----------
function dayStat(sd, nowMs) {
  sd.stats = sd.stats || { days: {} };
  const k = mskDay(nowMs);
  if (!sd.stats.days[k]) {
    sd.stats.days[k] = { checks: 0, in: 0, out: 0 };
    const keys = Object.keys(sd.stats.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 62))) delete sd.stats.days[old];
  }
  return sd.stats.days[k];
}
const costOf = (d) => ((d.in || 0) * PRICE_IN + (d.out || 0) * PRICE_OUT) / 1e6;
function spent(sd, nowMs) {
  const st = (sd.stats && sd.stats.days) || {};
  const today = mskDay(nowMs), month = today.slice(0, 7);
  let day = 0, mon = 0, checks = 0, cin = 0, cout = 0;
  for (const k of Object.keys(st)) if (k.startsWith(month)) { mon += costOf(st[k]); checks += st[k].checks; cin += st[k].in; cout += st[k].out; }
  if (st[today]) day = costOf(st[today]);
  return { day, month: mon, checks, cin, cout, today: st[today] ? st[today].checks : 0 };
}
// usage из ответов Anthropic (json HTTP-ноды) -> в статистику дня
function recordUsage(sd, nowMs, responses) {
  const d = dayStat(sd, nowMs);
  for (const r of responses) if (r && r.usage) { d.in += r.usage.input_tokens || 0; d.out += r.usage.output_tokens || 0; }
}
function statsHtml(sd, nowMs) {
  const s = spent(sd, nowMs);
  return `<b>Статистика</b>\nСегодня проверок ${s.today} из ${DAILY_LIMIT}.\nВ этом месяце проверок ${s.checks}.\nРасходы примерно $${s.day.toFixed(3)} за сегодня при потолке $${DAY_USD_CAP} и $${s.month.toFixed(3)} за месяц при потолке $${MONTH_USD_CAP}.\nТокенов ${s.cin} на входе и ${s.cout} на выходе, цена Sonnet $${PRICE_IN} и $${PRICE_OUT} за миллион.`;
}
const isOwner = (chat_id) => !!CFG.owner && String(chat_id) === String(CFG.owner);

// ---------- бот: разбор входящего ----------
const commandOf = (t) => { const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s|$)/.exec(t.trim()); return m ? m[1].toLowerCase() : null; };
// только t.me/<канал>/<id> или t.me/s/<канал>/<id>; адрес собирается из проверенных частей
const LINK_RE = /^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/(\d{1,9})\/?(?:\?[^\s]*)?$/i;
const fetchItem = (chat_id, channel, id) => ({ route: 'fetch', chat_id, fetch_channel: channel, fetch_id: String(id), fetch_url: `https://t.me/${channel}/${id}?embed=1` });

// текст принят в проверку: длина, потолки денег и лимиты ДО вызова модели
function admit(text, chat_id, sd, nowMs, extra) {
  const reply = (r) => ({ route: 'reply', chat_id, reply: r });
  if (text.length < MIN_CHARS) return reply(text.length < 120
    ? `Я только разбираю тексты постов, поговорить не смогу. Пришлите пост целиком, от ${MIN_CHARS} знаков, ссылку на него или перешлите его сюда.`
    : `Текст слишком короткий, нужно хотя бы ${MIN_CHARS} знаков, а пришло ${text.length}. Пришлите пост целиком.`);
  if (text.length > MAX_CHARS) return reply(`Текст слишком длинный, это ${text.length} знаков, а можно до ${MAX_CHARS}. Пришлите один пост.`);
  const s = spent(sd, nowMs);
  if (s.day >= DAY_USD_CAP) return reply('На сегодня проверки закончились. Попробуйте завтра.');
  if (s.month >= MONTH_USD_CAP) return reply('На этот месяц проверки закончились. Попробуйте в следующем.');
  const today = mskDay(nowMs);
  if (sd.day !== today) { sd.day = today; sd.count = 0; }
  if (sd.count >= DAILY_LIMIT) return reply(`Сегодня бот уже сделал ${DAILY_LIMIT} проверок, это его предел на сутки. Попробуйте завтра.`);
  sd.users = sd.users || {};
  let u = sd.users[chat_id];
  if (!u || u.day !== today) {
    for (const k of Object.keys(sd.users)) if (sd.users[k].day !== today) delete sd.users[k];
    u = sd.users[chat_id] = { day: today, n: 0 };
  }
  if (!isOwner(chat_id) && u.n >= USER_DAILY) return reply(`Вы сегодня уже сделали ${USER_DAILY} проверок, это предел на сутки. Попробуйте завтра.`);
  u.n++; sd.count++;
  dayStat(sd, nowMs).checks++;
  return { route: 'analyze', chat_id, text, used_today: sd.count, ...(extra || {}) };
}

// ---------- кнопки «Применить правку N»: код применяет сохранённые замены, модель не вызывается ----------
const FIX_FAIL = 'Эту правку не получилось применить автоматически, поправьте вручную';
// исходник + безопасные автоправки + выбранные замены -> текст или null (замены пересекаются, не сошлись факты)
function applyPicks(rec, nums) {
  const edits = [...(rec.auto || []), ...nums.map((n) => rec.suggs[n - 1])].map((e) => ({ start: e.start, end: e.end, ins: e.ins })).sort((a, b) => a.start - b.start);
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!(e.start >= 0 && e.end > e.start && e.end <= rec.text.length) || (i && e.start < edits[i - 1].end)) return null;
  }
  const text = buildText(rec.text, edits);
  return checkFacts(rec.text, text).ok ? text : null;
}
const nums = (a) => a.length === 1 ? String(a[0]) : a.slice(0, -1).join(', ') + ' и ' + a[a.length - 1];
function applyCallback(base, rec, what) {
  const out = (toast, parts, extra) => ({ ...base, toast, parts: parts || [], rm: [], rm_n: 0, ...(extra || {}) });
  if (!rec || !Array.isArray(rec.suggs) || !rec.suggs.length || typeof rec.text !== 'string') return out('Эта проверка уже устарела. Пришлите текст ещё раз', []);
  const applied = (rec.applied = rec.applied || []);
  const total = rec.suggs.length;
  let want;
  if (what === 'all') {
    want = rec.suggs.map((_, i) => i + 1).filter((n) => !applied.includes(n));
    if (!want.length) return out('Все правки уже применены', [], { already: true });
  } else {
    const n = Number(what);
    if (!rec.suggs[n - 1]) return out('Такой правки здесь нет', []);
    if (applied.includes(n)) return out('Эта правка уже применена', [], { already: true });
    want = [n];
  }
  // добавляем по одной: что не сошлось (пересечение, факты) — пропускаем
  let cur = applied.slice(), text = null; const skipped = [];
  for (const n of want) {
    const next = [...cur, n].sort((a, b) => a - b);
    const t = applyPicks(rec, next);
    if (t === null) skipped.push(n); else { cur = next; text = t; }
  }
  if (text === null) return out(FIX_FAIL, []);
  rec.applied = cur;
  const head = what === 'all' ? (cur.length === total ? 'Готово, применил все правки.' : `Готово, применил правки ${nums(want.filter((n) => !skipped.includes(n)))}.`) : `Готово, применил правку ${want[0]}.`;
  const rest = cur.length > 1 && what !== 'all' ? ` Сейчас применены правки ${nums(cur)}.` : '';
  const skip = skipped.length ? ` Правку ${nums(skipped)} не получилось применить автоматически, поправьте вручную.` : '';
  const parts = [`${head}${rest}${skip} Вот текст:`, ...(rec.pre_note ? [rec.pre_note] : []), ...splitHtml(cleanHtml(text, rec.links), TG_LIMIT - 96)];
  // оставшиеся правки того же результата: кнопки под последним сообщением; когда всё применено — строка вместо кнопок
  const rm = rec.suggs.map((_, i) => i + 1).filter((n) => !cur.includes(n));
  if (!rm.length) parts.push('Все правки применены.');
  return out(skipped.length ? 'Применил не всё, смотрите ниже' : 'Готово, текст ниже', parts, { rm, rm_n: rm.length, orig: base.orig });
}

// u — одно обновление Telegram; sd — staticData; возвращает json одного item
function route(u, sd, nowMs) {
  const cq = u.callback_query;
  if (cq) {
    const m = cq.message || {};
    const chat_id = String(m.chat ? m.chat.id : cq.from.id);
    const base = { route: 'callback', chat_id, cb_id: cq.id, message_id: String(m.message_id), new_html: entitiesToHtml(m.text || '', m.entities || []) };
    if (cq.data === 'example') {
      if (!CFG.example) return { ...base, toast: 'Пример пока не готов' };
      return { ...fetchItem(chat_id, EXAMPLE_CHANNEL, CFG.example), route: 'example', cb_id: cq.id, toast: 'Проверяю пример…' };
    }
    // кнопки привязаны к конкретному результату (chat_id + message_id); повторное нажатие ничего не делает
    sd.results = sd.results || {};
    const key = chat_id + ':' + m.message_id, rec = sd.results[key];
    const fixBtn = /^fix:(\d{1,2}|all)(?::(\d{1,12}))?$/.exec(cq.data || '');
    // кнопки под присланным текстом несут номер исходного сообщения: результат один, применённые копятся
    if (fixBtn) { const orig = fixBtn[2] || String(m.message_id); return applyCallback({ route: 'apply', chat_id, cb_id: cq.id, message_id: String(m.message_id), orig }, sd.results[chat_id + ':' + orig], fixBtn[1]); }
    if (rec && rec.open === false) return { ...base, toast: 'Вы уже выбрали', already: true };
    if (rec) rec.open = false;
    const accept = cq.data === 'accept';
    const foot = accept ? '✅ Принято. Готовый текст в следующем сообщении.' : '↩️ Оставлено как было.';
    let html = base.new_html + '\n\n' + foot;
    if (html.length > TG_LIMIT) html = esc((m.text || '').slice(0, 3800)) + '…\n\n' + foot;
    return { ...base, toast: accept ? 'Принято' : 'Оставляем как было', new_html: html };
  }
  const msg = u.message || {};
  const chat_id = String(msg.chat ? msg.chat.id : '');
  const reply = (r, text) => ({ route: r, chat_id, reply: text });
  // текст или подпись к картинке/файлу; пересланные посты приходят так же
  const isText = typeof msg.text === 'string';
  const rich = !isText && msg.rich_message ? richText(msg.rich_message) : '';
  const body = isText ? msg.text : typeof msg.caption === 'string' ? msg.caption : rich || null;
  if (body === null) return reply('reply', 'Пришлите текст поста, перешлите пост или отправьте ссылку вида t.me/канал/123. В картинке или файле без подписи я текста не вижу.');
  const cmd = isText ? commandOf(msg.text) : null;
  const arg = body.trim().replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  if (cmd === 'start') return reply('start', START);
  if (cmd === 'help') return reply('reply', HELP);
  if (cmd === 'catalog') return reply('reply', catalogHtml());
  if (cmd === 'subscribe') return reply('subscribe', 'Готово. Раз в сутки буду присылать сводку по новым постам канала «Культура Аналитики». Чтобы отписаться, нажмите /unsubscribe.');
  if (cmd === 'unsubscribe') return reply('unsubscribe', 'Отписал вас. Чтобы вернуться, нажмите /subscribe.');
  if ((cmd === 'stats' || cmd === 'allow' || cmd === 'disallow') && !isOwner(chat_id)) return reply('reply', 'Эта команда только для владельца бота.');
  if (cmd === 'stats') return reply('reply', statsHtml(sd, nowMs));
  if (cmd === 'allow' || cmd === 'disallow') {
    sd.allow = sd.allow || [];
    if (cmd === 'allow' && !arg) return reply('reply', sd.allow.length ? '<b>Исключения</b>\n' + sd.allow.map((a) => '• ' + esc(a)).join('\n') : 'Исключений пока нет. Чтобы добавить, напишите /allow и фразу.');
    if (!arg) return reply('reply', 'Напишите /disallow и фразу, которую нужно вернуть в проверку.');
    const key = arg.toLowerCase();
    if (cmd === 'allow') {
      if (arg.length > MAX_ALLOW_LEN) return reply('reply', `Фраза длиннее ${MAX_ALLOW_LEN} знаков.`);
      if (sd.allow.includes(key)) return reply('reply', `«${esc(key)}» уже в исключениях.`);
      if (sd.allow.length >= MAX_ALLOW) return reply('reply', `В списке уже ${MAX_ALLOW} фраз. Уберите лишние командой /disallow.`);
      sd.allow.push(key);
      return reply('reply', `Добавил «${esc(key)}». Эту фразу я не буду подсвечивать и убирать.`);
    }
    if (!sd.allow.includes(key)) return reply('reply', `«${esc(key)}» в исключениях нет. Весь список по команде /allow.`);
    sd.allow = sd.allow.filter((a) => a !== key);
    return reply('reply', `Убрал «${esc(key)}» из исключений.`);
  }
  if (cmd) return reply('reply', 'Не знаю такой команды.\n\n' + HELP);
  const lm = LINK_RE.exec(body.trim());
  if (lm) return fetchItem(chat_id, lm[1], lm[2]);
  const text = stripMarkdown(body);
  const links = linksFromEntities(body, text, isText ? msg.entities : msg.caption_entities);
  return admit(text, chat_id, sd, nowMs, links.length ? { links } : null);
}

// фрагмент HTML -> {text, links}: <a href> превращаются в ссылки с позициями в тексте
function fragmentWithLinks(f) {
  let text = '', open = null;
  const links = [];
  for (const part of f.replace(/<br\s*\/?>/gi, '\n').split(/(<a\s[^>]*>|<\/a>|<[^>]+>)/)) {
    const a = /^<a\s[^>]*href="([^"]*)"/i.exec(part);
    // t.me в embed кодирует & в ссылках дважды (&amp;amp;) — распаковываем до устойчивого вида
    if (a) { let u = a[1]; for (let k = 0; k < 3 && unescapeHtml(u) !== u; k++) u = unescapeHtml(u); open = { start: text.length, url: u }; continue; }
    if (/^<\/a>/i.test(part)) { if (open && text.length > open.start) links.push({ start: open.start, end: text.length, url: open.url, text: text.slice(open.start) }); open = null; continue; }
    if (part.startsWith('<')) continue;
    text += unescapeHtml(part);
  }
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return { text: trimmed, links: links.map((l) => ({ ...l, start: l.start - lead, end: l.end - lead })).filter((l) => l.start >= 0 && l.end <= trimmed.length && l.url !== l.text) };
}
// страница ?embed=1 -> {text, links} или null (пост без текста, закрытый канал, нет поста)
function parseEmbed(html) {
  const m = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(String(html || ''));
  const r = m ? fragmentWithLinks(m[1]) : null;
  return r && r.text ? r : null;
}
// base — item «fetch» из route, httpJson — ответ HTTP-ноды
function fromLink(base, httpJson, sd, nowMs) {
  const j = httpJson || {};
  const html = j.error ? '' : typeof j === 'string' ? j : (j.html !== undefined ? j.html : (j.data !== undefined ? j.data : ''));
  const e = parseEmbed(html);
  if (!e) return { route: 'reply', chat_id: base.chat_id, reply: 'Не получилось достать пост по ссылке: работает только для публичных каналов и постов с текстом. Перешлите пост сюда.' };
  const text = stripMarkdown(e.text);
  const links = text === e.text ? e.links : [];
  return admit(text, base.chat_id, sd, nowMs, { source_url: `https://t.me/${base.fetch_channel}/${base.fetch_id}`, ...(links.length ? { links } : {}) });
}

// ---------- детектор: три вызова и зона ----------
function detectorRequest(text) {
  return {
    model: DETECTOR_MODEL, max_tokens: 400,
    thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
    system: DETECTOR_SYSTEM,
    messages: [{ role: 'user', content: DETECTOR_USER(text.replace(/\s*@\w+\s*$/, '').trim()) }],
  };
}
const detectorRequests = (text) => [0, 1, 2, 3, 4].map((i) => ({ i, req: detectorRequest(text) }));

// ответ Anthropic (json HTTP-ноды) -> число 0..100 или null
function parseScore(j) {
  if (!j || j.error || !Array.isArray(j.content)) return null;
  const t = j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = t.match(/Оценка:\s*(\d{1,3})/i) || t.match(/\b(\d{1,3})\b/);
  return m ? Math.min(100, Number(m[1])) : null;
}
const zoneOf = (mean) => (mean < ZONE_MID ? 'low' : mean < ZONE_HIGH ? 'mid' : 'high');
function meanZone(scores) {
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
  const zone = zoneOf(mean);
  return { mean, zone, label: LABELS[zone] };
}
// число разных пунктов каталога среди находок «Разбора», у которых цитата найдена в тексте (подсказки без цитаты не считаем)
const MIN_DISTINCT_HIGH = 3;
function distinctSigns(findings) {
  const s = new Set();
  for (const f of findings || []) if (f && f.start >= 0 && f.sign && f.sign !== 50) s.add(f.sign); // п.50 (ошибка) — заметка, в зону не входит
  return s.size;
}
// Зона по оценке модели; «много приёмов» только если и находок разных пунктов >= 3, иначе средняя зона и пометка weak
// signs — список пунктов, который посчитал explain_fix.apply до отбора дублей (fx.signs); без него считаем по findings
// пункты, найденные кодом (очевидные шаблоны), входят в число разных приёмов
function withCode(signs, text) { return Array.isArray(signs) ? [...new Set([...signs, ...obviousPatterns(text).filter((p) => p.quote).map((p) => PAT_SIGN[p.id])])] : signs; }
function finalZone(mean, findings, hasFix, signs) {
  const zone = zoneOf(mean);
  const n = Array.isArray(signs) ? signs.length : distinctSigns(findings);
  if (zone === 'high' && hasFix && n < MIN_DISTINCT_HIGH) return { zone: 'mid', weak: true, label: LABELS.mid };
  return { zone, weak: false, label: LABELS[zone] };
}
// 0 ответов из 3 — «оценка модели недоступна»; 1–2 — считаем, но честно пишем «по N из 3 оценок»
// Обычно берём среднее первых трёх. Если они разошлись на SPREAD_MAX и больше (на 108 тестовых постах такого не было,
// было на GigaChat и на длинной статье), берём медиану всех пяти: два лишних вызова стоят ~0,2 цента.
const SPREAD_MAX = 30;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function scoreStep(responses) {
  const parsed = responses.map(parseScore);
  const first = parsed.slice(0, 3).filter((x) => x !== null);
  const all = parsed.filter((x) => x !== null);
  if (!all.length) return { api_error: true, scores: all, n_scores: 0, partial: false, need_shorten: true };
  const spread = first.length ? Math.max(...first) - Math.min(...first) : 0;
  if (first.length && spread < SPREAD_MAX) {
    const z = meanZone(first);
    return { api_error: false, scores: first, n_scores: first.length, partial: first.length < 3, ...z, need_shorten: true };
  }
  const mean = median(all);
  const zone = zoneOf(mean);
  return { api_error: false, scores: all, n_scores: all.length, partial: false, unstable: true, mean, zone, label: LABELS[zone], need_shorten: true };
}

// ---------- сообщение пользователю ----------
function cutEsc(s, max) { // самый длинный префикс, у которого экранированная длина <= max, по границе абзаца/предложения/слова
  let n = s.length;
  while (n > 0 && esc(s.slice(0, n)).length > max) n -= Math.max(1, Math.ceil((esc(s.slice(0, n)).length - max) / 6));
  if (n >= s.length) return s;
  let p = s.slice(0, n);
  const floor = Math.floor(n * 0.6);
  const cands = [p.lastIndexOf('\n\n'), p.lastIndexOf('. '), p.lastIndexOf('\n'), p.lastIndexOf(' ')];
  const best = cands.find((i) => i >= floor);
  if (best !== undefined) p = p.slice(0, best + (p[best] === '.' ? 1 : 0));
  return p.trimEnd() + '…';
}

// пост целиком; удалённые предложения (ranges по исходному тексту) в <s>; первые n знаков
function marked(text, ranges, n) {
  let out = '', pos = 0;
  for (const r of ranges) {
    if (r.start >= n) break;
    const e = Math.min(r.end, n);
    out += esc(text.slice(pos, r.start)) + '<s>' + esc(text.slice(r.start, e)) + '</s>' + (r.ins ? '<b>' + esc(r.ins) + '</b>' : '');
    pos = e;
  }
  return out + esc(text.slice(pos, n));
}
function markedFit(text, ranges, max) {
  let n = text.length, h = marked(text, ranges, n);
  if (h.length <= max) return h;
  while (n > 0 && h.length > max) { n -= Math.max(1, Math.ceil((h.length - max) / 8)); h = marked(text, ranges, n); }
  const floor = Math.floor(n * 0.6), p = text.slice(0, n);
  const best = [p.lastIndexOf('\n\n'), p.lastIndexOf('. '), p.lastIndexOf('\n'), p.lastIndexOf(' ')].find((i) => i >= floor);
  if (best !== undefined) n = best + (p[best] === '.' ? 1 : 0);
  return marked(text, ranges, n) + '…';
}
// длинный пост: только абзацы с изменениями (остальное — «…»)
function markedChanged(text, ranges, max) {
  const paras = [];
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  let m;
  while ((m = re.exec(text))) paras.push({ a: m.index, b: m.index + m[0].length });
  const parts = [];
  let skipped = false;
  for (const p of paras) {
    const inside = ranges.filter((r) => r.start >= p.a && r.end <= p.b);
    if (!inside.length) { skipped = true; continue; }
    if (skipped) { parts.push('…'); skipped = false; }
    parts.push(marked(text.slice(p.a, p.b), inside.map((r) => ({ start: r.start - p.a, end: r.end - p.a, ins: r.ins })), p.b - p.a));
  }
  if (skipped) parts.push('…');
  const h = parts.join('\n\n');
  if (h.length <= max) return h;
  // не помещается: целые абзацы по порядку, один длинный — по границе слова
  const out = [];
  let len = 0;
  for (const p of parts) { if (len + p.length + 2 > max - 4) break; out.push(p); len += p.length + 2; }
  if (!out.length) { const p = paras.find((x) => ranges.some((r) => r.start >= x.a && r.end <= x.b)) || paras[0]; return markedFit(text.slice(p.a, p.b), ranges.filter((r) => r.start >= p.a && r.end <= p.b).map((r) => ({ start: r.start - p.a, end: r.end - p.a, ins: r.ins })), max - 1); }
  return out.join('\n\n') + '\n\n…';
}

// предложение с «, а не»
const ANTI_RE = /[^.!?\n]*,\s+а\s+не(?![\p{L}])[^.!?\n]*[.!?…]*/giu;
// п.50: правильная форма по шаблону «вы проверяет … и принимает» → «вы проверяете … и принимаете»; null, если шаблона нет
function typoCorrect(quote) {
  const m = /(?<![\p{L}])(вы\s+[\p{L}]+?)(ет|ит)(?![\p{L}])/iu.exec(quote);
  if (!m) return null;
  const end = m.index + m[0].length; let good = m[1] + m[2] + "е";
  const rest = quote.slice(end);
  const m2 = /^([^.!?;]{0,40}?\s+и\s+)([\p{L}]+?)(ет|ит)(?![\p{L}])/iu.exec(rest);
  if (m2) { good += m2[1] + m2[2] + m2[3] + 'е'; good += (/^\s+[\p{L}-]+/u.exec(rest.slice(m2[0].length)) || [''])[0]; }
  return good;
}
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
// обрезка по границе слова: «…» после целого слова, не посреди слова
const clip = (s, n) => { if (s.length <= n) return s; let c = s.slice(0, n - 1); const i = c.lastIndexOf(' '); if (i >= n * 0.5) c = c.slice(0, i); return c.replace(/[\s,.;:—-]+$/, '') + '…'; };
const normQ = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/…$/, '').trim();
// линтерная подсветка без дублей с находками модели: то же место (цитата входит одна в другую) не повторяем
function dedupHighlights(highlights, findings) {
  const fq = findings.map((f) => normQ(f.quote)).filter((x) => x.length >= 6);
  return (highlights || []).filter((h) => {
    if (h.whole || !h.quote) return true;
    const hq = normQ(h.quote);
    return !fq.some((x) => hq.includes(x) || x.includes(hq));
  });
}

// ---------- шаг 18: «было → стало» только по изменённым словам ----------
// несколько слов до и после правки; пара строк целиком не показывается
function ctxWords(s, n, fromEnd) {
  const w = s.split(/\s+/).filter(Boolean);
  return { part: (fromEnd ? w.slice(-n) : w.slice(0, n)).join(' '), cut: w.length > n };
}
// ---------- очевидные шаблоны: регулярками, без модели, показываем всегда и первыми ----------
const CLICK_NOUN = '(?:факт|способ|причин|ошибк|секрет|совет|правил|шаг|вещ|привыч|миф|лайфхак|признак|урок|тренд|идей)';
const CLICK_HEAD = new RegExp('^[^\\p{L}\\p{N}]*\\d+\\s+(?:[\\p{L}-]+\\s+){0,2}?' + CLICK_NOUN + '[\\p{L}]*[^\\n]*?(?:измен|удив|перевер|сэконом|поменя|взорв|заставят|о которых вы не|которые вы не знали)', 'iu');
const LEAD_Q = /(?:Задумывались ли вы|Знали ли вы|А вы знали|Вы когда-нибудь|Представьте,? что)/iu;
const PROMISE = /(?:есть чем (?:вас )?удивить|вас удивит|вас удивят|изменит? (?:ваш|ваше) (?:взгляд|представление|отношение)|изменят (?:ваш|ваше) (?:взгляд|представление|отношение))/iu;
const BAIT_END = /(?:^|[\s.!?…])((?:А\s+)?(?:какой|какая|какое|какие|кто из вас|как у вас|а у вас|вы\b)[^?\n]*\?|(?:Согласны|Что думаете|Как думаете|А вы)[^?\n]*\?)/iu;
function sentAt(text, idx) {
  let a = idx; while (a > 0 && !/[.!?\n]/.test(text[a - 1])) a--;
  let b = idx; while (b < text.length && !/[.!?\n]/.test(text[b])) b++;
  if (b < text.length && text[b] !== '\n') b++;
  return text.slice(a, b).trim();
}
// -> [{id, quote, note}] в порядке показа
function obviousPatterns(text) {
  const out = [];
  if (!text) return out;
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  const headHit = first.length <= 140 && CLICK_HEAD.test(first);
  if (headHit) out.push({ id: 1, quote: first, note: 'Заголовок с числом и громким обещанием, так часто пишут нейросети.' });
  const lead = LEAD_Q.exec(text);
  if (lead) out.push({ id: 2, quote: sentAt(text, lead.index), note: 'Вопрос-заход, который только оттягивает главную мысль.' });
  const arrow = /(?:👇|⬇️?)/u.exec(text);
  if (arrow && !/https?:\/\/|t\.me\//.test(text.slice(arrow.index, arrow.index + 200).split('\n')[0])) out.push({ id: 3, quote: sentAt(text, arrow.index), note: 'Стрелка-указатель, она только подталкивает читать дальше.' });
  const keys = text.match(/[0-9]\uFE0F?\u20E3/g) || [];
  if (keys.length >= 2) { const m = /[0-9]\uFE0F?\u20E3/.exec(text); out.push({ id: 4, quote: sentAt(text, m.index), note: 'Нумерация цифрами-эмодзи вместо обычных цифр.' }); }
  const emo = (text.match(/\p{Extended_Pictographic}/gu) || []).length + keys.length;
  if (emo * 1000 / text.length > 3 && emo >= 3) out.push({ id: 7, quote: '', plain: true, note: `Много смайликов, ${emo} на пост.` });
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras.length > 1 ? paras[paras.length - 1] : '';
  const bm = last && BAIT_END.exec(last);
  if (bm) out.push({ id: 5, quote: sentAt(last, bm.index + bm[0].indexOf(bm[1])), note: 'Вопрос в конце ради ответов в комментариях.' });
  const pm = PROMISE.exec(headHit ? text.slice(nl) : text);
  if (pm) out.push({ id: 6, quote: sentAt(text, (headHit ? nl : 0) + pm.index), note: 'Обещание удивить, которое ничем не подкреплено.' });
  return out;
}
const DATA_WORD = /цифр|данн|отч[её]т|процент|%/i;
const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// автоправка кодом -> строка HTML: «…слова до <s>убрано</s><b>новое</b> слова после…»
function autoLine(text, e) {
  const rawB = text.slice(Math.max(0, e.start - 90), e.start), rawA = text.slice(e.end, e.end + 90);
  const b = ctxWords(rawB.slice(rawB.lastIndexOf('\n') + 1), 3, true);
  const a = ctxWords(rawA.split('\n')[0], 3, false);
  const del = clip(e.del || text.slice(e.start, e.end), 70);
  const tight = e.kind === 'EXC'; // «!» → «.»: знак прилипает к слову
  const after = e.kind === 'LEAD' || e.kind === 'CTA' ? upFirst(a.part) : a.part;
  const mid = `<s>${esc(del)}</s>${e.show ? '<b>' + esc(e.show) + '</b>' : ''}`;
  return (b.cut ? '…' : '') + (b.part ? esc(b.part) + (tight ? '' : ' ') : '') + mid + (after ? ' ' + esc(after) : '') + (a.cut ? '…' : '');
}
// пара «цитата → вариант» без общих слов по краям (по 2 слова контекста)
function pairParts(quote, variant) {
  const qa = quote.split(/\s+/), va = variant.split(/\s+/);
  let i = 0;
  while (i < qa.length && i < va.length && qa[i] === va[i]) i++;
  let j = 0;
  while (j < qa.length - i && j < va.length - i && qa[qa.length - 1 - j] === va[va.length - 1 - j]) j++;
  const s = Math.max(0, i - 2), tail = Math.min(2, j);
  const cut = (arr) => (s > 0 ? '…' : '') + arr.slice(s, arr.length - j + tail).join(' ') + (j > tail ? '…' : '');
  return [cut(qa), cut(va)];
}

function compose(it, lv, dropPost) {
  const q = (s) => `«${esc(clip(s, lv.q))}»`;
  const fx = it.fix && it.fix.status !== 'error' ? it.fix : null;
  const textOf = it.text || '';
  const para1 = textOf.split(/\n\s*\n/)[0] || '';
  // п.3: вопрос отдельной строкой-подзаголовком, за которым идёт объяснение в 2+ предложениях или список, читателю нужен
  const subheadQ = (f) => {
    if (f.sign !== 3 || !f.quote) return false;
    const q0 = f.quote.trim(), i = textOf.indexOf(q0);
    if (i < 0) return false;
    const ls = textOf.lastIndexOf('\n', i - 1) + 1; let le = textOf.indexOf('\n', i); if (le < 0) le = textOf.length;
    if (textOf.slice(ls, le).trim() !== q0 || !/\?$/.test(q0)) return false;
    const after = textOf.slice(le).replace(/^\s+/, '').split(/\n\s*\n/)[0] || '';
    return (after.match(/[.!?…](?:\s|$)/g) || []).length >= 2 || /^\s*(?:[-•*]|\d+[.)]|\p{Extended_Pictographic})/mu.test(after);
  };
  // п.28 «Обещания в начале» — только для первого абзаца; дальше это просто анонс продолжения
  const relabel = (f) => (f.sign === 28 && f.quote && !para1.includes(f.quote.trim()) ? { ...f, title: 'Анонс продолжения', lab: 'Анонс продолжения' } : f);
  const finds = (fx ? fx.findings : []).filter((f) => !subheadQ(f)).map(relabel);
  const hasScore = !it.api_error && it.scores && it.scores.length;
  const zi = hasScore ? finalZone(it.mean, finds, !!fx, withCode(fx && fx.signs, it.text)) : null;
  const live = !!(fx && zi && zi.zone === 'low'); // живой текст: правки не применяются, находки только как заметки
  const fixed = !!(fx && fx.status === 'fixed' && !live);
  const auto = fixed ? (fx.auto || fx.edits || []) : [];
  const det = [];
  const entries = []; // все найденные места по пунктам каталога: для полного списка
  const lines = [];
  const top = [];
  if (it.fix_error) lines.push('Подробно проверить текст не получилось, сервис сейчас недоступен. Сам я ничего не менял.');
  // эмодзи-маркеры: одна строка, правки не предлагаем
  const emojiN = (it.text || '').split('\n').filter((l) => /^\s*\p{Extended_Pictographic}/u.test(l)).length;
  const isEmojiHl = (h) => !h.whole && /эмодзи|смайл/i.test(h.reason || '');
  const emojiSeen = finds.some((f) => f.sign === 30) || (it.layout || []).some((c) => c.rule === 'C02') || (it.highlights || []).some(isEmojiHl);
  const emojiCnt = emojiN || finds.filter((f) => f.sign === 30).length || 1;
  const emojiLine = emojiSeen ? `Эмодзи в начале строк, ${emojiCnt} ${plural(emojiCnt, 'раз', 'раза', 'раз')}. Возможно, это стиль канала, решать вам.` : '';
  // 2) три группы находок модели: «можно заменить» (с вариантом или без), «ещё стоит посмотреть» (заметки), «оставлено» (в подробности)
  for (const f of finds) if (f.sign !== 30 && f.quote) entries.push({ sign: f.sign, quote: f.quote, lab: f.lab });
  const shown = finds.filter((f) => f.sign !== 30);
  const kindOf = (f) => (live && f.kind === 'suggest' ? 'note' : f.kind || 'note');
  // «Можно заменить» — только находки с готовым вариантом (замена или «убрать»); без варианта идут в «Ещё стоит посмотреть», причина отказа — в подробностях
  const hasVariant = (f) => (f.action === 'replace' && !!f.variant) || f.action === 'delete';
  const suggAll = shown.filter((f) => kindOf(f) === 'suggest');
  const sugg = suggAll.filter(hasVariant);
  const noVar = suggAll.filter((f) => !hasVariant(f));
  const notes = shown.filter((f) => kindOf(f) === 'note' || (kindOf(f) === 'suggest' && !hasVariant(f)));
  const left = shown.filter((f) => kindOf(f) === 'left');
  const suggLine = (f) => {
    if (f.action === 'replace' && f.variant) { const [a, b] = pairParts(f.quote, f.variant); return `${q(a)}\nМожно заменить на «${esc(clip(b, lv.q))}»${/[.!?…]$/.test(b) ? '' : '.'}`; }
    if (f.action === 'delete') return `${q(f.quote)}\nМожно убрать.`;
    return `${q(f.quote)}\n${esc(sentence(f.title || SHORT[f.sign] || ''))}`;
  };
  const groups = [];
  for (const f of notes) {
    if ((f.sign === 21 || f.sign === 22) && DATA_WORD.test(f.quote || '')) continue; // «нужен пример или цифра» там, где цифры уже есть, не ставим
    const g = groups.find((x) => x.sign === f.sign);
    if (g) { g.n++; continue; }
    const fixed50 = f.sign === 50 ? typoCorrect(f.quote) : null; // правильная форма: кодом, по шаблону «вы … -ет/-ит»
    groups.push({ sign: f.sign, title: f.sign === 50 ? '' : f.title || SHORT[f.sign] || '', quote: f.quote, hint: f.sign === 50 ? 'Похоже на опечатку.' + (fixed50 ? ` Лучше написать «${fixed50}».` : '') : f.action === 'hint' && ![21, 22, 39, 40, 48].includes(f.sign) ? f.hint : '', n: 1 });
  }
  // «, а не» (антитеза): если «Разбор» её не нашёл, берём место по шаблону из линтерного каталога (в линтере такого правила нет, regexp здесь, в слое бота)
  if (!live && !finds.some((f) => f.sign === 1) && it.text) {
    const seen = finds.map((f) => normQ(f.quote)).filter(Boolean);
    const anti = [];
    for (const m of it.text.matchAll(ANTI_RE)) {
      const sn = m[0].trim();
      if (!seen.some((x) => normQ(sn).includes(x) || x.includes(normQ(sn)))) { anti.push(sn); entries.push({ sign: 1, quote: sn }); }
    }
    if (anti.length) groups.push({ sign: 1, title: SHORT[1] || 'Антитеза', quote: anti[0], hint: '', n: anti.length });
  }
  const pats = obviousPatterns(it.text);
  const ovl = (a, b) => { const x = normQ(a), y = normQ(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };
  // код надёжнее: место, которое он назвал, не повторяем из находок модели
  for (let i = groups.length - 1; i >= 0; i--) if (pats.some((p) => p.quote && groups[i].quote && ovl(p.quote, groups[i].quote))) groups.splice(i, 1);
  for (let i = entries.length - 1; i >= 0; i--) if (pats.some((p) => p.quote && ovl(p.quote, entries[i].quote))) entries.splice(i, 1);
  // место, которое бот уже исправил сам, повторно не показываем
  const autoDels = auto.map((e) => e.del || '').filter(Boolean);
  const fixedByBot = (qt) => { const y = normQ(qt || ''); return !!y && autoDels.some((d) => { const x = normQ(d); return x && (x.includes(y) || (y.includes(x) && y.length <= x.length * 1.5 + 5)); }); };
  for (let i = groups.length - 1; i >= 0; i--) if (fixedByBot(groups[i].quote)) groups.splice(i, 1);
  for (let i = entries.length - 1; i >= 0; i--) if (fixedByBot(entries[i].quote)) entries.splice(i, 1);
  for (let i = pats.length - 1; i >= 0; i--) if (fixedByBot(pats[i].quote)) pats.splice(i, 1);
  for (const e of auto) entries.push({ sign: AUTO_SIGN[e.kind] || 4, quote: e.del || '' });
  const patGroups = pats.map((p) => ({ sign: 100 + p.id, psign: PAT_SIGN[p.id], title: p.note, quote: p.quote, hint: '', n: 1, plain: !!p.plain }));
  groups.unshift(...patGroups); // очевидные шаблоны всегда первыми
  for (const g of patGroups) entries.push({ sign: PAT_SIGN[g.sign - 100], quote: g.quote });
  const groupLine = (g) => [g.quote ? q(g.quote) : '', [g.title ? sentence(g.title) : '', g.hint ? sentence(g.hint) : '', g.n > 1 ? `Таких мест ещё ${g.n - 1}.` : '', g.quote || g.plain ? '' : 'Это про текст в целом.'].filter(Boolean).map(esc).join(' ')].filter(Boolean).join('\n');
  const HINT_SIGNS = [21, 22, 39, 40, 48];
  const hintGroups = groups.filter((g) => HINT_SIGNS.includes(g.sign));
  const typoF = finds.find((f) => f.sign === 50 && f.quote);
  const typoOk = typoF ? typoCorrect(typoF.quote) : null;
  const typoLine = typoF ? `Ещё заметил опечатку: ${q(typoF.quote)}${typoOk ? `, правильно «${esc(typoOk)}»` : ''}.` : '';
  // проверка по списку: все приёмы, кроме подсказок автору (21, 22, 39, 40, 48) и опечатки (50)
  const chk = groups.filter((g) => g.sign !== 50 && !HINT_SIGNS.includes(g.sign));
  const addChk = (sign, quote, extra) => { const g = chk.find((x) => (x.psign || x.sign) === sign); if (g) { g.n++; return; } chk.push({ sign, quote, title: SHORT[sign] || '', hint: '', n: 1, extra }); };
  for (const f of sugg) if (!HINT_SIGNS.includes(f.sign) && f.sign !== 50) addChk(f.sign, f.quote, 'Замену предлагаю ниже.');
  for (const e of auto) addChk(AUTO_SIGN[e.kind] || 4, e.del || '', 'Это я уже исправил.');
  if (emojiSeen) chk.push({ sign: 30, quote: '', title: '', hint: '', n: 1 });
  const chkLine = (g) => (g.sign === 30 && !g.quote ? esc(emojiLine) : g.extra !== undefined ? [g.quote ? q(g.quote) : '', [sentence(g.title), g.n > 1 ? `Таких мест ещё ${g.n - 1}.` : '', g.extra].filter(Boolean).map(esc).join(' ')].filter(Boolean).join('\n') : groupLine(g));
  const N = new Set(chk.map((g) => g.psign || g.sign)).size;
  const list = (hd, arr, cap) => hd + '\n' + arr.slice(0, cap).map((x, i) => `${i + 1}. ${x}`).join('\n') + (arr.length > cap ? `\nЕщё ${arr.length - cap}, их видно в полном списке в подробностях.` : '');
  if (zi) {
    const m = it.mean;
    // итог первым: главный ответ виден сразу, подробности ниже (просьба 26.11)
    const verdict = m < 30 ? (N <= 1 ? (m < 20 ? 'Вообще почти не вижу признаков AI 😎' : 'Похоже на живой текст.') : 'В целом звучит живо, но пара приёмов есть, их можно поправить.')
      : m < 55 ? 'Местами похоже на текст нейросети. Стоит перечитать отмеченные места 👀'
      : N >= 3 ? (m >= 90 ? 'Да тут вообще весь набор 😳' : 'Очень похоже на текст нейросети. Я бы внимательно пригляделся к этому тексту 🧐')
      : 'Claude видит шаблонность в целом, но конкретных приёмов мало. Перечитайте текст сами.';
    top.push('<b>Итог</b>\n' + verdict);
    top.push(`<b>Общее впечатление</b>\nClaude прочитал текст целиком и оценил его на <b>${Math.round(m)} из 100</b>. Это его ощущение, насколько текст похож на текст нейросети.`);
    if (fx || N) {
      const cap = lv.q >= 110 ? chk.length : Math.max(lv.find, patGroups.length);
      let blk = '<b>Проверка по списку</b>\n' + (N ? `Из 50 приёмов в тексте нашлось ${N}.` : 'Ни одного приёма из списка не нашлось.');
      if (N) blk += '\n' + chk.map(chkLine).slice(0, cap).map((x, i) => `${i + 1}. ${x}`).join('\n') + (chk.length > cap ? `\nЕщё ${chk.length - cap}, их видно в полном списке в подробностях.` : '');
      if (typoLine) blk += '\n' + typoLine;
      top.push(blk);
    } else if (typoLine) top.push(typoLine);
  } else {
    top.push(`<i>${DISCLAIMER}</i>`);
    if (fx) top.push('Число посчитать не удалось. Покажу только найденные места.');
    if (patGroups.length) top.push(list('<b>Ещё стоит перечитать</b>', patGroups.map(groupLine), patGroups.length));
    if (typoLine) top.push(typoLine);
  }
  if (fx && !live) {
    lines.push('\n' + (auto.length ? list(`<b>Исправил сам ${auto.length} ${plural(auto.length, 'место', 'места', 'мест')}</b>`, auto.map((e) => autoLine(it.text, e)), 8) : fx.auto_off ? 'Сам ничего не менял. Сам правлю только тексты с высоким числом, здесь только предлагаю.' : 'Сам ничего не менял: безопасных автоправок в этом тексте нет. Места выше решать автору.'));
    if (sugg.length) lines.push('\n' + list(`<b>Предлагаю заменить ${sugg.length} ${plural(sugg.length, 'место', 'места', 'мест')}</b>`, sugg.map(suggLine), lv.find));
  }
  // 3) подробности — одним раскрывающимся блоком
  const sc = hasScore ? it.scores : [];
  const scTxt = !sc.length ? '' : it.unstable ? `Первые три оценки сильно разошлись, поэтому я учёл ещё две: ${sc.slice(0, -1).join(', ')} и ${sc[sc.length - 1]}. Взял середину, ${Math.round(it.mean)}. На таком тексте оценке стоит доверять меньше.` : sc.length === 1 ? `Одна оценка ${sc[0]}, две другие не пришли.` : `${sc.length === 3 ? 'Три оценки' : 'Две оценки'} ${sc.slice(0, -1).join(', ')} и ${sc[sc.length - 1]}, среднее ${Math.round(it.mean)}.${sc.length < 3 ? ' Третья не пришла.' : ''}`;
  det.push('<b>Подробности</b>' + (scTxt ? '\n' + scTxt : ''));
  // шаблонные причины: 2–3 формулировки по очереди, чтобы фраза не повторялась; «ничем не отличается» не показываем
  const VARS = [
    [/^Замена выкидывает важные слова/, ['Замена выкидывает важные слова, и смысл потерялся бы', 'В замене пропали бы важные слова, и мысль стала бы другой', 'Если убрать эти слова, смысл фразы поплыл бы']],
    [/^Без этой фразы абзац не держится/, ['Без этой фразы абзац не держится, нужна ваша замена', 'Абзац на этой фразе держится, тут лучше переписать самому', 'Фраза нужна абзацу, готовую замену я не нашёл']],
  ];
  const varCount = new Map();
  const reasonText = (r) => { const v = VARS.find((x) => x[0].test(r)); if (!v) return r; const k = varCount.get(v) || 0; varCount.set(v, k + 1); return v[1][k % v[1].length]; };
  const NOISE = /^Замена ничем не отличается/;
  const nov = noVar.filter((f) => f.reason && !NOISE.test(f.reason) && !pats.some((p) => p.quote && ovl(p.quote, f.quote)));
  if (hintGroups.length) det.push('<b>Подсказки автору</b>\n' + hintGroups.map((g, i) => `${i + 1}. ${groupLine(g)}`).join('\n'));
  if (nov.length) {
    const gs = [];
    for (const f of nov) { const g = gs.find((x) => x.sign === f.sign && x.reason === f.reason); if (g) g.n++; else gs.push({ sign: f.sign, reason: f.reason, quote: f.quote, n: 1 }); }
    det.push('<b>Почему не предлагаю замену</b>\n' + gs.slice(0, 6).map((g, i) => `${i + 1}. ${q(g.quote)}\n${esc(sentence(clip(reasonText(g.reason || ''), 160)))}${g.n > 1 ? ` Таких мест ещё ${g.n - 1}.` : ''}`).join('\n'));
  }
  const left2 = left.filter((f) => !pats.some((p) => p.quote && ovl(p.quote, f.quote)));
  if (left2.length) det.push('<b>Оставил как есть</b>\n' + left2.slice(0, 5).map((f, i) => `${i + 1}. ${q(f.quote)}\n${esc(sentence(clip(reasonText(f.reason || ''), 120)))}`).join('\n'));
  if (it.lint && it.lint.tooShort) det.push('Текст короче 400 знаков, поэтому дополнительные проверки я не делал.');
  const ctaGone = auto.filter((e) => e.kind === 'CTA').map((e) => ({ quote: e.del }));
  const places = dedupHighlights(it.highlights, [...finds, ...ctaGone]).filter((h) => !isEmojiHl(h)).slice(0, lv.hi);
  if (places.length) det.push('<b>Ещё я заметил</b>\n' + places.map((p, i) => `${i + 1}. ${p.whole ? 'Это про текст в целом.' : q(p.quote)}\n${esc(sentence(plainReason(p)))}`).join('\n'));
  const lay = (it.layout || []).filter((c) => c.rule !== 'C02' && !(c.rule === 'B09' && ctaGone.length)).slice(0, lv.lay).map((c, i) => `${i + 1}. ${esc(sentence(LAYOUT_LABELS[c.rule] || c.rule))}\n${q(c.before)} → ${q(c.after)}`);
  if (lay.length) det.push('<b>Про оформление</b>\nЭто только совет, в тексте я ничего не менял.\n' + lay.join('\n'));
  { // полный список по пунктам каталога, ничего не обрезается
    const by = {};
    for (const e of entries) { const k = e.sign; by[k] = by[k] || []; by[k].lab = by[k].lab === undefined ? e.lab : (by[k].lab === e.lab ? e.lab : null); if (!by[k].some((x) => normQ(x) === normQ(e.quote))) by[k].push(e.quote); }
    const rows = Object.keys(by).map(Number).sort((a, b) => a - b).map((n) => `${n}. ${esc(by[n].lab || SHORT[n] || '')}.${by[n].filter(Boolean).length ? ' ' + by[n].filter(Boolean).map((x) => q(x)).join(' ') : ''}`);
    if (rows.length) det.splice(1, 0, '<b>Весь список по пунктам</b>\n' + rows.join('\n'));
  }
  const wrap = (arr) => [...top, ...lines].join('\n\n').replace(/\n\n\n/g, '\n\n') + '\n\n<blockquote expandable>' + arr.join('\n\n') + '</blockquote>';
  const before = wrap(det);
  const shownSugg = !live && fx ? sugg.slice(0, Math.min(lv.find, 6)) : [];
  if (!fixed || dropPost) return { html: before, has_post: false, sugg: shownSugg };
  // пост с зачёркнутым и новым — последним блоком «Подробностей», если помещается
  const ranges = fx.edits.map((e) => ({ start: e.start, end: e.end, ins: e.ins }));
  const head = '<b>Пост с правками</b>\nЗачёркнуто то, что я убрал, жирным то, что добавил.\n';
  const room = TG_LIMIT - before.length - head.length - 2;
  if (room < 300) return { html: before, has_post: false, sugg: shownSugg };
  const full = marked(it.text, ranges, it.text.length);
  const body = full.length <= room ? full : markedChanged(it.text, ranges, room - 40);
  return { html: wrap([...det, head + body]), has_post: true, sugg: shownSugg };
}

// -> {html, has_buttons, clean_parts: [html...]}; чистовик = только текст поста: исходный текст + безопасные автоправки, без служебных строк (опечатка п.50 — в сообщении); без них чистовик не присылаем
function buildMessage(it) {
  if (it.api_error && !(it.fix && it.fix.status !== 'error')) {
    const places = (it.highlights || []).slice(0, 4).map((p, i) => `${i + 1}. ${p.whole ? 'Это про текст в целом.' : '«' + esc(clip(p.quote, 90)) + '»'}\n${esc(sentence(plainReason(p)))}`);
    const lint = it.lint && !it.lint.tooShort && it.lint.score !== null ? `Набор правил без нейросети дал ${it.lint.score} из 100.` : '';
    let html = '<b>Число посчитать не удалось</b>\nСервис не ответил. Пришлите текст ещё раз чуть позже.' + (lint || places.length ? '\n\n' + lint : '') +
      (places.length ? '\n<blockquote expandable><b>Что я всё же заметил</b>\n' + places.join('\n') + '</blockquote>' : '') + `\n\n<i>${DISCLAIMER}</i>`;
    if (html.length > TG_LIMIT) html = html.slice(0, TG_LIMIT - 1) + '…';
    return { html, has_buttons: false, clean_parts: [] };
  }
  const levels = [{ q: 110, find: 6, lay: 4, hi: 5 }, { q: 70, find: 6, lay: 2, hi: 3 }, { q: 50, find: 4, lay: 1, hi: 0 }];
  let m = null;
  for (const lv of levels) { m = compose(it, lv, false); if (m && m.html.length <= TG_LIMIT) break; }
  if (!m || m.html.length > TG_LIMIT) m = compose(it, levels[2], true);
  let html = m.html;
  if (html.length > TG_LIMIT) html = html.slice(0, TG_LIMIT - 1) + '…'; // последний рубеж: хвост
  const zi = !it.api_error && it.scores && it.scores.length ? finalZone(it.mean, (it.fix && it.fix.findings) || [], !!it.fix, withCode(it.fix && it.fix.signs, it.text)) : null;
  const has = !!(it.fix && it.fix.status === 'fixed' && !(zi && zi.zone === 'low'));
  const typo = zi && zi.zone === 'low' ? null : ((it.fix && it.fix.findings) || []).find((f) => f.sign === 50 && f.quote) || null;
  const typoFix = typo ? typoCorrect(typo.quote) : null;
  const pre_note = typo ? 'Перед публикацией проверьте: ' + (typoFix ? '«' + esc(typoFix) + '»' : '«' + esc(clip(typo.quote, 110)) + '», похоже на опечатку') + '.' : '';
  // кнопки: «Применить правку N» (по две в ряд) и «Применить все правки»; без предложенных замен кнопок нет
  const sg = m.sugg || [];
  const buttons = [];
  for (let i = 0; i < sg.length; i += 2) buttons.push(sg.slice(i, i + 2).map((_, j) => ({ text: `Применить правку ${i + j + 1}`, data: `fix:${i + j + 1}` })));
  if (sg.length >= 2) buttons.push([{ text: 'Применить все правки', data: 'fix:all' }]);
  const payload = sg.length && !(it.api_error) ? {
    text: it.text, links: it.links || [], pre_note,
    auto: has ? it.fix.edits.map((e) => ({ start: e.start, end: e.end, ins: e.ins })) : [],
    suggs: sg.map((f) => ({ start: f.start, end: f.end, ins: f.action === 'delete' ? '' : f.variant })), applied: [],
  } : null;
  return { html, has_buttons: sg.length > 0, btn_n: sg.length, buttons, payload, pre_note: has ? pre_note : '', clean_parts: has ? splitHtml(cleanHtml(it.fix.text, it.links), TG_LIMIT - 96) : [] };
}
// результат с кнопками запоминаем под ключом chat_id:message_id (последние KEEP_RESULTS)
function registerResult(sd, chat_id, message_id, nowMs, payload) {
  sd.results = sd.results || {};
  sd.results[chat_id + ':' + message_id] = { open: true, t: nowMs, ...(payload || {}) };
  const keys = Object.keys(sd.results);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_RESULTS))) delete sd.results[k];
  // текст и замены нужны кнопкам правок только у свежих результатов: старые облегчаем, чтобы staticData не пух
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_PAYLOAD))) if (sd.results[k]) { delete sd.results[k].text; delete sd.results[k].suggs; delete sd.results[k].auto; delete sd.results[k].links; }
}

// ---------- ежедневный: разбор t.me/s ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeHtml(s) { return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))); }
function cleanFragment(f) { return unescapeHtml(f.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim(); }

// порт fetch_posts.py: страница t.me/s/<канал> -> [{id, date, views, text}] по убыванию id
function parsePosts(html) {
  const posts = {};
  const re = /data-post="[^\/"]+\/(\d+)"([\s\S]*?)(?=data-post="|$)/g;
  let b;
  while ((b = re.exec(html))) {
    const body = b[2];
    const m = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body);
    const d = /<time datetime="([^"]+)"/.exec(body);
    const v = /tgme_widget_message_views">([^<]+)</.exec(body);
    if (m) posts[b[1]] = { id: Number(b[1]), date: d ? d[1] : null, views: v ? v[1] : null, text: cleanFragment(m[1]) };
  }
  return Object.values(posts).sort((a, c) => c.id - a.id);
}

// новые = id > последнего виденного; первый запуск — только самый свежий; не больше 5
function newPosts(posts, sd) {
  if (!posts.length) return [];
  const last = sd.lastPostId;
  if (last === undefined || last === null) return [posts[0]];
  return posts.filter((p) => p.id > last).sort((a, c) => a.id - c.id).slice(0, 5); // пять самых старых непроверенных, остальные придут завтра
}

const CHANNEL = 'kultura_analitiki';
// начало поста вместо номера: первая строка с текстом без эмодзи, до ~60 знаков по границе слова
function postTitle(text) {
  const line = String(text || '').split('\n').map((l) => l.replace(/[\p{Extended_Pictographic}️‍⃣]/gu, '').replace(/\s+/g, ' ').trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) || '';
  if (line.length <= 60) return line.replace(/[.!?…:;,]+$/, '');
  let c = line.slice(0, 60); const i = c.lastIndexOf(' ');
  if (i >= 30) c = c.slice(0, i);
  return c.replace(/[\s,.;:—-]+$/, '') + '…';
}
// на каждый пост 3 запроса детектору; lintInfo(text) -> {lint, highlights}. Только посты канала, личные тексты сюда не попадают
function dailyRequests(posts, lintInfo) {
  const out = [];
  for (const p of posts) {
    const li = lintInfo(p.text);
    const post = { id: p.id, title: postTitle(p.text), date: p.date, url: `https://t.me/${CHANNEL}/${p.id}`, chars: p.text.length, lint_score: li.lint.score, lint_too_short: li.lint.tooShort, places: li.highlights.slice(0, 2).map((h) => ({ quote: h.quote, reason: h.reason })) };
    const req = detectorRequest(p.text);
    for (const i of [0, 1, 2]) out.push({ post, i, req });
  }
  return out;
}

// reqItems — json запросов (по порядку), responses — json ответов HTTP-ноды (в том же порядке)
function digest(reqItems, responses, sd, nowMs) {
  const by = {}, order = [];
  reqItems.forEach((r, k) => {
    if (!by[r.post.id]) { by[r.post.id] = { post: r.post, scores: [] }; order.push(r.post.id); }
    const s = parseScore(responses[k]);
    if (s !== null) by[r.post.id].scores.push(s);
  });
  const lines = [], failed = [];
  for (const id of order) {
    const { post, scores } = by[id];
    const link = `<a href="${post.url}">${esc(post.title || 'Пост ' + post.id)}</a>`;
    if (scores.length < 1) { failed.push(id); lines.push(`${link}. Число посчитать не удалось, проверю завтра.`); continue; }
    const z = meanZone(scores);
    const places = post.places.map((p) => `\n${p.quote ? '«' + esc(clip(p.quote, 90)) + '». ' : ''}${esc(sentence(plainReason(p)))}`).join('');
    lines.push(`${link}. ${HEADLINE[z.zone]}. Оценка ${Math.round(z.mean)} из 100.${scores.length < 3 ? ` Оценок ${scores.length} из 3.` : ''}${places}`);
  }
  let html = `<b>Новые посты канала за ${mskDay(nowMs).slice(8)}.${mskDay(nowMs).slice(5, 7)}</b>\n\n` + lines.join('\n\n') + `\n\n<i>${DISCLAIMER}</i>`;
  if (html.length > TG_LIMIT) html = html.slice(0, TG_LIMIT - 1) + '…';
  // дальше «последним виденным» считаем только то, что оценено; упавший пост (и всё после него) придёт завтра снова
  const newLast = failed.length ? Math.min(...failed) - 1 : Math.max(...order);
  sd.lastPostId = sd.lastPostId === undefined || sd.lastPostId === null ? newLast : Math.max(sd.lastPostId, newLast);
  return { html, posts: order.length, failed: failed.length, last_post_id: sd.lastPostId };
}

// ---------- копия владельцу (как «Owner copy» в боте спецтехники) ----------
// Владелец получает в личный бот коротко: кто написал, что прислал и что ответил бот. Свои сообщения владельца не дублируем.
const OWNER_CUT = 300;
const oneLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plainOf = (html) => String(html || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function ownerWho(u) {
  const f = (u && ((u.message && u.message.from) || (u.callback_query && u.callback_query.from))) || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ') || 'без имени';
  return { id: f.id, head: `👤 ${name} (${f.username ? '@' + f.username + ', ' : ''}id ${f.id})` };
}
const BTN = (data) => data === 'example' ? '«Проверить пример»' : /^fix:/.test(data) ? `«Применить правку ${String(data).split(':')[1] || ''}»` : `«${data}»`;
// ход без разбора: команды, отказы, нажатия кнопок. Разбор текста шлёт ownerAnalysis после сборки ответа.
function ownerTurn(u, r) {
  const w = ownerWho(u);
  if (w.id === undefined || isOwner(w.id) || !r) return null;
  if (r.route === 'analyze' || r.route === 'fetch' || r.route === 'example') return null;
  const m = (u && u.message) || {};
  const cq = u && u.callback_query;
  const client = cq ? 'нажал ' + BTN(cq.data) : oneLine(m.text || m.caption || (m.rich_message ? richText(m.rich_message) : '') || '[без текста]', OWNER_CUT);
  const bot = r.route === 'start' ? 'приветствие с кнопкой примера' : r.route === 'subscribe' ? 'подписал на сводку' : r.route === 'unsubscribe' ? 'отписал от сводки'
    : r.route === 'apply' ? 'прислал текст с правкой' : r.reply ? oneLine(plainOf(r.reply), 200) : r.toast ? oneLine(r.toast, 120) : r.route;
  return esc(`${w.head}\nНаписал: ${client}\nБот: ${bot}`);
}
// после разбора: что прислал, итог, оценка, сколько приёмов и правок, первые три места
function ownerAnalysis(u, it, html) {
  const w = ownerWho(u);
  if (w.id === undefined || isOwner(w.id)) return null;
  const m = (u && u.message) || {};
  const text = String((it && it.text) || '');
  const src = u && u.callback_query ? 'нажал «Проверить пример»' : it && it.source_url ? 'ссылку ' + it.source_url : 'текст';
  const p = plainOf(html);
  const verdict = (p.match(/Итог\n([^\n]+)/) || [])[1] || '';
  const score = (p.match(/оценил его на (\d+) из 100/) || [])[1];
  const found = (p.match(/Из 50 приёмов в тексте нашлось (\d+)/) || [])[1] || (/Ни одного приёма/.test(p) ? '0' : '?');
  const sugg = (p.match(/Предлагаю заменить (\d+)/) || [])[1] || '0';
  const auto = (p.match(/Исправил сам (\d+)/) || [])[1] || '0';
  const chk = (p.split('Проверка по списку')[1] || '').split('\n\n')[0];
  const cl = chk.split('\n');
  const top = [];
  cl.forEach((l, i) => { if (/^\d+\. /.test(l) && top.length < 3) { const why = cl[i + 1] && !/^\d+\. /.test(cl[i + 1]) ? ' ' + oneLine(cl[i + 1], 60) : ''; top.push(oneLine(l, 110) + why); } });
  const lines = [
    w.head,
    `Прислал ${src} (${text.length} знаков): ${oneLine(text, OWNER_CUT) || oneLine(m.text, OWNER_CUT)}`,
    `Бот: ${verdict}${score ? ` Оценка ${score}.` : ''} Приёмов ${found}, замен предложил ${sugg}, сам исправил ${auto}.`,
    ...top,
  ];
  let out = esc(lines.join('\n'));
  if (out.length > 4000) out = out.slice(0, 3990).replace(/&[a-z#0-9]*$/i, '') + '…';
  return out;
}

module.exports = {
  ownerTurn, ownerAnalysis,
  CFG, MIN_CHARS, MAX_CHARS, DAILY_LIMIT, USER_DAILY, DAY_USD_CAP, MONTH_USD_CAP, ZONE_MID, ZONE_HIGH, LABELS, DISCLAIMER, AUTO_LIST, START, HELP, DETECTOR_SYSTEM, DETECTOR_USER,
  esc, richText, postTitle, obviousPatterns, withCode, entitiesToHtml, linksFromEntities, cleanHtml, splitHtml, route, admit, parseEmbed, fromLink, detectorRequest, detectorRequests, parseScore, zoneOf, meanZone, scoreStep, finalZone, distinctSigns,
  recordUsage, spent, statsHtml, buildMessage, registerResult, cutEsc, marked, markedChanged, parsePosts, newPosts, dailyRequests, digest, mskDay,
};
