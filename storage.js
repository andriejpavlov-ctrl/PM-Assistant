// storage.js — слой хранения поверх localStorage.
// Не знает о DOM и о Claude. Чистый CRUD + версия схемы.
//
// Модель данных (schemaVersion 2): три типа сущностей в одном массиве
// `entities`, различаемые полем `type`: 'topic' | 'task' | 'note'.

const STORAGE_KEY = 'pm_assistant_v2';
const SCHEMA_VERSION = 2;

// ===== Допустимые значения перечислений =====
export const ENUMS = {
  topicUrgency: ['urgent', 'high', 'medium', 'low'],
  topicImportance: ['critical', 'high', 'medium', 'low'],
  topicStatus: ['open', 'discussed'],
  taskPriority: ['P1', 'P2', 'P3', 'P4'],
  taskStatus: ['todo', 'in_progress', 'done', 'blocked'],
};

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  settings: {
    theme: 'dark',
    model: 'claude-haiku-4-5-20251001',
    apiKey: '',
  },
  entities: [],
};

let state = null;

// ===== Утилиты =====

/** Короткий уникальный id с префиксом типа. */
function genId(prefix) {
  const rand = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return `${prefix}_${rand.slice(0, 10)}`;
}

function nowISO() {
  return new Date().toISOString();
}

/** Привести значение к допустимому из списка, иначе вернуть fallback. */
function coerceEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Гарантировать массив строк. */
function strArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/** Нормализовать дедлайн к 'YYYY-MM-DD' или null. */
function normDeadline(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ===== Загрузка / сохранение / миграции =====

function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { ...structuredClone(DEFAULT_STATE), ...parsed };
      state.settings = { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) };
      state.entities = Array.isArray(parsed.entities) ? parsed.entities : [];
    } else {
      state = migrateFromV1() || structuredClone(DEFAULT_STATE);
    }
  } catch (e) {
    console.error('Не удалось прочитать состояние, начинаю с чистого:', e);
    state = structuredClone(DEFAULT_STATE);
  }
  return state;
}

/**
 * Перенос данных со схемы v1 (ключ pm_assistant_v1, единый массив items),
 * если v2 ещё не создан. discussion -> topic, task -> task, note -> note.
 */
function migrateFromV1() {
  try {
    const rawV1 = localStorage.getItem('pm_assistant_v1');
    if (!rawV1) return null;
    const v1 = JSON.parse(rawV1);
    const people = v1.people || [];
    const nameOf = (id) => people.find((p) => p.id === id)?.name || null;

    const migrated = structuredClone(DEFAULT_STATE);
    migrated.settings = { ...migrated.settings, ...(v1.settings || {}) };

    (v1.items || []).forEach((it) => {
      if (it.type === 'discussion') {
        migrated.entities.push(buildTopic({
          rawText: it.body || it.title, person: nameOf(it.personId) || '',
          topic: it.title, deadline: it.due, tags: it.tags,
          status: it.status === 'done' ? 'discussed' : 'open',
          createdAt: it.createdAt,
        }));
      } else if (it.type === 'task') {
        migrated.entities.push(buildTask({
          rawText: it.body || it.title, title: it.title, description: it.body,
          deadline: it.due, tags: it.tags,
          relatedPeople: nameOf(it.personId) ? [nameOf(it.personId)] : [],
          priority: { high: 'P1', medium: 'P2', low: 'P3' }[it.priority] || 'P3',
          status: it.status === 'done' ? 'done' : 'todo',
          createdAt: it.createdAt,
        }));
      } else {
        migrated.entities.push(buildNote({
          rawText: it.body || it.title, title: it.title, content: it.body,
          tags: it.tags, createdAt: it.createdAt,
        }));
      }
    });
    return migrated;
  } catch (e) {
    console.warn('Миграция с v1 не удалась:', e);
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Не удалось сохранить состояние:', e);
  }
}

// ===== Фабрики сущностей (чистые, без записи в стор) =====

function buildBase(prefix, type, draft) {
  const ts = draft.createdAt || nowISO();
  return {
    id: genId(prefix),
    type,
    createdAt: ts,
    updatedAt: ts,
    rawText: draft.rawText || '',
    tags: strArray(draft.tags),
    aiSummary: draft.aiSummary || '',
  };
}

function buildTopic(draft = {}) {
  return {
    ...buildBase('top', 'topic', draft),
    person: (draft.person || '').trim(),
    topic: draft.topic || draft.title || '(без темы)',
    urgency: coerceEnum(draft.urgency, ENUMS.topicUrgency, 'medium'),
    importance: coerceEnum(draft.importance, ENUMS.topicImportance, 'medium'),
    deadline: normDeadline(draft.deadline),
    status: coerceEnum(draft.status, ENUMS.topicStatus, 'open'),
  };
}

