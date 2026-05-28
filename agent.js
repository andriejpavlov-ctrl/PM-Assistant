// agent.js — обёртка над Claude API. Вызывается напрямую из браузера.
// Не трогает DOM и localStorage; получает ключ/модель параметрами.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Низкоуровневый запрос к Claude.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {string} [opts.system]
 * @param {Array}  [opts.tools]
 * @param {object} [opts.tool_choice]
 * @param {number} [opts.max_tokens]
 */
async function callClaude({ apiKey, model, messages, system, tools, tool_choice, max_tokens = 2048 }) {
  if (!apiKey) {
    throw new Error('Не задан API-ключ. Открой Настройки (⚙) и вставь ключ Claude.');
  }

  const body = { model, max_tokens, messages };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Разрешает вызов прямо из браузера (личное использование).
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || JSON.stringify(err);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }
  return res.json();
}

/** Достать первый text-блок из ответа. */
function getText(response) {
  return (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Достать вход tool_use по имени инструмента. */
function getToolInput(response, toolName) {
  const block = (response.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
  return block ? block.input : null;
}

// ===== Инструмент для структурированного разбора захвата =====
const EXTRACT_TOOL = {
  name: 'extract_items',
  description: 'Сохранить структурированные элементы, извлечённые из заметок пользователя.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['task', 'note', 'discussion'], description: 'task — действие; note — мысль/факт; discussion — тема для 1:1 с человеком' },
            title: { type: 'string', description: 'Короткий заголовок (до ~80 символов)' },
            body: { type: 'string', description: 'Доп. детали или контекст, может быть пустым' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            due: { type: ['string', 'null'], description: 'Дедлайн ISO YYYY-MM-DD или null' },
            person: { type: ['string', 'null'], description: 'Имя коллеги для discussion, иначе null' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'title'],
        },
      },
    },
    required: ['items'],
  },
};

/**
 * Разобрать сырой текст на черновики элементов.
 * Возвращает массив объектов вида storage-draft (person -> строка имени).
 */
export async function parseCapture({ apiKey, model, rawText, people = [], today }) {
  const peopleHint = people.length ? `Известные коллеги: ${people.map((p) => p.name).join(', ')}.` : '';
  const system =
    `Ты — ассистент директора по продукту. Разбирай сырые заметки на отдельные элементы: ` +
    `задачи (task), заметки (note) и темы для обсуждения 1:1 (discussion). ` +
    `Сегодня ${today}. Относительные даты («до пятницы», «завтра») переводи в ISO YYYY-MM-DD. ` +
    `Если упомянут человек для обсуждения — клади имя в person. ` +
    `Не выдумывай детали, которых нет. Отвечай ТОЛЬКО через инструмент extract_items. ${peopleHint}`;

  const response = await callClaude({
    apiKey,
    model,
    system,
    messages: [{ role: 'user', content: rawText }],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_items' },
    max_tokens: 2048,
  });

  const input = getToolInput(response, 'extract_items');
  return input?.items || [];
}

/**
 * Ответить на вопрос пользователя по всей базе элементов.
 * Возвращает { answer, relevantIds }.
 */
export async function ask({ apiKey, model, question, items, today }) {
  // Компактная проекция элементов, чтобы не раздувать контекст.
  const compact = items.map((it) => ({
    id: it.id,
    type: it.type,
    title: it.title,
    body: it.body,
    status: it.status,
    priority: it.priority,
    due: it.due,
    person: it.personName || null,
    tags: it.tags,
  }));

  const system =
    `Ты — ассистент директора по продукту. Сегодня ${today}. ` +
    `Отвечай на вопрос, опираясь ТОЛЬКО на переданные элементы (JSON ниже). ` +
    `Будь краток и по делу. В конце ответа на отдельной строке выведи: ` +
    `RELEVANT_IDS: id1, id2 — перечисли id элементов, на которые опираешься (или "нет").`;

  const response = await callClaude({
    apiKey,
    model,
    system,
    messages: [
      {
        role: 'user',
        content: `Элементы (JSON):\n${JSON.stringify(compact)}\n\nВопрос: ${question}`,
      },
    ],
    max_tokens: 1024,
  });

  const text = getText(response);
  const relevantIds = [];
  let answer = text;

  const match = text.match(/RELEVANT_IDS:\s*(.+)$/im);
  if (match) {
    answer = text.slice(0, match.index).trim();
    match[1]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('itm_'))
      .forEach((id) => relevantIds.push(id));
  }

  return { answer, relevantIds };
}
