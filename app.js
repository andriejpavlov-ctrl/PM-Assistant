// app.js — контроллер. Единственный модуль, который трогает DOM.
// Вкладки: capture (захват) | board (доска из трёх колонок) | search (поиск).

import * as store from './storage.js';
import { processCapture, processQuery } from './agent.js';

const fileConfig = window.PM_CONFIG || {};
const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

const TYPE_LABEL = { topic: 'Тема', task: 'Задача', note: 'Заметка' };
const URGENCY_LABEL = { urgent: 'срочно', high: 'высокая', medium: 'средняя', low: 'низкая' };
const IMPORTANCE_LABEL = { critical: 'критично', high: 'высокая', medium: 'средняя', low: 'низкая' };

const URGENCY_RANK = { urgent: 3, high: 2, medium: 1, low: 0 };
const IMPORTANCE_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const PRIORITY_RANK = { P1: 4, P2: 3, P3: 2, P4: 1 };

let captureDraft = null; // результат processCapture, ещё не сохранён
const filters = { person: '', project: '', priority: '', status: 'active' };
let sortMode = 'default';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Прокинуть ключ и модель из настроек в window.*, откуда их читает agent.js. */
function syncApiKey() {
  const s = store.getSettings();
  window.CLAUDE_API_KEY = s.apiKey || '';
  window.CLAUDE_MODEL = s.model || DEFAULT_MODEL;
}

// ===== Производные от типа =====
function isClosed(e) {
  return (e.type === 'task' && e.status === 'done') || (e.type === 'topic' && e.status === 'discussed');
}
function displayTitle(e) {
  return e.type === 'topic' ? e.topic || '(без темы)' : e.title || '(без названия)';
}
function displayBody(e) {
  if (e.type === 'topic') return e.aiSummary || '';
  if (e.type === 'task') return [e.description, e.expectedResult && `🎯 ${e.expectedResult}`].filter(Boolean).join('\n');
  return e.content || '';
}
function peopleOf(e) {
  return e.type === 'topic' ? (e.person ? [e.person] : []) : e.relatedPeople || [];
}
function projectsOf(e) {
  return e.relatedProjects || [];
}
function sevClass(level) {
  if (['urgent', 'critical', 'high', 'P1'].includes(level)) return 'badge-sev-high';
  if (['medium', 'P2'].includes(level)) return 'badge-sev-medium';
  return 'badge-sev-low';
}
function scoreEntity(e) {
  if (e.type === 'topic') return (URGENCY_RANK[e.urgency] || 0) + (IMPORTANCE_RANK[e.importance] || 0);
  if (e.type === 'task') return (PRIORITY_RANK[e.priority] || 0) * 2;
  return 0;
}

// ===== Инициализация =====
function init() {
  const settings = store.getSettings();
  if (!settings.apiKey && fileConfig.apiKey) store.updateSettings({ apiKey: fileConfig.apiKey });
  if (fileConfig.model && settings.model === DEFAULT_MODEL) store.updateSettings({ model: fileConfig.model });
  applyTheme(store.getSettings().theme);
  syncApiKey();

  bindNav();
  bindCapture();
  bindBoard();
  bindSearch();
  bindSettings();
  bindTheme();
}

// ===== Навигация =====
function bindNav() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
}
function switchTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  if (name === 'board') {
    populateFilters();
    renderBoard();
  }
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
  $('#capture-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onParse();
    }
  });
}

async function onParse() {
  const raw = $('#capture-input').value.trim();
  if (!raw) return;

  const btn = $('#parse-btn');
  const status = $('#capture-status');
  btn.disabled = true;
  showStatus(status, 'Claude обрабатывает…');

  try {
    const result = await processCapture(raw);
    captureDraft = result && result.type ? result : null;
    status.hidden = true;
    if (captureDraft) renderCaptureResult();
    else showStatus(status, 'Не удалось разобрать — попробуйте переформулировать.');
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обработать';
  }
}

function renderCaptureResult() {
  const box = $('#capture-result');
  box.innerHTML = '';
  if (!captureDraft) return;

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(buildTop(captureDraft));
  card.appendChild(el('p', 'card-title', displayTitle(captureDraft)));
  const body = displayBody(captureDraft);
  if (body) card.appendChild(el('p', 'card-body', body));
  card.appendChild(buildMeta(captureDraft));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const editBtn = el('button', 'btn btn-ghost btn-sm', 'Редактировать');
  editBtn.addEventListener('click', () => renderCaptureEdit());
  const saveBtn = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  saveBtn.addEventListener('click', saveCaptureDraft);
  footer.append(editBtn, saveBtn);
  card.appendChild(footer);

  box.appendChild(card);
}

