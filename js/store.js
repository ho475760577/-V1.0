/**
 * 本地存储：浏览器 localStorage 即时保存，并可由本机网页服务同步到 data/storyrealm-workspace.json。
 */

const KEY_CFG = 'sil.configs';
const KEY_CHAT = 'sil.chat';
const KEY_CUR = 'sil.current';
const KEY_API = 'sil.api';
const KEY_SYNC_META = 'sil.syncMeta';
const WORKSPACE_API = '/api/workspace';
let persistenceReady = false;
let syncTimer = null;
let syncInFlight = Promise.resolve();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (error) {
    console.error('存储失败', error);
    throw new Error('本地保存失败，可能是浏览器存储空间已满。请先导出作品备份后清理空间。', { cause: error });
  }
  touchWorkspace();
}

function touchWorkspace() {
  if (!persistenceReady) return;
  try { localStorage.setItem(KEY_SYNC_META, String(Date.now())); } catch { /* localStorage 的错误已在具体写入处报告 */ }
  queueWorkspaceSync();
}

function workspaceEndpoint() {
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') return `${location.origin}${WORKSPACE_API}`;
  return WORKSPACE_API;
}

function localWorkspaceHasData(backup) {
  const data = backup?.data || {};
  return Boolean(data[KEY_CFG] || data[KEY_CHAT] || data[KEY_CARDS] || data[KEY_PERSONAS] || data[KEY_CREATION]);
}

function localWorkspaceUpdatedAt(backup) {
  const saved = Number(localStorage.getItem(KEY_SYNC_META));
  if (Number.isFinite(saved) && saved > 0) return saved;
  const configs = backup?.data?.[KEY_CFG];
  try {
    const parsed = JSON.parse(configs || '{}');
    return Math.max(0, ...Object.values(parsed).map((item) => Number(item?.updatedAt) || 0));
  } catch { return 0; }
}

async function pushWorkspace() {
  if (!persistenceReady || typeof fetch !== 'function') return false;
  const backup = JSON.parse(exportWorkspaceBackup());
  const clientUpdatedAt = Math.max(Date.now(), localWorkspaceUpdatedAt(backup));
  try {
    const response = await fetch(workspaceEndpoint(), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: backup, clientUpdatedAt }),
    });
    if (!response.ok) return false;
    localStorage.setItem(KEY_SYNC_META, String(clientUpdatedAt));
    return true;
  } catch { return false; }
}

function queueWorkspaceSync() {
  if (!persistenceReady || typeof fetch !== 'function') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncInFlight = syncInFlight.then(() => pushWorkspace()).catch(() => false);
  }, 250);
}

/** 启动时与本机文件副本合并；服务不可用时继续使用浏览器存储。 */
export async function initializePersistence() {
  if (persistenceReady) return { available: true, source: 'ready' };
  persistenceReady = true;
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* 浏览器可能不允许持久化请求 */ }
  if (typeof fetch !== 'function') return { available: false, source: 'local' };
  const localBackup = JSON.parse(exportWorkspaceBackup());
  const localHasData = localWorkspaceHasData(localBackup);
  const localUpdatedAt = localWorkspaceUpdatedAt(localBackup);
  try {
    const response = await fetch(workspaceEndpoint(), { cache: 'no-store' });
    if (!response.ok) return { available: false, source: 'local' };
    const payload = await response.json();
    const remote = payload?.workspace;
    const remoteHasData = localWorkspaceHasData(remote);
    const remoteUpdatedAt = Number(payload?.updatedAt) || 0;
    if (remoteHasData && (!localHasData || remoteUpdatedAt > localUpdatedAt)) {
      importWorkspaceBackup(remote, { touch: false });
      localStorage.setItem(KEY_SYNC_META, String(remoteUpdatedAt || Date.now()));
      return { available: true, source: 'file' };
    }
    if (localHasData && (!remoteHasData || localUpdatedAt >= remoteUpdatedAt)) {
      await pushWorkspace();
      return { available: true, source: 'local' };
    }
    return { available: true, source: 'empty' };
  } catch {
    return { available: false, source: 'local' };
  }
}

export function setLastCard(configId, cardId) {
  if (!configId) return;
  const key = 'sil.lastcard.' + configId;
  if (cardId) localStorage.setItem(key, cardId);
  else localStorage.removeItem(key);
  touchWorkspace();
}

