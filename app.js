// app.js — контроллер. Единственный модуль, который трогает DOM.
// Вкладки: capture (Главная: захват + поиск) | board (Карточки) | archive (Архив).
// Единая карточка: title, description, people[], projects[], priority, deadline, tags.

import * as store from './storage.js';
import { processCapture, processQuery, findSimilarCard, mergeCards, generateMeme } from './agent.js';
import * as sync from './sync.js';

const fileConfig = window.PM_CONFIG || {};
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const PRIORITY_RANK = { P1: 3, P2: 2, P3: 1, '': 0 };
const PRIORITY_NAME = { P1: 'Высокий', P2: 'Средний', P3: 'Низкий' };
const PRIORITY_LABEL = { P1: 'P1 • Высокий', P2: 'P2 • Средний', P3: 'P3 • Низкий', '': 'Без приоритета' };

// Уменьшительные → полная форма имени (детерминированная подстраховка к модели).
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

let captureDraft = null; // карточка-черновик после processCapture, ещё не сохранена
const filters = { person: '', project: '', priority: '', dateRange: 'all', created: 'all' };
let sortMode = 'default';

// Дата/время создания в формате DD-MM-YYYY HH:MM (локальное время).
function formatCreated(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Срок (ISO YYYY-MM-DD) → DD-MM-YYYY. */
function formatDeadline(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
}

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

// ===== Облачная синхронизация (Supabase) =====
function syncCfg() {
  const s = store.getSettings();
  return { url: s.supabaseUrl || '', key: s.supabaseKey || '', workspace: s.workspaceId || '' };
}
let pushTimer = null;
let pendingPush = false;

function setSyncStatus(msg, isError = false) {
  const elm = document.getElementById('sync-status');
  if (!elm) return;
  elm.textContent = msg || '';
  elm.classList.toggle('is-error', isError);
  elm.hidden = !msg;
}

/** Дебаунс-пуш локальных изменений в облако. */
function schedulePush() {
  if (!sync.isConfigured(syncCfg())) return;
  pendingPush = true;
  setSyncStatus('Сохранение в облако…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, 700);
}
async function doPush() {
  if (!sync.isConfigured(syncCfg())) return;
  try {
    await sync.push(syncCfg(), store.getEverything());
    pendingPush = false;
    setSyncStatus('Синхронизировано ✓');
  } catch (e) {
    setSyncStatus('Ошибка синхронизации: ' + e.message, true);
  }
}
/** Перерисовать текущую вкладку после применения удалённых данных. */
function rerenderActiveView() {
  const active = document.querySelector('.tab[aria-selected="true"]');
  const name = active ? active.dataset.tab : 'capture';
  if (name === 'board') { populateFilters(); afterFilterChange(); }
  else if (name === 'archive') renderArchive();
}
/**
 * Подтянуть карточки из облака. opts.auto — фоновый вызов (не трогаем,
 * если есть несохранённые локальные правки). Если в облаке пусто — заливаем
 * текущие локальные карточки.
 */
async function doPull(opts = {}) {
  if (!sync.isConfigured(syncCfg())) return;
  if (opts.auto && pendingPush) return;
  try {
    if (!opts.auto) setSyncStatus('Загрузка из облака…');
    const remote = await sync.pull(syncCfg());
    if (remote) {
      store.replaceCards(remote.cards);
      rerenderActiveView();
      setSyncStatus('Синхронизировано ✓');
    } else {
      await doPush();
    }
  } catch (e) {
    setSyncStatus('Ошибка синхронизации: ' + e.message, true);
  }
}

// ===== Нормализация и объединение имён людей =====
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function firstToken(name) { return (name || '').trim().split(/\s+/)[0] || ''; }
function lastToken(name) { const p = (name || '').trim().split(/\s+/); return p.slice(1).join(' '); }
function isFullName(name) { return (name || '').trim().split(/\s+/).length >= 2; }
function normKey(s) { return (s || '').toLowerCase().replace(/ё/g, 'е'); }

// Множество известных имён (ключи словаря + их полные формы) для распознавания
// «имя vs фамилия» в одиночном токене.
const KNOWN_FIRST_NAMES = new Set([
  ...Object.keys(DIMINUTIVES).map(normKey),
  ...Object.values(DIMINUTIVES).map(normKey),
]);
// Характерные окончания русских фамилий (проверяется ПОСЛЕ словаря имён).
const SURNAME_RE = /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ской|енко|енков|чук|юк|ук|швили|дзе|ян|оглы|их|ых|ко)$/i;

/** Классифицировать одиночный токен: 'name' (нужна фамилия) или 'surname' (нужно имя). */
function classifyToken(token) {
  const k = normKey(token);
  if (KNOWN_FIRST_NAMES.has(k)) return 'name';   // известное имя
  if (SURNAME_RE.test(token)) return 'surname';  // похоже на фамилию
  return 'name';                                 // по умолчанию — имя
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
/** Названия проектов из всех карточек, включая архив (дедуп без учёта регистра). */
function knownProjects() {
  const seen = new Set();
  const list = [];
  store.getEverything().forEach((c) =>
    (c.projects || []).forEach((p) => {
      const name = String(p || '').trim();
      const key = normKey(name);
      if (name && !seen.has(key)) { seen.add(key); list.push(name); }
    })
  );
  return list;
}
/** Полные имена (имя+фамилия) из всех карточек, включая архив, в канонической форме. */
function knownFullNames() {
  const set = new Set();
  store.getEverything().forEach((c) =>
    (c.people || []).forEach((p) => {
      const k = canonicalize(p);
      if (k && isFullName(k)) set.add(k);
    })
  );
  return [...set];
}

// ===== Инициализация =====
function init() {
  const settings = store.getSettings();
  if (!settings.apiKey && fileConfig.apiKey) store.updateSettings({ apiKey: fileConfig.apiKey });
  if (fileConfig.model && settings.model === DEFAULT_MODEL) store.updateSettings({ model: fileConfig.model });
  if (!settings.supabaseUrl && fileConfig.supabaseUrl) store.updateSettings({ supabaseUrl: fileConfig.supabaseUrl });
  if (!settings.supabaseKey && fileConfig.supabaseKey) store.updateSettings({ supabaseKey: fileConfig.supabaseKey });
  applyTheme(store.getSettings().theme);
  syncApiKey();

  bindNav();
  bindCapture();
  bindBoard();
  bindSearch();
  bindSettings();
  bindTheme();
  bindArchive();
  bindMeme();

  const saved = localStorage.getItem('pm_active_tab');
  if (saved && document.querySelector(`.tab[data-tab="${saved}"]`)) switchTab(saved);

  // Облачная синхронизация: пуш при локальных изменениях, тянем при загрузке
  // и при возврате на вкладку (чтобы видеть правки с других устройств).
  store.onChange(schedulePush);
  if (sync.isConfigured(syncCfg())) doPull();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) doPull({ auto: true }); });
}

// ===== Навигация =====
function bindNav() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
}
function switchTab(name) {
  localStorage.setItem('pm_active_tab', name);
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
// Три темы по кругу: тёмная → светлая → стекло (Liquid Glass) → тёмная.
const THEMES = ['dark', 'light', 'glass'];
const THEME_ICON = { dark: '☾', light: '☀', glass: '◗' };
const THEME_TITLE = { dark: 'Тёмная тема', light: 'Светлая тема', glass: 'Стекло (Liquid Glass)' };
function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('#theme-toggle');
  btn.textContent = THEME_ICON[t];
  btn.title = `${THEME_TITLE[t]} — нажмите, чтобы сменить`;
}
function bindTheme() {
  $('#theme-toggle').addEventListener('click', () => {
    const cur = store.getSettings().theme;
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length] || 'light';
    store.updateSettings({ theme: next });
    applyTheme(next);
  });
}

