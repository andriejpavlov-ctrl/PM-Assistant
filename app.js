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
const VISUAL_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
// Для записей без явных urgency/importance выводим их из приоритета задачи.
const TASK_PRIO_URGENCY = { P1: 'urgent', P2: 'high', P3: 'medium', P4: 'low' };
const TASK_PRIO_IMPORTANCE = { P1: 'critical', P2: 'high', P3: 'medium', P4: 'low' };

let captureDraft = null; // результат processCapture, ещё не сохранён
const filters = { person: '', project: '', priority: '', status: 'all', dateRange: 'all' };
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

  const view = annotate(captureDraft); // для отображения метки приоритета
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(buildTop(view));
  card.appendChild(el('p', 'card-title', displayTitle(view)));
  const body = displayBody(view);
  if (body) card.appendChild(el('p', 'card-body', body));
  card.appendChild(buildMeta(view));

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
  $('#filter-daterange').addEventListener('change', (e) => { filters.dateRange = e.target.value; renderBoard(); });
  $$('#sort-toggles .chip').forEach((c) =>
    c.addEventListener('click', () => {
      sortMode = c.dataset.sort;
      $$('#sort-toggles .chip').forEach((x) => x.classList.toggle('is-active', x === c));
      renderBoard();
    })
  );
  $('#filter-reset').addEventListener('click', () => {
    filters.person = filters.project = filters.priority = '';
    filters.status = 'all';
    filters.dateRange = 'all';
    sortMode = 'default';
    $('#filter-person').value = $('#filter-project').value = $('#filter-priority').value = '';
    $('#filter-status').value = 'all';
    $('#filter-daterange').value = 'all';
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

// ===== Сортировка и фильтрация (матрица Эйзенхауэра) =====

// Эффективные срочность/важность: у заметок их нет, у задач при отсутствии
// выводим из приоритета P1-P4.
function effUrgency(it) {
  if (it.urgency) return it.urgency;
  if (it.type === 'task' && it.priority) return TASK_PRIO_URGENCY[it.priority] || 'medium';
  return it.type === 'note' ? 'low' : 'medium';
}
function effImportance(it) {
  if (it.importance) return it.importance;
  if (it.type === 'task' && it.priority) return TASK_PRIO_IMPORTANCE[it.priority] || 'medium';
  return it.type === 'note' ? 'low' : 'medium';
}

/** Матрица Эйзенхауэра: (ранг срочности, ранг важности) → визуальный приоритет. */
function classifyVisual(ur, ir) {
  if (ur === 3 && ir === 3) return 'P0'; // urgent + critical
  if (ur >= 2 && ir >= 2) return 'P1';   // высокая срочность + высокая важность
  if (ur === 1 || ir >= 2) return 'P2';  // средняя срочность ИЛИ высокая важность
  if (ur === 0 && ir === 1) return 'P3'; // низкая срочность + средняя важность
  if (ur === 0 && ir === 0) return 'P4'; // низкая + низкая
  return 'P2';                           // прочее (напр. срочно, но не важно)
}

/** Добавить к записи priorityScore (число для отладки) и visualPriority (P0-P4). */
function annotate(it) {
  const ur = URGENCY_RANK[effUrgency(it)] ?? 1;
  const ir = IMPORTANCE_RANK[effImportance(it)] ?? 1;
  const visualPriority = classifyVisual(ur, ir);
  // Чем выше — тем раньше: банд (P0..P4) доминирует, внутри банда — срочность, затем важность.
  const priorityScore = (4 - VISUAL_RANK[visualPriority]) * 1000 + ur * 100 + ir * 10;
  return { ...it, priorityScore, visualPriority };
}

// --- предикаты фильтров ---
function typeMatches(it, type) {
  if (!type) return true;
  return Array.isArray(type) ? type.includes(it.type) : it.type === type;
}
function statusMatches(it, status) {
  if (!status || status === 'all') return true;
  if (status === 'done') return isClosed(it);
  if (status === 'in_progress') return it.type === 'task' && it.status === 'in_progress';
  if (status === 'open') {
    if (it.type === 'task') return it.status === 'todo';
    if (it.type === 'topic') return it.status === 'open';
    return true; // заметки считаем открытыми
  }
  return true;
}
/** Совпадение строки: точное вхождение в любую сторону (простой fuzzy). */
function fuzzyIncludes(hay, needle) {
  const h = (hay || '').toLowerCase();
  const n = needle.toLowerCase();
  return h.includes(n) || n.includes(h);
}
function personMatches(it, q) {
  if (!q) return true;
  return peopleOf(it).some((p) => fuzzyIncludes(p, q.trim()));
}
function projectMatches(it, q) {
  if (!q) return true;
  return [...projectsOf(it), ...(it.tags || [])].some((p) => fuzzyIncludes(p, q.trim()));
}
function priorityMatches(it, p) {
  return !p || it.priority === p;
}
function dateMatches(it, range) {
  if (!range || range === 'all') return true;
  if (!it.deadline) return false;
  const today = todayISO();
  if (range === 'overdue') return !isClosed(it) && it.deadline < today;
  if (range === 'today') return it.deadline === today;
  if (range === 'this_week') return it.deadline >= today && it.deadline <= endOfWeekISO();
  if (range === 'this_month') return it.deadline >= today && it.deadline <= endOfMonthISO();
  return true;
}
function endOfWeekISO() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // Пн=0 … Вс=6
  d.setDate(d.getDate() + (6 - dow));
  return d.toISOString().slice(0, 10);
}
function endOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

/** Сравнение по дедлайну: просроченные первыми, затем по ближайшей дате; без срока — в конец. */
function cmpDeadline(a, b) {
  const key = (it) => {
    if (!it.deadline) return ['2', '9999-99-99'];
    const overdue = !isClosed(it) && it.deadline < todayISO();
    return [overdue ? '0' : '1', it.deadline];
  };
  const [ba, da] = key(a);
  const [bb, db] = key(b);
  return ba.localeCompare(bb) || da.localeCompare(db);
}

/**
 * Отфильтровать и отсортировать записи.
 * @param {Array}  items   исходные записи
 * @param {string} sortBy  'default'|'priority'|'deadline'|'person'|'project'
 * @param {object} filters { person, project, status, type, dateRange, priority }
 * @returns {Array} новые объекты с добавленными priorityScore (число) и visualPriority (P0-P4)
 */
export function sortAndFilter(items, sortBy = 'default', filters = {}) {
  const filtered = (items || []).filter(
    (it) =>
      typeMatches(it, filters.type) &&
      statusMatches(it, filters.status) &&
      personMatches(it, filters.person) &&
      projectMatches(it, filters.project) &&
      priorityMatches(it, filters.priority) &&
      dateMatches(it, filters.dateRange)
  );

  const annotated = filtered.map(annotate);
  const byStr = (fn) => (a, b) => (fn(a) || '').localeCompare(fn(b) || '', 'ru');

  switch (sortBy) {
    case 'deadline':
      annotated.sort(cmpDeadline);
      break;
    case 'person':
      annotated.sort(byStr((e) => peopleOf(e)[0]));
      break;
    case 'project':
      annotated.sort(byStr((e) => projectsOf(e)[0]));
      break;
    case 'priority':
    case 'default':
    default:
      // По важности + срочности: выше priorityScore — раньше, при равенстве — ближе дедлайн.
      annotated.sort((a, b) => b.priorityScore - a.priorityScore || cmpDeadline(a, b));
  }
  return annotated;
}

function renderBoard() {
  const annotated = sortAndFilter(store.getAll(), sortMode, {
    person: filters.person,
    project: filters.project,
    priority: filters.priority,
    status: filters.status,
    dateRange: filters.dateRange,
  });
  const cols = {
    topic: $('#col-topics'),
    task: $('#col-tasks'),
    note: $('#col-notes'),
  };
  const counts = { topic: 0, task: 0, note: 0 };

  Object.values(cols).forEach((ul) => (ul.innerHTML = ''));
  ['topic', 'task', 'note'].forEach((type) => {
    const items = annotated.filter((e) => e.type === type);
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
  if (e.visualPriority) top.appendChild(badge(e.visualPriority, `badge-${e.visualPriority}`));
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
    // Сохраняем порядок, выбранный AI, но добавляем метку приоритета.
    results.map(annotate).forEach((e) => resultsEl.appendChild(buildCard(e)));
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

// Запускаем приложение только в браузере (в Node модуль импортируется для тестов).
if (typeof document !== 'undefined' && document.querySelector) init();
