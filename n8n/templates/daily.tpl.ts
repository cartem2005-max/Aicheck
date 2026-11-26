import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Раз в сутки в 10:00 по Москве',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 10, triggerAtMinute: 0 }] } },
    position: [240, 300],
  },
  output: [{}],
});

const fetchChannel = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Скачать страницу канала',
    parameters: {
      method: 'GET',
      url: 'https://t.me/s/kultura_analitiki',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }] },
      options: { timeout: 30000, response: { response: { responseFormat: 'text', outputPropertyName: 'html' } } },
    },
    position: [480, 300],
  },
  output: [{ html: '<div data-post="kultura_analitiki/101">…</div>' }],
});

const saveRun = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Запомнить запуск',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'yxzTsLh5pi8hfc6r' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: 'last_daily_run' }] },
      columns: {
        mappingMode: 'defineBelow',
        value: { key: 'last_daily_run', value: expr('{{ $now.toISO() }}') },
        matchingColumns: ['key'],
        schema: [
          { id: 'key', displayName: 'key', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'value', displayName: 'value', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
        ],
      },
    },
    position: [600, 300],
  },
  output: [{ id: 1, key: 'last_daily_run', value: '2026-11-27T07:00:00.000Z' }],
});

const parsePosts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Разбор постов и поиск новых',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_D_PARSE__ },
    position: [720, 300],
  },
  output: [{ id: 102, date: '2026-11-27T05:00:00+00:00', views: '1.2K', text: 'Текст нового поста' }],
});

const lintAndRequests = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Линтер и запросы детектору',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_D_REQUESTS__ },
    position: [960, 300],
  },
  output: [{ post: { id: 102, url: 'https://t.me/kultura_analitiki/102', lint_score: 20, places: [] }, i: 0, req: { model: 'claude-sonnet-5-5', max_tokens: 400 } }],
});

const detector = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Детектор: оценка поста',
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
    position: [1200, 300],
  },
  output: [{ content: [{ type: 'text', text: 'Оценка: 45' }] }],
});

const digest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Сводка по новым постам',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: __JS_D_DIGEST__ },
    position: [1440, 300],
  },
  output: [{ html: '<b>Новые посты канала</b>', posts: 1, failed: 0, last_post_id: 102 }],
});

const subscribers = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Взять подписчиков',
    executeOnce: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'lBQAVQqvf2M4HQyw' },
      returnAll: true,
    },
    position: [1680, 300],
  },
  output: [{ id: 1, chat_id: '42' }],
});

const sendDigest = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Отправить сводку подписчику',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('{{ $("Сводка по новым постам").first().json.html }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: { telegramApi: { id: 'UCGHq0cjNS0FR2Kt', name: 'ии чек' } },
    position: [1920, 300],
  },
  output: [{ ok: true, result: { message_id: 8 } }],
});

export default workflow('kan-daily', 'КАН: ежедневная сводка по новым постам канала', { settings: { timezone: 'Europe/Moscow' } })
  .add(schedule)
  .to(fetchChannel)
  .to(saveRun)
  .to(parsePosts)
  .to(lintAndRequests)
  .to(detector)
  .to(digest)
  .to(subscribers)
  .to(sendDigest)
  .group('Поиск новых постов', [fetchChannel, saveRun, parsePosts], {
    description: 'Скачивает t.me/s/kultura_analitiki, запоминает время запуска, оставляет посты новее последнего виденного.',
  })
  .group('Оценка постов', [lintAndRequests, detector], {
    description: 'Линтер и три оценки детектора Claude на каждый новый пост.',
  })
  .group('Сводка и рассылка', [digest, subscribers, sendDigest], {
    description: 'Собирает сводку, запоминает последний пост и шлёт её подписчикам из таблицы.',
  });
