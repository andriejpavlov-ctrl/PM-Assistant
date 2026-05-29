// app.js — контроллер. Единственный модуль, который трогает DOM.
// Вкладки: capture (захват) | board (доска из трёх колонок) | search (поиск).

import * as store from './storage.js';
import { processCapture, processQuery } from './agent.js';

const fileConfig = window.PM_CONFIG || {};
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const TYPE_LABEL = { topic: 'Тема', task: 'Задача', note: 'Заметка' };
const URGENCY_LABEL = { urgent: 'срочно', high: 'высокая', medium: 'средняя', low: 'низкая' };
const IMPORTANCE_LABEL = { critical: 'критично', high: 'высокая', medium: 'средняя', low: 'низкая' };
const STATUS_LABEL = { todo: 'к выполнению', in_progress: 'в работе', done: 'выполнено', blocked: 'заблокировано', open: 'открыта', discussed: 'обсуждено' };

const URGENCY_RANK = { urgent: 3, high: 2, medium: 1, low: 0 };
const IMPORTANCE_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const PRIORITY_RANK = { P1: 4, P2: 3, P3: 2, P4: 1 };
const VISUAL_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
// Для записей без явных urgency/importance выводим их из приоритета задачи.
const TASK_PRIO_URGENCY = { P1: 'urgent', P2: 'high', P3: 'medium', P4: 'low' };
const TASK_PRIO_IMPORTANCE = { P1: 'critical', P2: 'high', P3: 'medium', P4: 'low' };

// Уменьшительные → полная форма имени (детерминированная подстраховка к модели).
// Ключи без «ё» (при поиске «ё»→«е»); значения — с правильным написанием.
const DIMINUTIVES = {
  оля: 'Ольга', ольга: 'Ольга', лена: 'Елена', елена: 'Елена', катя: 'Екатерина', екатерина: 'Екатерина',
  наташа: 'Наталья', наталья: 'Наталья', наталия: 'Наталья', таня: 'Татьяна', татьяна: 'Татьяна',
  маша: 'Мария', мария: 'Мария', аня: 'Анна', анна: 'Анна', даша: 'Дарья', дарья: 'Дарья',
  настя: 'Анастасия', анастасия: 'Анастасия', юля: 'Юлия', юлия: 'Юлия', света: 'Светлана', светлана: 'Светлана',
  ксюша: 'Ксения', ксения: 'Ксения', ира: 'Ирина', ирина: 'Ирина', надя: 'Надежда', надежда: 'Надежда',
  люба: 'Любовь', любовь: 'Любовь', галя: 'Галина', галина: 'Галина', поля: 'Полина', полина: 'Полина',
  лиза: 'Елизавета', елизавета: 'Елизавета', соня: 'Софья', софья: 'Софья', варя: 'Варвара', варвара: 'Варвара',
  алена: 'Алёна', вера: 'Вера', марина: 'Марина', оксана: 'Оксана', кристина: 'Кристина', евгения: 'Евгения',
  дима: 'Дмитрий', дмитрий: 'Дмитрий', миша: 'Михаил', михаил: 'Михаил', ваня: 'Иван', иван: 'Иван',
  коля: 'Николай', николай: 'Николай', петя: 'Пётр', петр: 'Пётр', паша: 'Павел', павел: 'Павел',
  саша: 'Александр', саня: 'Александр', шура: 'Александр', александр: 'Александр', александра: 'Александра',
  сережа: 'Сергей', сергей: 'Сергей', рома: 'Роман', роман: 'Роман', костя: 'Константин', константин: 'Константин',
  леша: 'Алексей', алексей: 'Алексей', вова: 'Владимир', володя: 'Владимир', владимир: 'Владимир',
  вася: 'Василий', василий: 'Василий', боря: 'Борис', борис: 'Борис', гена: 'Геннадий', геннадий: 'Геннадий',
  женя: 'Евгений', евгений: 'Евгений', артем: 'Артём', тема: 'Артём', семен: 'Семён', сема: 'Семён',
  антон: 'Антон', кирилл: 'Кирилл', макс: 'Максим', максим: 'Максим', никита: 'Никита', даня: 'Даниил',
  даниил: 'Даниил', федя: 'Фёдор', федор: 'Фёдор', матвей: 'Матвей', денис: 'Денис', егор: 'Егор',
  стас: 'Станислав', станислав: 'Станислав', влад: 'Владислав', владислав: 'Владислав', гриша: 'Григорий',
  григорий: 'Григорий', тимур: 'Тимур', руслан: 'Руслан', глеб: 'Глеб', игорь: 'Игорь',
};

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

