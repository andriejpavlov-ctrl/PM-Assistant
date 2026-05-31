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

  const payload = {
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
  };

  // fetch() падает с TypeError «Failed to fetch» при сетевых проблемах: нет сети,
  // CORS, или запрос к api.anthropic.com режет расширение/блокировщик/файрвол
  // (частая причина именно на десктопе). Делаем одну повторную попытку и
  // показываем понятное сообщение вместо загадочного «Failed to fetch».
  let res;
  try {
    res = await fetch(API_URL, payload);
  } catch (e1) {
    try {
      res = await fetch(API_URL, payload);
    } catch (e2) {
      throw new Error(
        'Не удалось связаться с api.anthropic.com. Проверьте интернет и отключите ' +
        'блокировщик рекламы/VPN/расширения для этой страницы — они часто режут запросы к API.'
      );
    }
  }

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

const CAPTURE_SYSTEM = `Ты — персональный ассистент директора по продукту. Преврати свободный текст пользователя в ОДНУ ИЛИ НЕСКОЛЬКО структурированных карточек. Всегда отвечай строго в формате JSON без дополнительного текста.

КОГДА РАЗБИВАТЬ НА НЕСКОЛЬКО КАРТОЧЕК:
По умолчанию — ОДНА карточка. Раздели текст на НЕСКОЛЬКО карточек ТОЛЬКО если в нём явно несколько РАЗНЫХ, НЕ связанных между собой заметок. Признаки того, что заметки разные и их стоит разделить:
• это разные дела/задачи/вопросы, которые нельзя объединить в одно действие;
• у них разный контекст или тема;
• они про разных людей и разные ситуации;
• они относятся к разным проектам/продуктам;
• у них разные сроки/дедлайны.
Если фрагменты про ОДНО дело (пусть и описанные разными словами, или один уточняет другой) — это ОДНА карточка. НЕ дроби одну мысль на части и НЕ объединяй явно разные дела в одну карточку.

ПОЛЯ КАЖДОЙ КАРТОЧКИ:
• title — короткое название в форме действия (глагол + объект). До ~7 слов. ОБЯЗАТЕЛЬНО сохраняй ключевой ГЛАГОЛ ДЕЙСТВИЯ (обсудить, согласовать, написать, спросить, проверить, подготовить, решить, выяснить…), если он был в тексте. Убирай «воду» («надо бы», «не забыть», «вроде как»), но НЕ теряй смысл.
• description — все остальные детали и контекст из текста (что конкретно сделать, нюансы, образ результата). Если деталей нет — "".
• people — массив имён людей, с кем это связано (с кем обсудить / кого касается). Может быть несколько. Если людей нет — [].
• projects — массив проектов/продуктов. ПО УМОЛЧАНИЮ []. Каждый элемент — ОБЪЕКТ {"name":"...","confidence":"high"|"low","sameAs":"точное название из списка известных проектов или null"}.
  КОГДА вообще добавлять проект (иначе оставляй [] — НЕ угадывай «по смыслу»):
   1) рядом стоит слово-маркёр: «проект», «продукт», «направление», «стрим», «инициатива», «программа», «эпик», «epic», «workstream», «команда» или их формы/синонимы в ИТ-контексте → name = название после этого слова, confidence "high" (например: «проект Полис» → name "Полис").
   2) есть слово ИЛИ словосочетание с ЗАГЛАВНОЙ буквы НЕ в начале предложения, и это НЕ имя собственное человека/города/компании → это почти наверняка название проекта/продукта/направления — ДАЖЕ если само слово нарицательное («Управление качеством», «Ценообразование», «Биллинг»). ВСЕГДА возвращай его как проект, НИКОГДА не отбрасывай молча: name = заглавное слово вместе с относящимися к нему следующими словами (например «по Управлению качеством» → name "Управление качеством"; приведи к именительному падежу). confidence "high", если уверен, что это проект; confidence "low", если сомневаешься, проект ли это вообще (приложение переспросит пользователя).
  Слова СО СТРОЧНОЙ буквы (полис, биллинг, отчёт), отделы, технологии и общие термины БЕЗ заглавной — НЕ проект.
  sameAs (сопоставление с известными проектами — их список передаётся ниже):
   - если name по СМЫСЛУ обозначает ТОТ ЖЕ проект, что один из известных (одно и то же, но другими словами: например «Конструктор» и «Конструктор Цунами» — это один проект) → верни ТОЧНОЕ название из списка известных;
   - если это РАЗНЫЕ проекты (например «Динамическое ценообразование» и «Ценообразование для Поней» — разные) → null;
   - если точное совпадение с известным (без учёта регистра) → верни это известное название и confidence "high".
• priority — три уровня: "P1" (высокий) | "P2" (средний) | "P3" (низкий). Определяй по срочности и важности: «срочно/asap/сегодня/завтра/важно/критично/блокер» → "P1"; обычные дела на ближайшую неделю → "P2"; «потом/когда-нибудь/не горит/через месяц» → "P3". Если непонятно — "".
• deadline — ISO YYYY-MM-DD относительно переданной сегодняшней даты; относительные даты («до пятницы», «завтра») переводи в дату; если срока нет — null.
• tags — короткие теги-ключевые слова, если уместны; иначе [].

ИМЕНА ЛЮДЕЙ:
- В people клади только настоящие русские имена/имя+фамилию (Наташа, Пётр Смирнов, Оля). НЕ считай людьми продукты, проекты, отделы, аббревиатуры (Еком, бэклог, API, дизайн, маркетинг) — это projects или просто слова.
- Бери имя РОВНО как в тексте (приведи к именительному падежу), НЕ разворачивай уменьшительные в полную форму — это делает приложение отдельно (иначе ошибки: Настя ≠ Наталья).
- Если ниже передан список известных коллег и имя соответствует одному — верни ИМЕННО его (полное имя с фамилией), чтобы объединить варианты.

ФОРМАТ ОТВЕТА (строго один JSON-объект со списком карточек):
{"cards":[{"title":"...","description":"...","people":["..."],"projects":[{"name":"...","confidence":"high|low","sameAs":null}],"priority":"P1|P2|P3|","deadline":null|"YYYY-MM-DD","tags":["..."]}]}

Если заметка одна — верни массив cards с одним элементом. Не выдумывай данные, которых нет в тексте: пустые строки — "", пустые списки — [], отсутствующий срок — null.`;