// ===== Главная: захват =====
function dupCheckEnabled() {
  // По умолчанию включено; выключается только явным false в настройках.
  return store.getSettings().dupCheck !== false;
}
function bindCapture() {
  $('#parse-btn').addEventListener('click', onParse);
  $('#capture-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onParse();
    }
  });
  // Тумблер проверки дублей — состояние хранится в настройках (localStorage).
  const tgl = $('#dupcheck-toggle');
  if (tgl) {
    tgl.checked = dupCheckEnabled();
    tgl.addEventListener('change', () => store.updateSettings({ dupCheck: tgl.checked }));
  }
}

async function onParse() {
  const raw = $('#capture-input').value.trim();
  if (!raw) return;

  const btn = $('#parse-btn');
  const status = $('#capture-status');
  $('#capture-result').innerHTML = '';
  btn.disabled = true;
  showStatus(status, 'Claude обрабатывает…');

  try {
    const cards = await processCapture(raw, knownFullNames(), { knownProjects: knownProjects() });
    const drafts = cards.map(normalizeDraft).filter(Boolean);
    status.hidden = true;
    if (!drafts.length) {
      showStatus(status, 'Не удалось разобрать — попробуйте переформулировать.');
    } else if (drafts.length === 1) {
      captureDraft = drafts[0];
      startPeopleResolution(captureDraft);
    } else {
      // ИИ увидел несколько не связанных между собой заметок — предлагаем разделить.
      renderSplitPrompt(raw, drafts);
    }
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать';
  }
}

/**
 * Экран-предложение: вставленный текст содержит несколько не связанных заметок.
 * Пользователь может создать все карточки сразу или оставить всё одной заметкой.
 */
function renderSplitPrompt(raw, drafts) {
  const box = $('#capture-result');
  box.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(el('p', 'card-title', `Похоже, здесь несколько разных заметок (${drafts.length})`));
  card.appendChild(el('p', 'card-body', 'Я разделил текст по смыслу. Можно создать карточки по отдельности или оставить всё одной заметкой.'));

  const list = el('div', 'split-cards');
  drafts.forEach((d, i) => list.appendChild(dupColumn(`Карточка ${i + 1}`, d)));
  card.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'card-footer dup-actions';

  const splitBtn = el('button', 'btn btn-primary btn-sm', `Создать ${drafts.length} ${plural(drafts.length, 'карточку', 'карточки', 'карточек')}`);
  splitBtn.addEventListener('click', () => startSplitPeopleResolution(drafts));

  const oneBtn = el('button', 'btn btn-ghost btn-sm', 'Оставить одной заметкой');
  oneBtn.addEventListener('click', () => keepAsSingle(raw));

  const discard = el('button', 'btn btn-ghost btn-sm', 'Отмена');
  discard.addEventListener('click', () => {
    captureDraft = null;
    box.innerHTML = '';
    showStatus($('#capture-status'), 'Создание отменено.');
  });

  footer.append(splitBtn, oneBtn, discard);
  card.appendChild(footer);
  box.appendChild(card);
}

/** Создать сразу все карточки из разбиения (имена уже уточнены и канонизированы). */
function saveSplitDrafts(drafts) {
  drafts.forEach((d) => store.createCard(d));
  captureDraft = null;
  $('#capture-result').innerHTML = '';
  $('#capture-input').value = '';
  const n = drafts.length;
  showStatus($('#capture-status'), `Создано ${n} ${plural(n, 'карточка', 'карточки', 'карточек')} ✓ — смотрите в разделе «Карточки».`);
}

/**
 * Уточнение ФИО для НЕСКОЛЬКИХ карточек разом: собираем недостающие имена/фамилии
 * по всем черновикам (по разу на уникальное имя), затем сохраняем все карточки.
 */
function startSplitPeopleResolution(drafts) {
  const known = knownFullNames();
  const pending = [];
  const seen = new Set();
  drafts.forEach((draft) => {
    (draft.people || []).forEach((name) => {
      const key = normKey(name);
      if (!name || seen.has(key)) return;
      seen.add(key);
      if (isFullName(name)) return; // обе части уже есть

      const kind = classifyToken(name); // 'name' → не хватает фамилии; 'surname' → имени
      // Однозначное совпадение с известным коллегой — подставляем во все черновики.
      const matches = kind === 'surname'
        ? [...new Set(known.filter((f) => normKey(lastToken(f)) === key))]
        : [...new Set(known.filter((f) => normKey(firstToken(f)) === key))];
      if (matches.length === 1) {
        drafts.forEach((d) => setPersonName(d, name, matches[0]));
        return;
      }
      pending.push({ original: name, token: name, kind, candidates: matches });
    });
  });
  const done = () => resolveProjects(drafts, () => saveSplitDrafts(drafts));
  if (!pending.length) done();
  else renderSurnamePrompt(drafts, pending, done);
}

/** Оставить весь текст одной карточкой: повторный разбор с принудительным склеиванием. */
async function keepAsSingle(raw) {
  const status = $('#capture-status');
  $('#capture-result').innerHTML = '';
  showStatus(status, 'Собираю в одну карточку…');
  try {
    const cards = await processCapture(raw, knownFullNames(), { forceSingle: true, knownProjects: knownProjects() });
    captureDraft = normalizeDraft(cards[0]);
    status.hidden = true;
    if (captureDraft) startPeopleResolution(captureDraft);
    else showStatus(status, 'Не удалось разобрать — попробуйте переформулировать.');
  } catch (e) {
    showStatus(status, e.message, true);
  }
}

