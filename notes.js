// notes.js — раздел «Заметки»: простой блокнот с форматированием текста
// и синхронизацией через Supabase. Самодостаточный модуль — НЕ зависит от
// app.js и не меняет его данные. Заметки хранятся отдельно:
//   • localStorage  → ключ pm_notes_v1: { notes: [...] }
//   • Supabase      → та же таблица pm_state, но отдельная строка
//                     id = "<workspace>__notes", data = { notes: [...] }.
// Конфиг Supabase берём из общих настроек приложения (storage.js getSettings).

import { getSettings } from './storage.js';

const LS_KEY = 'pm_notes_v1';
const TABLE = 'pm_state';

/** @typedef {{id:string, body:string, createdAt:string, updatedAt:string}} Note */
let notes = /** @type {Note[]} */ ([]);
let currentId = null;
let query = '';
const el = {};
let saveTimer = null;
let pushTimer = null;
let pendingPush = false;
let suppressInput = false; // не реагировать на input при программном заполнении

// ===================== Хранилище (локально) =====================
function genId() {
  const r = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return 'note_' + r.slice(0, 10);
}
function nowISO() { return new Date().toISOString(); }

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const p = raw ? JSON.parse(raw) : null;
    notes = p && Array.isArray(p.notes) ? p.notes : [];
  } catch { notes = []; }
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ notes })); } catch {}
}
function sorted() {
  return [...notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ===================== Синхронизация (Supabase) =====================
function cloudCfg() {
  const s = getSettings();
  const url = (s.supabaseUrl || '').replace(/\/+$/, '');
  const key = s.supabaseKey || '';
  const ws = (s.workspaceId || '').trim() || 'default';
  return { url, key, rowId: ws + '__notes' };
}
function cloudReady(c) { return !!(c.url && c.key); }
function cloudHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function pullCloud(opts = {}) {
  const c = cloudCfg();
  if (!cloudReady(c)) return;
  if (opts.auto && pendingPush) return; // не перетирать несохранённые правки
  try {
    if (!opts.auto) setStatus('Загрузка из облака…');
    const url = `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(c.rowId)}&select=data,updated_at`;
    const res = await fetch(url, { headers: cloudHeaders(c.key) });
    if (!res.ok) throw new Error('Supabase ' + res.status);
    const rows = await res.json();
    if (rows && rows.length) {
      const remote = Array.isArray(rows[0].data?.notes) ? rows[0].data.notes : [];
      notes = remote;
      saveLocal();
      if (currentId && !notes.find((n) => n.id === currentId)) currentId = null;
      renderList();
      if (currentId) openNote(currentId, { keepFocus: true });
      else selectFirstOrBlank();
      setStatus('Синхронизировано ✓');
    } else {
      await pushCloudNow(); // в облаке пусто — зальём локальные
    }
  } catch (e) {
    setStatus('Ошибка синхронизации', true);
  }
}
function schedulePush() {
  const c = cloudCfg();
  if (!cloudReady(c)) return;
  pendingPush = true;
  setStatus('Сохранение в облако…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushCloudNow, 800);
}
async function pushCloudNow() {
  const c = cloudCfg();
  if (!cloudReady(c)) return;
  try {
    const body = [{ id: c.rowId, data: { notes }, updated_at: nowISO() }];
    const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { ...cloudHeaders(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Supabase ' + res.status);
    pendingPush = false;
    setStatus('Синхронизировано ✓');
  } catch (e) {
    setStatus('Ошибка синхронизации', true);
  }
}

// Любое локальное изменение: сохранить и (если настроено) запланировать пуш.
function commit() {
  saveLocal();
  schedulePush();
}

// ===================== Заголовок/превью из тела =====================
function plainText(html) {
  // Вставляем переносы строк на границах блоков, чтобы заголовок (первая строка)
  // и превью считались корректно — textContent сам по себе их не добавляет.
  const s = (html || '')
    .replace(/<\/(div|p|h1|h2|h3|li|blockquote|ul|ol|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const d = document.createElement('div');
  d.innerHTML = s;
  return (d.textContent || '').replace(/ /g, ' ');
}
function titleOf(note) {
  const t = plainText(note.body).trim().split('\n').map((s) => s.trim()).find(Boolean);
  return t || 'Без названия';
}
function snippetOf(note) {
  const lines = plainText(note.body).split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.slice(1).join(' ') || (lines.length ? '' : 'Пустая заметка');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ===================== Рендер списка =====================
function renderList() {
  const list = el.list;
  if (!list) return;
  const q = query.trim().toLowerCase();
  const items = sorted().filter((n) => {
    if (!q) return true;
    return plainText(n.body).toLowerCase().includes(q);
  });
  list.innerHTML = '';
  items.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'note-item' + (n.id === currentId ? ' is-active' : '');
    li.dataset.id = n.id;
    const h = document.createElement('div');
    h.className = 'note-item-title';
    h.textContent = titleOf(n);
    const meta = document.createElement('div');
    meta.className = 'note-item-meta';
    const date = document.createElement('span');
    date.className = 'note-item-date';
    date.textContent = fmtDate(n.updatedAt);
    const snip = document.createElement('span');
    snip.className = 'note-item-snippet';
    snip.textContent = snippetOf(n);
    meta.append(date, snip);
    li.append(h, meta);
    li.addEventListener('click', () => openNote(n.id));
    list.appendChild(li);
  });
  el.empty.hidden = items.length > 0;
  el.empty.textContent = notes.length ? 'Ничего не найдено.' : 'Заметок пока нет. Создайте первую →';
}

// ===================== Открытие/создание/удаление =====================
function selectFirstOrBlank() {
  const first = sorted()[0];
  if (first) openNote(first.id, { keepFocus: true });
  else clearEditor();
}
function clearEditor() {
  currentId = null;
  suppressInput = true;
  el.editor.innerHTML = '';
  suppressInput = false;
  el.editor.setAttribute('data-empty', 'true');
  el.meta.textContent = '';
  el.app.classList.remove('is-editing');
  setToolbarEnabled(false);
}
function openNote(id, opts = {}) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  currentId = id;
  suppressInput = true;
  el.editor.innerHTML = note.body || '';
  suppressInput = false;
  el.editor.removeAttribute('data-empty');
  el.meta.textContent = 'Изменено: ' + fmtDate(note.updatedAt);
  el.app.classList.add('is-editing');
  setToolbarEnabled(true);
  renderList();
  if (!opts.keepFocus) el.editor.focus();
}
function newNote() {
  const note = { id: genId(), body: '', createdAt: nowISO(), updatedAt: nowISO() };
  notes.unshift(note);
  commit();
  openNote(note.id);
  el.editor.focus();
}
function deleteCurrent() {
  if (!currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  if (!confirm(`Удалить заметку «${titleOf(note)}»? Это действие нельзя отменить.`)) return;
  notes = notes.filter((n) => n.id !== currentId);
  currentId = null;
  commit();
  renderList();
  selectFirstOrBlank();
}

// Автосохранение тела при вводе.
function onEditorInput() {
  if (suppressInput || !currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  note.body = el.editor.innerHTML;
  note.updatedAt = nowISO();
  el.editor.toggleAttribute('data-empty', !el.editor.textContent.trim());
  el.meta.textContent = 'Изменено: ' + fmtDate(note.updatedAt);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { commit(); renderList(); }, 400);
}

// ===================== Форматирование =====================
function setToolbarEnabled(on) {
  el.app.querySelectorAll('button[data-cmd], #note-export, #note-delete')
    .forEach((b) => { b.disabled = !on; });
}
function exec(cmd, value = null) {
  el.editor.focus();
  try { document.execCommand(cmd, false, value); } catch {}
  onEditorInput();
}
function applyCommand(cmd) {
  switch (cmd) {
    case 'bold': return exec('bold');
    case 'italic': return exec('italic');
    case 'strike': return exec('strikeThrough');
    case 'h2': return toggleBlock('H2', 'formatBlock', '<h2>');
    case 'ul': return exec('insertUnorderedList');
    case 'ol': return exec('insertOrderedList');
    case 'quote': return toggleBlock('BLOCKQUOTE', 'formatBlock', '<blockquote>');
    case 'code': return wrapInline('code');
    case 'check': return insertChecklistItem();
    case 'clear': el.editor.focus(); exec('removeFormat'); return exec('formatBlock', '<div>');
    default: return;
  }
}
function toggleBlock(tag, cmd, value) {
  // Повторное нажатие на том же блоке — снять формат (вернуть в обычный абзац).
  const cur = currentBlockTag();
  exec(cmd, cur === tag ? '<div>' : value);
}
function currentBlockTag() {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return '';
  let node = sel.anchorNode;
  while (node && node !== el.editor) {
    if (node.nodeType === 1 && /^(H1|H2|H3|BLOCKQUOTE|PRE|LI)$/.test(node.tagName)) return node.tagName;
    node = node.parentNode;
  }
  return '';
}
function wrapInline(tag) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { el.editor.focus(); return; }
  const range = sel.getRangeAt(0);
  const wrap = document.createElement(tag);
  try {
    wrap.appendChild(range.extractContents());
    range.insertNode(wrap);
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(wrap);
    sel.addRange(r);
  } catch {}
  onEditorInput();
}
function insertChecklistItem() {
  el.editor.focus();
  const li = document.createElement('div');
  li.className = 'note-todo';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.contentEditable = 'false';
  const span = document.createElement('span');
  span.className = 'note-todo-text';
  span.appendChild(document.createTextNode('')); // пустой узел — место для курсора
  li.append(cb, span);
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(li);
    // курсор внутрь span
    const r = document.createRange();
    r.selectNodeContents(span);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    el.editor.appendChild(li);
  }
  onEditorInput();
}
// Делегированный клик по чекбоксам — фиксируем состояние в HTML (для сохранения).
function onEditorClick(e) {
  const cb = e.target;
  if (cb && cb.tagName === 'INPUT' && cb.type === 'checkbox') {
    if (cb.checked) cb.setAttribute('checked', ''); else cb.removeAttribute('checked');
    cb.closest('.note-todo')?.classList.toggle('done', cb.checked);
    onEditorInput();
  }
}

// Вставка как простой текст — чтобы не тащить мусорный HTML из буфера.
function onPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

// ===================== Экспорт в Markdown =====================
function htmlToMarkdown(root) {
  const lines = [];
  function inline(node) {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      const inner = inline(n);
      if (tag === 'B' || tag === 'STRONG') out += `**${inner}**`;
      else if (tag === 'I' || tag === 'EM') out += `*${inner}*`;
      else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') out += `~~${inner}~~`;
      else if (tag === 'CODE') out += '`' + inner + '`';
      else if (tag === 'A') out += `[${inner}](${n.getAttribute('href') || ''})`;
      else if (tag === 'BR') out += '\n';
      else out += inner;
    });
    return out;
  }
  function block(node) {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { if (n.textContent.trim()) lines.push(n.textContent.trim()); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'H1') lines.push('# ' + inline(n));
      else if (tag === 'H2') lines.push('## ' + inline(n));
      else if (tag === 'H3') lines.push('### ' + inline(n));
      else if (tag === 'BLOCKQUOTE') lines.push('> ' + inline(n).replace(/\n/g, '\n> '));
      else if (tag === 'PRE') lines.push('```\n' + n.textContent + '\n```');
      else if (tag === 'UL' || tag === 'OL') {
        let i = 1;
        n.querySelectorAll(':scope > li').forEach((li) => {
          lines.push((tag === 'OL' ? `${i++}. ` : '- ') + inline(li));
        });
      } else if (n.classList.contains('note-todo')) {
        const done = n.querySelector('input[type=checkbox]')?.checked;
        const txt = (n.querySelector('.note-todo-text')?.textContent || '').trim();
        lines.push(`- [${done ? 'x' : ' '}] ${txt}`);
      } else if (tag === 'DIV' || tag === 'P') {
        const t = inline(n).trim();
        lines.push(t); // пустые DIV → пустая строка (абзац)
      } else {
        lines.push(inline(n));
      }
    });
  }
  block(root);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function exportCurrent() {
  if (!currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  const md = htmlToMarkdown(el.editor);
  const blob = new Blob([md + '\n'], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  const safe = titleOf(note).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'note';
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ===================== Статус =====================
let statusTimer = null;
function setStatus(msg, isError = false) {
  if (!el.status) return;
  el.status.textContent = msg || '';
  el.status.classList.toggle('is-error', isError);
  clearTimeout(statusTimer);
  if (msg && !isError) statusTimer = setTimeout(() => { el.status.textContent = ''; }, 2500);
}

// ===================== Разметка раздела =====================
const TOOLBAR = [
  ['bold', 'Ж', 'Жирный (Ctrl+B)', 'b'],
  ['italic', 'К', 'Курсив (Ctrl+I)', 'i'],
  ['strike', 'З', 'Зачёркнутый', 's'],
  ['h2', 'Заголовок', 'Заголовок', 'h'],
  ['ul', '• Список', 'Маркированный список', 'u'],
  ['ol', '1. Список', 'Нумерованный список', 'o'],
  ['check', '☑ Чек-лист', 'Пункт чек-листа', 'c'],
  ['quote', '❝ Цитата', 'Цитата', 'q'],
  ['code', '‹/›', 'Моноширинный код', 'k'],
  ['clear', '⌫ Формат', 'Убрать форматирование', 'x'],
];

function buildUI(root) {
  root.innerHTML = `
    <div class="notes-app">
      <aside class="notes-pane-list">
        <div class="notes-list-head">
          <button id="note-new" class="btn btn-primary btn-sm" type="button">+ Новая</button>
          <input id="note-search" class="notes-search" type="text" placeholder="Поиск по заметкам…" />
        </div>
        <ul id="notes-list" class="notes-list"></ul>
        <p id="notes-empty" class="notes-empty" hidden></p>
        <span id="notes-status" class="notes-status" aria-live="polite"></span>
      </aside>
      <section class="notes-pane-editor">
        <div id="notes-toolbar" class="notes-toolbar">
          <button id="notes-back" class="notes-back btn btn-ghost btn-sm" type="button" title="К списку">‹</button>
          ${TOOLBAR.map(([cmd, label, title]) =>
            `<button data-cmd="${cmd}" class="fmt-btn fmt-${cmd}" type="button" title="${title}">${label}</button>`
          ).join('')}
        </div>
        <div id="note-editor" class="note-editor" contenteditable="true"
             data-placeholder="Начните писать…" data-empty="true" spellcheck="true"></div>
        <div class="notes-editor-foot">
          <span id="note-meta" class="note-meta"></span>
          <span class="notes-foot-actions">
            <button id="note-export" class="btn btn-ghost btn-sm" type="button" title="Скачать как Markdown">Экспорт .md</button>
            <button id="note-delete" class="btn btn-ghost btn-sm btn-danger" type="button">Удалить</button>
          </span>
        </div>
      </section>
    </div>`;

  el.app = root.querySelector('.notes-app');
  el.list = root.querySelector('#notes-list');
  el.empty = root.querySelector('#notes-empty');
  el.status = root.querySelector('#notes-status');
  el.toolbar = root.querySelector('#notes-toolbar');
  el.editor = root.querySelector('#note-editor');
  el.meta = root.querySelector('#note-meta');

  root.querySelector('#note-new').addEventListener('click', newNote);
  root.querySelector('#note-delete').addEventListener('click', deleteCurrent);
  root.querySelector('#note-export').addEventListener('click', exportCurrent);
  root.querySelector('#notes-back').addEventListener('click', () => el.app.classList.remove('is-editing'));
  root.querySelector('#note-search').addEventListener('input', (e) => { query = e.target.value; renderList(); });

  // Кнопки форматирования (mousedown — чтобы не терять выделение в редакторе).
  el.toolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); applyCommand(btn.dataset.cmd); });
  });

  el.editor.addEventListener('input', onEditorInput);
  el.editor.addEventListener('click', onEditorClick);
  el.editor.addEventListener('paste', onPaste);
  el.editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i') { /* нативный execCommand отработает, синхронизируем */ setTimeout(onEditorInput, 0); }
    }
  });
}

// ===================== Инициализация =====================
function init() {
  const root = document.getElementById('view-notes');
  if (!root) return;
  buildUI(root);
  loadLocal();
  renderList();
  selectFirstOrBlank();

  // Облако: тянем при открытии вкладки «Заметки» и при возврате на вкладку браузера.
  const notesTab = document.querySelector('.tab[data-tab="notes"]');
  if (notesTab) notesTab.addEventListener('click', () => pullCloud());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullCloud({ auto: true }); });
  // Первичная подтяжка, если синхронизация уже настроена.
  pullCloud({ auto: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