// Дополнение к промпту, когда пользователь решил оставить весь текст одной карточкой.
const CAPTURE_SINGLE_RULE = `\n\nВАЖНО: верни РОВНО ОДНУ карточку (массив cards с одним элементом), объединив весь текст в неё, даже если кажется, что тем несколько.`;

/**
 * Превращает свободный текст в одну или несколько карточек.
 * @param {string} rawText  текст пользователя
 * @param {string[]} [knownPeople]  список известных коллег (полные имена) для объединения
 * @param {object} [opts]  { forceSingle, knownProjects } — forceSingle: вернуть ровно одну карточку; knownProjects: список существующих проектов для сопоставления
 * @returns {Promise<object[]>}  массив карточек-черновиков
 */
export async function processCapture(rawText, knownPeople = [], opts = {}) {
  const peopleHint = Array.isArray(knownPeople) && knownPeople.length
    ? `\n\nИзвестные коллеги (если имя совпадает — верни полное): ${knownPeople.join(', ')}.`
    : '';
  const knownProjects = Array.isArray(opts.knownProjects) ? opts.knownProjects : [];
  const projectsHint = knownProjects.length
    ? `\n\nИзвестные проекты (для поля sameAs — сопоставляй по СМЫСЛУ): ${knownProjects.join(', ')}.`
    : '';
  const singleRule = opts.forceSingle ? CAPTURE_SINGLE_RULE : '';
  const user = `Сегодняшняя дата: ${todayISO()}.${peopleHint}${projectsHint}${singleRule}\n\nТекст пользователя:\n"""${rawText}"""\n\nРазбери и верни JSON.`;
  const text = await callClaude(CAPTURE_SYSTEM, user, { maxTokens: 1500 });
  const parsed = safeParseJSON(text);

  let cards = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cards) ? parsed.cards : [parsed]);
  cards = cards.filter((c) => c && typeof c === 'object');
  if (!cards.length) throw new Error('Модель не вернула ни одной карточки');

  cards.forEach((c) => { c.rawText = rawText; });
  return opts.forceSingle ? cards.slice(0, 1) : cards;
}

