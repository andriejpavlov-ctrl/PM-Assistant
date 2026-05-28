// storage.js — слой хранения поверх localStorage.
// Не знает о DOM и о Claude. Чистый CRUD + версия схемы.

const STORAGE_KEY = 'pm_assistant_v1';
const SCHEMA_VERSION = 1;

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  settings: {
    theme: 'dark',
    model: 'claude-opus-4-8',
    apiKey: '',
  },
  items: [],
  people: [],
};

let state = null;

/** Сгенерировать короткий уникальный id с префиксом. */
function genId(prefix) {
  const rand = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return `${prefix}_${rand.slice(0, 10)}`;
}

function nowISO() {
  return new Date().toISOString();
}

/** Прочитать состояние из localStorage (один раз, потом кэш в памяти). */
function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Здесь при росте SCHEMA_VERSION можно добавить миграции.
      state = { ...structuredClone(DEFAULT_STATE), ...parsed };
      state.settings = { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) };
    } else {
      state = structuredClone(DEFAULT_STATE);
    }
  } catch (e) {
    console.error('Не удалось прочитать состояние, начинаю с чистого:', e);
    state = structuredClone(DEFAULT_STATE);
  }
  return state;
}

/** Сохранить текущее состояние в localStorage. */
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Не удалось сохранить состояние:', e);
  }
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

// ===== Люди =====
export function getPeople() {
  return [...load().people];
}

/** Найти человека по имени (без регистра) или создать нового. */
export function ensurePerson(name) {
  if (!name) return null;
  load();
  const norm = name.trim().toLowerCase();
  let person = state.people.find((p) => p.name.toLowerCase() === norm);
  if (!person) {
    person = { id: genId('per'), name: name.trim(), role: '' };
    state.people.push(person);
    persist();
  }
  return person;
}

// ===== Элементы (задачи / заметки / темы) =====
export function getItems() {
  return [...load().items];
}

export function getItem(id) {
  return load().items.find((it) => it.id === id) || null;
}

/**
 * Добавить новый элемент. Принимает «черновик» (частичные поля),
 * заполняет обязательные значения по умолчанию.
 */
export function addItem(draft) {
  load();
  const item = {
    id: genId('itm'),
    type: draft.type || 'note',
    title: draft.title || '(без названия)',
    body: draft.body || '',
    status: draft.status || 'open',
    priority: draft.priority || 'medium',
    due: draft.due || null,
    personId: draft.personId || null,
    tags: Array.isArray(draft.tags) ? draft.tags : [],
    sourceCaptureId: draft.sourceCaptureId || null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  state.items.unshift(item);
  persist();
  return item;
}

export function updateItem(id, patch) {
  load();
  const item = state.items.find((it) => it.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: nowISO() });
  persist();
  return item;
}

export function deleteItem(id) {
  load();
  const before = state.items.length;
  state.items = state.items.filter((it) => it.id !== id);
  if (state.items.length !== before) persist();
}

/** Полный экспорт состояния (для бэкапа). */
export function exportAll() {
  return JSON.stringify(load(), null, 2);
}
