// agent.js — AI-агент на Claude API. Прямые вызовы через fetch().
// Ключ берётся из window.CLAUDE_API_KEY (пользователь вводит его в настройках).
// Модель: claude-3-5-haiku-20241022. Все системные промпты — на русском,
// агент всегда отвечает валидным JSON.

// Модель настраивается: app.js прокидывает выбранную в настройках модель
// в window.CLAUDE_MODEL. Если не задана — используем дефолт.
const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function getModel() {
  return window.CLAUDE_MODEL || DEFAULT_MODEL;
}

/** Текущая дата в ISO (YYYY-MM-DD) — передаётся в промпты для расчёта дедлайнов. */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Низкоуровневый вызов Claude. Возвращает текст ответа (первый text-блок).
 * @param {string} system  системный промпт (на русском)
 * @param {string} user    пользовательское сообщение
 * @param {object} [opts]  { maxTokens }
 */
async function callClaude(system, user, { maxTokens = 1500 } = {}) {
  const apiKey = window.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('Не задан API-ключ. Введите ключ Claude в настройках приложения.');
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Разрешает вызов напрямую из браузера.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
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

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Надёжный разбор JSON из ответа модели: срезает markdown-ограждения ```json,
 * при необходимости вырезает первый сбалансированный объект/массив.
 */
function safeParseJSON(text) {
  if (!text) throw new Error('Пустой ответ от модели');
  let s = text.trim();

  // Убрать ограждения ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // Попытаться вырезать первый JSON-объект или массив.
    const start = s.search(/[{[]/);
    const lastObj = s.lastIndexOf('}');
    const lastArr = s.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (start !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error('Не удалось разобрать JSON из ответа модели');
  }
}

// ============================================================
// ФУНКЦИЯ 1: processCapture(rawText)
// ============================================================

const CAPTURE_SYSTEM = `Ты — персональный ассистент директора по продукту. Твоя задача — структурировать информацию из свободного текста.

При определении срочности используй следующую логику:
- "срочно", "asap", "сейчас" → urgent (🔴)
- "важно", "критично", "завтра", "сегодня" → high (🟠)
- "в конце недели", "на этой неделе" → medium (🟡)
- "через месяц", "когда-нибудь", "по возможности" → low (🟢)
- Без упоминания срока → medium по умолчанию

Всегда отвечай строго в формате JSON без дополнительного текста.

Сначала определи ТИП записи:
• "topic" — тема, которую нужно обсудить с конкретным человеком (упомянут коллега, встреча, "обсудить с…", "спросить у…").
• "task"  — задача для самого пользователя (нужно что-то сделать).
• "note"  — заметка, мысль, идея, факт без явного действия и без собеседника.

ВАЖНОСТЬ (importance): "critical" — "критично", "блокер", "обязательно"; "high" — "важно", "приоритет"; "medium" — по умолчанию; "low" — "мелочь", "необязательно".
ДЕДЛАЙН (deadline): переводи относительные даты в ISO YYYY-MM-DD относительно переданной сегодняшней даты; если срока нет — null.
ПРИОРИТЕТ задачи (priority): P1 (срочно и важно), P2 (важно, не срочно), P3 (срочно, не важно), P4 (ни то, ни другое).

Формат JSON по типу (urgency: urgent|high|medium|low; importance: critical|high|medium|low):
topic: {"type":"topic","person":"имя","topic":"суть темы","urgency":"...","importance":"...","deadline":null|"YYYY-MM-DD","tags":["..."]}
task:  {"type":"task","title":"название","description":"что конкретно сделать","expectedResult":"образ результата","deadline":null|"YYYY-MM-DD","priority":"P1|P2|P3|P4","urgency":"...","importance":"...","tags":["..."]}
note:  {"type":"note","title":"заголовок","tags":["..."]}

Не выдумывай данные, которых нет в тексте: отсутствующие строки оставляй пустыми "", отсутствующие даты — null, теги — [].`;

/**
 * Разбирает свободный текст в структурированный объект записи.
 * @param {string} rawText
 * @returns {Promise<object>} объект с полем type и извлечёнными данными
 */
export async function processCapture(rawText) {
  const user = `Сегодняшняя дата: ${todayISO()}.\n\nТекст пользователя:\n"""${rawText}"""\n\nРазбери и верни JSON.`;
  const text = await callClaude(CAPTURE_SYSTEM, user, { maxTokens: 1024 });
  const result = safeParseJSON(text);
  // Сохраняем исходный текст для трассируемости.
  result.rawText = rawText;
  return result;
}

// ============================================================
// ФУНКЦИЯ 2: processQuery(queryText, allData)
// ============================================================

const QUERY_SYSTEM = `Ты — поисковый ассистент директора по продукту. Тебе дают запрос на естественном языке и массив записей (JSON): тип "topic" (темы для обсуждения с людьми), "task" (задачи), "note" (заметки).

Найди записи, релевантные запросу, и отсортируй их по полезности для пользователя
(учитывай совпадение по человеку/теме/проекту, срочность, важность, дедлайн).

Верни ТОЛЬКО валидный JSON без markdown в формате:
{"explanation":"короткое объяснение, как ты отфильтровал и отсортировал","resultIds":["id1","id2", ...]}

resultIds — id релевантных записей строго в порядке от самой релевантной к наименее.
Если ничего не подходит — resultIds: [] и поясни это в explanation. Используй только переданные id, ничего не выдумывай.`;

/**
 * Находит, фильтрует и сортирует релевантные записи под запрос пользователя.
 * @param {string} queryText
 * @param {Array<object>} allData  все записи из БД
 * @returns {Promise<{explanation: string, results: object[]}>}
 */
export async function processQuery(queryText, allData) {
  // Компактная проекция, чтобы не раздувать контекст лишними полями.
  const compact = (allData || []).map((e) => ({
    id: e.id,
    type: e.type,
    person: e.person || null,
    topic: e.topic || null,
    title: e.title || null,
    urgency: e.urgency || null,
    importance: e.importance || null,
    priority: e.priority || null,
    status: e.status || null,
    deadline: e.deadline || null,
    relatedPeople: e.relatedPeople || [],
    relatedProjects: e.relatedProjects || [],
    tags: e.tags || [],
  }));

  const user = `Запрос: "${queryText}"\n\nЗаписи (JSON):\n${JSON.stringify(compact)}`;
  const text = await callClaude(QUERY_SYSTEM, user, { maxTokens: 1024 });
  const parsed = safeParseJSON(text);

  // Восстанавливаем полные записи в порядке, заданном моделью.
  const byId = new Map((allData || []).map((e) => [e.id, e]));
  const results = (parsed.resultIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean);

  return { explanation: parsed.explanation || '', results };
}

// ============================================================
// ФУНКЦИЯ 3: generateDailySummary(allData)
// ============================================================

const SUMMARY_SYSTEM = `Ты — личный ассистент директора по продукту. На основе всех записей сформируй краткую сводку на сегодня.

Учитывай типы записей: "task" (задачи со статусом и приоритетом P1-P4), "topic" (темы для обсуждения с людьми, со срочностью/важностью), "note" (заметки).
Сегодняшнюю дату тебе передадут — выделяй просроченные и сегодняшние дедлайны.

Верни ТОЛЬКО валидный JSON без markdown в формате:
{
  "greeting":"короткое приветствие/общая фраза",
  "urgentTasks":[{"id":"...","title":"...","why":"почему срочно"}],
  "upcomingTopics":[{"id":"...","person":"...","topic":"...","why":"почему обсудить скоро"}],
  "todayFocus":["3-5 пунктов: что важнее всего сделать сегодня"],
  "summary":"связный абзац-сводка на 2-3 предложения"
}

Не включай выполненные задачи (status "done") и обсуждённые темы (status "discussed"). Используй только реальные id из данных. Если данных мало — верни пустые массивы, но заполни summary.`;

/**
 * Формирует краткую сводку на день: срочные задачи, темы для ближайших встреч,
 * фокус на сегодня.
 * @param {Array<object>} allData
 * @returns {Promise<object>} { greeting, urgentTasks, upcomingTopics, todayFocus, summary }
 */
export async function generateDailySummary(allData) {
  const compact = (allData || []).map((e) => ({
    id: e.id,
    type: e.type,
    person: e.person || null,
    topic: e.topic || null,
    title: e.title || null,
    urgency: e.urgency || null,
    importance: e.importance || null,
    priority: e.priority || null,
    status: e.status || null,
    deadline: e.deadline || null,
  }));

  const user = `Сегодняшняя дата: ${todayISO()}.\n\nВсе записи (JSON):\n${JSON.stringify(compact)}\n\nСформируй сводку на день.`;
  const text = await callClaude(SUMMARY_SYSTEM, user, { maxTokens: 1500 });
  return safeParseJSON(text);
}