function renderCaptureEdit() {
  const box = $('#capture-result');
  box.innerHTML = '';
  const d = captureDraft;

  const card = document.createElement('div');
  card.className = 'card';
  const form = document.createElement('div');
  form.className = 'edit-form';

  const titleLabel = d.type === 'topic' ? 'Тема' : 'Заголовок';
  form.appendChild(field(titleLabel, inputFor(d.type === 'topic' ? 'topic' : 'title')));

  if (d.type === 'topic') {
    form.appendChild(field('Человек', inputFor('person')));
    form.appendChild(field('Срочность', selectFor('urgency', store.ENUMS.topicUrgency, URGENCY_LABEL)));
    form.appendChild(field('Важность', selectFor('importance', store.ENUMS.topicImportance, IMPORTANCE_LABEL)));
    form.appendChild(field('Дедлайн', inputFor('deadline', 'date')));
  } else if (d.type === 'task') {
    form.appendChild(field('Что сделать', inputFor('description')));
    form.appendChild(field('Образ результата', inputFor('expectedResult')));
    form.appendChild(field('Приоритет', selectFor('priority', store.ENUMS.taskPriority)));
    form.appendChild(field('Дедлайн', inputFor('deadline', 'date')));
  } else {
    form.appendChild(field('Содержание', inputFor('content')));
  }
  form.appendChild(field('Теги (через запятую)', tagsInput()));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const cancel = el('button', 'btn btn-ghost btn-sm', 'Отмена');
  cancel.addEventListener('click', renderCaptureResult);
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  save.addEventListener('click', saveCaptureDraft);
  footer.append(cancel, save);

  card.append(form, footer);
  box.appendChild(card);

  // ---- helpers замыкаются на captureDraft ----
  function inputFor(key, type = 'text') {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.type = type;
    inp.value = d[key] || '';
    inp.addEventListener('input', () => (d[key] = inp.value));
    return inp;
  }
  function selectFor(key, options, labels) {
    const sel = document.createElement('select');
    sel.className = 'select';
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = labels ? labels[opt] || opt : opt;
      if (d[key] === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => (d[key] = sel.value));
    return sel;
  }
  function tagsInput() {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.value = (d.tags || []).join(', ');
    inp.addEventListener('input', () => (d.tags = inp.value.split(',').map((s) => s.trim()).filter(Boolean)));
    return inp;
  }
}

function saveCaptureDraft() {
  if (!captureDraft) return;
  store.createEntity(captureDraft);
  captureDraft = null;
  $('#capture-result').innerHTML = '';
  $('#capture-input').value = '';
  showStatus($('#capture-status'), 'Сохранено ✓ — смотрите на доске «Задачи и темы».');
}

// ===== Вкладка «Доска» =====
function bindBoard() {
  $('#filter-person').addEventListener('change', (e) => { filters.person = e.target.value; renderBoard(); });
  $('#filter-project').addEventListener('change', (e) => { filters.project = e.target.value; renderBoard(); });
  $('#filter-priority').addEventListener('change', (e) => { filters.priority = e.target.value; renderBoard(); });
  $('#filter-status').addEventListener('change', (e) => { filters.status = e.target.value; renderBoard(); });
  $$('#sort-toggles .chip').forEach((c) =>
    c.addEventListener('click', () => {
      sortMode = c.dataset.sort;
      $$('#sort-toggles .chip').forEach((x) => x.classList.toggle('is-active', x === c));
      renderBoard();
    })
  );
  $('#filter-reset').addEventListener('click', () => {
    filters.person = filters.project = filters.priority = '';
    filters.status = 'active';
    sortMode = 'default';
    $('#filter-person').value = $('#filter-project').value = $('#filter-priority').value = '';
    $('#filter-status').value = 'active';
    $$('#sort-toggles .chip').forEach((x) => x.classList.toggle('is-active', x.dataset.sort === 'default'));
    populateFilters();
    renderBoard();
  });
}

/** Наполнить выпадающие списки людей и проектов из данных, сохранив выбор. */
function populateFilters() {
  const all = store.getAll();
  const people = [...new Set(all.flatMap(peopleOf).filter(Boolean))].sort();
  const projects = [...new Set(all.flatMap(projectsOf).filter(Boolean))].sort();
  fillSelect($('#filter-person'), people, filters.person);
  fillSelect($('#filter-project'), projects, filters.project);
}
function fillSelect(sel, values, current) {
  sel.innerHTML = '<option value="">Все</option>';
  values.forEach((v) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  });
}

function passesFilter(e) {
  if (filters.status === 'active' && isClosed(e)) return false;
  if (filters.status === 'done' && !isClosed(e)) return false;
  if (filters.person && !peopleOf(e).includes(filters.person)) return false;
  if (filters.project && !projectsOf(e).includes(filters.project)) return false;
  if (filters.priority && e.priority !== filters.priority) return false;
  return true;
}

function sortEntities(list) {
  const arr = [...list];
  const byStr = (fn) => (a, b) => (fn(a) || '').localeCompare(fn(b) || '', 'ru');
  switch (sortMode) {
    case 'deadline':
      return arr.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    case 'priority':
      return arr.sort((a, b) => scoreEntity(b) - scoreEntity(a));
    case 'person':
      return arr.sort(byStr((e) => peopleOf(e)[0]));
    case 'project':
      return arr.sort(byStr((e) => projectsOf(e)[0]));
    default: // важность + срочность
      return arr.sort((a, b) => scoreEntity(b) - scoreEntity(a));
  }
}