// Служебные слова-связки: не начинают и не продолжают название проекта.
const PROJECT_CONNECTORS = new Set([
  'и', 'в', 'на', 'по', 'для', 'с', 'со', 'до', 'от', 'к', 'о', 'об', 'у', 'за',
  'из', 'про', 'что', 'как', 'при', 'во', 'же', 'бы', 'ли', 'не', 'а', 'но', 'или',
]);
// Нарицательные слова, которые иногда пишут с заглавной, но это НЕ проекты.
const PROJECT_STOPWORDS = new Set([
  'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье',
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
  'сентябрь', 'октябрь', 'ноябрь', 'декабрь', 'сегодня', 'завтра', 'вчера',
  'отчёт', 'отчет', 'встреча', 'звонок', 'созвон', 'задача', 'письмо', 'почта',
]);
// Предлоги-спутники: следующее за ними имя — это, как правило, человек
// («с Наташей», «у Олега»), а не проект. Помогает отсечь склонённые имена,
// которых нет в словаре в именительном падеже.
const PERSON_PREPOSITIONS = new Set(['с', 'со', 'у']);
const CLEAN_EDGES = (t) => t.replace(/^[«"'(\[]+/, '').replace(/[.,;:!?»"')\]]+$/, '');
const STARTS_UPPER = (t) => /^[А-ЯЁA-Z]/.test(t);
const STARTS_LOWER = (t) => /^[а-яёa-z]/.test(t);

// Косвенные падежи семейства «-ение/-ание» → именительный. Очень узкий и
// безопасный набор: трогаем только слова с этими специфичными окончаниями
// (управлению, ценообразованию, планированием…). Слова вне этого семейства
// (качеством, Биллингом, Динамическому) НЕ меняем — приведение остаётся
// «простым» и не ломает остальные названия.
const CASE_ENDINGS = [
  [/ением$/, 'ение'], [/анием$/, 'ание'],
  [/ению$/, 'ение'], [/анию$/, 'ание'],
  [/ении$/, 'ение'], [/ании$/, 'ание'],
  [/ения$/, 'ение'], [/ания$/, 'ание'],
];
/** Простая нормализация падежа одного слова (только семейство -ение/-ание). */
function toNominative(word) {
  if (!word || word.length < 6) return word;
  for (const [re, repl] of CASE_ENDINGS) {
    if (re.test(word)) return word.replace(re, repl);
  }
  return word;
}

/**
 * Детерминированная страховка к модели: ищем в исходном тексте слова/фразы
 * с ЗАГЛАВНОЙ буквы НЕ в начале предложения, которые модель могла пропустить.
 * Возвращаем кандидатов с confidence 'low' (приложение переспросит «это проект?»).
 * Исключаем: начало предложения, имена людей, общие слова из стоп-списка и то,
 * что модель уже вернула как проект.
 */
function detectMissedProjects(rawText, people, meta) {
  if (!rawText) return [];
  const existing = (meta || []).map((m) => normKey(m.name));
  const peopleFirst = new Set((people || []).map((p) => normKey(firstToken(p))));
  const found = [];
  const seen = new Set();
  rawText.split(/[.!?\n]+/).forEach((sentence) => {
    const tokens = sentence.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) { // i=0 — начало предложения, пропускаем
      const word = CLEAN_EDGES(tokens[i]);
      if (!STARTS_UPPER(word) || word.length < 3) continue;
      const key = normKey(word);
      if (PROJECT_STOPWORDS.has(key) || PROJECT_CONNECTORS.has(key)) continue;
      if (KNOWN_FIRST_NAMES.has(key) || peopleFirst.has(key)) continue; // это имя человека
      // Перед словом стоит предлог-спутник человека («с Наташей») — это персона.
      if (PERSON_PREPOSITIONS.has(normKey(CLEAN_EDGES(tokens[i - 1])))) continue;
      // Собрать фразу: заглавное слово + следующие строчные слова (не связки).
      // Каждое слово приводим к именительному падежу (только семейство -ение/-ание),
      // сохраняя регистр первой буквы заглавного слова.
      const parts = [cap(toNominative(word))];
      for (let j = i + 1; j < tokens.length; j++) {
        const next = CLEAN_EDGES(tokens[j]);
        if (!STARTS_LOWER(next) || PROJECT_CONNECTORS.has(normKey(next))) break;
        parts.push(toNominative(next));
      }
      const name = parts.join(' ');
      const nameKey = normKey(name);
      if (seen.has(nameKey)) continue;
      // Модель уже вернула этот проект (по вхождению заглавного слова) — не дублируем.
      if (existing.some((e) => e === nameKey || e.includes(key) || nameKey.includes(e))) continue;
      seen.add(nameKey);
      found.push({ name, confidence: 'low', sameAs: '' });
    }
  });
  return found;
}

/** Привести ответ модели к черновику-карточке и канонизировать имена.
 *  Проекты сохраняем как готовые строки (draft.projects) + сырьё с метаданными
 *  (draft._projectMeta) для последующего уточнения — confidence/sameAs. */
function normalizeDraft(result) {
  if (!result || typeof result !== 'object') return null;
  const rawProjects = (Array.isArray(result.projects) ? result.projects : [result.projects]).filter(Boolean);
  const meta = rawProjects.map((p) => {
    if (p && typeof p === 'object') {
      return {
        name: String(p.name || '').trim(),
        confidence: p.confidence === 'low' ? 'low' : 'high',
        sameAs: p.sameAs ? String(p.sameAs).trim() : '',
      };
    }
    return { name: String(p || '').trim(), confidence: 'high', sameAs: '' };
  }).filter((m) => m.name);
  // Страховка: добавляем заглавные фразы из текста, которые модель пропустила.
  const peopleCanon = (Array.isArray(result.people) ? result.people : [result.people]).filter(Boolean).map(canonicalize);
  detectMissedProjects(result.rawText, peopleCanon, meta).forEach((m) => meta.push(m));
  const d = {
    rawText: result.rawText || '',
    title: result.title || '',
    description: result.description || '',
    people: (Array.isArray(result.people) ? result.people : [result.people]).filter(Boolean).map(canonicalize),
    projects: meta.map((m) => m.name),
    _projectMeta: meta,
    priority: ['P1', 'P2', 'P3'].includes(result.priority) ? result.priority : '',
    deadline: result.deadline || null,
    tags: Array.isArray(result.tags) ? result.tags : [],
  };
  if (!d.title && !d.description) return null;
  return d;
}

/** Заменить имя во всех вхождениях draft.people (по точному совпадению). */
function setPersonName(draft, original, full) {
  draft.people = (draft.people || []).map((p) => (p === original ? full : p));
}

/** Заменить/удалить проект во всех вхождениях draft.projects (пустое имя — удалить),
 *  без дубликатов (без учёта регистра). */
function setProjectName(draft, original, newName) {
  const next = [];
  const seen = new Set();
  (draft.projects || []).forEach((p) => {
    const v = (p === original) ? (newName || '').trim() : p;
    if (!v) return;
    const k = normKey(v);
    if (!seen.has(k)) { seen.add(k); next.push(v); }
  });
  draft.projects = next;
}

/**
 * Уточнение проектов перед сохранением (для одной карточки или для разбивки).
 * Логика (см. _projectMeta из normalizeDraft):
 *  1) точное совпадение с известным проектом → подставляем его молча;
 *  2) похож на известный (sameAs) → спрашиваем, по умолчанию подставить существующий;
 *  3) низкая уверенность («это проект?») → спрашиваем, можно изменить/очистить;
 *  4) уверенный новый проект → оставляем как есть.
 * @param {object[]} drafts  карточки-черновики
 * @param {Function} onDone  что вызвать после уточнения
 */
function resolveProjects(drafts, onDone) {
  const known = knownProjects();
  const knownKey = new Map(known.map((k) => [normKey(k), k]));
  const pending = [];
  const seen = new Set();
  drafts.forEach((draft) => {
    (draft._projectMeta || []).forEach((m) => {
      const key = normKey(m.name);
      if (!m.name || seen.has(key)) return;
      seen.add(key);
      // 1) точное совпадение с известным — подставить молча (в каноническом написании).
      if (knownKey.has(key)) {
        const canonical = knownKey.get(key);
        if (canonical !== m.name) drafts.forEach((d) => setProjectName(d, m.name, canonical));
        return;
      }
      // 2) похож на известный — спросить (по умолчанию подставить существующий).
      const sameKey = normKey(m.sameAs);
      if (m.sameAs && knownKey.has(sameKey) && sameKey !== key) {
        pending.push({ original: m.name, kind: 'similar', suggested: knownKey.get(sameKey), candidates: known });
        return;
      }
      // 3) сомнение, проект ли это — спросить.
      if (m.confidence === 'low') {
        pending.push({ original: m.name, kind: 'doubt', suggested: m.name, candidates: known });
        return;
      }
      // 4) уверенный новый проект — оставляем как есть.
    });
  });
  if (!pending.length) onDone();
  else renderProjectPrompt(drafts, pending, onDone);
}

/** Форма уточнения проектов. Поле ввода с предзаполнением + чипы существующих. */
function renderProjectPrompt(drafts, pending, onDone) {
  const targets = Array.isArray(drafts) ? drafts : [drafts];
  const box = $('#capture-result');
  box.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(el('p', 'card-title', 'Уточните проект'));
  card.appendChild(el('p', 'card-body', 'Помогите не плодить разные названия одного проекта. Можно изменить название, выбрать существующее или очистить поле, если это не проект.'));

  const form = el('div', 'edit-form');
  const known = knownProjects();

  const rows = pending.map((p) => {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.value = p.suggested || '';
    inp.placeholder = 'Название проекта';
    inp.setAttribute('list', 'known-projects');
    const labelText = p.kind === 'similar'
      ? `«${p.original}» похоже на проект «${p.suggested}». Подставить его или оставить «${p.original}»?`
      : `«${p.original}» — это проект? Уточните название или очистите поле, если нет.`;
    const wrap = field(labelText, inp);

    const picks = el('div', 'find-suggestions');
    if (p.kind === 'similar') {
      const keepNew = el('button', 'chip', `Оставить «${p.original}»`);
      keepNew.addEventListener('click', () => (inp.value = p.original));
      picks.appendChild(keepNew);
    }
    (p.candidates || []).slice(0, 6).forEach((name) => {
      if (normKey(name) === normKey(p.original)) return;
      const b = el('button', 'chip', name);
      b.addEventListener('click', () => (inp.value = name));
      picks.appendChild(b);
    });
    const notProject = el('button', 'chip', 'Не проект');
    notProject.addEventListener('click', () => (inp.value = ''));
    picks.appendChild(notProject);
    wrap.appendChild(picks);

    form.appendChild(wrap);
    return { p, inp };
  });

  // Подсказки автодополнения по существующим проектам.
  const dl = document.createElement('datalist');
  dl.id = 'known-projects';
  known.forEach((v) => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
  form.appendChild(dl);

  const footer = el('div', 'card-footer');
  const skip = el('button', 'btn btn-ghost btn-sm', 'Оставить как есть');
  skip.addEventListener('click', () => onDone());
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  const commit = () => {
    rows.forEach(({ p, inp }) => {
      targets.forEach((d) => setProjectName(d, p.original, inp.value.trim()));
    });
    onDone();
  };
  save.addEventListener('click', commit);
  // Enter в любом поле = «Сохранить» (datalist-подсказки выбираются стрелками без Enter).
  rows.forEach(({ inp }) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  }));
  footer.append(skip, save);

  card.append(form, footer);
  box.appendChild(card);
  // Фокус в первое поле, чтобы можно было сразу печатать/нажать Enter.
  if (rows[0]) rows[0].inp.focus();
}

