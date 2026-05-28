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
// Один общий элемент с дискриминатором type; поля каждого типа — опциональны,
// заполняются по релевантности. Соответствует фабрикам в storage.js.
const EXTRACT_TOOL = {
  name: 'extract_entities',
  description: 'Сохранить структурированные сущности, извлечённые из заметок директора по продукту.',
  input_schema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['topic', 'task', 'note'],
              description: 'topic — тема для обсуждения с коллегой; task — задача для себя; note — общая заметка/идея',
            },
            // Общие
            tags: { type: 'array', items: { type: 'string' } },
            aiSummary: { type: 'string', description: 'Краткое резюме сути в 1 предложение' },
            // TOPIC
            person: { type: 'string', description: '[topic] имя коллеги для обсуждения' },
            topic: { type: 'string', description: '[topic] суть темы' },
            urgency: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: '[topic] срочность' },
            importance: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '[topic] важность' },
            // TASK
            title: { type: 'string', description: '[task|note] короткое название' },
            description: { type: 'string', description: '[task] что конкретно сделать' },
            expectedResult: { type: 'string', description: '[task] образ результата' },
            priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'], description: '[task] приоритет' },
            // NOTE
            content: { type: 'string', description: '[note] содержание заметки' },
            // TASK + NOTE
            relatedPeople: { type: 'array', items: { type: 'string' }, description: '[task|note] упомянутые люди' },
            relatedProjects: { type: 'array', items: { type: 'string' }, description: '[task|note] упомянутые проекты' },
            // Общий дедлайн (topic, task)
            deadline: { type: ['string', 'null'], description: 'Дедлайн ISO YYYY-MM-DD или null' },
          },
          required: ['type'],
        },
      },
    },
    required: ['entities'],
  },
};

/**
 * Разобрать сырой текст на черновики сущностей (topic | task | note).
 * Каждый черновик кладёт rawText = исходный текст и готов к store.createEntity.
 * Возвращает массив draft-объектов.
 */
export async function parseCapture({ apiKey, model, rawText, people = [], today }) {
  const peopleHint = people.length ? `Известные коллеги: ${people.join(', ')}.` : '';
  const system =
    `Ты — ассистент директора по продукту. Разбери сырые заметки на отдельные сущности трёх типов:\n` +
    `• topic — тема для обсуждения с конкретным коллегой (заполни person, topic, urgency, importance);\n` +
    `• task — задача для себя (заполни title, description, expectedResult, priority);\n` +
    `• note — общая заметка/идея без явного действия (заполни title, content).\n` +
    `Сегодня ${today}. Относительные даты («до пятницы», «завтра») переводи в ISO YYYY-MM-DD, иначе deadline=null. ` +
    `Заполняй только релевантные типу поля; для task/note выноси упомянутых людей и проекты в relatedPeople/relatedProjects. ` +
    `Добавляй краткий aiSummary. Не выдумывай детали, которых нет в тексте. ` +
    `Отвечай ТОЛЬКО через инструмент extract_entities. ${peopleHint}`;

  const response = await callClaude({
    apiKey,
    model,
    system,
    messages: [{ role: 'user', content: rawText }],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_entities' },
    max_tokens: 2048,
  });

  const input = getToolInput(response, 'extract_entities');
  const entities = input?.entities || [];
  // Прокинуть исходный текст в каждый черновик.
  return entities.map((e) => ({ ...e, rawText }));
}

/**
 * Ответить на вопрос пользователя по всей базе элементов.
 * Возвращает { answer, relevantIds }.
 */
export async function ask({ apiKey, model, question, entities, today }) {
  // Компактная проекция: только значимые поля каждого типа.
  const compact = entities.map((e) => {
    const base = { id: e.id, type: e.type, tags: e.tags, deadline: e.deadline || null };
    if (e.type === 'topic') {
      return { ...base, person: e.person, topic: e.topic, urgency: e.urgency, importance: e.importance, status: e.status, summary: e.aiSummary };
    }
    if (e.type === 'task') {
      return { ...base, title: e.title, description: e.description, expectedResult: e.expectedResult, priority: e.priority, status: e.status, people: e.relatedPeople, projects: e.relatedProjects, summary: e.aiSummary };
    }
    return { ...base, title: e.title, content: e.content, people: e.relatedPeople, projects: e.relatedProjects, summary: e.aiSummary };
  });

  const system =
    `Ты — ассистент директора по продукту. Сегодня ${today}. ` +
    `Отвечай на вопрос, опираясь ТОЛЬКО на переданные сущности (JSON ниже): topic — темы для 1:1, task — задачи, note — заметки. ` +
    `Будь краток и по делу. В конце ответа на отдельной строке выведи: ` +
    `RELEVANT_IDS: id1, id2 — перечисли id сущностей, на которые опираешься (или "нет").`;

  const response = await callClaude({
    apiKey,
    model,
    system,
    messages: [
      {
        role: 'user',
        content: `Сущности (JSON):\n${JSON.stringify(compact)}\n\nВопрос: ${question}`,
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
      .filter((s) => /^(top|tsk|not)_/.test(s))
      .forEach((id) => relevantIds.push(id));
  }

  return { answer, relevantIds };
}