function renderBoard() {
  const filtered = store.getAll().filter(passesFilter);
  const cols = {
    topic: $('#col-topics'),
    task: $('#col-tasks'),
    note: $('#col-notes'),
  };
  const counts = { topic: 0, task: 0, note: 0 };

  Object.values(cols).forEach((ul) => (ul.innerHTML = ''));
  ['topic', 'task', 'note'].forEach((type) => {
    const items = sortEntities(filtered.filter((e) => e.type === type));
    counts[type] = items.length;
    if (!items.length) {
      cols[type].appendChild(el('li', 'empty-col', 'Пусто'));
    } else {
      items.forEach((e) => cols[type].appendChild(buildCard(e)));
    }
  });

  $('#count-topics').textContent = counts.topic;
  $('#count-tasks').textContent = counts.task;
  $('#count-notes').textContent = counts.note;
}

// ===== Карточки =====
function buildTop(e) {
  const top = document.createElement('div');
  top.className = 'card-top';
  top.appendChild(badge(TYPE_LABEL[e.type] || e.type, `badge-${e.type}`));
  if (e.type === 'task' && e.priority) top.appendChild(badge(e.priority, `badge-${e.priority}`));
  if (e.type === 'topic' && e.urgency) top.appendChild(badge(URGENCY_LABEL[e.urgency] || e.urgency, sevClass(e.urgency)));
  return top;
}

function buildMeta(e) {
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  peopleOf(e).forEach((p) => meta.appendChild(metaSpan(`👤 ${p}`)));
  projectsOf(e).forEach((p) => meta.appendChild(metaSpan(`📁 ${p}`)));
  if (e.type === 'topic' && e.importance) meta.appendChild(metaSpan(`★ ${IMPORTANCE_LABEL[e.importance] || e.importance}`));
  if (e.deadline) {
    const overdue = !isClosed(e) && e.deadline < todayISO();
    const span = metaSpan(`⏱ ${e.deadline}`);
    span.classList.add('meta-due');
    if (overdue) span.classList.add('is-overdue');
    meta.appendChild(span);
  }
  (e.tags || []).forEach((t) => meta.appendChild(metaSpan(`#${t}`)));
  return meta;
}

function buildCard(e) {
  const li = document.createElement('li');
  li.className = 'card' + (isClosed(e) ? ' is-done' : '');
  li.appendChild(buildTop(e));
  li.appendChild(el('p', 'card-title', displayTitle(e)));
  const body = displayBody(e);
  if (body) li.appendChild(el('p', 'card-body', body));
  li.appendChild(buildMeta(e));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  if (e.type === 'task' || e.type === 'topic') {
    const doneBtn = el('button', 'btn btn-ghost btn-sm', isClosed(e) ? 'Вернуть' : 'Выполнено');
    doneBtn.addEventListener('click', () => {
      const closed = isClosed(e);
      const patch = e.type === 'task'
        ? { status: closed ? 'todo' : 'done' }
        : { status: closed ? 'open' : 'discussed' };
      store.update(e.id, patch);
      renderBoard();
    });
    footer.appendChild(doneBtn);
  }
  const del = el('button', 'btn btn-ghost btn-sm', '🗑');
  del.title = 'Удалить';
  del.addEventListener('click', () => {
    store.remove(e.id);
    renderBoard();
  });
  footer.appendChild(del);
  li.appendChild(footer);
  return li;
}

// ===== Вкладка «Найти» =====
function bindSearch() {
  $('#search-btn').addEventListener('click', onSearch);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearch();
  });
  $$('.suggestion').forEach((s) =>
    s.addEventListener('click', () => {
      $('#search-input').value = s.textContent;
      onSearch();
    })
  );
}

async function onSearch() {
  const question = $('#search-input').value.trim();
  if (!question) return;

  const btn = $('#search-btn');
  const status = $('#search-status');
  const answerEl = $('#search-answer');
  const resultsEl = $('#search-results');
  answerEl.hidden = true;
  resultsEl.innerHTML = '';
  btn.disabled = true;
  showStatus(status, 'Claude ищет…');

  try {
    const { explanation, results } = await processQuery(question, store.getAll());
    status.hidden = true;
    answerEl.textContent = explanation || (results.length ? '' : 'Ничего не найдено.');
    answerEl.hidden = !answerEl.textContent;
    results.forEach((e) => resultsEl.appendChild(buildCard(e)));
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Найти';
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
      model: $('#model-input').value.trim() || DEFAULT_MODEL,
    });
    syncApiKey();
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
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function field(labelText, inputNode) {
  const wrap = document.createElement('label');
  wrap.appendChild(el('span', '', labelText));
  wrap.appendChild(inputNode);
  return wrap;
}
function badge(text, cls) {
  return el('span', `badge ${cls}`, text);
}
function metaSpan(text) {
  return el('span', 'meta-tag', text);
}
function showStatus(elm, msg, isError = false) {
  elm.textContent = msg;
  elm.classList.toggle('is-error', isError);
  elm.hidden = false;
}

init();