// ===== Нормализация и объединение имён людей =====
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function firstToken(name) {
  return (name || '').trim().split(/\s+/)[0] || '';
}
function isFullName(name) {
  return (name || '').trim().split(/\s+/).length >= 2;
}
/** Привести имя к канонической форме: развернуть уменьшительное, расставить заглавные. */
export function canonicalize(name) {
  const n = (name || '').trim().replace(/\s+/g, ' ');
  if (!n) return '';
  const parts = n.split(' ');
  const key = parts[0].toLowerCase().replace(/ё/g, 'е');
  parts[0] = DIMINUTIVES[key] || cap(parts[0]);
  for (let i = 1; i < parts.length; i++) parts[i] = cap(parts[i]);
  return parts.join(' ');
}
/** Полные имена (имя+фамилия) из всех записей, включая архив, в канонической форме. */
function knownFullNames() {
  const set = new Set();
  store.getEverything().forEach((e) =>
    peopleOf(e).forEach((p) => {
      const c = canonicalize(p);
      if (c && isFullName(c)) set.add(c);
    })
  );
  return [...set];
}
/** Имена людей из черновика (для topic — person, для task/note — relatedPeople). */
function draftPersonNames(d) {
  if (d.type === 'topic') return d.person ? [d.person] : [];
  return Array.isArray(d.relatedPeople) ? d.relatedPeople.slice() : [];
}
/** Заменить имя человека в черновике (по точному совпадению старого значения). */
function setDraftPersonName(d, original, full) {
  if (d.type === 'topic') {
    if (d.person === original) d.person = full;
  } else {
    d.relatedPeople = (d.relatedPeople || []).map((p) => (p === original ? full : p));
  }
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

  // Восстановить вкладку, открытую до перезагрузки.
  const saved = localStorage.getItem('pm_active_tab');
  if (saved && document.querySelector(`.tab[data-tab="${saved}"]`)) switchTab(saved);
}

// ===== Навигация =====
function bindNav() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
}
function switchTab(name) {
  localStorage.setItem('pm_active_tab', name); // запоминаем для восстановления после перезагрузки
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  if (name === 'board') {
    populateFilters();
    afterFilterChange();
  } else if (name === 'archive') {
    renderArchive();
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
    const result = await processCapture(raw, knownFullNames());
    captureDraft = result && result.type ? result : null;
    status.hidden = true;
    if (captureDraft) startPeopleResolution(captureDraft);
    else showStatus(status, 'Не удалось разобрать — попробуйте переформулировать.');
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обработать';
  }
}

/**
 * Нормализовать имена в черновике и, если для кого-то указано только имя без
 * фамилии и его нельзя однозначно сопоставить с известным коллегой, — спросить
 * фамилию у пользователя. Иначе сразу показать карточку результата.
 */
function startPeopleResolution(draft) {
  // 1. Канонизируем все имена на месте (разворачиваем уменьшительные).
  [...new Set(draftPersonNames(draft).filter(Boolean))].forEach((orig) => {
    const c = canonicalize(orig);
    if (c !== orig) setDraftPersonName(draft, orig, c);
  });

  // 2. Имена без фамилии пытаемся сопоставить с известными полными именами.
  const known = knownFullNames();
  const pending = [];
  [...new Set(draftPersonNames(draft).filter(Boolean))].forEach((name) => {
    if (isFullName(name)) return; // уже есть фамилия
    const matches = [...new Set(known.filter((f) => firstToken(f).toLowerCase() === name.toLowerCase()))];
    if (matches.length === 1) {
      setDraftPersonName(draft, name, matches[0]); // однозначно — объединяем
    } else {
      pending.push({ original: name, firstName: name, candidates: matches });
    }
  });

  if (!pending.length) renderCaptureResult();
  else renderSurnamePrompt(draft, pending);
}

