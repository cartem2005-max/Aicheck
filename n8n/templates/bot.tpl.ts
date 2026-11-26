import { workflow, node, trigger, expr, ifElse, switchCase } from '@n8n/workflow-sdk';

const telegramTrigger = trigger({
  type: 'n8n-nodes-base.telegramTrigger',
  version: 1.5,
  config: {
    name: 'Сообщение или кнопка в Telegram',
    parameters: { updates: ['message', 'callback_query'] },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [240, 400],
  },
  output: [{ update_id: 1, message: { message_id: 5, chat: { id: 42 }, text: 'Текст поста' } }],
});

const parseAndLimits = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Разбор и лимиты',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_PARSE__ },
    position: [480, 400],
  },
  output: [{ route: 'analyze', chat_id: '42', text: 'Текст поста', used_today: 1 }],
});

const router = switchCase({
  version: 3.2,
  config: {
    name: 'Куда направить',
    parameters: {
      rules: {
        values: [
          { outputKey: 'Проверка текста', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'analyze' }], combinator: 'and' } },
          { outputKey: 'Ссылка на пост', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'fetch' }], combinator: 'and' } },
          { outputKey: 'Кнопка «Пример»', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'example' }], combinator: 'and' } },
          { outputKey: 'Приветствие', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'start' }], combinator: 'and' } },
          { outputKey: 'Подписка', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'subscribe' }], combinator: 'and' } },
          { outputKey: 'Отписка', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'unsubscribe' }], combinator: 'and' } },
          { outputKey: 'Нажатие кнопки', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'callback' }], combinator: 'and' } },
          { outputKey: 'Применить правку', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'apply' }], combinator: 'and' } },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Ответить сразу' },
    },
    position: [720, 400],
  },
});

const subscribe = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Записать подписчика',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'lBQAVQqvf2M4HQyw' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'chat_id', condition: 'eq', keyValue: expr('{{ $("Разбор и лимиты").first().json.chat_id }}') }] },
      columns: {
        mappingMode: 'defineBelow',
        value: { chat_id: expr('{{ $("Разбор и лимиты").first().json.chat_id }}') },
        matchingColumns: ['chat_id'],
        schema: [{ id: 'chat_id', displayName: 'chat_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }],
      },
    },
    position: [960, 560],
  },
  output: [{ id: 1, chat_id: '42' }],
});

const unsubscribe = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Удалить подписчика',
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: 'lBQAVQqvf2M4HQyw' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'chat_id', condition: 'eq', keyValue: expr('{{ $("Разбор и лимиты").first().json.chat_id }}') }] },
    },
    position: [960, 720],
  },
  output: [{ id: 1, chat_id: '42' }],
});

const replyNow = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Ответить сразу',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Разбор и лимиты").first().json.chat_id }}'),
      text: expr('{{ $("Разбор и лимиты").first().json.reply }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1200, 640],
  },
  output: [{ ok: true, result: { message_id: 6 } }],
});

const answerButton = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Ответить на нажатие',
    parameters: {
      resource: 'callback',
      operation: 'answerQuery',
      queryId: expr('{{ $("Разбор и лимиты").first().json.cb_id }}'),
      additionalFields: { text: expr('{{ $("Разбор и лимиты").first().json.toast }}') },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [960, 880],
  },
  output: [{ ok: true, result: true }],
});

const removeButtons = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Снять кнопки',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $("Разбор и лимиты").first().json.chat_id }}'),
      messageId: expr('{{ $("Разбор и лимиты").first().json.message_id }}'),
      text: expr('{{ $("Разбор и лимиты").first().json.new_html }}'),
      replyMarkup: 'none',
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1200, 880],
  },
  output: [{ ok: true, result: { message_id: 6 } }],
});

const answerApply = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Ответить на нажатие правки',
    parameters: {
      resource: 'callback',
      operation: 'answerQuery',
      queryId: expr('{{ $("Разбор и лимиты").first().json.cb_id }}'),
      additionalFields: { text: expr('{{ $("Разбор и лимиты").first().json.toast }}') },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [960, 1040],
  },
  output: [{ ok: true, result: true }],
});

