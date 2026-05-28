// app.js — контроллер. Единственный модуль, который трогает DOM.
// Связывает UI ⟷ storage.js ⟷ agent.js. Работает с тремя типами сущностей:
// topic (обсудить с коллегой) | task (задача) | note (заметка).

import * as store from './storage.js';
import { parseCapture, ask } from './agent.js';

// config.js (необязательный) может задать window.PM_CONFIG = { apiKey, model }.
const fileConfig = window.PM_CONFIG || {};

const TYPE_LABEL = { topic: 'Обсудить', task: 'Задача', note: 'Заметка' };
const URGENCY_LABEL = { urgent: 'срочно', high: 'высокая', medium: 'средняя', low: 'низкая' };
const IMPORTANCE_LABEL = { critical: 'критично', high: 'высокая', medium: 'средняя', low: 'низкая' };
const TASK_STATUS_LABEL = { todo: 'к выполнению', in_progress: 'в работе', done: 'готово', blocked: 'заблок.' };

let drafts = []; // черновики после разбора, ещё не сохранены
const filters = { type: 'all', status: 'active' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Уровень важности/срочности/приоритета -> CSS-класс цвета. */
function sevClass(level) {
  if (['urgent', 'critical', 'high', 'P1'].includes(level)) return 'badge-prio-high';
  if (['medium', 'P2'].includes(level)) return 'badge-prio-medium';
  return 'badge-prio-low';
}

/** Закрыта ли сущность (выполнена/обсуждена). */
function isClosed(e) {
  return (e.type === 'task' && e.status === 'done') || (e.type === 'topic' && e.status === 'discussed');
}

// Заголовок и тело для отображения зависят от типа.
function displayTitle(e) {
  return e.type === 'topic' ? e.topic || '(без темы)' : e.title || '(без названия)';
}
function displayBody(e) {
  if (e.type === 'topic') return e.aiSummary || '';
  if (e.type === 'task') return [e.description, e.expectedResult && `🎯 ${e.expectedResult}`].filter(Boolean).join('\n');
  return e.content || '';
}
function setDraftTitle(draft, value) {
  if (draft.type === 'topic') draft.topic = value;
  else draft.title = value;
}

// ===== Инициализация =====
function init() {
  const settings = store.getSettings();
  if (!settings.apiKey && fileConfig.apiKey) store.updateSettings({ apiKey: fileConfig.apiKey });
  if (fileConfig.model && settings.model === 'claude-opus-4-8') store.updateSettings({ model: fileConfig.model });
  applyTheme(store.getSettings().theme);

  bindNav();
  bindCapture();
  bindTasks();
  bindFind();
  bindSettings();
  bindTheme();

  renderItems();
}

// ===== Навигация по вкладкам =====
function bindNav() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  if (name === 'tasks') renderItems();
}

// ===== Тема =====
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '☾' : '☀';
}

function bindTheme() {
  $('#theme-toggle').addEventListener('click', () => {
    const next = store.getSettings().theme === 'dark' ? 'light' : 'dark';
    store.updateSettings({ theme: next });
    applyTheme(next);
  });
}

// ===== Вкладка «Захватить» =====
function bindCapture() {
  $('#parse-btn').addEventListener('click', onParse);
  $('#save-all-btn').addEventListener('click', onSaveAllDrafts);
}

async function onParse() {
  const raw = $('#capture-input').value.trim();
  if (!raw) return;

  const btn = $('#parse-btn');
  const status = $('#capture-status');
  setBusy(btn, status, 'Claude разбирает заметки…');

  try {
    const { apiKey, model } = store.getSettings();
    // Передаём имена известных коллег для подсказки распознавания.
    const people = [...new Set(store.getAll().flatMap((e) => (e.type === 'topic' ? [e.person] : e.relatedPeople || [])).filter(Boolean))];
    drafts = await parseCapture({ apiKey, model, rawText: raw, people, today: todayISO() });
    status.hidden = true;
    renderDrafts();
    if (!drafts.length) showStatus(status, 'Ничего не удалось извлечь — попробуй переформулировать.');
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    clearBusy(btn, 'Разобрать ✦');
  }
}

