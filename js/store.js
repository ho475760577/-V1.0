/**
 * 本地存储：作品配置 + 聊天记录，全部落在浏览器 localStorage
 */

const KEY_CFG = 'sil.configs';
const KEY_CHAT = 'sil.chat';
const KEY_CUR = 'sil.current';
const KEY_API = 'sil.api';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.error('存储失败', e);
    alert('本地存储写入失败，可能是空间已满或处于隐私模式');
  }
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
}

/* ============ 新作品向导草稿与创建 ============ */
const KEY_CREATION = 'sil.creationDraft';
export function loadCreationDraft() { return read(KEY_CREATION, null); }
export function saveCreationDraft(value) { write(KEY_CREATION, value); }
export function clearCreationDraft() { localStorage.removeItem(KEY_CREATION); }

/** 明确创建后才提交；任一步存储失败则恢复之前的数据。 */
export function saveStoryBundle({ configId, cfg, card, persona }) {
  if (!configId || !cfg || !card?.id || !persona?.id || cfg.personaId !== persona.id) {
    throw new Error('新作品数据不完整');
  }
  const configs = listConfigs(), cards = listCards(), personas = listPersonas();
  if (configs[configId] || cards[card.id] || personas[persona.id]) throw new Error('新作品标识重复，请重试创建');
  const lastCardKey = 'sil.lastcard.' + configId;
  const keys = [KEY_CFG, KEY_CARDS, KEY_PERSONAS, lastCardKey, KEY_CUR, KEY_PERSONA_CUR];
  const before = new Map(keys.map((key) => [key, localStorage.getItem(key)]));
  const now = Date.now();
  try {
    localStorage.setItem(KEY_CARDS, JSON.stringify({ ...cards, [card.id]: { ...card, updatedAt: now } }));
    localStorage.setItem(KEY_PERSONAS, JSON.stringify({ ...personas, [persona.id]: { ...persona, updatedAt: now } }));
    localStorage.setItem(KEY_CFG, JSON.stringify({ ...configs, [configId]: { ...cfg, id: configId, updatedAt: now } }));
    localStorage.setItem(lastCardKey, card.id);
    localStorage.setItem(KEY_CUR, configId);
    localStorage.setItem(KEY_PERSONA_CUR, persona.id);
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