const applyParts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Части текста с правками',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_APPLY_PARTS__ },
    position: [1200, 1040],
  },
  output: [{ chat_id: '42', part: 'Готово, применил правку 1. Вот текст:' }],
});

const sendApplied = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1440, 1040],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const applyHasButtons = switchCase({
  version: 3.2,
  config: {
    name: 'Сколько правок осталось',
    parameters: {
      rules: {
        values: [
          { outputKey: 'Осталось: 1', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 1 }], combinator: 'and' } },
          { outputKey: 'Осталось: 2', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 2 }], combinator: 'and' } },
          { outputKey: 'Осталось: 3', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 3 }], combinator: 'and' } },
          { outputKey: 'Осталось: 4', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 4 }], combinator: 'and' } },
          { outputKey: 'Осталось: 5', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 5 }], combinator: 'and' } },
          { outputKey: 'Осталось: 6', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.rm_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 6 }], combinator: 'and' } },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Без кнопок' },
    },
    position: [1440, 1200],
  },
});

const sendApplied1 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 1',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1320],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const sendApplied2 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 2',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[1] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[1] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: expr('fix:all:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1440],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const sendApplied3 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 3',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[1] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[1] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[2] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[2] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: expr('fix:all:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1560],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const sendApplied4 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 4',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[1] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[1] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[2] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[2] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[3] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[3] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: expr('fix:all:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1680],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const sendApplied5 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 5',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[1] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[1] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[2] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[2] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[3] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[3] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[4] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[4] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: expr('fix:all:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1800],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const sendApplied6 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить текст с правками, осталось: 6',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[0] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[0] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[1] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[1] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[2] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[2] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[3] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[3] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: expr('Применить правку {{ $json.rm[4] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[4] }}:{{ $json.orig }}') } }, { text: expr('Применить правку {{ $json.rm[5] }}'), additionalFields: { callback_data: expr('fix:{{ $json.rm[5] }}:{{ $json.orig }}') } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: expr('fix:all:{{ $json.orig }}') } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 1920],
  },
  output: [{ ok: true, result: { message_id: 9 } }],
});

const fetchPost = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Достать пост по ссылке',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Разбор и лимиты").first().json.fetch_url }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }] },
      options: { timeout: 30000, response: { response: { responseFormat: 'text', outputPropertyName: 'html' } } },
    },
    position: [960, 400],
  },
  output: [{ html: '<div class="tgme_widget_message_text">Текст поста</div>' }],
});

const textFromLink = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Текст из ссылки',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_FROM_LINK__ },
    position: [1200, 400],
  },
  output: [{ route: 'analyze', chat_id: '42', text: 'Текст поста', used_today: 1 }],
});

const gotText = ifElse({
  version: 2.2,
  config: {
    name: 'Текст получен?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.route }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'analyze' }],
        combinator: 'and',
      },
    },
    position: [1440, 400],
  },
});

const refuseLink = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отказ по ссылке',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.reply }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1680, 520],
  },
  output: [{ ok: true, result: { message_id: 6 } }],
});

const sendClean = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить чистовик',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $json.part }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4560, 240],
  },
  output: [{ ok: true, result: { message_id: 8 } }],
});

const progress = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Проверяю пост…',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Разбор и лимиты").first().json.chat_id }}'),
      text: 'Проверяю пост…',
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [960, 240],
  },
  output: [{ ok: true, result: { message_id: 6, chat: { id: 42 } } }],
});

const exampleAnswer = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Ответить на кнопку «Пример»',
    parameters: {
      resource: 'callback',
      operation: 'answerQuery',
      queryId: expr('{{ $("Разбор и лимиты").first().json.cb_id }}'),
      additionalFields: { text: expr('{{ $("Разбор и лимиты").first().json.toast }}') },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [960, 480],
  },
  output: [{ ok: true, result: true }],
});

const startMessage = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Приветствие с кнопкой',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Разбор и лимиты").first().json.chat_id }}'),
      text: expr('{{ $("Разбор и лимиты").first().json.reply }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Проверить пример', additionalFields: { callback_data: 'example' } }] } }] },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [960, 600],
  },
  output: [{ ok: true, result: { message_id: 6 } }],
});