function renderDrafts() {
  const wrap = $('#drafts');
  const list = $('#drafts-list');
  list.innerHTML = '';
  if (!drafts.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  drafts.forEach((draft, idx) => list.appendChild(renderDraftCard(draft, idx)));
}

function renderDraftCard(draft, idx) {
  const li = document.createElement('li');
  li.className = 'card';

  const main = document.createElement('div');
  main.className = 'card-main';

  // Редактируемый заголовок (topic.topic либо title).
  const title = document.createElement('input');
  title.className = 'text-input draft-edit';
  title.value = displayTitle(draft);
  title.addEventListener('input', () => setDraftTitle(drafts[idx], title.value));
  main.appendChild(title);

  main.appendChild(buildMeta(draft));

  const bodyText = displayBody(draft);
  if (bodyText) {
    const body = document.createElement('p');
    body.className = 'card-body';
    body.textContent = bodyText;
    main.appendChild(body);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const del = iconBtn('✕', 'Убрать из черновиков');
  del.addEventListener('click', () => {
    drafts.splice(idx, 1);
    renderDrafts();
  });
  actions.appendChild(del);

  li.append(main, actions);
  return li;
}

function onSaveAllDrafts() {
  drafts.forEach((draft) => store.createEntity(draft));
  drafts = [];
  renderDrafts();
  $('#capture-input').value = '';
  showStatus($('#capture-status'), 'Сохранено ✓ — смотри на вкладке «Задачи».');
  renderItems();
}

// ===== Вкладка «Задачи» (список всех сущностей) =====
function bindTasks() {
  $$('#type-filters .chip').forEach((c) =>
    c.addEventListener('click', () => {
      filters.type = c.dataset.filterType;
      setActiveChip('#type-filters', c);
      renderItems();
    })
  );
  $$('#status-filters .chip').forEach((c) =>
    c.addEventListener('click', () => {
      filters.status = c.dataset.filterStatus;
      setActiveChip('#status-filters', c);
      renderItems();
    })
  );
}

function passesFilter(e) {
  if (filters.type !== 'all' && e.type !== filters.type) return false;
  if (filters.status === 'active' && isClosed(e)) return false;
  if (filters.status === 'done' && !isClosed(e)) return false;
  return true;
}

function renderItems() {
  const list = $('#items-list');
  const empty = $('#items-empty');
  const entities = store.getAll().filter(passesFilter);

  list.innerHTML = '';
  empty.hidden = entities.length > 0;
  entities.forEach((e) => list.appendChild(renderItemCard(e)));
}

function renderItemCard(e) {
  const li = document.createElement('li');
  li.className = 'card' + (isClosed(e) ? ' is-done' : '');

  // Чекбокс закрытия: task -> done, topic -> discussed.
  if (e.type === 'task' || e.type === 'topic') {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = isClosed(e);
    check.addEventListener('change', () => {
      const patch = e.type === 'task'
        ? { status: check.checked ? 'done' : 'todo' }
        : { status: check.checked ? 'discussed' : 'open' };
      store.update(e.id, patch);
      renderItems();
    });
    li.appendChild(check);
  }

  const main = document.createElement('div');
  main.className = 'card-main';

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = displayTitle(e);
  main.appendChild(title);

  const bodyText = displayBody(e);
  if (bodyText) {
    const body = document.createElement('p');
    body.className = 'card-body';
    body.textContent = bodyText;
    main.appendChild(body);
  }

  main.appendChild(buildMeta(e));

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const del = iconBtn('🗑', 'Удалить');
  del.addEventListener('click', () => {
    store.remove(e.id);
    renderItems();
  });
  actions.appendChild(del);

  li.append(main, actions);
  return li;
}

/** Построить блок мета-бейджей под конкретный тип (работает и для черновика, и для сохранённого). */
function buildMeta(e) {
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.appendChild(badge(TYPE_LABEL[e.type] || e.type, `badge-${e.type}`));

  if (e.type === 'topic') {
    if (e.urgency) meta.appendChild(badge(`⚡ ${URGENCY_LABEL[e.urgency] || e.urgency}`, sevClass(e.urgency)));
    if (e.importance) meta.appendChild(badge(`★ ${IMPORTANCE_LABEL[e.importance] || e.importance}`, sevClass(e.importance)));
    if (e.person) meta.appendChild(metaSpan(`👤 ${e.person}`));
  } else if (e.type === 'task') {
    if (e.priority) meta.appendChild(badge(e.priority, sevClass(e.priority)));
    if (e.status && e.status !== 'done') meta.appendChild(metaSpan(`• ${TASK_STATUS_LABEL[e.status] || e.status}`));
  }

  if (e.deadline) {
    const overdue = !isClosed(e) && e.deadline < todayISO();
    const span = metaSpan(`⏱ ${e.deadline}`);
    span.classList.add('meta-due');
    if (overdue) span.classList.add('is-overdue');
    meta.appendChild(span);
  }

  (e.relatedPeople || []).forEach((p) => meta.appendChild(metaSpan(`👤 ${p}`)));
  (e.relatedProjects || []).forEach((p) => meta.appendChild(metaSpan(`📁 ${p}`)));
  (e.tags || []).forEach((t) => meta.appendChild(metaSpan(`#${t}`)));
  return meta;
}

// ===== Вкладка «Найти» =====
function bindFind() {
  $('#find-btn').addEventListener('click', onFind);
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFind();
  });
  $$('.suggestion').forEach((s) =>
    s.addEventListener('click', () => {
      $('#find-input').value = s.textContent;
      onFind();
    })
  );
}