// ============================================================
// ФУНКЦИЯ 2: processQuery(queryText, allData)
// ============================================================

const QUERY_SYSTEM = `Ты — поисковый ассистент директора по продукту. Тебе дают запрос на естественном языке и массив карточек (JSON): у каждой есть title, description, people, projects, priority, deadline, tags.

ЗАДАЧА: найди карточки, релевантные запросу, и верни их ID в порядке убывания релевантности
(учитывай совпадение по человеку/проекту/тексту, приоритет, дедлайн).
ДОПОЛНИТЕЛЬНО: если вопрос подразумевает сводку или анализ («что срочного», «чем заняться», «что по проекту X»),
сформулируй краткую сводку в 2–4 предложения, выдели главное — ключевые задачи, людей, проекты, сроки и на чём
стоит сфокусироваться. Если ничего не нашлось — summary пустой.

ФОРМАТ ОТВЕТА (строго JSON):
{"ids":["id1","id2"],"explanation":"коротко, почему эти карточки","summary":"сводка или пустая строка","summaryTitle":"короткий заголовок сводки"}
Ничего кроме JSON.`;

/**
 * Ищет карточки по естественно-языковому запросу.
 * @returns {Promise<{explanation,summary,summaryTitle,results}>}
 */
export async function processQuery(queryText, allData) {
  // Компактная версия карточек для промпта (экономим токены).
  const compact = (allData || []).map((c) => ({
    id: c.id,
    title: c.title || '',
    description: c.description || '',
    people: c.people || [],
    projects: c.projects || [],
    priority: c.priority || '',
    deadline: c.deadline || null,
    tags: c.tags || [],
  }));
  const user = `Запрос: "${queryText}"\n\nКарточки (JSON):\n${JSON.stringify(compact)}\n\nСегодня: ${todayISO()}. Верни JSON.`;
  const text = await callClaude(QUERY_SYSTEM, user, { maxTokens: 1500 });
  const parsed = safeParseJSON(text);

  const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
  const byId = new Map((allData || []).map((e) => [e.id, e]));
  const results = ids
    .map((id) => byId.get(id))
    .filter(Boolean);
  return {
    explanation: parsed.explanation || '',
    summary: parsed.summary || '',
    summaryTitle: parsed.summaryTitle || '',
    results,
  };
}

// ============================================================
// ФУНКЦИЯ 3: findSimilarCard(draft, cards)
// ============================================================

const SIMILAR_SYSTEM = `Ты — ассистент, который ищет ДУБЛИКАТЫ карточек. Тебе дают НОВУЮ карточку и массив СУЩЕСТВУЮЩИХ карточек (JSON).

ЗАДАЧА: определи, есть ли среди существующих карточка, которая ПО СМЫСЛУ дублирует новую (тот же вопрос/задача/событие).
Считай дубликатом, если речь об одном и том же деле (даже если формулировки разные). НЕ считай дубликатом разные задачи по одному человеку/проекту.

ФОРМАТ ОТВЕТА (строго JSON): {"similarId":"id или null","reason":"короткое объяснение или пустая строка"}
Ничего кроме JSON.`;

/**
 * Ищет среди существующих карточек дубликат новой.
 * @returns {Promise<{similarId,reason}>}
 */
export async function findSimilarCard(draft, cards) {
  if (!cards || !cards.length) return { similarId: null, reason: '' };
  const compact = cards.map((c) => ({
    id: c.id,
    title: c.title || '',
    description: c.description || '',
    people: c.people || [],
    projects: c.projects || [],
  }));
  const draftCompact = {
    title: draft.title || '',
    description: draft.description || '',
    people: draft.people || [],
    projects: draft.projects || [],
  };
  const user = `НОВАЯ карточка:\n${JSON.stringify(draftCompact)}\n\nСУЩЕСТВУЮЩИЕ карточки:\n${JSON.stringify(compact)}\n\nВерни JSON.`;
  const text = await callClaude(SIMILAR_SYSTEM, user, { maxTokens: 300 });
  const parsed = safeParseJSON(text);
  const similarId = parsed.similarId && parsed.similarId !== 'null' ? parsed.similarId : null;
  return { similarId, reason: parsed.reason || '' };
}