function buildTask(draft = {}) {
  return {
    ...buildBase('tsk', 'task', draft),
    title: draft.title || '(без названия)',
    description: draft.description || '',
    expectedResult: draft.expectedResult || '',
    deadline: normDeadline(draft.deadline),
    priority: coerceEnum(draft.priority, ENUMS.taskPriority, 'P3'),
    relatedPeople: strArray(draft.relatedPeople),
    relatedProjects: strArray(draft.relatedProjects),
    status: coerceEnum(draft.status, ENUMS.taskStatus, 'todo'),
  };
}

function buildNote(draft = {}) {
  return {
    ...buildBase('not', 'note', draft),
    title: draft.title || '(без названия)',
    content: draft.content || '',
    relatedPeople: strArray(draft.relatedPeople),
    relatedProjects: strArray(draft.relatedProjects),
  };
}

// ===== Настройки =====

export function getSettings() {
  return { ...load().settings };
}

export function updateSettings(patch) {
  load();
  state.settings = { ...state.settings, ...patch };
  persist();
  return getSettings();
}

// ===== CREATE =====

export function createTopic(draft) {
  load();
  const topic = buildTopic(draft);
  state.entities.unshift(topic);
  persist();
  return topic;
}

export function createTask(draft) {
  load();
  const task = buildTask(draft);
  state.entities.unshift(task);
  persist();
  return task;
}

export function createNote(draft) {
  load();
  const note = buildNote(draft);
  state.entities.unshift(note);
  persist();
  return note;
}

/** Создать сущность по полю draft.type ('topic' | 'task' | 'note'). */
export function createEntity(draft = {}) {
  switch (draft.type) {
    case 'topic': return createTopic(draft);
    case 'task': return createTask(draft);
    case 'note': return createNote(draft);
    default: throw new Error(`Неизвестный тип сущности: ${draft.type}`);
  }
}

// ===== READ =====

/** Все сущности (копия массива). */
export function getAll() {
  return [...load().entities];
}

export function getById(id) {
  return load().entities.find((e) => e.id === id) || null;
}

export function getTopics() {
  return load().entities.filter((e) => e.type === 'topic');
}

export function getTasks() {
  return load().entities.filter((e) => e.type === 'task');
}

export function getNotes() {
  return load().entities.filter((e) => e.type === 'note');
}

/** Произвольный фильтр: query(e => e.status === 'open'). */
export function query(predicate) {
  return load().entities.filter(predicate);
}

// ===== UPDATE =====

/**
 * Частичное обновление по id. Поле type сменить нельзя; перечисления
 * приводятся к допустимым значениям, дедлайн нормализуется.
 */
export function update(id, patch = {}) {
  load();
  const entity = state.entities.find((e) => e.id === id);
  if (!entity) return null;

  const { id: _i, type: _t, createdAt: _c, ...rest } = patch;
  const next = { ...rest };

  if ('tags' in next) next.tags = strArray(next.tags);
  if ('deadline' in next) next.deadline = normDeadline(next.deadline);
  if ('relatedPeople' in next) next.relatedPeople = strArray(next.relatedPeople);
  if ('relatedProjects' in next) next.relatedProjects = strArray(next.relatedProjects);

  if (entity.type === 'topic') {
    if ('urgency' in next) next.urgency = coerceEnum(next.urgency, ENUMS.topicUrgency, entity.urgency);
    if ('importance' in next) next.importance = coerceEnum(next.importance, ENUMS.topicImportance, entity.importance);
    if ('status' in next) next.status = coerceEnum(next.status, ENUMS.topicStatus, entity.status);
  } else if (entity.type === 'task') {
    if ('priority' in next) next.priority = coerceEnum(next.priority, ENUMS.taskPriority, entity.priority);
    if ('status' in next) next.status = coerceEnum(next.status, ENUMS.taskStatus, entity.status);
  }

  Object.assign(entity, next, { updatedAt: nowISO() });
  persist();
  return entity;
}

// ===== DELETE =====

export function remove(id) {
  load();
  const before = state.entities.length;
  state.entities = state.entities.filter((e) => e.id !== id);
  const removed = state.entities.length !== before;
  if (removed) persist();
  return removed;
}

/** Удалить все сущности (настройки сохраняются). */
export function clearAll() {
  load();
  state.entities = [];
  persist();
}

// ===== Импорт / экспорт =====

export function exportAll() {
  return JSON.stringify(load(), null, 2);
}

/** Заменить состояние из JSON-строки (бэкап). Возвращает true при успехе. */
export function importAll(json) {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.entities)) throw new Error('нет массива entities');
    state = {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
    };
    persist();
    return true;
  } catch (e) {
    console.error('Импорт не удался:', e);
    return false;
  }
}