/** Форма «уточните фамилию» для имён без фамилии. */
function renderSurnamePrompt(draft, pending) {
  const box = $('#capture-result');
  box.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(el('p', 'card-title', 'Уточните фамилию'));
  card.appendChild(el('p', 'card-body', 'Добавьте фамилию, чтобы один человек не превратился в разные записи. Можно пропустить.'));

  const form = document.createElement('div');
  form.className = 'edit-form';
  const knownSurnames = [...new Set(knownFullNames().map((f) => f.split(' ').slice(1).join(' ')).filter(Boolean))];

  const rows = pending.map((p) => {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.placeholder = 'Фамилия';
    inp.setAttribute('list', 'known-surnames');
    const wrap = field(`Имя: ${p.firstName}`, inp);
    // Быстрый выбор уже известного коллеги с таким же именем.
    if (p.candidates && p.candidates.length) {
      const picks = document.createElement('div');
      picks.className = 'find-suggestions';
      p.candidates.forEach((full) => {
        const b = el('button', 'chip', full);
        b.addEventListener('click', () => (inp.value = full.split(' ').slice(1).join(' ')));
        picks.appendChild(b);
      });
      wrap.appendChild(picks);
    }
    form.appendChild(wrap);
    return { p, inp };
  });

  const dl = document.createElement('datalist');
  dl.id = 'known-surnames';
  knownSurnames.forEach((s) => {
    const o = document.createElement('option');
    o.value = s;
    dl.appendChild(o);
  });
  form.appendChild(dl);

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const skip = el('button', 'btn btn-ghost btn-sm', 'Пропустить');
  skip.addEventListener('click', () => renderCaptureResult());
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  save.addEventListener('click', () => {
    rows.forEach(({ p, inp }) => {
      const sur = inp.value.trim();
      const full = sur ? canonicalize(`${p.firstName} ${sur}`) : p.firstName;
      setDraftPersonName(draft, p.original, full);
    });
    renderCaptureResult();
  });
  footer.append(skip, save);

  card.append(form, footer);
  box.appendChild(card);
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
  $('#filter-person').addEventListener('change', (e) => { filters.person = e.target.value; afterFilterChange(); });
  $('#filter-project').addEventListener('change', (e) => { filters.project = e.target.value; afterFilterChange(); });
  $('#filter-priority').addEventListener('change', (e) => { filters.priority = e.target.value; afterFilterChange(); });
  $('#filter-status').addEventListener('change', (e) => { filters.status = e.target.value; afterFilterChange(); });
  $('#filter-daterange').addEventListener('change', (e) => { filters.dateRange = e.target.value; afterFilterChange(); });
  $('#sort-select').addEventListener('change', (e) => { sortMode = e.target.value; renderBoard(); });
  $('#filter-reset').addEventListener('click', () => {
    filters.person = filters.project = filters.priority = '';
    filters.status = 'all';
    filters.dateRange = 'all';
    sortMode = 'default';
    $('#filter-person').value = $('#filter-project').value = $('#filter-priority').value = '';
    $('#filter-status').value = 'all';
    $('#filter-daterange').value = 'all';
    $('#sort-select').value = 'default';
    populateFilters();
    afterFilterChange();
  });
}

/** Есть ли активные фильтры (кроме «все»). */
function hasActiveFilters() {
  return !!(filters.person || filters.project || filters.priority ||
    (filters.status && filters.status !== 'all') ||
    (filters.dateRange && filters.dateRange !== 'all'));
}

/** Реакция на смену фильтра: подсветить активные пилюли, показать «Сбросить», перерисовать. */
function afterFilterChange() {
  const mark = (sel, active) => sel.classList.toggle('is-filtered', active);
  mark($('#filter-person'), !!filters.person);
  mark($('#filter-project'), !!filters.project);
  mark($('#filter-priority'), !!filters.priority);
  mark($('#filter-status'), filters.status && filters.status !== 'all');
  mark($('#filter-daterange'), filters.dateRange && filters.dateRange !== 'all');
  $('#filter-reset').hidden = !hasActiveFilters();
  renderBoard();
}

/** Наполнить дропдауны людей и проектов из данных, сохранив выбор и метку-плейсхолдер. */
function populateFilters() {
  const all = store.getAll();
  const people = [...new Set(all.flatMap(peopleOf).filter(Boolean))].sort();
  const projects = [...new Set(all.flatMap(projectsOf).filter(Boolean))].sort();
  fillSelect($('#filter-person'), 'Человек', people, filters.person);
  fillSelect($('#filter-project'), 'Проект', projects, filters.project);
}
function fillSelect(sel, placeholder, values, current) {
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = placeholder;
  sel.appendChild(ph);
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
  if (e.type === 'task' && e.status === 'in_progress') meta.appendChild(metaItem('progress', 'в работе'));
  peopleOf(e).forEach((p) => meta.appendChild(metaItem('person', p)));
  projectsOf(e).forEach((p) => meta.appendChild(metaItem('project', p)));
  if (e.type === 'topic' && e.importance) meta.appendChild(metaItem('star', IMPORTANCE_LABEL[e.importance] || e.importance));
  if (e.deadline) {
    const overdue = !isClosed(e) && e.deadline < todayISO();
    const span = metaItem('clock', e.deadline);
    span.classList.add('meta-due');
    if (overdue) span.classList.add('is-overdue');
    meta.appendChild(span);
  }
  (e.tags || []).forEach((t) => meta.appendChild(metaItem('tag', t)));
  return meta;
}

