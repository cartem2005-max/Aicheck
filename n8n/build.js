'use strict';
// Генератор SDK-кода n8n: node n8n/build.js  ->  n8n/dist/bot.sdk.ts и n8n/dist/daily.sdk.ts
// В SDK-коде нет ни функций, ни циклов: jsCode каждой Code-ноды — готовый строковый литерал (JSON.stringify),
// который собирается здесь: модули из src/ в виде функций-фабрик (вместо require) + короткий «клей» ноды.
// Те же строки гоняет n8n/simulate.js (поддельные $input/$json) — поэтому код Code-нод тестируется без n8n.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// ---------- модули -> фабрики ----------
const file = (name) => path.join(SRC, name === 'rules.json' ? 'rules.json' : name + '.js');
const SKIP = new Set(['llm']); // сеть и файлы в n8n не нужны: explain_fix.explainFix() вызывается только при проверке на dev

function requiresOf(name) {
  const src = fs.readFileSync(file(name), 'utf8');
  return [...src.matchAll(/require\('\.\/([\w.]+?)(?:\.js)?'\)/g)].map((m) => m[1]).filter((n) => !SKIP.has(n));
}
function closure(names) {
  const seen = [];
  const visit = (n) => { if (seen.includes(n)) return; seen.push(n); if (n !== 'rules.json') requiresOf(n).forEach(visit); };
  names.forEach(visit);
  return seen.sort();
}
// убираем только строки-комментарии целиком: так размер bundle меньше, а строки и регулярки не задеваются
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function bundle(names) {
  const mods = closure(names);
  let out = 'const __d = {}; const __c = {};\n' +
    'function __req(n) { n = n.replace(/^.*\\//, "").replace(/\\.js$/, ""); if (!__c[n]) { const m = { exports: {} }; if (!__d[n]) throw new Error("нет модуля " + n); __c[n] = m; __d[n](m, m.exports, __req); } return __c[n].exports; }\n';
  for (const n of mods) {
    const body = n === 'rules.json' ? 'module.exports = ' + fs.readFileSync(file(n), 'utf8').trim() + ';' : strip(fs.readFileSync(file(n), 'utf8'));
    out += `__d[${JSON.stringify(n)}] = function (module, exports, require) {\n${body}\n};\n`;
  }
  return out;
}

// ---------- ноды: модули и «клей» ----------
const GET_REQS = (name) => `$(${JSON.stringify(name)})`;
const NODES = {
  // бот
  PARSE: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const u = $input.first().json;
return [{ json: bot.route(u, sd, Date.now()) }];` },
  LINT: { mods: ['bot_lint'], glue: `
const { lintStep } = __req('bot_lint');
const sd = $getWorkflowStaticData('global');
let it;
try { it = ${GET_REQS('Текст из ссылки')}.first().json; if (it.route !== 'analyze') throw new Error('не ссылка'); } catch (e) { it = ${GET_REQS('Разбор и лимиты')}.first().json; }
const progress = ${GET_REQS('Проверяю пост…')}.first().json;
const pid = progress && progress.result ? progress.result.message_id : (progress ? progress.message_id : undefined);
return [{ json: { ...it, progress_id: pid, ...lintStep(it.text, 5, sd.allow || []) } }];` },
  REQUESTS: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const it = $input.first().json;
return bot.detectorRequests(it.text).map((r) => ({ json: r }));` },
  SCORE: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const base = ${GET_REQS('Линтер и автоправки')}.first().json;
const sd = $getWorkflowStaticData('global');
const responses = $input.all().map((i) => i.json);
bot.recordUsage(sd, Date.now(), responses);
return [{ json: { ...base, ...bot.scoreStep(responses) } }];` },
  FIX_REQ: { mods: ['explain_fix'], glue: `
const E = __req('explain_fix');
const it = $input.first().json;
return [{ json: { ...it, fix_req: E.buildRequest(it.text) } }];` },
  FIX_APPLY: { mods: ['explain_fix', 'bot_core'], glue: `
const E = __req('explain_fix');
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const base = ${GET_REQS('Запрос на разбор')}.first().json;
const res = $input.first().json;
const out = { ...base };
delete out.fix_req;
bot.recordUsage(sd, Date.now(), [res]);
const content = res && !res.error && Array.isArray(res.content) ? res.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : null;
if (content === null) out.fix_error = true;
else {
  const live = typeof base.mean === 'number' && base.mean < bot.ZONE_MID; // живой текст (оценка модели < 30): правки не применяем
  const r = E.apply(base.text, E.parseJson(content), { allow: sd.allow || [], links: base.links, noEdit: live, gate: true, mean: base.mean });
  if (r.status === 'error') out.fix_error = true;
  else {
    out.fix = r;
    const cands = live ? [] : E.retryCandidates(r); // отклонённое кодом можно один раз переделать (вторая HTTP-нода)
    if (cands.length) { const js = E.parseJson(content); out.need_retry = true; out.retry_cands = cands; out.fix_js = js; out.retry_req = E.buildRetryRequest(base.text, js, cands); }
  }
}
out.need_retry = !!out.need_retry;
return [{ json: out }];` },
  FIX_RETRY: { mods: ['explain_fix', 'bot_core'], glue: `