/**
 * Перед показом карточки уточняем недостающие фамилии. Имена уже канонизированы
 * (Настя → Анастасия). Если у персоны нет фамилии и её нельзя однозначно
 * сопоставить с известным коллегой — спрашиваем фамилию у пользователя.
 */
function startPeopleResolution(draft) {
  const known = knownFullNames();
  const pending = [];
  const seen = new Set();
  (draft.people || []).forEach((name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    if (isFullName(name)) return; // обе части уже есть

    const kind = classifyToken(name); // 'name' → не хватает фамилии; 'surname' → имени
    // Однозначное совпадение с известным коллегой по той же части — объединяем.
    const matches = kind === 'surname'
      ? [...new Set(known.filter((f) => normKey(lastToken(f)) === normKey(name)))]
      : [...new Set(known.filter((f) => normKey(firstToken(f)) === normKey(name)))];
    if (matches.length === 1) { setPersonName(draft, name, matches[0]); return; }
    pending.push({ original: name, token: name, kind, candidates: matches });
  });
  // После ФИО — уточняем проекты, и только потом проверка дублей.
  const done = () => resolveProjects([draft], afterPeopleResolved);
  if (!pending.length) done();
  else renderSurnamePrompt(draft, pending, done);
}

/**
 * После уточнения ФИО — проверка на дубликат среди существующих карточек.
 * Если найдена похожая, показываем выбор (оставить обе / объединить / не добавлять);
 * иначе — обычный предпросмотр.
 */
async function afterPeopleResolved() {
  if (!captureDraft) return;
  // Тумблер выключен — пропускаем проверку дублей, сразу показываем карточку.
  if (!dupCheckEnabled()) { renderCaptureResult(); return; }
  const box = $('#capture-result');
  const status = $('#capture-status');
  showStatus(status, 'Проверяю, нет ли похожей карточки…');
  try {
    const { similarId, reason } = await findSimilarCard(captureDraft, store.getAll());
    status.hidden = true;
    const existing = similarId ? store.getById(similarId) : null;
    if (existing) renderDuplicatePrompt(existing, reason);
    else renderCaptureResult();
  } catch (e) {
    // Если проверка не удалась — не блокируем сохранение, просто показываем карточку.
    status.hidden = true;
    renderCaptureResult();
  }
}

/** Подставить приоритет/срок при объединении: из новой карточки, иначе из старой. */
function mergedPriorityDeadline(existing, draft) {
  return {
    priority: draft.priority || existing.priority || '',
    deadline: draft.deadline || existing.deadline || null,
  };
}

/** Экран выбора при найденном дубликате: оставить обе / объединить / не добавлять. */
function renderDuplicatePrompt(existing, reason) {
  const box = $('#capture-result');
  box.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(el('p', 'card-title', 'Похоже, такая карточка уже есть'));
  if (reason) card.appendChild(el('p', 'card-body', reason));

  // Превью существующей карточки (read-only).
  const cmp = el('div', 'dup-compare');
  cmp.append(dupColumn('Уже есть', existing), dupColumn('Новая запись', captureDraft));
  card.appendChild(cmp);

  const footer = document.createElement('div');
  footer.className = 'card-footer dup-actions';

  const keepBoth = el('button', 'btn btn-ghost btn-sm', 'Оставить обе');
  keepBoth.addEventListener('click', () => renderCaptureResult());

  const merge = el('button', 'btn btn-primary btn-sm', 'Объединить');
  merge.addEventListener('click', () => onMerge(existing));

  const discard = el('button', 'btn btn-ghost btn-sm', 'Не добавлять');
  discard.addEventListener('click', () => {
    captureDraft = null;
    box.innerHTML = '';
    $('#capture-input').value = '';
    showStatus($('#capture-status'), 'Новая запись отменена.');
  });

  footer.append(keepBoth, merge, discard);
  card.appendChild(footer);
  box.appendChild(card);
}

/** Колонка-превью карточки для экрана сравнения дубликата. */
function dupColumn(label, c) {
  const col = el('div', 'dup-col');
  col.appendChild(el('span', 'dup-label', label));
  col.appendChild(el('p', 'dup-title', c.title || '(без названия)'));
  if (c.description) col.appendChild(el('p', 'dup-desc', c.description));
  const meta = [];
  if ((c.people || []).length) meta.push((c.people || []).join(', '));
  if ((c.projects || []).length) meta.push((c.projects || []).join(', '));
  if (c.priority && PRIORITY_NAME[c.priority]) meta.push(PRIORITY_NAME[c.priority]);
  if (c.deadline) meta.push(`срок ${formatDeadline(c.deadline)}`);
  if (meta.length) col.appendChild(el('p', 'dup-meta', meta.join(' · ')));
  return col;
}