// id карточки, открытой в режиме инлайн-редактирования (на доске).
let editingId = null;

function buildCard(e) {
  if (editingId === e.id) return buildCardEditor(e);

  const li = document.createElement('li');
  li.className = 'card' + (isClosed(e) ? ' is-done' : '') + (e.type === 'task' && e.status === 'in_progress' ? ' is-progress' : '');
  li.appendChild(buildTop(e));
  li.appendChild(el('p', 'card-title', displayTitle(e)));
  const body = displayBody(e);
  if (body) li.appendChild(el('p', 'card-body', body));
  li.appendChild(buildMeta(e));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  if (e.type === 'task') {
    // Открытую задачу можно перевести «В работу»; закрытую — только вернуть.
    if (!isClosed(e)) {
      const inProg = e.status === 'in_progress';
      const progBtn = iconBtn('progress', inProg ? 'В работе' : 'В работу', inProg ? 'is-active' : '');
      progBtn.addEventListener('click', () => {
        store.update(e.id, { status: inProg ? 'todo' : 'in_progress' });
        renderBoard();
      });
      footer.appendChild(progBtn);
    }
    const doneBtn = iconBtn(isClosed(e) ? 'restore' : 'done', isClosed(e) ? 'Вернуть' : 'Выполнено');
    doneBtn.addEventListener('click', () => {
      store.update(e.id, { status: isClosed(e) ? 'todo' : 'done' });
      renderBoard();
    });
    footer.appendChild(doneBtn);
  } else if (e.type === 'topic') {
    const doneBtn = iconBtn(isClosed(e) ? 'restore' : 'done', isClosed(e) ? 'Вернуть' : 'Обсуждено');
    doneBtn.addEventListener('click', () => {
      store.update(e.id, { status: isClosed(e) ? 'open' : 'discussed' });
      renderBoard();
    });
    footer.appendChild(doneBtn);
  }
  const editBtn = iconBtn('edit', '');
  editBtn.title = 'Редактировать';
  editBtn.addEventListener('click', () => {
    editingId = e.id;
    renderBoard();
  });
  footer.appendChild(editBtn);
  const del = iconBtn('trash', '');
  del.title = 'В архив';
  del.addEventListener('click', () => {
    store.remove(e.id);
    renderBoard();
  });
  footer.appendChild(del);
  li.appendChild(footer);
  return li;
}

/** Инлайн-редактор карточки на доске. Правит все поля выбранной записи. */
function buildCardEditor(e) {
  const draft = { ...e, tags: [...(e.tags || [])], relatedPeople: [...(e.relatedPeople || [])], relatedProjects: [...(e.relatedProjects || [])] };
  const li = document.createElement('li');
  li.className = 'card is-editing';
  const form = document.createElement('div');
  form.className = 'edit-form';

  const input = (key, type = 'text') => {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.type = type;
    inp.value = draft[key] || '';
    inp.addEventListener('input', () => (draft[key] = inp.value));
    return inp;
  };
  const select = (key, options, labels) => {
    const sel = document.createElement('select');
    sel.className = 'select';
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = labels ? labels[opt] || opt : opt;
      if (draft[key] === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => (draft[key] = sel.value));
    return sel;
  };
  const listInput = (key) => {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.value = (draft[key] || []).join(', ');
    inp.addEventListener('input', () => (draft[key] = inp.value.split(',').map((s) => s.trim()).filter(Boolean)));
    return inp;
  };

  if (e.type === 'topic') {
    form.appendChild(field('Тема', input('topic')));
    form.appendChild(field('Человек', input('person')));
    form.appendChild(field('Срочность', select('urgency', store.ENUMS.topicUrgency, URGENCY_LABEL)));
    form.appendChild(field('Важность', select('importance', store.ENUMS.topicImportance, IMPORTANCE_LABEL)));
    form.appendChild(field('Статус', select('status', store.ENUMS.topicStatus, STATUS_LABEL)));
    form.appendChild(field('Дедлайн', input('deadline', 'date')));
    form.appendChild(field('Резюме', input('aiSummary')));
  } else if (e.type === 'task') {
    form.appendChild(field('Название', input('title')));
    form.appendChild(field('Что сделать', input('description')));
    form.appendChild(field('Образ результата', input('expectedResult')));
    form.appendChild(field('Приоритет', select('priority', store.ENUMS.taskPriority)));
    form.appendChild(field('Статус', select('status', store.ENUMS.taskStatus, STATUS_LABEL)));
    form.appendChild(field('Дедлайн', input('deadline', 'date')));
    form.appendChild(field('Люди (через запятую)', listInput('relatedPeople')));
    form.appendChild(field('Проекты (через запятую)', listInput('relatedProjects')));
  } else {
    form.appendChild(field('Заголовок', input('title')));
    form.appendChild(field('Содержание', input('content')));
    form.appendChild(field('Люди (через запятую)', listInput('relatedPeople')));
    form.appendChild(field('Проекты (через запятую)', listInput('relatedProjects')));
  }
  form.appendChild(field('Теги (через запятую)', listInput('tags')));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const cancel = el('button', 'btn btn-ghost btn-sm', 'Отмена');
  cancel.addEventListener('click', () => {
    editingId = null;
    renderBoard();
  });
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  save.addEventListener('click', () => {
    // Канонизируем имена при ручном редактировании тоже.
    if (draft.type === 'topic' && draft.person) draft.person = canonicalize(draft.person);
    if (Array.isArray(draft.relatedPeople)) draft.relatedPeople = draft.relatedPeople.map(canonicalize);
    store.update(e.id, draft);
    editingId = null;
    renderBoard();
  });
  footer.append(cancel, save);

  li.append(form, footer);
  return li;
}