async function onFind() {
  const question = $('#find-input').value.trim();
  if (!question) return;

  const btn = $('#find-btn');
  const status = $('#find-status');
  const answerEl = $('#find-answer');
  const resultsEl = $('#find-results');
  answerEl.hidden = true;
  resultsEl.innerHTML = '';
  setBusy(btn, status, 'Claude думает…');

  try {
    const { apiKey, model } = store.getSettings();
    const entities = store.getAll();
    const { answer, relevantIds } = await ask({ apiKey, model, question, entities, today: todayISO() });

    status.hidden = true;
    answerEl.textContent = answer;
    answerEl.hidden = false;

    relevantIds
      .map((id) => store.getById(id))
      .filter(Boolean)
      .forEach((e) => resultsEl.appendChild(renderItemCard(e)));
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    clearBusy(btn, 'Спросить');
  }
}

// ===== Настройки =====
function bindSettings() {
  const modal = $('#settings-modal');
  $('#settings-btn').addEventListener('click', () => {
    const s = store.getSettings();
    $('#api-key-input').value = s.apiKey || '';
    $('#model-input').value = s.model || '';
    modal.hidden = false;
  });
  $('#settings-close').addEventListener('click', () => (modal.hidden = true));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  $('#settings-save').addEventListener('click', () => {
    store.updateSettings({
      apiKey: $('#api-key-input').value.trim(),
      model: $('#model-input').value.trim() || 'claude-opus-4-8',
    });
    modal.hidden = true;
  });
  $('#export-btn').addEventListener('click', exportData);
}

function exportData() {
  const blob = new Blob([store.exportAll()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pm-assistant-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Хелперы DOM =====
function badge(text, cls) {
  const el = document.createElement('span');
  el.className = `badge ${cls}`;
  el.textContent = text;
  return el;
}

function metaSpan(text) {
  const el = document.createElement('span');
  el.className = 'meta-tag';
  el.textContent = text;
  return el;
}

function iconBtn(symbol, title) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = symbol;
  b.title = title;
  return b;
}

function setActiveChip(group, active) {
  $$(`${group} .chip`).forEach((c) => c.classList.toggle('is-active', c === active));
}

function setBusy(btn, statusEl, msg) {
  btn.disabled = true;
  showStatus(statusEl, msg);
}

function clearBusy(btn, label) {
  btn.disabled = false;
  btn.textContent = label;
}

function showStatus(el, msg, isError = false) {
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
}

init();