/** Объединить существующую карточку с черновиком через ИИ и сохранить. */
async function onMerge(existing) {
  const status = $('#capture-status');
  showStatus(status, 'Объединяю карточки…');
  try {
    const merged = await mergeCards(existing, captureDraft);
    const { priority, deadline } = mergedPriorityDeadline(existing, captureDraft);
    store.update(existing.id, {
      title: merged.title || existing.title,
      description: merged.description || '',
      people: (Array.isArray(merged.people) ? merged.people : []).map(canonicalize),
      projects: Array.isArray(merged.projects) ? merged.projects : [],
      tags: Array.isArray(merged.tags) ? merged.tags : [],
      priority,
      deadline,
    });
    captureDraft = null;
    $('#capture-result').innerHTML = '';
    $('#capture-input').value = '';
    showStatus(status, 'Объединено ✓ — смотрите в разделе «Карточки».');
  } catch (e) {
    showStatus(status, 'Не удалось объединить: ' + e.message, true);
  }
}

/**
 * Форма уточнения недостающей части имени (фамилия или имя). Можно пропустить.
 * @param {object[]} drafts  карточки-черновики, к которым применяем уточнения
 * @param {object[]} pending список неуточнённых токенов
 * @param {Function} onDone  что вызвать после «Сохранить»/«Пропустить»
 */
function renderSurnamePrompt(drafts, pending, onDone) {
  const targets = Array.isArray(drafts) ? drafts : [drafts];
  const box = $('#capture-result');
  box.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(el('p', 'card-title', 'Уточните ФИО'));
  card.appendChild(el('p', 'card-body', 'Добавьте недостающую часть, чтобы одна персона не превратилась в разные карточки. Можно пропустить.'));

  const form = document.createElement('div');
  form.className = 'edit-form';
  const known = knownFullNames();
  // Подсказки автодополнения: фамилии (для токена-имени) и имена (для токена-фамилии).
  const knownSurnames = [...new Set(known.map((f) => lastToken(f)).filter(Boolean))];
  const knownNames = [...new Set(known.map((f) => firstToken(f)).filter(Boolean))];

  const rows = pending.map((p) => {
    const needSurname = p.kind === 'name'; // не хватает фамилии
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.placeholder = needSurname ? 'Фамилия' : 'Имя';
    inp.setAttribute('list', needSurname ? 'known-surnames' : 'known-names');
    const labelText = needSurname ? `Имя: ${p.token} — укажите фамилию` : `Фамилия: ${p.token} — укажите имя`;
    const wrap = field(labelText, inp);
    // Быстрый выбор уже известной персоны (подставляем недостающую часть).
    if (p.candidates && p.candidates.length) {
      const picks = document.createElement('div');
      picks.className = 'find-suggestions';
      p.candidates.forEach((full) => {
        const b = el('button', 'chip', full);
        b.addEventListener('click', () => (inp.value = needSurname ? lastToken(full) : firstToken(full)));
        picks.appendChild(b);
      });
      wrap.appendChild(picks);
    }
    form.appendChild(wrap);
    return { p, inp, needSurname };
  });

  const mkDatalist = (id, values) => {
    const dl = document.createElement('datalist');
    dl.id = id;
    values.forEach((v) => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
    return dl;
  };
  form.appendChild(mkDatalist('known-surnames', knownSurnames));
  form.appendChild(mkDatalist('known-names', knownNames));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const skip = el('button', 'btn btn-ghost btn-sm', 'Пропустить');
  skip.addEventListener('click', () => onDone());
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  const commit = () => {
    rows.forEach(({ p, inp, needSurname }) => {
      const extra = inp.value.trim();
      // needSurname: «Имя Фамилия»; иначе: «Имя Фамилия» = extra + токен-фамилия.
      const full = !extra
        ? p.token
        : (needSurname ? canonicalize(`${p.token} ${extra}`) : canonicalize(`${extra} ${p.token}`));
      // Подставляем уточнённое имя во ВСЕ переданные черновики.
      targets.forEach((d) => setPersonName(d, p.original, full));
    });
    onDone();
  };
  save.addEventListener('click', commit);
  // Enter в любом поле = «Сохранить».
  rows.forEach(({ inp }) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  }));
  footer.append(skip, save);

  card.append(form, footer);
  box.appendChild(card);
  // Фокус в первое поле — можно сразу печатать недостающую часть.
  if (rows[0]) rows[0].inp.focus();
}

function renderCaptureResult() {
  const box = $('#capture-result');
  box.innerHTML = '';
  if (!captureDraft) return;
  const card = buildCard(captureDraft, { preview: true });
  box.appendChild(card);
}

function saveCaptureDraft() {
  if (!captureDraft) return;
  store.createCard(captureDraft);
  captureDraft = null;
  $('#capture-result').innerHTML = '';
  $('#capture-input').value = '';
  showStatus($('#capture-status'), 'Сохранено ✓ — смотрите в разделе «Карточки».');
}

// ===== Карточки: фильтры и сортировка =====
function bindBoard() {
  $('#filter-person').addEventListener('change', (e) => { filters.person = e.target.value; afterFilterChange(); });
  $('#filter-project').addEventListener('change', (e) => { filters.project = e.target.value; afterFilterChange(); });
  $('#filter-priority').addEventListener('change', (e) => { filters.priority = e.target.value; afterFilterChange(); });
  $('#filter-daterange').addEventListener('change', (e) => { filters.dateRange = e.target.value; afterFilterChange(); });
  $('#filter-created').addEventListener('change', (e) => { filters.created = e.target.value; afterFilterChange(); });
  $('#sort-select').addEventListener('change', (e) => { sortMode = e.target.value; renderBoard(); });
  $$('.filter-clear').forEach((b) => b.addEventListener('click', () => clearOneFilter(b.dataset.clear)));
  $('#filter-reset').addEventListener('click', resetAllFilters);
  const emptyReset = $('#cards-empty-reset');
  if (emptyReset) emptyReset.addEventListener('click', resetAllFilters);
}

/** Сбросить все фильтры и сортировку к значениям по умолчанию. */
function resetAllFilters() {
  filters.person = filters.project = filters.priority = '';
  filters.dateRange = 'all';
  filters.created = 'all';
  sortMode = 'default';
  $('#filter-person').value = $('#filter-project').value = $('#filter-priority').value = '';
  $('#filter-daterange').value = 'all';
  $('#filter-created').value = 'all';
  $('#sort-select').value = 'default';
  populateFilters();
  afterFilterChange();
}

function hasActiveFilters() {
  return !!(filters.person || filters.project || filters.priority
    || (filters.dateRange && filters.dateRange !== 'all')
    || (filters.created && filters.created !== 'all'));
}

function afterFilterChange() {
  const states = {
    person: !!filters.person,
    project: !!filters.project,
    priority: !!filters.priority,
    daterange: !!(filters.dateRange && filters.dateRange !== 'all'),
    created: !!(filters.created && filters.created !== 'all'),
  };
  // Подсветить активную пилюлю и показать её персональный «✕».
  Object.entries(states).forEach(([key, active]) => {
    $(`#filter-${key}`).classList.toggle('is-filtered', active);
    const clr = document.querySelector(`.filter-clear[data-clear="${key}"]`);
    if (clr) clr.hidden = !active;
  });
  $('#filter-reset').disabled = !hasActiveFilters();
  renderBoard();
}

/** Сбросить один фильтр по ключу (person|project|priority|daterange|created). */
function clearOneFilter(key) {
  if (key === 'daterange') { filters.dateRange = 'all'; $('#filter-daterange').value = 'all'; }
  else if (key === 'created') { filters.created = 'all'; $('#filter-created').value = 'all'; }
  else { filters[key] = ''; $(`#filter-${key}`).value = ''; }
  afterFilterChange();
}