// ===== Вкладка «Архив» =====
function renderArchive() {
  const list = $('#archive-list');
  const empty = $('#archive-empty');
  const items = store.getArchived().map(annotate);
  list.innerHTML = '';
  $('#count-archive').textContent = items.length;
  empty.hidden = items.length > 0;
  items.forEach((e) => list.appendChild(buildArchiveCard(e)));
}

function buildArchiveCard(e) {
  const li = document.createElement('li');
  li.className = 'card is-archived';
  li.appendChild(buildTop(e));
  li.appendChild(el('p', 'card-title', displayTitle(e)));
  const body = displayBody(e);
  if (body) li.appendChild(el('p', 'card-body', body));
  li.appendChild(buildMeta(e));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const restore = iconBtn('restore', 'Вернуть');
  restore.addEventListener('click', () => {
    store.unarchive(e.id);
    renderArchive();
  });
  const del = iconBtn('trash', 'Удалить навсегда');
  del.addEventListener('click', () => {
    if (confirm('Удалить запись навсегда? Это действие необратимо.')) {
      store.destroy(e.id);
      renderArchive();
    }
  });
  footer.append(restore, del);
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
    renderAnswer(answerEl, explanation, results.length);
    // Сохраняем порядок, выбранный AI, но добавляем метку приоритета.
    results.map(annotate).forEach((e) => resultsEl.appendChild(buildCard(e)));
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Найти';
  }
}

/** Карточка ответа AI: заголовок «Ответ ассистента», текст и счётчик находок. */
function renderAnswer(box, explanation, count) {
  box.innerHTML = '';
  const text = explanation || (count ? '' : 'Ничего не найдено по этому запросу.');
  if (!text && !count) { box.hidden = true; return; }

  const head = el('div', 'answer-head');
  head.append(el('span', 'answer-icon', '✦'), el('span', 'answer-label', 'Ответ ассистента'));
  if (count) head.appendChild(el('span', 'answer-count', `${count} ${plural(count, 'находка', 'находки', 'находок')}`));
  box.appendChild(head);

  if (text) box.appendChild(el('p', 'answer-text', text));
  box.hidden = false;
}

/** Русское склонение числительных: 1 находка / 2 находки / 5 находок. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
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

// Единый набор монохромных SVG-иконок (16×16, currentColor) для консистентности.
const ICONS = {
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  star: '<path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tag: '<path d="M3 11.5V5a2 2 0 0 1 2-2h6.5L21 12.5 12.5 21z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  progress: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/>',
};
/** Создать инлайновую SVG-иконку (наследует цвет/размер от родителя). */
function icon(name) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}
/** Текстовая мета-метка с ведущей иконкой (единый размер). */
function metaItem(name, text) {
  const span = el('span', 'meta-tag');
  span.appendChild(icon(name));
  span.appendChild(document.createTextNode(text));
  return span;
}
/** Кнопка с иконкой + подписью для подвала карточки. */
function iconBtn(name, label, cls = '') {
  const b = el('button', `btn btn-ghost btn-sm ${cls}`.trim());
  b.appendChild(icon(name));
  if (label) b.appendChild(document.createTextNode(label));
  return b;
}
function showStatus(elm, msg, isError = false) {
  elm.textContent = msg;
  elm.classList.toggle('is-error', isError);
  elm.hidden = false;
}

// Запускаем приложение только в браузере (в Node модуль импортируется для тестов).
if (typeof document !== 'undefined' && document.querySelector) init();