const E = __req('explain_fix');
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const base = ${GET_REQS('Применить правки и проверить факты')}.first().json;
const res = $input.first().json;
const out = { ...base };
const cands = base.retry_cands, js = base.fix_js;
delete out.retry_req; delete out.retry_cands; delete out.fix_js; delete out.need_retry;
bot.recordUsage(sd, Date.now(), [res]);
const content = res && !res.error && Array.isArray(res.content) ? res.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : null;
if (content !== null) { // сбой повтора: остаётся первый разбор
  const r = E.applyRetry(base.text, js, E.parseJson(content), cands, { allow: sd.allow || [], links: base.links, gate: true, mean: base.mean });
  if (r.status !== 'error') out.fix = r;
}
return [{ json: out }];` },
  COMPOSE: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const it = $input.first().json;
const sd = $getWorkflowStaticData('global');
const m = bot.buildMessage(it);
if (m.has_buttons) bot.registerResult(sd, String(it.chat_id), String(it.progress_id), Date.now(), m.payload);
return [{ json: { chat_id: it.chat_id, progress_id: it.progress_id, html: m.html, has_buttons: m.has_buttons, btn_n: m.btn_n, clean_parts: m.clean_parts, pre_note: m.pre_note || '' } }];` },
  OWNER_TURN: { mods: ['bot_core'], glue: `
// копия владельцу: ход без разбора (команды, отказы, кнопки); разбор текста — отдельной нодой после сборки ответа
const bot = __req('bot_core');
const u = ${GET_REQS('Сообщение или кнопка в Telegram')}.first().json;
const t = bot.ownerTurn(u, $input.first().json);
return t ? [{ json: { text: t } }] : [];` },
  OWNER_ANALYSIS: { mods: ['bot_core'], glue: `
// копия владельцу: что прислали и что ответил бот (итог, оценка, приёмы, правки)
const bot = __req('bot_core');
const u = ${GET_REQS('Сообщение или кнопка в Telegram')}.first().json;
let it;
try { it = ${GET_REQS('Текст из ссылки')}.first().json; if (it.route !== 'analyze') throw new Error('не ссылка'); } catch (e) { it = ${GET_REQS('Разбор и лимиты')}.first().json; }
const t = bot.ownerAnalysis(u, it, $input.first().json.html);
return t ? [{ json: { text: t } }] : [];` },
  CLEAN_PARTS: { mods: [], glue: `
const m = ${GET_REQS('Собрать сообщение')}.first().json;
return [...(m.pre_note && (m.clean_parts || []).length ? [m.pre_note] : []), ...(m.clean_parts || [])].map((p) => ({ json: { chat_id: m.chat_id, part: p } }));` },
  APPLY_PARTS: { mods: [], glue: `
const it = ${GET_REQS('Разбор и лимиты')}.first().json;
const parts = it.parts || [];
// кнопки оставшихся правок — только под последним сообщением
return parts.map((p, i) => ({ json: { chat_id: it.chat_id, part: p, rm: i === parts.length - 1 ? (it.rm || []) : [], rm_n: i === parts.length - 1 ? (it.rm_n || 0) : 0, orig: it.orig } }));` },
  FROM_LINK: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const base = ${GET_REQS('Разбор и лимиты')}.first().json;
return [{ json: bot.fromLink(base, $input.first().json, sd, Date.now()) }];` },
  // ежедневный
  D_PARSE: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const j = ${GET_REQS('Скачать страницу канала')}.first().json;
const html = typeof j === 'string' ? j : (j.html !== undefined ? j.html : (j.data !== undefined ? j.data : ''));
const posts = bot.parsePosts(String(html));
return bot.newPosts(posts, sd).map((p) => ({ json: p }));` },
  D_REQUESTS: { mods: ['bot_core', 'bot_lint'], glue: `
const bot = __req('bot_core');
const { lintStep } = __req('bot_lint');
const posts = $input.all().map((i) => i.json);
return bot.dailyRequests(posts, (t) => lintStep(t)).map((r) => ({ json: r }));` },
  D_DIGEST: { mods: ['bot_core'], glue: `
const bot = __req('bot_core');
const sd = $getWorkflowStaticData('global');
const reqs = ${GET_REQS('Линтер и запросы детектору')}.all().map((i) => i.json);
const res = $input.all().map((i) => i.json);
return [{ json: bot.digest(reqs, res, sd, Date.now()) }];` },
};

// subs: [[что, на что]] — подстановка констант (для simulate.js); в боевую сборку ничего не подставляется
function jsCode(key, subs) { const n = NODES[key]; let s = bundle(n.mods) + n.glue; for (const [a, c] of subs || []) s = s.split(a).join(c); return s; }

// stub=true: jsCode заменён короткой заглушкой — для validate_workflow (структура графа проверяется без 100 КБ кода)
function render(tplFile, outFile, stub) {
  let t = fs.readFileSync(path.join(__dirname, 'templates', tplFile), 'utf8');
  const used = [...t.matchAll(/__JS_([A-Z_]+)__/g)].map((m) => m[1]);
  for (const k of used) t = t.split(`__JS_${k}__`).join(JSON.stringify(stub ? 'return $input.all();' : jsCode(k)));
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', outFile), t);
  let json = null;
  if (!stub) { // тот же граф обычным JSON n8n: dist/bot.json, dist/daily.json
    const wf = require('./to_json').toWorkflow(t);
    const text = JSON.stringify(wf, null, 1);
    fs.writeFileSync(path.join(__dirname, 'dist', outFile.replace('.sdk.ts', '.json')), text);
    json = { nodes: wf.nodes.length, bytes: Buffer.byteLength(text) };
  }
  return { outFile, chars: t.length, nodes: used, json };
}

module.exports = { NODES, jsCode, bundle, closure };

if (require.main === module) {
  for (const [tpl, out] of [['bot.tpl.ts', 'bot.sdk.ts'], ['daily.tpl.ts', 'daily.sdk.ts']]) {
    const r = render(tpl, out);
    render(tpl, out.replace('.sdk.ts', '.stub.ts'), true);
    console.log(r.outFile, r.chars, 'знаков; Code-ноды:', r.nodes.join(', '), '| JSON:', r.json.nodes, 'нод,', r.json.bytes, 'байт');
  }
}