function populateFilters() {
  const all = store.getAll();
  const people = [...new Set(all.flatMap((c) => c.people || []).filter(Boolean))].sort();
  const projects = [...new Set(all.flatMap((c) => c.projects || []).filter(Boolean))].sort();
  fillSelect($('#filter-person'), 'Персоны', people, filters.person);
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

// --- предикаты фильтров ---
function fuzzyIncludes(hay, needle) {
  const h = (hay || '').toLowerCase();
  const n = needle.toLowerCase();
  return h.includes(n) || n.includes(h);
}
function personMatches(c, q) { return !q || (c.people || []).some((p) => fuzzyIncludes(p, q.trim())); }
function projectMatches(c, q) { return !q || [...(c.projects || []), ...(c.tags || [])].some((p) => fuzzyIncludes(p, q.trim())); }
function priorityMatches(c, p) { return !p || c.priority === p; }
function dateMatches(c, range) {
  if (!range || range === 'all') return true;
  if (!c.deadline) return false;
  const today = todayISO();
  if (range === 'overdue') return c.deadline < today;
  if (range === 'today') return c.deadline === today;
  if (range === 'this_week') return c.deadline >= today && c.deadline <= endOfWeekISO();
  if (range === 'this_month') return c.deadline >= today && c.deadline <= endOfMonthISO();
  return true;
}
/** Фильтр по дате СОЗДАНИЯ карточки (createdAt): сегодня / неделя / месяц / раньше. */
function createdMatches(c, range) {
  if (!range || range === 'all') return true;
  if (!c.createdAt) return false;
  const created = new Date(c.createdAt);
  if (isNaN(created.getTime())) return false;
  const createdDay = created.toISOString().slice(0, 10);
  const today = todayISO();
  if (range === 'today') return createdDay === today;
  if (range === 'this_week') return createdDay >= startOfWeekISO() && createdDay <= today;
  if (range === 'this_month') return createdDay >= startOfMonthISO() && createdDay <= today;
  if (range === 'older') return createdDay < startOfMonthISO();
  return true;
}
function startOfWeekISO() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}
function startOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function endOfWeekISO() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() + (6 - dow));
  return d.toISOString().slice(0, 10);
}
function endOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}
function cmpDeadline(a, b) {
  const ka = a.deadline || '9999-99-99';
  const kb = b.deadline || '9999-99-99';
  return ka.localeCompare(kb);
}

/**
 * Отфильтровать и отсортировать карточки.
 * @returns {Array} отфильтрованный/отсортированный массив (исходные объекты)
 */
export function sortAndFilter(items, sortBy = 'default', f = {}) {
  const filtered = (items || []).filter(
    (c) =>
      personMatches(c, f.person) &&
      projectMatches(c, f.project) &&
      priorityMatches(c, f.priority) &&
      dateMatches(c, f.dateRange) &&
      createdMatches(c, f.created)
  );
  const arr = [...filtered];
  const byStr = (fn) => (a, b) => (fn(a) || '').localeCompare(fn(b) || '', 'ru');
  switch (sortBy) {
    case 'deadline': arr.sort(cmpDeadline); break;
    case 'person': arr.sort(byStr((c) => (c.people || [])[0])); break;
    case 'project': arr.sort(byStr((c) => (c.projects || [])[0])); break;
    case 'priority':
    case 'default':
    default:
      // По приоритету (P1 → P3), при равенстве — ближе дедлайн.
      arr.sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0) || cmpDeadline(a, b));
  }
  return arr;
}

function renderBoard() {
  const list = $('#cards-list');
  const empty = $('#cards-empty');
  const emptyFiltered = $('#cards-empty-filtered');
  const countEl = $('#cards-count');
  const total = store.getAll().length;
  const cards = sortAndFilter(store.getAll(), sortMode, filters);
  list.innerHTML = '';
  // Три состояния пустоты: совсем нет карточек / есть, но фильтры ничего не дали / есть результаты.
  const filtered = hasActiveFilters();
  if (empty) empty.hidden = !(cards.length === 0 && !filtered);
  if (emptyFiltered) emptyFiltered.hidden = !(cards.length === 0 && filtered);
  // Счётчик «Показано N из M» — только когда есть карточки и активны фильтры.
  if (countEl) {
    if (total > 0 && filtered) {
      countEl.textContent = `Показано ${cards.length} из ${total}`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }
  // Сборка во фрагмент и одна вставка в DOM — без лишних reflow на каждой карточке.
  const frag = document.createDocumentFragment();
  cards.forEach((c) => frag.appendChild(buildCard(c)));
  list.appendChild(frag);
}

// ===== Построение карточки =====
/** Строка одного типа сущностей (персоны / проекты / теги). null — если пусто. */
function buildFieldLine(type, iconName, values) {
  const list = (values || []).filter(Boolean);
  if (!list.length) return null;
  const line = el('div', `card-line card-line--${type}`);
  list.forEach((v) => line.appendChild(metaItem(iconName, v)));
  return line;
}

// Карточка-сводка создаётся из ответа ассистента и помечается тегом «сводка».
const SUMMARY_TAG = 'сводка';
function isSummaryCard(c) {
  return (c.tags || []).some((t) => normKey(t) === SUMMARY_TAG);
}

/**
 * Наполнить тело карточки сверху вниз:
 * заголовок → описание → персоны → проекты → теги → дата создания.
 * Приоритет и срок — в подвале (см. buildFooter), на уровне кнопок.
 */
function appendCardBody(li, c) {
  const summary = isSummaryCard(c);
  if (summary) li.classList.add('is-summary');   // акцентная рамка вокруг карточки
  const title = el('p', 'card-title', c.title || '(без названия)');
  if (summary) {
    // Иконка-сводка слева от названия (в отдельной flex-строке, чтобы не
    // ломать многоточие-обрезку заголовка через -webkit-line-clamp).
    const row = el('div', 'card-title-row');
    const ic = icon('summary');
    ic.classList.add('summary-mark');
    row.append(ic, title);
    li.appendChild(row);
  } else {
    li.appendChild(title);
  }
  if (c.description) li.appendChild(el('p', 'card-body', c.description));
  const persons = buildFieldLine('person', 'person', c.people);
  if (persons) li.appendChild(persons);
  const projects = buildFieldLine('project', 'project', c.projects);
  if (projects) li.appendChild(projects);
  const tags = buildFieldLine('tag', 'tag', c.tags);
  if (tags) li.appendChild(tags);
  // Дата и время создания — отдельной строкой под тегами.
  const created = formatCreated(c.createdAt);
  if (created) {
    const line = el('div', 'card-line card-line--created');
    line.appendChild(metaItem('clock', created));
    li.appendChild(line);
  }
}

/** Левая часть подвала: приоритет + срок (иконка флажка, формат DD-MM-YYYY). */
function buildFooterMeta(c) {
  const wrap = el('div', 'card-foot-meta');
  if (c.priority && PRIORITY_NAME[c.priority]) wrap.appendChild(badge(PRIORITY_NAME[c.priority], `badge-${c.priority}`));
  if (c.deadline) {
    const due = metaItem('flag', formatDeadline(c.deadline));
    due.classList.add('card-due');
    if (c.deadline < todayISO()) due.classList.add('is-overdue');
    wrap.appendChild(due);
  }
  return wrap;
}

/** Подвал карточки: слева приоритет+дата, справа кнопки действий. */
function buildFooter(c, buttons) {
  const footer = el('div', 'card-footer');
  footer.appendChild(buildFooterMeta(c));
  const actions = el('div', 'card-actions');
  buttons.forEach((b) => actions.appendChild(b));
  footer.appendChild(actions);
  return footer;
}

// id раскрытых карточек (показывают всё), и id редактируемой.
const expandedIds = new Set();
let editingId = null;

/**
 * Построить карточку. opts.preview=true — режим предпросмотра на Главной
 * (всегда раскрыта, кнопки «Дозаполнить»/«Сохранить»).
 */
function buildCard(c, opts = {}) {
  const preview = !!opts.preview;
  if (!preview && editingId === c.id) return buildCardEditor(c, false);

  const expanded = preview || expandedIds.has(c.id);
  const li = document.createElement('li');
  li.className = 'card' + (preview ? '' : ' is-clickable') + (expanded ? ' is-expanded' : '');
  if (!preview) {
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.card-footer, button, a, select, input')) return;
      if (expandedIds.has(c.id)) expandedIds.delete(c.id);
      else expandedIds.add(c.id);
      renderBoard();
    });
  }

  appendCardBody(li, c);

  let buttons;
  if (preview) {
    const editBtn = iconBtn('edit', 'Дозаполнить');
    editBtn.addEventListener('click', () => renderCaptureEditor());
    const saveBtn = el('button', 'btn btn-primary btn-sm', 'Сохранить');
    saveBtn.addEventListener('click', saveCaptureDraft);
    buttons = [editBtn, saveBtn];
  } else {
    const editBtn = iconBtn('edit', '');
    editBtn.title = 'Дозаполнить';
    editBtn.addEventListener('click', () => { editingId = c.id; renderBoard(); });
    const del = iconBtn('trash', '');
    del.title = 'В архив';
    del.addEventListener('click', () => {
      store.remove(c.id);
      renderBoard();
      showToast('Карточка в архиве', 'Отменить', () => { store.unarchive(c.id); renderBoard(); });
    });
    buttons = [editBtn, del];
  }
  li.appendChild(buildFooter(c, buttons));
  return li;
}

