// sync.js — облачная синхронизация карточек через Supabase (PostgREST REST API).
// Чистый модуль: не трогает DOM и localStorage. Конфиг передаётся аргументом.
//
// Модель хранения: одна строка в таблице pm_state на «рабочую область»:
//   id (text, PK) = workspace, data (jsonb) = { cards: [...] }, updated_at (timestamptz).
// Стратегия: последний-записавший-побеждает на уровне всего документа (для
// личного использования между своими устройствами этого достаточно).

const TABLE = 'pm_state';

function headers(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function base(cfg) {
  return `${cfg.url.replace(/\/+$/, '')}/rest/v1/${TABLE}`;
}

function wid(cfg) {
  return cfg.workspace && cfg.workspace.trim() ? cfg.workspace.trim() : 'default';
}

async function safeText(res) {
  try {
    const t = await res.text();
    try { return JSON.parse(t).message || t; } catch { return t; }
  } catch {
    return '';
  }
}

/** Готова ли синхронизация (заданы URL и ключ). */
export function isConfigured(cfg) {
  return !!(cfg && cfg.url && cfg.key);
}

/**
 * Забрать карточки из облака.
 * @returns {Promise<{cards: Array, updatedAt: string|null} | null>} null — строки ещё нет
 */
export async function pull(cfg) {
  const url = `${base(cfg)}?id=eq.${encodeURIComponent(wid(cfg))}&select=data,updated_at`;
  const res = await fetch(url, { headers: headers(cfg.key) });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows || !rows.length) return null;
  const data = rows[0].data || {};
  return { cards: Array.isArray(data.cards) ? data.cards : [], updatedAt: rows[0].updated_at || null };
}

/**
 * Записать карточки в облако (upsert по id рабочей области).
 */
export async function push(cfg, cards) {
  const body = [{ id: wid(cfg), data: { cards: cards || [] }, updated_at: new Date().toISOString() }];
  const res = await fetch(base(cfg), {
    method: 'POST',
    headers: { ...headers(cfg.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await safeText(res)}`);
  return true;
}
