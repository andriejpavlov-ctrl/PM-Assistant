// agent.js — AI-агент на Claude API. Прямые вызовы через fetch().
// Ключ берётся из window.CLAUDE_API_KEY (пользователь вводит его в настройках).
// Модель: claude-haiku-4-5-20251001. Все системные промпты — на русском,
// агент всегда отвечает валидным JSON.

// Модель настраивается: app.js прокидывает выбранную в настройках модель
// в window.CLAUDE_MODEL. Если не задана — используем дефолт.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
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

const CAPTURE_SYSTEM = `Ты — персональный ассистент директора по продукту. Преврати свободный текст пользователя в ОДНУ структурированную карточку. Всегда отвечай строго в формате JSON без дополнительного текста.

ПОЛЯ КАРТОЧКИ:
• title — короткое название в форме действия (глагол + объект). До ~7 слов. ОБЯЗАТЕЛЬНО сохраняй ключевой ГЛАГОЛ ДЕЙСТВИЯ (обсудить, согласовать, написать, спросить, проверить, подготовить, решить, выяснить…), если он был в тексте. Убирай «воду» («надо бы», «не забыть», «вроде как»), но НЕ теряй смысл.
• description — все остальные детали и контекст из текста (что конкретно сделать, нюансы, образ результата). Если деталей нет — "".
• people — массив имён людей, с кем это связано (с кем обсудить / кого касается). Может быть несколько. Если людей нет — [].
• projects — массив проектов/продуктов, к которым это относится. Может быть несколько. Если нет — [].
• priority — три уровня: "P1" (высокий) | "P2" (средний) | "P3" (низкий). Определяй по срочности и важности: «срочно/asap/сегодня/завтра/важно/критично/блокер» → "P1"; обычные дела на ближайшую неделю → "P2"; «потом/когда-нибудь/не горит/через месяц» → "P3". Если непонятно — "".
• deadline — ISO YYYY-MM-DD относительно переданной сегодняшней даты; относительные даты («до пятницы», «завтра») переводи в дату; если срока нет — null.
• tags — короткие теги-ключевые слова, если уместны; иначе [].

ИМЕНА ЛЮДЕЙ:
- В people клади только настоящие русские имена/имя+фамилию (Наташа, Пётр Смирнов, Оля). НЕ считай людьми продукты, проекты, отделы, аббревиатуры (Еком, бэклог, API, дизайн, маркетинг) — это projects или просто слова.
- Бери имя РОВНО как в тексте (приведи к именительному падежу), НЕ разворачивай уменьшительные в полную форму — это делает приложение отдельно (иначе ошибки: Настя ≠ Наталья).
- Если ниже передан список известных коллег и имя соответствует одному — верни ИМЕННО его (полное имя с фамилией), чтобы объединить варианты.

ФОРМАТ ОТВЕТА (строго один объект):
{"title":"...","description":"...","people":["..."],"projects":["..."],"priority":"P1|P2|P3|","deadline":null|"YYYY-MM-DD","tags":["..."]}

Не выдумывай данные, которых нет в тексте: пустые строки — "", пустые списки — [], отсутствующий срок — null.`;

/**
 * Разбирает свободный текст в единую карточку.
 * @param {string} rawText
 * @param {string[]} [knownPeople]  список известных коллег (полные имена) для объединения вариантов
 * @returns {Promise<object>} карточка-черновик с полями title, description, people, projects, priority, deadline, tags
 */
export async function processCapture(rawText, knownPeople = []) {
  const peopleHint = (knownPeople && knownPeople.length)
    ? `\n\nИзвестные коллеги (если имя соответствует одному из них — используй ИМЕННО это полное имя с фамилией): ${knownPeople.join(', ')}.`
    : '';
  const user = `Сегодняшняя дата: ${todayISO()}.${peopleHint}\n\nТекст пользователя:\n"""${rawText}"""\n\nРазбери и верни JSON.`;
  const text = await callClaude(CAPTURE_SYSTEM, user, { maxTokens: 1024 });
  const result = safeParseJSON(text);
  // Сохраняем исходный текст для трассируемости.
  result.rawText = rawText;
  return result;
}

// ============================================================
// ФУНКЦИЯ 2: processQuery(queryText, allData)
// ============================================================

const QUERY_SYSTEM = `Ты — поисковый ассистент директора по продукту. Тебе дают запрос на естественном языке и массив карточек (JSON): у каждой есть title, description, people, projects, priority, deadline, tags.

Найди карточки, релевантные запросу, и отсортируй их по полезности для пользователя
(учитывай совпадение по человеку/проекту/тексту, приоритет, дедлайн).

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
  // Компактная проекция карточек, чтобы не раздувать контекст лишними полями.
  const compact = (allData || []).map((c) => ({
    id: c.id,
    title: c.title || null,
    description: c.description || null,
    people: c.people || [],
    projects: c.projects || [],
    priority: c.priority || null,
    deadline: c.deadline || null,
    tags: c.tags || [],
  }));

  const user = `Запрос: "${queryText}"\n\nКарточки (JSON):\n${JSON.stringify(compact)}`;
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

const SUMMARY_SYSTEM = `Ты — личный ассистент директора по продукту. На основе всех карточек сформируй краткую сводку на сегодня.

У каждой карточки есть title, description, people, projects, priority (P1 высокий, P2 средний, P3 низкий), deadline, tags.
Сегодняшнюю дату тебе передадут — выделяй просроченные и сегодняшние дедлайны.

Верни ТОЛЬКО валидный JSON без markdown в формате:
{
  "greeting":"короткое приветствие/общая фраза",
  "urgent":[{"id":"...","title":"...","why":"почему важно"}],
  "todayFocus":["3-5 пунктов: что важнее всего сделать сегодня"],
  "summary":"связный абзац-сводка на 2-3 предложения"
}

Используй только реальные id из данных. Если данных мало — верни пустые массивы, но заполни summary.`;

/**
 * Формирует краткую сводку на день по карточкам.
 * @param {Array<object>} allData
 * @returns {Promise<object>} { greeting, urgent, todayFocus, summary }
 */
export async function generateDailySummary(allData) {
  const compact = (allData || []).map((c) => ({
    id: c.id,
    title: c.title || null,
    people: c.people || [],
    projects: c.projects || [],
    priority: c.priority || null,
    deadline: c.deadline || null,
  }));

  const user = `Сегодняшняя дата: ${todayISO()}.\n\nВсе карточки (JSON):\n${JSON.stringify(compact)}\n\nСформируй сводку на день.`;
  const text = await callClaude(SUMMARY_SYSTEM, user, { maxTokens: 1500 });
  return safeParseJSON(text);
}