/** Редактор полей: на доске (saved=true, пишет в store) или для черновика на Главной. */
function buildCardEditor(c, isDraft) {
  const draft = isDraft ? c : { ...c, people: [...(c.people || [])], projects: [...(c.projects || [])], tags: [...(c.tags || [])] };
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
  const area = (key, rows) => {
    const t = document.createElement('textarea');
    t.className = 'text-input';
    t.rows = rows;
    t.value = draft[key] || '';
    t.addEventListener('input', () => (draft[key] = t.value));
    return t;
  };
  const listArea = (key, rows) => {
    const t = document.createElement('textarea');
    t.className = 'text-input';
    t.rows = rows;
    t.value = (draft[key] || []).join(', ');
    t.addEventListener('input', () => (draft[key] = t.value.split(',').map((s) => s.trim()).filter(Boolean)));
    return t;
  };
  const prioritySelect = () => {
    const sel = document.createElement('select');
    sel.className = 'select';
    [['', PRIORITY_LABEL['']], ['P1', PRIORITY_LABEL.P1], ['P2', PRIORITY_LABEL.P2], ['P3', PRIORITY_LABEL.P3]].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if ((draft.priority || '') === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => (draft.priority = sel.value));
    return sel;
  };
  const listInput = (key) => {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.value = (draft[key] || []).join(', ');
    inp.addEventListener('input', () => (draft[key] = inp.value.split(',').map((s) => s.trim()).filter(Boolean)));
    return inp;
  };

  form.appendChild(field('Название', area('title', 2)));
  form.appendChild(field('Описание', area('description', 4)));
  form.appendChild(field('Персоны (через запятую)', listInput('people')));
  form.appendChild(field('Проекты (через запятую)', listArea('projects', 2)));
  form.appendChild(field('Приоритет', prioritySelect()));
  form.appendChild(field('Срок', input('deadline', 'date')));
  form.appendChild(field('Теги (через запятую)', listArea('tags', 2)));

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const cancel = el('button', 'btn btn-ghost btn-sm', 'Отмена');
  const save = el('button', 'btn btn-primary btn-sm', 'Сохранить');
  if (isDraft) {
    cancel.addEventListener('click', renderCaptureResult);
    save.addEventListener('click', () => {
      draft.people = (draft.people || []).map(canonicalize);
      saveCaptureDraft();
    });
  } else {
    cancel.addEventListener('click', () => { editingId = null; renderBoard(); });
    save.addEventListener('click', () => {
      draft.people = (draft.people || []).map(canonicalize);
      store.update(c.id, draft);
      editingId = null;
      renderBoard();
    });
  }
  footer.append(cancel, save);

  li.append(form, footer);
  return li;
}

/** Редактирование черновика на Главной (дозаполнение перед сохранением). */
function renderCaptureEditor() {
  const box = $('#capture-result');
  box.innerHTML = '';
  box.appendChild(buildCardEditor(captureDraft, true));
}

// ===== Архив =====
function renderArchive() {
  const list = $('#archive-list');
  const empty = $('#archive-empty');
  const cards = store.getArchived();
  list.innerHTML = '';
  $('#count-archive').textContent = cards.length;
  empty.hidden = cards.length > 0;
  $('#archive-clear').hidden = cards.length === 0;
  const frag = document.createDocumentFragment();
  cards.forEach((c) => frag.appendChild(buildArchiveCard(c)));
  list.appendChild(frag);
}
function bindArchive() {
  $('#archive-clear').addEventListener('click', () => {
    const n = store.getArchived().length;
    if (!n) return;
    if (confirm(`Удалить все карточки из архива (${n})? Это действие необратимо.`)) {
      store.destroyArchived();
      renderArchive();
    }
  });
}
function buildArchiveCard(c) {
  const li = document.createElement('li');
  li.className = 'card is-archived';
  appendCardBody(li, c);

  const restore = iconBtn('restore', 'Вернуть');
  restore.addEventListener('click', () => { store.unarchive(c.id); renderArchive(); });
  const del = iconBtn('trash', 'Удалить навсегда');
  del.addEventListener('click', () => {
    if (confirm('Удалить запись навсегда? Это действие необратимо.')) { store.destroy(c.id); renderArchive(); }
  });
  li.appendChild(buildFooter(c, [restore, del]));
  return li;
}