export function loadLastCard(configId) {
  return configId ? localStorage.getItem('sil.lastcard.' + configId) : null;
}

/* ============ 作品配置 ============ */

export function listConfigs() {
  return read(KEY_CFG, {});
}

export function saveConfig(id, cfg) {
  const all = listConfigs();
  all[id] = { ...cfg, id, updatedAt: Date.now() };
  write(KEY_CFG, all);
  return all[id];
}

export function loadConfig(id) {
  return listConfigs()[id] || null;
}

export function deleteConfig(id) {
  const all = listConfigs();
  delete all[id];
  write(KEY_CFG, all);
}

export function currentId() {
  return localStorage.getItem(KEY_CUR) || null;
}

export function setCurrentId(id) {
  if (id) localStorage.setItem(KEY_CUR, id);
  else localStorage.removeItem(KEY_CUR);
  touchWorkspace();
}

/* ============ 聊天记录 ============ */

// 键 = configId + ':' + cardId，多角色各存各的对话
function chatKey(configId, cardId) {
  return cardId ? `${configId}:${cardId}` : configId;
}

export function saveChat(configId, messages, cardId) {
  const all = read(KEY_CHAT, {});
  all[chatKey(configId, cardId)] = messages;
  write(KEY_CHAT, all);
}

export function loadChat(configId, cardId) {
  return read(KEY_CHAT, {})[chatKey(configId, cardId)] || [];
}

export function clearChat(configId, cardId) {
  const all = read(KEY_CHAT, {});
  delete all[chatKey(configId, cardId)];
  write(KEY_CHAT, all);
}

/** 某作品下所有角色已有的对话（用于标记「有未读」等） */
export function chatsOfConfig(configId) {
  const all = read(KEY_CHAT, {});
  const out = {};
  for (const k of Object.keys(all)) {
    if (k.startsWith(configId + ':')) {
      out[k.slice(configId.length + 1)] = all[k];
    }
  }
  return out;
}

/* ============ API 配置 ============ */

export function getApiBase() {
  return localStorage.getItem(KEY_API) || 'http://127.0.0.1:8080';
}

export function setApiBase(url) {
  localStorage.setItem(KEY_API, url);
  touchWorkspace();
}

/* ============ 角色卡 ============ */

const KEY_CARDS = 'sil.cards';

export function listCards() {
  return read(KEY_CARDS, {});
}

export function saveCard(card) {
  const all = listCards();
  all[card.id] = { ...card, updatedAt: Date.now() };
  write(KEY_CARDS, all);
  return all[card.id];
}

export function loadCard(id) {
  return listCards()[id] || null;
}

export function deleteCard(id) {
  const all = listCards();
  delete all[id];
  write(KEY_CARDS, all);
}

/* ============ 玩家身份 Persona ============ */

const KEY_PERSONAS = 'sil.personas';
const KEY_PERSONA_CUR = 'sil.persona.current';

export function listPersonas() {
  return read(KEY_PERSONAS, {});
}

export function savePersona(p) {
  const all = listPersonas();
  all[p.id] = { ...p, updatedAt: Date.now() };
  write(KEY_PERSONAS, all);
  return all[p.id];
}

export function loadPersona(id) {
  return listPersonas()[id] || null;
}

export function deletePersona(id) {
  const all = listPersonas();
  delete all[id];
  write(KEY_PERSONAS, all);
  if (currentPersonaId() === id) setCurrentPersonaId(null);
}

export function currentPersonaId() {
  return localStorage.getItem(KEY_PERSONA_CUR) || null;
}

export function setCurrentPersonaId(id) {
  if (id) localStorage.setItem(KEY_PERSONA_CUR, id);
  else localStorage.removeItem(KEY_PERSONA_CUR);
  touchWorkspace();
}

/* ============ 新作品向导草稿与创建 ============ */
const KEY_CREATION = 'sil.creationDraft';
export function loadCreationDraft() { return read(KEY_CREATION, null); }
export function saveCreationDraft(value) { write(KEY_CREATION, value); }
export function clearCreationDraft() { localStorage.removeItem(KEY_CREATION); touchWorkspace(); }