const lastRun = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Когда был последний запуск',
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'yxzTsLh5pi8hfc6r' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: 'last_daily_run' }] },
      returnAll: false,
      limit: 1,
    },
    position: [1200, 560],
  },
  output: [{ id: 1, key: 'last_daily_run', value: '2026-11-27T07:00:00.000Z' }],
});

const replySubscribe = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Ответить на подписку',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Разбор и лимиты").first().json.chat_id }}'),
      text: expr('{{ $("Разбор и лимиты").first().json.reply }}\nРассылка идёт в 10 утра по Москве. Последний успешный запуск {{ $json.value ? "был " + DateTime.fromISO($json.value).setZone("Europe/Moscow").toFormat("dd.MM HH:mm") + " МСК" : "ещё не было" }}.'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1440, 560],
  },
  output: [{ ok: true, result: { message_id: 6 } }],
});

const cleanParts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Части чистовика',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_CLEAN_PARTS__ },
    position: [4320, 240],
  },
  output: [{ chat_id: '42', part: 'Чистовик без пометок' }],
});

const lintNode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Линтер и автоправки',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_LINT__ },
    position: [960, 240],
  },
  output: [{ chat_id: '42', text: 'Текст поста', lint: { score: 31, tooShort: false, flagged: true }, highlights: [{ rule: 'B09', quote: 'Хотите попробовать?', reason: 'Призыв в конце', whole: false }], layout: [] }],
});

const detectorRequests = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Три запроса детектору',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_REQUESTS__ },
    position: [1200, 240],
  },
  output: [{ i: 0, req: { model: 'claude-sonnet-5-5', max_tokens: 400 } }, { i: 1, req: { model: 'claude-sonnet-5-5', max_tokens: 400 } }, { i: 2, req: { model: 'claude-sonnet-5-5', max_tokens: 400 } }],
});

const detector = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Детектор: оценка текста',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'anthropicApi',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.req) }}'),
      options: { timeout: 120000 },
    },
    credentials: { anthropicApi: { id: '8wMo4DBxAaivXAhj', name: 'Anthropic api' } },
    position: [1440, 240],
  },
  output: [{ content: [{ type: 'text', text: 'Оценка: 45' }] }],
});

const scoreAndZone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Среднее и зона',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_SCORE__ },
    position: [1680, 240],
  },
  output: [{ chat_id: '42', text: 'Текст поста', api_error: false, scores: [45, 40, 50], mean: 45, zone: 'mid', label: 'Есть признаки, посмотрите текст', need_shorten: true }],
});

const needShorten = ifElse({
  version: 2.2,
  config: {
    name: 'Нужен разбор?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.need_shorten }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
    position: [1920, 240],
  },
});

const shortenRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Запрос на разбор',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_FIX_REQ__ },
    position: [2160, 120],
  },
  output: [{ chat_id: '42', text: 'Текст поста', fix_req: { model: 'claude-sonnet-5-5', max_tokens: 2500 } }],
});

const shortenCall = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Разбор: найти приёмы и предложить правки',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'anthropicApi',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.fix_req) }}'),
      options: { timeout: 120000 },
    },
    credentials: { anthropicApi: { id: '8wMo4DBxAaivXAhj', name: 'Anthropic api' } },
    position: [2400, 120],
  },
  output: [{ content: [{ type: 'text', text: '{"findings":[]}' }] }],
});

const applyShorten = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Применить правки и проверить факты',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_FIX_APPLY__ },
    position: [2640, 120],
  },
  output: [{ chat_id: '42', text: 'Текст поста', need_retry: false, fix: { status: 'unchanged', text: 'Текст поста', findings: [], edits: [], found: 0, fixed: 0 } }],
});

const retryNeeded = ifElse({
  version: 2.2,
  config: {
    name: 'Есть что переделать?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.need_retry }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
    position: [2880, 120],
  },
});

