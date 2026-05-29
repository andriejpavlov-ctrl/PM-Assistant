// storage.js — слой хранения поверх localStorage.
// Не знает о DOM и о Claude. Чистый CRUD + версия схемы.
//
// Модель данных (schemaVersion 3): единый тип «карточка» (card) с полями
// title, description, people[], projects[], priority, deadline, tags.
// Статусов и типов (topic/task/note) больше нет.

const STORAGE_KEY = 'pm_assistant_v3';
const SCHEMA_VERSION = 3;

// ===== Допустимые значения перечислений =====
export const ENUMS = {
  priority: ['P1', 'P2', 'P3'], // P1 — высокий, P2 — средний, P3 — низкий
};

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  settings: {
    theme: 'dark',
    model: 'claude-haiku-4-5-20251001',
    apiKey: '',
  },
  cards: [],
};

let state = null;

// ===== Утилиты =====

/** Короткий уникальный id с префиксом. */
function genId(prefix = 'crd') {
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
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
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
      state.cards = Array.isArray(parsed.cards) ? parsed.cards : [];
      // Миграция приоритетов на 3 уровня: устаревший P4 → P3 (низкий),
      // прочие невалидные значения — без приоритета. Сохраняем результат разово.
      let changed = false;
      state.cards.forEach((c) => {
        const before = c.priority;
        if (c.priority === 'P4') c.priority = 'P3';
        else if (c.priority && !ENUMS.priority.includes(c.priority)) c.priority = '';
        if (c.priority !== before) changed = true;
      });
      if (changed) persist();
    } else {
      state = migrateFromV2() || structuredClone(DEFAULT_STATE);
    }
  } catch (e) {
    console.error('Не удалось прочитать состояние, начинаю с чистого:', e);
    state = structuredClone(DEFAULT_STATE);
  }
  return state;
}

/**
 * Перенос данных со схемы v2 (ключ pm_assistant_v2, массив entities с типами
 * topic/task/note), если v3 ещё не создан. Всё сводится к единой карточке.
 */
function migrateFromV2() {
  try {
    const rawV2 = localStorage.getItem('pm_assistant_v2');
    if (!rawV2) return null;
    const v2 = JSON.parse(rawV2);
    const migrated = structuredClone(DEFAULT_STATE);
    migrated.settings = { ...migrated.settings, ...(v2.settings || {}) };

    (v2.entities || []).forEach((e) => {
      const people = e.type === 'topic' ? (e.person ? [e.person] : []) : (e.relatedPeople || []);
      migrated.cards.push(buildCard({
        title: e.type === 'topic' ? e.topic : e.title,
        description: e.type === 'note' ? e.content : [e.description, e.expectedResult].filter(Boolean).join('\n'),
        people,
        projects: e.relatedProjects || [],
        priority: e.priority || '',
        deadline: e.deadline,
        tags: e.tags,
        rawText: e.rawText,
        aiSummary: e.aiSummary,
        archived: !!e.archived,
        createdAt: e.createdAt,
      }));
    });
    return migrated;
  } catch (e) {
    console.warn('Миграция с v2 не удалась:', e);
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

// ===== Фабрика карточки (чистая, без записи в стор) =====

function buildCard(draft = {}) {
  const ts = draft.createdAt || nowISO();
  return {
    id: genId(),
    createdAt: ts,
    updatedAt: ts,
    archived: !!draft.archived,
    rawText: draft.rawText || '',
    title: draft.title || '(без названия)',
    description: draft.description || '',
    people: strArray(draft.people),
    projects: strArray(draft.projects),
    priority: coerceEnum(draft.priority, ENUMS.priority, ''),
    deadline: normDeadline(draft.deadline),
    tags: strArray(draft.tags),
    aiSummary: draft.aiSummary || '',
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

export function createCard(draft) {
  load();
  const card = buildCard(draft);
  state.cards.unshift(card);
  persist();
  return card;
}

// ===== READ =====

/** Активные карточки (не в архиве). */
export function getAll() {
  return load().cards.filter((c) => !c.archived);
}
/** Архивные карточки. */
export function getArchived() {
  return load().cards.filter((c) => c.archived);
}
/** Вообще все карточки, включая архив. */
export function getEverything() {
  return [...load().cards];
}
export function getById(id) {
  return load().cards.find((c) => c.id === id) || null;
}

// ===== UPDATE =====

/** Частичное обновление по id. id/createdAt сменить нельзя; поля нормализуются. */
export function update(id, patch = {}) {
  load();
  const card = state.cards.find((c) => c.id === id);
  if (!card) return null;

  const { id: _i, createdAt: _c, ...rest } = patch;
  const next = { ...rest };
  if ('people' in next) next.people = strArray(next.people);
  if ('projects' in next) next.projects = strArray(next.projects);
  if ('tags' in next) next.tags = strArray(next.tags);
  if ('deadline' in next) next.deadline = normDeadline(next.deadline);
  if ('priority' in next) next.priority = coerceEnum(next.priority, ENUMS.priority, '');

  Object.assign(card, next, { updatedAt: nowISO() });
  persist();
  return card;
}

// ===== ARCHIVE / DELETE =====

export function archive(id) { return update(id, { archived: true }); }
export function unarchive(id) { return update(id, { archived: false }); }
/** Удалить из доски = отправить в архив (данные не теряются). */
export function remove(id) { return !!archive(id); }
/** Безвозвратное удаление (из архива). */
export function destroy(id) {
  load();
  const before = state.cards.length;
  state.cards = state.cards.filter((c) => c.id !== id);
  const removed = state.cards.length !== before;
  if (removed) persist();
  return removed;
}
export function clearAll() {
  load();
  state.cards = [];
  persist();
}

// ===== Импорт / экспорт =====

export function exportAll() {
  return JSON.stringify(load(), null, 2);
}
export function importAll(json) {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.cards)) throw new Error('нет массива cards');
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