const BACKUP_SCHEMA = 'storyrealm.workspace';
const BACKUP_VERSION = 1;
const BACKUP_KEYS = [KEY_CFG, KEY_CHAT, KEY_CUR, KEY_API, KEY_CARDS, KEY_PERSONAS, KEY_PERSONA_CUR, KEY_CREATION];

function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Complete local backup including conversations, characters, personas and unfinished creation draft. */
export function exportWorkspaceBackup() {
  const data = Object.fromEntries(BACKUP_KEYS.map((key) => [key, localStorage.getItem(key)]));
  const lastCards = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('sil.lastcard.')) lastCards[key] = localStorage.getItem(key);
  }
  return JSON.stringify({ schema: BACKUP_SCHEMA, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data, lastCards }, null, 2);
}

/** Replace this app's local data atomically; existing data is restored if any write fails. */
export function importWorkspaceBackup(input, { touch = true } = {}) {
  const backup = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isRecord(backup) || backup.schema !== BACKUP_SCHEMA || backup.version !== BACKUP_VERSION || !isRecord(backup.data)
    || !isRecord(backup.lastCards || {})) throw new Error('备份格式无效或版本不兼容');
  for (const key of [KEY_CFG, KEY_CHAT, KEY_CARDS, KEY_PERSONAS]) {
    const raw = backup.data[key];
    if (raw == null) continue;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isRecord(parsed)) throw new Error('备份中的数据结构无效：' + key);
  }
  const keys = [...new Set([...BACKUP_KEYS, ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key) => key?.startsWith('sil.lastcard.')), ...Object.keys(backup.lastCards || {})])];
  const before = new Map(keys.map((key) => [key, localStorage.getItem(key)]));
  try {
    for (const key of keys) {
      if (key.startsWith('sil.lastcard.')) localStorage.removeItem(key);
      else if (backup.data[key] == null) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof backup.data[key] === 'string' ? backup.data[key] : JSON.stringify(backup.data[key]));
    }
    for (const [key, value] of Object.entries(backup.lastCards || {})) {
      if (!key.startsWith('sil.lastcard.') || typeof value !== 'string') throw new Error('备份中的角色绑定无效');
      localStorage.setItem(key, value);
    }
  } catch (error) {
    for (const [key, value] of before) {
      try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* best effort rollback */ }
    }
    throw new Error('备份恢复失败，当前数据已尝试还原。' + (error?.message ? ` ${error.message}` : ''));
  }
  if (touch) touchWorkspace();
  return currentId();
}

/** 明确创建后才提交；任一步存储失败则恢复之前的数据。 */
export function saveStoryBundle({ configId, cfg, card, persona }) {
  if (!configId || !cfg || !card?.id || !persona?.id || cfg.personaId !== persona.id) {
    throw new Error('新作品数据不完整');
  }
  const configs = listConfigs(), cards = listCards(), personas = listPersonas();
  if (configs[configId] || cards[card.id] || personas[persona.id]) throw new Error('新作品标识重复，请重试创建');
  const lastCardKey = 'sil.lastcard.' + configId;
  const keys = [KEY_CFG, KEY_CARDS, KEY_PERSONAS, lastCardKey, KEY_CUR, KEY_PERSONA_CUR, KEY_SYNC_META];
  const before = new Map(keys.map((key) => [key, localStorage.getItem(key)]));
  const now = Date.now();
  try {
    localStorage.setItem(KEY_CARDS, JSON.stringify({ ...cards, [card.id]: { ...card, updatedAt: now } }));
    localStorage.setItem(KEY_PERSONAS, JSON.stringify({ ...personas, [persona.id]: { ...persona, updatedAt: now } }));
    localStorage.setItem(KEY_CFG, JSON.stringify({ ...configs, [configId]: { ...cfg, id: configId, updatedAt: now } }));
    localStorage.setItem(lastCardKey, card.id);
    localStorage.setItem(KEY_CUR, configId);
    localStorage.setItem(KEY_PERSONA_CUR, persona.id);
    touchWorkspace();
  } catch (error) {
    let restored = true;
    for (const [key, value] of before) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      catch { restored = false; }
    }
    throw new Error(restored ? '保存失败，未创建作品；草稿仍保留，请检查浏览器存储空间后重试。'
      : '保存失败且部分数据无法恢复，请先保留草稿并检查浏览器存储空间。');
  }
  return configId;
}