// ============================================================
// ФУНКЦИЯ 4: mergeCards(existing, draft)
// ============================================================

const MERGE_SYSTEM = `Ты — ассистент, который ОБЪЕДИНЯЕТ две карточки в одну. Тебе дают СУЩЕСТВУЮЩУЮ карточку и НОВУЮ запись (JSON).

ЗАДАЧА: собери общий контекст в ОДНУ карточку без потери смысла.
• title — лучший из двух или улучшенный (глагол действия + объект, до ~7 слов).
• description — объединённые детали обеих (без повторов).
• people / projects / tags — объединение без дубликатов.

ФОРМАТ ОТВЕТА (строго JSON):
{"title":"...","description":"...","people":["..."],"projects":["..."],"tags":["..."]}
Ничего кроме JSON.`;

/**
 * Объединяет две карточки в одну через модель.
 * @returns {Promise<{title,description,people,projects,tags}>}
 */
export async function mergeCards(existing, draft) {
  const proj = (c) => ({
    title: c.title || '',
    description: c.description || '',
    people: c.people || [],
    projects: c.projects || [],
    tags: c.tags || [],
  });
  const user = `СУЩЕСТВУЮЩАЯ:\n${JSON.stringify(proj(existing))}\n\nНОВАЯ:\n${JSON.stringify(proj(draft))}\n\nОбъедини и верни JSON.`;
  const text = await callClaude(MERGE_SYSTEM, user, { maxTokens: 800 });
  const parsed = safeParseJSON(text);
  return {
    title: parsed.title || existing.title || '',
    description: parsed.description || '',
    people: Array.isArray(parsed.people) ? parsed.people : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

// ============================================================
// ФУНКЦИЯ 5: generateDailySummary(allData)
// ============================================================

const SUMMARY_SYSTEM = `Ты — ассистент директора по продукту. Тебе дают массив активных карточек (JSON).
У каждой карточки есть title, description, people, projects, priority (P1 высокий, P2 средний, P3 низкий), deadline, tags.

ЗАДАЧА: сделай краткую сводку дня — на чём сфокусироваться, что горит, какие дедлайны близко.
Пиши по-деловому, без воды, 3–6 предложений.

ФОРМАТ ОТВЕТА (строго JSON): {"summary":"текст сводки"}
Ничего кроме JSON.`;

/**
 * Генерирует сводку дня по активным карточкам.
 * @returns {Promise<string>}
 */
export async function generateDailySummary(allData) {
  const compact = (allData || []).map((c) => ({
    title: c.title || '',
    description: c.description || '',
    people: c.people || [],
    projects: c.projects || [],
    priority: c.priority || '',
    deadline: c.deadline || null,
    tags: c.tags || [],
  }));
  const user = `Активные карточки (JSON):\n${JSON.stringify(compact)}\n\nСегодня: ${todayISO()}. Верни JSON.`;
  const text = await callClaude(SUMMARY_SYSTEM, user, { maxTokens: 1500 });
  const parsed = safeParseJSON(text);
  return parsed.summary || '';
}

// ============================================================
// ФУНКЦИЯ 6: generateMeme()
// ============================================================

const MEME_SYSTEM = `Ты — генератор брутальных, мотивирующих и смешных советов для менеджера продукта в стиле интернет-мемов.

ЗАДАЧА: выдай ОДИН короткий совет (1–2 предложения) в стиле одного из брутальных героев (Чак Норрис, Джейсон Статхем и т.п.).
Совет должен быть с юмором, про работу продакт-менеджера (бэклог, релизы, стейкхолдеры, метрики, дедлайны).

ФОРМАТ ОТВЕТА (строго JSON): {"hero":"имя героя","meme":"текст совета"}
Ничего кроме JSON.`;

/**
 * Генерирует случайный брутальный совет.
 * @returns {Promise<{hero,meme}>}
 */
export async function generateMeme() {
  const seed = Math.random().toString(36).slice(2, 8);
  const user = `Сгенерируй свежий совет (seed ${seed}, чтобы не повторяться). Верни JSON.`;
  const text = await callClaude(MEME_SYSTEM, user, { maxTokens: 400 });
  const parsed = safeParseJSON(text);
  return { hero: parsed.hero || '', meme: parsed.meme || '' };
}