// ===== Главная: спросить ассистента =====
function bindSearch() {
  $('#search-btn').addEventListener('click', onSearch);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearch(); });
  $$('.suggestion').forEach((s) =>
    s.addEventListener('click', () => { $('#search-input').value = s.textContent; onSearch(); })
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
    const { explanation, summary, summaryTitle, results } = await processQuery(question, store.getAll());
    status.hidden = true;
    renderAnswer(answerEl, { explanation, summary, summaryTitle, count: results.length });
    const frag = document.createDocumentFragment();
    results.forEach((c) => frag.appendChild(buildCard(c)));
    resultsEl.appendChild(frag);
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}
function renderAnswer(box, info) {
  const { explanation = '', summary = '', summaryTitle = '', count = 0 } = info;
  box.innerHTML = '';
  if (!summary && !explanation && !count) { box.hidden = true; return; }
  const head = el('div', 'answer-head');
  head.append(el('span', 'answer-icon', '✦'), el('span', 'answer-label', summary ? 'Сводка' : 'Ответ ассистента'));
  if (count) head.appendChild(el('span', 'answer-count', `${count} ${plural(count, 'находка', 'находки', 'находок')}`));
  box.appendChild(head);
  const text = summary || explanation || 'Ничего не найдено по этому запросу.';
  box.appendChild(el('p', 'answer-text', text));
  // Кнопка «Сохранить как карточку» — только когда есть содержательная сводка.
  if (summary && count) {
    const actions = el('div', 'answer-actions');
    const saveBtn = el('button', 'btn btn-primary btn-sm', 'Сохранить как карточку');
    saveBtn.addEventListener('click', () => saveSummaryCard(summaryTitle, summary, saveBtn));
    actions.appendChild(saveBtn);
    box.appendChild(actions);
  }
  box.hidden = false;
}
/** Создать новую карточку из саммаризованной сводки поиска. */
function saveSummaryCard(title, summary, btn) {
  const t = (title || '').trim() || 'Сводка по запросу';
  store.createCard({ title: t, description: summary, tags: ['сводка'] });
  if (btn) { btn.disabled = true; btn.textContent = 'Сохранено ✓ — в разделе «Карточки»'; }
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ===== Главная: The daily AI Meme =====
const MEME_SPIN_MS = 3000;   // принудительная длительность анимации перед показом совета
const MEME_PEAK = 12;        // пиковый множитель скорости орбиты
let memeRaf = null;

/** Кривая скорости за время t∈[0,1]: разгон до пика к ~65% времени, затем
 *  плавное торможение обратно к 1 — чтобы орбита «усиливалась и плавно
 *  останавливалась» к моменту показа совета. */
function memeSpeedAt(t) {
  const PEAK_AT = 0.65;
  if (t < PEAK_AT) {
    const k = t / PEAK_AT;                  // 0→1: ускоряющийся разгон
    return 1 + (MEME_PEAK - 1) * (k * k);
  }
  const k = (t - PEAK_AT) / (1 - PEAK_AT);  // 0→1
  const eased = 1 - Math.pow(1 - k, 3);     // ease-out: мягкое торможение
  return MEME_PEAK - (MEME_PEAK - 1) * eased;
}

/** Запускаем 3-секундный разгон-торможение орбиты через requestAnimationFrame. */
function startMemeSpinup() {
  const orbit = document.querySelector('.meme-orbit');
  if (!orbit) return;
  cancelAnimationFrame(memeRaf);
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min((now - t0) / MEME_SPIN_MS, 1);
    orbit.style.setProperty('--meme-speed', memeSpeedAt(t).toFixed(3));
    memeRaf = t < 1 ? requestAnimationFrame(tick) : null;
  };
  memeRaf = requestAnimationFrame(tick);
}
/** Останавливаем разгон и возвращаем обычную скорость. */
function stopMemeSpinup() {
  cancelAnimationFrame(memeRaf);
  memeRaf = null;
  const orbit = document.querySelector('.meme-orbit');
  if (orbit) orbit.style.setProperty('--meme-speed', 1);
}

function bindMeme() {
  const btn = $('#meme-btn');
  if (btn) btn.addEventListener('click', onMeme);
}
async function onMeme() {
  const btn = $('#meme-btn');
  const status = $('#meme-status');
  const out = $('#meme-output');
  btn.disabled = true;
  btn.classList.add('is-loading');
  startMemeSpinup();
  out.hidden = true;
  showStatus(status, 'Призываю брутальную мудрость…');
  // Совет показываем не раньше, чем отыграет вся 3-секундная анимация —
  // даже если ИИ ответил мгновенно. Ошибку, наоборот, показываем сразу.
  const spin = new Promise((resolve) => setTimeout(resolve, MEME_SPIN_MS));
  try {
    const [{ hero, meme }] = await Promise.all([generateMeme(), spin]);
    status.hidden = true;
    out.querySelector('.meme-text').textContent = meme || 'Сегодня муза молчит. Жми ещё.';
    out.querySelector('.meme-hero').textContent = hero ? `в стиле ${hero}` : '';
    out.hidden = false;
  } catch (e) {
    showStatus(status, e.message, true);
  } finally {
    stopMemeSpinup();
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

// ===== Настройки =====
function bindSettings() {
  const modal = $('#settings-modal');
  $('#settings-btn').addEventListener('click', () => {
    const s = store.getSettings();
    $('#api-key-input').value = s.apiKey || '';
    $('#model-input').value = s.model || '';
    $('#supabase-url-input').value = s.supabaseUrl || '';
    $('#supabase-key-input').value = s.supabaseKey || '';
    $('#workspace-input').value = s.workspaceId || '';
    setSyncStatus(sync.isConfigured(syncCfg())
      ? 'Синхронизация включена.'
      : 'Синхронизация выключена. Заполните URL и anon-ключ.');
    modal.hidden = false;
  });
  $('#settings-close').addEventListener('click', () => (modal.hidden = true));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  $('#settings-save').addEventListener('click', () => {
    store.updateSettings({
      apiKey: $('#api-key-input').value.trim(),
      model: $('#model-input').value.trim() || DEFAULT_MODEL,
      supabaseUrl: $('#supabase-url-input').value.trim(),
      supabaseKey: $('#supabase-key-input').value.trim(),
      workspaceId: $('#workspace-input').value.trim(),
    });
    syncApiKey();
    modal.hidden = true;
    if (sync.isConfigured(syncCfg())) doPull();
  });
  // «Синхронизировать сейчас» — применяет введённые ключи и тянет облако,
  // не закрывая модалку (чтобы был виден статус).
  $('#sync-now').addEventListener('click', () => {
    store.updateSettings({
      supabaseUrl: $('#supabase-url-input').value.trim(),
      supabaseKey: $('#supabase-key-input').value.trim(),
      workspaceId: $('#workspace-input').value.trim(),
    });
    if (!sync.isConfigured(syncCfg())) { setSyncStatus('Укажите Supabase URL и anon-ключ.', true); return; }
    doPull();
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

// Единый набор монохромных SVG-иконок (currentColor) для консистентности.
const ICONS = {
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  // «Сводка»: лист с убывающими строками — узнаваемый знак краткого изложения.
  summary: '<path d="M6 3h9l3 3v15a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  tag: '<path d="M3 11.5V5a2 2 0 0 1 2-2h6.5L21 12.5 12.5 21z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}
function metaItem(name, text) {
  const span = el('span', 'meta-tag');
  span.appendChild(icon(name));
  span.appendChild(document.createTextNode(text));
  return span;
}
function iconBtn(name, label) {
  const b = el('button', 'btn btn-ghost btn-sm');
  b.appendChild(icon(name));
  if (label) b.appendChild(document.createTextNode(label));
  return b;
}
// Тост с действием «Отменить»: появляется внизу, сам исчезает через ~6 секунд.
let toastTimer = null;
function showToast(msg, actionLabel, onAction) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  toast.appendChild(el('span', 'toast-msg', msg));
  if (actionLabel && onAction) {
    const btn = el('button', 'toast-action', actionLabel);
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      toast.classList.remove('is-visible');
      onAction();
    });
    toast.appendChild(btn);
  }
  // Запускаем анимацию появления на следующий кадр (чтобы сработал transition).
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 6000);
}

let statusHideTimer = null;
function showStatus(elm, msg, isError = false) {
  elm.textContent = msg;
  elm.classList.toggle('is-error', isError);
  elm.hidden = false;
  // Успешные сообщения сами гаснут через 5 секунд; ошибки остаются на экране.
  clearTimeout(statusHideTimer);
  if (!isError) {
    statusHideTimer = setTimeout(() => {
      // Прячем только если текст не сменился на новый (на случай быстрых действий).
      if (elm.textContent === msg) elm.hidden = true;
    }, 5000);
  }
}

// Запускаем приложение только в браузере (в Node модуль импортируется для тестов).
if (typeof document !== 'undefined' && document.querySelector) init();