const retryCall = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Разбор: переделать отклонённое',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'anthropicApi',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.retry_req) }}'),
      options: { timeout: 120000 },
    },
    credentials: { anthropicApi: { id: '8wMo4DBxAaivXAhj', name: 'Anthropic api' } },
    position: [3120, 60],
  },
  output: [{ content: [{ type: 'text', text: '{"findings":[]}' }] }],
});

const applyRetry = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Применить переделанное',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_FIX_RETRY__ },
    position: [3360, 60],
  },
  output: [{ chat_id: '42', text: 'Текст поста', fix: { status: 'unchanged', text: 'Текст поста', findings: [], edits: [], found: 0, fixed: 0 } }],
});

const composeMessage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Собрать сообщение',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_COMPOSE__ },
    position: [3600, 240],
  },
  output: [{ chat_id: '42', progress_id: 6, html: '<b>Есть признаки</b>', has_buttons: false, clean_parts: [] }],
});

const hasButtons = switchCase({
  version: 3.2,
  config: {
    name: 'Сколько кнопок правок',
    parameters: {
      rules: {
        values: [
          { outputKey: 'Правок: 1', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 1 }], combinator: 'and' } },
          { outputKey: 'Правок: 2', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 2 }], combinator: 'and' } },
          { outputKey: 'Правок: 3', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 3 }], combinator: 'and' } },
          { outputKey: 'Правок: 4', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 4 }], combinator: 'and' } },
          { outputKey: 'Правок: 5', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 5 }], combinator: 'and' } },
          { outputKey: 'Правок: 6', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.btn_n }}'), operator: { type: 'number', operation: 'equals' }, rightValue: 6 }], combinator: 'and' } },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Без кнопок' },
    },
    position: [3840, 240],
  },
});

const editWithButtons1 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 1',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 80],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editWithButtons2 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 2',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }, { text: 'Применить правку 2', additionalFields: { callback_data: 'fix:2' } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: 'fix:all' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 100],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editWithButtons3 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 3',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }, { text: 'Применить правку 2', additionalFields: { callback_data: 'fix:2' } }] } },
          { row: { buttons: [{ text: 'Применить правку 3', additionalFields: { callback_data: 'fix:3' } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: 'fix:all' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 120],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editWithButtons4 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 4',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }, { text: 'Применить правку 2', additionalFields: { callback_data: 'fix:2' } }] } },
          { row: { buttons: [{ text: 'Применить правку 3', additionalFields: { callback_data: 'fix:3' } }, { text: 'Применить правку 4', additionalFields: { callback_data: 'fix:4' } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: 'fix:all' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 140],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editWithButtons5 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 5',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }, { text: 'Применить правку 2', additionalFields: { callback_data: 'fix:2' } }] } },
          { row: { buttons: [{ text: 'Применить правку 3', additionalFields: { callback_data: 'fix:3' } }, { text: 'Применить правку 4', additionalFields: { callback_data: 'fix:4' } }] } },
          { row: { buttons: [{ text: 'Применить правку 5', additionalFields: { callback_data: 'fix:5' } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: 'fix:all' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 160],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editWithButtons6 = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат, правок: 6',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Применить правку 1', additionalFields: { callback_data: 'fix:1' } }, { text: 'Применить правку 2', additionalFields: { callback_data: 'fix:2' } }] } },
          { row: { buttons: [{ text: 'Применить правку 3', additionalFields: { callback_data: 'fix:3' } }, { text: 'Применить правку 4', additionalFields: { callback_data: 'fix:4' } }] } },
          { row: { buttons: [{ text: 'Применить правку 5', additionalFields: { callback_data: 'fix:5' } }, { text: 'Применить правку 6', additionalFields: { callback_data: 'fix:6' } }] } },
          { row: { buttons: [{ text: 'Применить все правки', additionalFields: { callback_data: 'fix:all' } }] } },
        ],
      },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 180],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

const editPlain = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Показать результат',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: expr('{{ $json.chat_id }}'),
      messageId: expr('{{ $json.progress_id }}'),
      text: expr('{{ $json.html }}'),
      replyMarkup: 'none',
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [4080, 340],
  },
  output: [{ ok: true, result: { message_id: 7 } }],
});

