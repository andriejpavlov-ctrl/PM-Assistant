// app.js — контроллер. Единственный модуль, который трогает DOM.
// Связывает UI ⟷ storage.js ⟷ agent.js.

import * as store from './storage.js';
import { parseCapture, ask } from './agent.js';

// config.js (необязательный) может задать window.PM_CONFIG = { apiKey, model }.
const fileConfig = window.PM_CONFIG || {};

const TYPE_LABEL = { task: 'Задача', note: 'Заметка', discussion: 'Обсудить' };
const PRIO_LABEL = { high: 'высокий', medium: 'средний', low: 'низкий' };

let draftItems = []; // черновики после разбора, ещё не сохранены
const filters = { type: 'all', status: 'active' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ===== Инициализация =====
function init() {
  // Применить сохранённые настройки (с фолбэком на config.js).
  const settings = store.getSettings();
  if (!settings.apiKey && fileConfig.apiKey) {
    store.updateSettings({ apiKey: fileConfig.apiKey });
  }
  if (fileConfig.model && settings.model === 'claude-opus-4-8') {
    store.updateSettings({ model: fileConfig.model });
  }
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
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
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
  const input = $('#capture-input');
  const raw = input.value.trim();
  if (!raw) return;

  const btn = $('#parse-btn');
  const status = $('#capture-status');
  setBusy(btn, status, 'Claude разбирает заметки…');

  try {
    const { apiKey, model } = store.getSettings();
    const items = await parseCapture({
      apiKey,
      model,
      rawText: raw,
      people: store.getPeople(),
      today: todayISO(),
    });
    draftItems = items;
    status.hidden = true;
    renderDrafts();
    if (!items.length) showStatus(status, 'Ничего не удалось извлечь — попробуй переформулировать.');
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
  if (!draftItems.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  draftItems.forEach((draft, idx) => list.appendChild(renderDraftCard(draft, idx)));
}

function renderDraftCard(draft, idx) {
  const li = document.createElement('li');
  li.className = 'card';

  const main = document.createElement('div');
  main.className = 'card-main';

  // Редактируемый заголовок.
  const title = document.createElement('input');
  title.className = 'text-input draft-edit';
  title.value = draft.title || '';
  title.addEventListener('input', () => (draftItems[idx].title = title.value));
  main.appendChild(title);

  // Мета: тип, приоритет, дедлайн, человек.
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.appendChild(badge(TYPE_LABEL[draft.type] || draft.type, `badge-${draft.type}`));
  if (draft.type === 'task') meta.appendChild(badge(PRIO_LABEL[draft.priority] || 'средний', `badge-prio-${draft.priority || 'medium'}`));
  if (draft.due) meta.appendChild(metaSpan(`⏱ ${draft.due}`));
  if (draft.person) meta.appendChild(metaSpan(`👤 ${draft.person}`));
  (draft.tags || []).forEach((t) => meta.appendChild(metaSpan(`#${t}`)));
  main.appendChild(meta);

  if (draft.body) {
    const body = document.createElement('p');
    body.className = 'card-body';
    body.textContent = draft.body;
    main.appendChild(body);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const del = iconBtn('✕', 'Убрать из черновиков');
  del.addEventListener('click', () => {
    draftItems.splice(idx, 1);
    renderDrafts();
  });
  actions.appendChild(del);

  li.append(main, actions);
  return li;
}

function onSaveAllDrafts() {
  draftItems.forEach((draft) => {
    const personId = draft.person ? store.ensurePerson(draft.person)?.id : null;
    store.addItem({
      type: draft.type,
      title: draft.title,
      body: draft.body || '',
      priority: draft.priority || 'medium',
      due: draft.due || null,
      personId,
      tags: draft.tags || [],
    });
  });
  draftItems = [];
  renderDrafts();
  $('#capture-input').value = '';
  showStatus($('#capture-status'), 'Сохранено ✓ — смотри на вкладке «Задачи».');
  renderItems();
}

// ===== Вкладка «Задачи» =====
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

function passesFilter(item) {
  if (filters.type !== 'all' && item.type !== filters.type) return false;
  if (filters.status === 'active' && (item.status === 'done' || item.status === 'archived')) return false;
  if (filters.status === 'done' && item.status !== 'done') return false;
  return true;
}

function renderItems() {
  const list = $('#items-list');
  const empty = $('#items-empty');
  const people = store.getPeople();
  const items = store.getItems().filter(passesFilter);

  list.innerHTML = '';
  empty.hidden = items.length > 0;
  items.forEach((item) => list.appendChild(renderItemCard(item, people)));
}

function renderItemCard(item, people) {
  const li = document.createElement('li');
  li.className = 'card' + (item.status === 'done' ? ' is-done' : '');

  // Чекбокс «готово» только для задач.
  if (item.type === 'task') {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = item.status === 'done';
    check.addEventListener('change', () => {
      store.updateItem(item.id, { status: check.checked ? 'done' : 'open' });
      renderItems();
    });
    li.appendChild(check);
  }

  const main = document.createElement('div');
  main.className = 'card-main';

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = item.title;
  main.appendChild(title);

  if (item.body) {
    const body = document.createElement('p');
    body.className = 'card-body';
    body.textContent = item.body;
    main.appendChild(body);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.appendChild(badge(TYPE_LABEL[item.type] || item.type, `badge-${item.type}`));
  if (item.type === 'task') meta.appendChild(badge(PRIO_LABEL[item.priority] || 'средний', `badge-prio-${item.priority}`));
  if (item.due) {
    const overdue = item.status !== 'done' && item.due < todayISO();
    const span = metaSpan(`⏱ ${item.due}`);
    span.classList.add('meta-due');
    if (overdue) span.classList.add('is-overdue');
    meta.appendChild(span);
  }
  if (item.personId) {
    const person = people.find((p) => p.id === item.personId);
    if (person) meta.appendChild(metaSpan(`👤 ${person.name}`));
  }
  (item.tags || []).forEach((t) => meta.appendChild(metaSpan(`#${t}`)));
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const del = iconBtn('🗑', 'Удалить');
  del.addEventListener('click', () => {
    store.deleteItem(item.id);
    renderItems();
  });
  actions.appendChild(del);

  li.append(main, actions);
  return li;
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
    const people = store.getPeople();
    // Обогащаем элементы именем человека для контекста.
    const items = store.getItems().map((it) => ({
      ...it,
      personName: people.find((p) => p.id === it.personId)?.name || null,
    }));

    const { answer, relevantIds } = await ask({ apiKey, model, question, items, today: todayISO() });

    status.hidden = true;
    answerEl.textContent = answer;
    answerEl.hidden = false;

    const relevant = relevantIds.map((id) => store.getItem(id)).filter(Boolean);
    relevant.forEach((item) => resultsEl.appendChild(renderItemCard(item, people)));
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