export default workflow('kan-bot', 'КАН: проверка текста на приёмы нейросети')
  .add(telegramTrigger)
  .to(parseAndLimits)
  .to(
    router
      .onCase(0, progress.to(lintNode).to(detectorRequests).to(detector).to(scoreAndZone).to(
        needShorten
          .onTrue(shortenRequest.to(shortenCall).to(applyShorten.to(retryNeeded.onTrue(retryCall.to(applyRetry.to(composeMessage))).onFalse(composeMessage))))
          .onFalse(composeMessage),
      ))
      .onCase(1, fetchPost.to(textFromLink).to(gotText.onTrue(progress).onFalse(refuseLink)))
      .onCase(2, exampleAnswer.to(fetchPost))
      .onCase(3, startMessage)
      .onCase(4, subscribe.to(lastRun).to(replySubscribe))
      .onCase(5, unsubscribe.to(replyNow))
      .onCase(6, answerButton.to(removeButtons))
      .onCase(7, answerApply.to(applyParts).to(applyHasButtons.onCase(0, sendApplied1).onCase(1, sendApplied2).onCase(2, sendApplied3).onCase(3, sendApplied4).onCase(4, sendApplied5).onCase(5, sendApplied6).onCase(6, sendApplied)))
      .onCase(8, replyNow),
  )
  .add(composeMessage)
  .to(hasButtons.onCase(0, editWithButtons1).onCase(1, editWithButtons2).onCase(2, editWithButtons3).onCase(3, editWithButtons4).onCase(4, editWithButtons5).onCase(5, editWithButtons6).onCase(6, editPlain))
  .add(editWithButtons1)
  .to(cleanParts.to(sendClean))
  .add(editWithButtons2)
  .to(cleanParts.to(sendClean))
  .add(editWithButtons3)
  .to(cleanParts.to(sendClean))
  .add(editWithButtons4)
  .to(cleanParts.to(sendClean))
  .add(editWithButtons5)
  .to(cleanParts.to(sendClean))
  .add(editWithButtons6)
  .to(cleanParts.to(sendClean))
  .add(editPlain)
  .to(cleanParts)
  .group('Приём и лимиты', [parseAndLimits, router], {
    description: 'Разбирает сообщение: команды, длина 400–4000 знаков, лимиты и потолки расходов до вызова модели.',
  })
  .group('Ссылка на пост', [fetchPost, textFromLink, gotText], {
    description: 'Если прислали ссылку t.me/канал/123, достаёт текст поста (публичный канал); не вышло — отказ.',
  })
  .group('Проверка текста', [progress, lintNode, detectorRequests, detector, scoreAndZone], {
    description: 'Сразу «Проверяю пост…», линтер, три оценки шаблонности Claude, среднее и зона.',
  })
  .group('Разбор и правки', [shortenRequest, shortenCall, applyShorten, retryNeeded, retryCall, applyRetry], {
    description: 'Claude проходит текст по каталогу из 49 приёмов и предлагает замены; код применяет только безопасные (цитата, факты, ссылки, отрицания) и сверяет факты; отклонённые замены один раз переделывает та же модель.',
  })
  .group('Ответ пользователю', [composeMessage, hasButtons, editWithButtons1, editWithButtons2, editWithButtons3, editWithButtons4, editWithButtons5, editWithButtons6, editPlain, cleanParts, sendClean], {
    description: 'Результат редактирует сообщение «Проверяю пост…» (до 4096 знаков), чистовик идёт отдельным сообщением.',
  })
  .group('Кнопки «Применить правку»', [answerApply, applyParts, applyHasButtons, sendApplied, sendApplied1, sendApplied2, sendApplied3, sendApplied4, sendApplied5, sendApplied6], {
    description: 'Сразу отвечает на нажатие; код (без модели) применяет выбранную замену к сохранённому тексту, проверяет факты и присылает новый чистовик.',
  })
  .group('Кнопки «Принять» и «Оставить» (старые сообщения)', [answerButton, removeButtons], {
    description: 'Сразу отвечает на нажатие и снимает кнопки; повторное нажатие ничего не делает.',
  });
