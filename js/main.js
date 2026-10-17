/**
 * 主界面逻辑
 */
import { assemble, makeBlock, makeEntry, SCAN, MATCH, SCOPE, ENTRY_TYPE_LABELS, exportConfig, importConfig } from './assembler.js';
import { llm, LLM } from './llm.js';
import * as store from './store.js';
import { parseReply, parseState, parseStructuredReply, serializeStructuredReply, buildPanelFrame, formatText, escapeHtml } from './render.js';
import { initCard, selectCard as selectEditorCard } from './card-panel.js';
import { makePersona, personaToBlock, compressImage, avatarPlaceholder, PERSONA_PRESETS } from './persona.js';
import { getBodyLength, getBodyTarget, MAX_BODY_CHARS, TARGET_BODY_CHARS, generationOptions } from './prompts.js';
import { profileEditor } from './profile.js';
import { profileAIEditor, bindProfileAI } from './profile-assist.js';
import { migrateNarrativeInstructions } from './narrative.js';
import { openStoryCreator } from './story-creator-panel.js';
import { mergeMemory, memoryToMarkdown, normalizeMemory, parseMemoryMarkdown } from './memory.js';

const $ = (id) => document.getElementById(id);
const EMPTY_SCENE = {
  time: '', world: '', location: '', plot: '', weather: '', atmosphere: '', lighting: '',
  sounds: [], scents: [], participants: [], objects: [], goal: '', conflict: '', tension: '',
};

/* ============ 应用状态 ============ */
const state = {
  configId: null,
  cfg: null,
  cardId: null,        // 当前激活的角色卡
  personaId: null,     // 当前玩家身份
  messages: [],
  busy: false,
  memoryBusy: false,
  streaming: false,
  contextVersion: 0,
  tab: 'card',
};

const getCard = () => (state.cardId ? store.loadCard(state.cardId) : null);
const getPersona = () => (state.personaId ? store.loadPersona(state.personaId) : null);

/* ============ 初始化 ============ */
async function init() {
  await store.initializePersistence();
  llm.base = store.getApiBase();
  $('apiBase').value = llm.base;

  const ids = Object.keys(store.listConfigs());
  if (ids.length) {
    selectConfig(store.currentId() || ids[0]);
  } else {
    newConfig();
  }
  renderConfigList();
  renderCastBar();
  renderBlocks();
  renderEntries();
  renderVars();
  renderPersona();
  bindEvents();
  checkHealth();

  initCard(
    () => state.cfg,
    (blocks) => applyCardToConfig(blocks),
    () => { renderBlocks(); renderVars(); renderChat(); },
    (cardId) => { switchCast(cardId); }
  );
}

/* ============ 作品管理 ============ */
function newConfig() {
  state.contextVersion += 1;
  state.configId = 'cfg_' + Date.now().toString(36);
  state.cfg = {
    name: '新作品',
    blocks: [makeBlock({ name: '主提示词', order: 0, content: '你是一个角色扮演引擎。请沉浸地扮演角色。' })],
    entries: [],
    vars: { enabled: false, prompt: '', historyLimit: 20 },
    memory: { enabled: false, summary: '', markdown: '', threshold: 20, keepRecent: 8, shortTerm: [], longTerm: [] },
    choices: { enabled: false },
    responseFormat: { enabled: true, showReview: false },
    scene: { ...EMPTY_SCENE },
    greeting: '',
    personaId: null,
  };
  state.messages = [];
  state.cardId = null;
  state.personaId = null;
  state.memoryBusy = false;
  store.setCurrentId(state.configId);
  store.saveConfig(state.configId, state.cfg);
  renderConfigList();
  renderCastBar();
  renderBlocks(); renderEntries(); renderVars();
  renderPersona();
  $('msgList').innerHTML = '';
  $('chatTitle').textContent = '新作品';
  if ($('cfgName')) $('cfgName').value = state.cfg.name;
}

function selectConfig(id) {
  const cfg = store.loadConfig(id);
  if (!cfg) return newConfig();
  state.configId = id;
  state.cfg = {
    ...cfg,
    memory: normalizeMemory({ enabled: false, summary: '', markdown: '', threshold: 20, keepRecent: 8, shortTerm: [], longTerm: [], ...(cfg.memory || {}) }),
    choices: { enabled: false, ...(cfg.choices || {}) },
    // 旧作品没有该字段时，默认恢复结构化剧情模板；明确关闭的作品仍保持关闭。
    responseFormat: { enabled: cfg.responseFormat?.enabled ?? true, showReview: false, ...(cfg.responseFormat || {}) },
    scene: { ...EMPTY_SCENE, ...(cfg.scene || {}) },
  };
  // 兼容已保存作品中的旧版格式指令，不改聊天历史、开场白或人物正文。
  for (const block of state.cfg.blocks || []) {
    if (['主提示词', '篇幅要求'].includes(block.name)) {
      block.content = migrateNarrativeInstructions(block.content);
    }
  }
  // 身份按作品绑定；没有绑定时保持空，不继承上一个作品的身份
  state.personaId = cfg.personaId || null;
  // 恢复该作品上次激活的角色
  const savedCardId = store.loadLastCard(id);
  state.cardId = savedCardId && store.loadCard(savedCardId) ? savedCardId : null;
  state.contextVersion += 1;
  state.messages = store.loadChat(id, state.cardId);
  store.setCurrentId(id);
  $('chatTitle').textContent = cfg.name;
  if ($('cfgName')) $('cfgName').value = cfg.name || '';
  renderConfigList();
  renderCastBar();
  renderBlocks(); renderEntries(); renderVars(); renderPersona();
  renderChat();
}

function persist() {
  try {
    store.saveConfig(state.configId, state.cfg);
    store.saveChat(state.configId, state.messages, state.cardId);
    if (state.cardId) store.setLastCard(state.configId, state.cardId);
    const status = $('saveStatus');
    if (status) { status.textContent = ''; status.className = 'tb-stat'; }
    return true;
  } catch (error) {
    const status = $('saveStatus');
    if (status) {
      status.textContent = error.message;
      status.className = 'tb-stat bad';
    }
    return false;
  }
}

function persistConversation(context) {
  store.saveConfig(context.configId, context.cfg);
  store.saveChat(context.configId, context.messages, context.cardId);
  if (context.cardId) store.setLastCard(context.configId, context.cardId);
}

function applyCardToConfig(blocks) {
  const names = new Set(blocks.map((b) => b.name));
  const kept = state.cfg.blocks.filter((b) => b.name !== '篇幅要求' && !names.has(b.name));
  state.cfg.blocks = [...kept, ...blocks.map((b) => makeBlock(b))];
  persist();
}

function renderConfigList() {
  const box = $('configList');
  const all = store.listConfigs();
  const ids = Object.keys(all).sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));
  if (!ids.length) { box.innerHTML = '<div class="empty">暂无作品</div>'; return; }
  box.innerHTML = ids.map((id) => {
    const c = all[id];
    return `<div class="cfg-item ${id === state.configId ? 'active' : ''}" data-id="${id}">
      <span class="cfg-name">${escapeHtml(c.name || '未命名')}</span>
      <span class="cfg-meta">${c.entries?.length || 0} 条世界书</span>
    </div>`;
  }).join('');
  box.querySelectorAll('.cfg-item').forEach((el) => {
    el.onclick = () => selectConfig(el.dataset.id);
  });
}

/* ============ 角色栏（多角色） ============ */

function renderCastBar() {
  const box = $('castBar');
  const cards = store.listCards();
  const ids = Object.keys(cards).sort((a, b) => (cards[b].updatedAt || 0) - (cards[a].updatedAt || 0));
  const chats = store.chatsOfConfig(state.configId);

  const items = [{ id: '', card: null }].concat(
    ids.map((id) => ({ id, card: cards[id] }))
  );

  box.innerHTML = items.map(({ id, card }) => {
    const av = card ? cardAvatarOf(card) : avatarPlaceholder('无');
    const hasChat = id && (chats[id]?.length || 0) > 0;
    return `<div class="cast ${id === state.cardId ? 'on' : ''}" data-id="${id}" title="${escapeHtml(card ? (card.name || '未命名') : '不指定角色')}">
      <span class="cast-av" style="${av.url ? `background-image:url(${av.url})` : `background:${av.color}`}">
        ${av.url ? '' : escapeHtml(av.text)}
        ${hasChat ? '<i class="cast-dot"></i>' : ''}
      </span>
      <span class="cast-nm">${escapeHtml(card ? (card.name || '未命名') : '无角色')}</span>
    </div>`;
  }).join('');

  box.querySelectorAll('.cast').forEach((el) => {
    el.onclick = () => switchCast(el.dataset.id || null);
  });
}

function cardAvatarOf(card) {
  if (card.avatar) return { url: card.avatar, ...avatarPlaceholder(card.name) };
  return avatarPlaceholder(card.name);
}

function switchCast(cardId) {
  if (cardId === state.cardId) return;
  state.contextVersion += 1;
  state.cardId = cardId;
  state.messages = store.loadChat(state.configId, cardId);
  persist();
  renderCastBar();
  renderChat();
}

/* ============ 玩家身份 Persona ============ */

function renderPersona() {
  const personas = store.listPersonas();
  const ids = Object.keys(personas).sort((a, b) => (personas[b].updatedAt || 0) - (personas[a].updatedAt || 0));
  const cur = state.personaId ? personas[state.personaId] : null;

  // 顶部条
  const av = cur ? (cur.avatar ? { url: cur.avatar, ...avatarPlaceholder(cur.name) } : avatarPlaceholder(cur.name)) : avatarPlaceholder('我');
  const bar = $('personaChip');
  bar.innerHTML = `
    <span class="pc-av" style="${av.url ? `background-image:url(${av.url})` : `background:${av.color}`}">
      ${av.url ? '' : escapeHtml(av.text)}
    </span>
    <span class="pc-nm">${escapeHtml(cur ? (cur.name || '未设置身份') : '设置「我」')}</span>`;
  bar.title = '点击设置玩家身份';

  // 编辑面板
  const box = $('personaBox');
  if (!cur) {
    box.innerHTML = `
      <div class="p-empty">
        还没设置玩家身份。模型不知道「你」是谁，互动会变得很泛。
      </div>
      <button id="newPersona" class="add-btn">+ 创建我的身份</button>
      <label class="mini">或者套个预设</label>
      <div id="pPresetList" class="tpl-list"></div>
      <div id="pEditor"></div>`;
  } else {
    box.innerHTML = `<div id="pEditor"></div>`;
  }

  // 预设列表
  const pl = $('pPresetList');
  if (pl) {
    pl.innerHTML = PERSONA_PRESETS.map((p) => `
      <button class="tpl" data-k="${p.key}">
        <span class="tpl-icon">${p.icon}</span><span class="tpl-label">${p.label}</span>
      </button>`).join('');
    pl.querySelectorAll('.tpl').forEach((el) => {
      el.onclick = () => {
        const tpl = PERSONA_PRESETS.find((x) => x.key === el.dataset.k);
        const p = makePersona({ name: '', ...tpl.data });
        p.name = tpl.label;
        state.personaId = p.id;
        store.savePersona(p);
        store.setCurrentPersonaId(p.id);
        state.cfg.personaId = p.id;
        persist();
        renderPersona();
      };
    });
  }

  if ($('newPersona')) {
    $('newPersona').onclick = () => {
      const p = makePersona();
      state.personaId = p.id;
      store.savePersona(p);
      store.setCurrentPersonaId(p.id);
      state.cfg.personaId = p.id;
      persist();
      renderPersona();
    };
  }

  renderPersonaFields(cur);
}

function renderPersonaFields(p) {
  const box = $('pEditor');
  if (!box) return;
  if (!p) { box.innerHTML = ''; return; }

  const av = p.avatar ? { url: p.avatar } : avatarPlaceholder(p.name);

  box.innerHTML = `
    <div class="p-av-row">
      <span class="p-av" style="${av.url ? `background-image:url(${av.url})` : `background:${av.color}`}">
        ${av.url ? '' : escapeHtml(av.text)}
      </span>
      <div class="p-av-btns">
        <button id="pUpImg" class="mini-btn">上传头像</button>
        ${p.avatar ? '<button id="pDelImg" class="mini-btn">移除</button>' : ''}
        <input id="pImgFile" type="file" accept="image/*" hidden>
      </div>
      <select id="pSel" class="card-sel">
        ${Object.values(store.listPersonas())
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${escapeHtml(x.name || '未命名')}</option>`)
          .join('')}
        ${Object.keys(store.listPersonas()).length <= 1 ? '<option value="__new__">+ 新建身份</option>' : ''}
      </select>
      ${Object.keys(store.listPersonas()).length > 1 ? '<button id="pDel" class="mini-btn">删除</button>' : ''}
    </div>

    <div class="cf">
      <label class="mini">我的名字<span class="cf-hint">替换提示词里的 {{user}}</span></label>
      <input class="cf-in" data-pk="name" value="${escapeHtml(p.name || '')}" placeholder="例如：沈砚">
    </div>
    ${profileAIEditor('persona', p.id)}
    ${profileEditor(p, 'data-pk')}
    <div class="cf">
      <label class="mini">外貌<span class="cf-hint">面容、发型、整体印象</span></label>
      <textarea class="cf-ta" data-pk="appearance" rows="3">${escapeHtml(p.appearance || '')}</textarea>
    </div>
    <div class="cf">
      <label class="mini">身份<span class="cf-hint">我是谁、和对方是什么关系</span></label>
      <textarea class="cf-ta" data-pk="identity" rows="2">${escapeHtml(p.identity || '')}</textarea>
    </div>
    <div class="cf">
      <label class="mini">性格<span class="cf-hint">影响对方如何对待我</span></label>
      <textarea class="cf-ta" data-pk="personality" rows="2">${escapeHtml(p.personality || '')}</textarea>
    </div>
    <div class="cf">
      <label class="mini">经历与背景<span class="cf-hint">成长经历、关系来源、重要往事</span></label>
      <textarea class="cf-ta" data-pk="background" rows="3">${escapeHtml(p.background || '')}</textarea>
    </div>
    <div class="cf">
      <label class="mini">备注<span class="cf-hint">不进入提示词，仅自己看</span></label>
      <textarea class="cf-ta" data-pk="note" rows="2">${escapeHtml(p.note || '')}</textarea>
    </div>
    <button id="pApply" class="add-btn">应用到当前作品</button>`;

  bindProfileAI(box, {
    kind: 'persona', id: p.id, llm, load: store.loadPersona,
    save: (updated) => { store.savePersona(updated); },
    currentId: () => state.personaId, refresh: renderPersona,
  });

  box.querySelectorAll('[data-pk]').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
    el[ev] = () => {
      const cur = store.loadPersona(p.id) || p;
      cur[el.dataset.pk] = el.value;
      if (el.dataset.pk === 'gender') cur.pronoun = '';
      store.savePersona(cur);
      state.personaId = cur.id;
      store.setCurrentPersonaId(cur.id);
      state.cfg.personaId = cur.id;
      $('personaChip').innerHTML = `
        <span class="pc-av" style="background:${cur.avatar ? `url(${cur.avatar}) center/cover` : avatarPlaceholder(cur.name).color}">
          ${cur.avatar ? '' : escapeHtml(avatarPlaceholder(cur.name).text)}
        </span>
        <span class="pc-nm">${escapeHtml(cur.name || '未设置身份')}</span>`;
      persist();
      if (el.dataset.pk === 'gender') renderPersona();
    };
  });

  $('pUpImg').onclick = () => $('pImgFile').click();
  $('pImgFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const cur = store.loadPersona(p.id) || p;
      cur.avatar = await compressImage(f, 256, 0.85);
      store.savePersona(cur);
      renderPersona();
    } catch (err) {
      alert(err.message);
    }
    e.target.value = '';
  };
  if ($('pDelImg')) {
    $('pDelImg').onclick = () => {
      const cur = store.loadPersona(p.id);
      cur.avatar = '';
      store.savePersona(cur);
      renderPersona();
    };
  }
  if ($('pDel')) {
    $('pDel').onclick = () => {
      if (!confirm('删除这个身份？')) return;
      store.deletePersona(p.id);
      const rest = Object.keys(store.listPersonas());
      state.personaId = rest[0] || null;
      state.cfg.personaId = state.personaId;
      if (state.personaId) store.setCurrentPersonaId(state.personaId);
      persist();
      renderPersona();
    };
  }

  $('pSel').onchange = (e) => {
    const v = e.target.value;
    if (v === '__new__') {
      const np = makePersona();
      store.savePersona(np);
      state.personaId = np.id;
    } else {
      state.personaId = v;
    }
    store.setCurrentPersonaId(state.personaId);
    state.cfg.personaId = state.personaId;
    persist();
    renderPersona();
  };

  $('pApply').onclick = () => {
    state.cfg.personaId = state.personaId;
    persist();
    $('statHit').textContent = '身份已应用';
    setTimeout(() => { $('statHit').textContent = ''; }, 1600);
  };
}

/* ============ 模型健康检查 ============ */

async function checkHealth() {
  const dot = $('healthDot');
  const txt = $('healthTxt');
  if (!dot || !txt) return;

  const ok = await llm.health();
  dot.className = 'dot ' + (ok ? 'ok' : 'bad');
  txt.textContent = ok ? '模型已连接' : '模型未连接';
  txt.title = ok ? `已连接 ${llm.base}` : '请先启动 llama-server';
}

/* ============ 生成参数 ============ */
function genOpts() {
  return generationOptions(state.cfg);
}

/* ============ 基础设置：设定块 ============ */
function renderBlocks() {
  const box = $('blockList');
  const blocks = [...(state.cfg.blocks || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!blocks.length) { box.innerHTML = '<div class="empty">还没有设定块</div>'; return; }

  box.innerHTML = blocks.map((b) => `
    <div class="block-card" data-id="${b.id}">
      <div class="bc-head">
        <input class="bc-name" value="${escapeHtml(b.name)}" placeholder="块名称">
        <label class="mini">插入顺序
          <input class="bc-order" type="number" value="${b.order || 0}">
        </label>
        <label class="chk"><input class="bc-on" type="checkbox" ${b.enabled ? 'checked' : ''}>启用</label>
        <button class="del" title="删除">×</button>
      </div>
      <textarea class="bc-body" rows="5" placeholder="内容...">${escapeHtml(b.content)}</textarea>
      <div class="bc-foot"><span class="count">0 字</span></div>
    </div>`).join('');

  box.querySelectorAll('.block-card').forEach(card => {
    const id = card.dataset.id;
    const find = () => state.cfg.blocks.find((b) => b.id === id);

    const body = card.querySelector('.bc-body');
    const counter = card.querySelector('.count');
    const updateCount = () => { counter.textContent = body.value.length + ' 字'; };
    updateCount();

    body.oninput = () => { find().content = body.value; updateCount(); persist(); };
    card.querySelector('.bc-name').oninput = (e) => { find().name = e.target.value; persist(); renderConfigList(); };
    card.querySelector('.bc-order').onchange = (e) => { find().order = parseInt(e.target.value) || 0; persist(); renderBlocks(); };
    card.querySelector('.bc-on').onchange = (e) => { find().enabled = e.target.checked; persist(); };
    card.querySelector('.del').onclick = () => {
      state.cfg.blocks = state.cfg.blocks.filter((b) => b.id !== id);
      persist(); renderBlocks();
    };
  });
}

/* ============ 世界书 ============ */
function renderEntries() {
  const box = $('entryList');
  const entries = state.cfg.entries || [];
  if (!entries.length) {
    box.innerHTML = '<div class="empty">还没有世界书条目<br><small>把「不必随时触发」的设定放这里，按关键词自动注入</small></div>';
    return;
  }

  box.innerHTML = entries.map((e) => `
    <div class="entry-card ${e.enabled ? '' : 'off'}" data-id="${e.id}">
      <div class="ec-head">
        <label class="chk"><input class="ec-on" type="checkbox" ${e.enabled ? 'checked' : ''}>启用</label>
        <label class="chk"><input class="ec-const" type="checkbox" ${e.constant ? 'checked' : ''}>常驻</label>
        <select class="ec-type" title="设定类型">${Object.entries(ENTRY_TYPE_LABELS).map(([key, label]) => `<option value="${key}" ${(e.type || 'general') === key ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <input class="ec-cat" value="${escapeHtml(e.category || '')}" placeholder="分类">
        <input class="ec-order" type="number" value="${e.order || 100}" title="数字越小越靠前">
        <button class="ec-del" title="删除">×</button>
      </div>
      <div class="ec-row">
        <label class="mini">触发区域</label>
        <select class="ec-scan">
          <option value="both" ${e.scan === 'both' ? 'selected' : ''}>用户+AI</option>
          <option value="user" ${e.scan === 'user' ? 'selected' : ''}>仅用户</option>
          <option value="ai" ${e.scan === 'ai' ? 'selected' : ''}>仅 AI</option>
        </select>
        <label class="mini">匹配</label>
        <select class="ec-match">
          <option value="any" ${e.match === 'any' ? 'selected' : ''}>或（任一）</option>
          <option value="all" ${e.match === 'all' ? 'selected' : ''}>与（全部）</option>
        </select>
        <label class="mini">影响范围</label>
        <select class="ec-scope">
          <option value="prompt" ${e.scope === 'prompt' ? 'selected' : ''}>提示词</option>
          <option value="prepend" ${e.scope === 'prepend' ? 'selected' : ''}>前置词</option>
          <option value="append" ${e.scope === 'append' ? 'selected' : ''}>后置词</option>
        </select>
      </div>
      <textarea class="ec-keys" rows="1" placeholder="触发关键词，逗号分隔（支持 /正则/）">${escapeHtml((e.keys || []).join(', '))}</textarea>
      <details class="ec-conditions"><summary>高级触发条件</summary><div class="ec-condition-grid">
        <label class="mini">满足任一条件词<textarea class="ec-requires" rows="1" placeholder="例如：发现旧信，关系转为信任">${escapeHtml((e.requires || []).join(', '))}</textarea></label>
        <label class="mini">排除任一条件词<textarea class="ec-excludes" rows="1" placeholder="例如：已离开山城">${escapeHtml((e.excludes || []).join(', '))}</textarea></label>
        <label class="mini">关系阶段<textarea class="ec-stage" rows="1" placeholder="留空表示不限阶段">${escapeHtml(e.relationshipStage || '')}</textarea></label>
      </div><small>条件词会检查当前输入、场景、角色关系和局势；关系阶段需匹配当前角色状态。</small></details>
      <textarea class="ec-body" rows="4" placeholder="内容—— 必须是完整独立的陈述，模型只看得到这一段">${escapeHtml(e.content)}</textarea>
    </div>`).join('');

  box.querySelectorAll('.entry-card').forEach(card => {
    const id = card.dataset.id;
    const find = () => state.cfg.entries.find((x) => x.id === id);

    card.querySelector('.ec-on').onchange = (e) => { find().enabled = e.target.checked; persist(); renderEntries(); };
    card.querySelector('.ec-const').onchange = (e) => { find().constant = e.target.checked; persist(); };
    card.querySelector('.ec-type').onchange = (e) => { find().type = e.target.value; persist(); };
    card.querySelector('.ec-cat').oninput = (e) => { find().category = e.target.value; persist(); };
    card.querySelector('.ec-order').onchange = (e) => { find().order = parseInt(e.target.value) || 100; persist(); };
    card.querySelector('.ec-scan').onchange = (e) => { find().scan = e.target.value; persist(); };
    card.querySelector('.ec-match').onchange = (e) => { find().match = e.target.value; persist(); };
    card.querySelector('.ec-scope').onchange = (e) => { find().scope = e.target.value; persist(); };
    card.querySelector('.ec-keys').oninput = (e) => {
      find().keys = e.target.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      persist();
    };
    for (const [selector, key] of [['.ec-requires', 'requires'], ['.ec-excludes', 'excludes']]) {
      card.querySelector(selector).oninput = (event) => {
        find()[key] = event.target.value.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean);
        persist();
      };
    }
    card.querySelector('.ec-stage').oninput = (event) => { find().relationshipStage = event.target.value.trim(); persist(); };
    card.querySelector('.ec-body').oninput = (e) => { find().content = e.target.value; persist(); };
    card.querySelector('.ec-del').onclick = () => {
      state.cfg.entries = state.cfg.entries.filter((x) => x.id !== id);
      persist(); renderEntries(); renderConfigList();
    };
  });
}

/* ============ 变量面板 ============ */
function renderVars() {
  const v = state.cfg.vars || {};
  $('varsOn').checked = !!v.enabled;
  $('varsPrompt').value = v.prompt || '';
  $('varsHistory').value = v.historyLimit || 20;
  $('varsPanel').style.display = v.enabled ? 'block' : 'none';
  if ($('greetingBox')) $('greetingBox').value = state.cfg.greeting || '';
  renderStatePanel();
  renderMemory();
  if ($('choicesOn')) $('choicesOn').checked = !!state.cfg.choices?.enabled;
  if ($('formatOn')) $('formatOn').checked = !!state.cfg.responseFormat?.enabled;
  if ($('formatReview')) $('formatReview').checked = !!state.cfg.responseFormat?.showReview;
  if ($('formatPanel')) $('formatPanel').style.display = state.cfg.responseFormat?.enabled ? 'block' : 'none';
}

const DEFAULT_VARS_PROMPT = `请维护当前游戏状态。每次回复末尾追加一段严格 JSON，格式为 <State>{"字段名": "值"}</State>。只输出当前状态对象，不要把 JSON 放进普通台词中。`;

function renderStatePanel() {
  const box = $('statePanel');
  if (!box) return;
  const vars = state.cfg?.vars || {};
  const values = vars.values && typeof vars.values === 'object' ? vars.values : {};
  const keys = Object.keys(values);
  if (!vars.enabled || !keys.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="state-head"><span>当前状态</span><button class="mini-btn" data-state-clear title="清除状态">清除</button></div>
    <div class="state-grid">${keys.map((key) => `
      <div class="state-item"><span class="state-key">${escapeHtml(key)}</span><span class="state-value">${escapeHtml(formatStateValue(values[key]))}</span></div>
    `).join('')}</div>`;
  box.querySelector('[data-state-clear]').onclick = () => {
    state.cfg.vars.values = {};
    persist();
    renderStatePanel();
  };
}

function formatStateValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function applyStateFromReply(raw) {
  const parsed = parseState(raw);
  if (!parsed.state) return parsed;
  state.cfg.vars = state.cfg.vars || {};
  state.cfg.vars.values = { ...(state.cfg.vars.values || {}), ...parsed.state };
  persist();
  renderStatePanel();
  return parsed;
}

/** Apply structured data to its owning story, even if the visible story changes mid-stream. */
function applyStructuredReplyToConfig(raw, cfg) {
  const parsed = parseStructuredReply(raw);
  let changed = false;

  if (parsed.state) {
    cfg.vars = cfg.vars || {};
    cfg.vars.values = { ...(cfg.vars.values || {}), ...parsed.state };
    changed = true;
  }

  if (parsed.scene && typeof parsed.scene === 'object') {
    const next = { ...(cfg.scene || {}) };
    for (const key of ['time', 'world', 'location', 'plot', 'weather', 'atmosphere', 'lighting', 'goal', 'conflict']) {
      if (Object.hasOwn(parsed.scene, key)) next[key] = String(parsed.scene[key] ?? '').trim();
    }
    if (Object.hasOwn(parsed.scene, 'tension')) next.tension = parsed.scene.tension ?? '';
    for (const key of ['sounds', 'scents', 'participants', 'objects']) {
      if (Object.hasOwn(parsed.scene, key) && Array.isArray(parsed.scene[key])) next[key] = parsed.scene[key];
    }
    cfg.scene = next;
    changed = true;
  }

  if (parsed.player) { cfg.playerState = parsed.player; changed = true; }
  if (parsed.characters) { cfg.characterStates = parsed.characters; changed = true; }
  if (parsed.situation) { cfg.situation = parsed.situation; changed = true; }

  if (parsed.changes && typeof parsed.changes === 'object') {
    cfg.lastChanges = parsed.changes;
    changed = true;
  }

  if (parsed.memory && typeof parsed.memory === 'object') {
    cfg.memory = mergeMemory(cfg.memory || {}, parsed.memory);
    changed = true;
  }

  return { parsed, changed };
}

/** Apply a reply to the currently selected story and refresh its panels. */
function applyStructuredReply(raw) {
  const result = applyStructuredReplyToConfig(raw, state.cfg);
  if (result.changed) {
    persist();
    renderStatePanel();
    renderMemory();
  }
  return result.parsed;
}

function renderMemory() {
  const m = state.cfg.memory || {};
  if ($('memoryOn')) $('memoryOn').checked = !!m.enabled;
  if ($('memorySummary')) $('memorySummary').value = m.summary || '';
  if ($('memoryMarkdown')) $('memoryMarkdown').value = m.markdown || memoryToMarkdown(m);
  if ($('memoryThreshold')) $('memoryThreshold').value = m.threshold || 20;
  if ($('memoryKeep')) $('memoryKeep').value = m.keepRecent || 8;
  if ($('memoryPanel')) $('memoryPanel').style.display = m.enabled ? 'block' : 'none';
}

function setMemoryStatus(text, kind = '') {
  const box = $('memoryStatus');
  if (!box) return;
  box.textContent = text;
  box.className = 'ai-status ' + kind;
}

async function summarizeMemory(force = false) {
  if (state.memoryBusy) return;
  const context = { version: state.contextVersion, configId: state.configId, cardId: state.cardId, cfg: state.cfg, messages: state.messages };
  const m = context.cfg.memory || {};
  if (!m.enabled && !force) return;
  const keep = Math.max(2, Math.min(30, Number(m.keepRecent) || 8));
  const old = context.messages.slice(0, -keep);
  if (old.length < 2) {
    if (context.version === state.contextVersion) setMemoryStatus('对话还不够长，暂时无需摘要。');
    return;
  }

  state.memoryBusy = true;
  if (context.version === state.contextVersion) setMemoryStatus('正在整理较早对话…', 'busy');
  const transcript = old.map((x) => `${x.role === 'user' ? '用户' : '角色'}：${x.content}`).join('\n');
  const previous = m.markdown ? `已有 Markdown 记忆：\n${m.markdown}\n\n` : (m.summary ? `已有摘要：\n${m.summary}\n\n` : '');
  try {
    const result = await llm.chat([
      { role: 'system', content: '你是角色扮演对话的记忆整理器。保留人物关系、已经发生的事实、承诺、未解决的线索和当前情绪。只输出 Markdown，不要输出思维链、解释或 JSON。必须使用以下标题：# 剧情记忆、## 对话摘要、## 长期记忆、## 短期记忆；事实使用无序列表。' },
      { role: 'user', content: `${previous}请把下面的较早对话整理成可供后续模型延续剧情的 Markdown 记忆档案。合并重复事实，删除已经被明确推翻的旧状态，但不要凭空补充：\n${transcript}` },
    ], { temperature: 0.25, max_tokens: 500 });
    const markdown = (result.content || '').trim();
    if (!markdown) throw new Error('模型没有返回摘要');
    const parsed = parseMemoryMarkdown(markdown);
    context.cfg.memory = normalizeMemory({ ...m, ...parsed, summary: parsed.summary || m.summary, markdown, enabled: true, keepRecent: keep });
    context.messages = context.messages.slice(-keep);
    persistConversation(context);
    if (context.version === state.contextVersion) {
      state.messages = context.messages;
      renderMemory();
      renderChat();
      setMemoryStatus(`已整理 ${old.length} 条旧消息，保留最近 ${keep} 条。`, 'ok');
    }
  } catch (err) {
    if (context.version === state.contextVersion) setMemoryStatus('摘要失败：' + err.message, 'bad');
    console.error(err);
  } finally {
    state.memoryBusy = false;
  }
}

function maybeAutoSummarize() {
  const m = state.cfg.memory || {};
  const threshold = Math.max(6, Number(m.threshold) || 20);
  if (m.enabled && state.messages.length >= threshold) summarizeMemory(false);
}

/* ============ 聊天 ============ */
function renderChat() {
  const box = $('msgList');
  box.innerHTML = '';
  const card = getCard();

  // 顶部显示当前角色
  if (card) {
    const av = cardAvatarOf(card);
    const head = document.createElement('div');
    head.className = 'cast-head';
    head.innerHTML = `
      <span class="ch-av" style="${av.url ? `background-image:url(${av.url})` : `background:${av.color}`}">
        ${av.url ? '' : escapeHtml(av.text)}
      </span>
      <span class="ch-nm">${escapeHtml(card.name || '未命名')}</span>
      ${card.tagline ? `<span class="ch-tag">${escapeHtml(card.tagline)}</span>` : ''}`;
    box.appendChild(head);
  }

  if (state.cfg.greeting && state.messages.length === 0) {
    const g = document.createElement('div');
    g.className = 'greet';
    g.innerHTML = formatText(escapeHtml(state.cfg.greeting));
    box.appendChild(g);
  }

  for (const m of state.messages) box.appendChild(bubbleFor(m));
  scrollDown();
}

function bubbleFor(m) {
  const div = document.createElement('div');
  div.className = 'msg ' + m.role;

  if (m.role === 'user') {
    const p = getPersona();
    const av = p ? (p.avatar ? { url: p.avatar, ...avatarPlaceholder(p.name) } : avatarPlaceholder(p.name)) : avatarPlaceholder('我');
    const who = p && p.name ? p.name : '我';
    div.innerHTML = `
      <span class="msg-av" style="${av.url ? `background-image:url(${av.url})` : `background:${av.color}`}">
        ${av.url ? '' : escapeHtml(av.text)}
      </span>
      <div class="bubble">
        <div class="msg-who">${escapeHtml(who)}</div>
        ${formatText(escapeHtml(m.content))}
      </div>`;
    return div;
  }

  const wrap = document.createElement('div');
  wrap.className = 'bubble ai-bubble';
  const structured = parseStructuredReply(m.content || '');
  appendSceneStrip(wrap, structured.scene);
  for (const seg of parseReply(structured.text)) {
    if (seg.type === 'text') {
      const d = document.createElement('div');
      d.className = 'seg-text';
      d.innerHTML = formatText(escapeHtml(seg.content));
      wrap.appendChild(d);
    } else {
      const holder = document.createElement('div');
      holder.className = 'seg-html';
      holder.appendChild(buildPanelFrame(seg.content));
      wrap.appendChild(holder);
    }
  }
  if (structured.player && typeof structured.player === 'object') {
    const persona = getPersona();
    const rows = [
      ['姓名', persona?.name], ['身份', structured.player.status],
      ...Object.entries(structured.player.values || {}).map(([key, value]) => [key, displaySceneValue(value)]),
    ].filter(([, value]) => value != null && String(value).trim());
    appendStructuredPanel(wrap, '玩家状态', rows, 'reply-player');
  }
  if (Array.isArray(structured.characters) && structured.characters.length) {
    const rows = structured.characters.map((item) => [item.name,
      [item.mood, item.relationship, item.goal, item.status].filter(Boolean).join(' · ')]);
    appendStructuredPanel(wrap, '角色状态', rows, 'reply-characters');
  }
  if (structured.situation && typeof structured.situation === 'object') {
    const rows = [
      ['当前风险', structured.situation.risks],
      ['待解决事项', structured.situation.openThreads],
    ].filter(([, value]) => Array.isArray(value) ? value.length : !!value);
    appendStructuredPanel(wrap, '场景与风险', rows, 'reply-situation');
  }
  if (structured.changes && typeof structured.changes === 'object') {
    const changes = document.createElement('details');
    changes.className = 'reply-changes';
    const value = structured.changes;
    const rows = [
      ['summary', '本轮概况'], ['time', '时间'], ['location', '地点'], ['discoveries', '新发现'], ['relationships', '关系变化'],
      ['state', '状态变化'], ['events', '本轮事件'], ['goals', '目标变化'],
    ].filter(([key]) => value[key] != null && String(value[key]).trim())
      .map(([key, label]) => `<div><b>${label}</b>${escapeHtml(displaySceneValue(value[key]))}</div>`);
    if (rows.length) {
      changes.innerHTML = `<summary>本轮变化</summary><div class="changes-content">${rows.join('')}</div>`;
      wrap.appendChild(changes);
    }
  }
  if (structured.memory && typeof structured.memory === 'object') {
    const memory = document.createElement('details');
    memory.className = 'reply-memory';
    const short = Array.isArray(structured.memory.shortTerm) ? structured.memory.shortTerm : [];
    const long = Array.isArray(structured.memory.longTerm) ? structured.memory.longTerm : [];
    memory.innerHTML = `<summary>剧情记忆</summary><div class="memory-content">${
      [...short.map((x) => `短期：${escapeHtml(String(x))}`), ...long.map((x) => `长期：${escapeHtml(String(x))}`)]
        .map((x) => `<div>${x}</div>`).join('')
    }</div>`;
    wrap.appendChild(memory);
  }
  if (structured.review && state.cfg.responseFormat?.showReview) {
    const review = document.createElement('details');
    review.className = 'reply-review';
    review.innerHTML = `<summary>演绎检查</summary><div>${formatText(escapeHtml(structured.review))}</div>`;
    wrap.appendChild(review);
  }
  if (structured.choices.length) {
    const choices = document.createElement('div');
    choices.className = 'reply-choices';
    choices.innerHTML = '<span class="choices-label">可以选择：</span>' + structured.choices.map((choice) => {
      const item = typeof choice === 'string' ? { text: choice } : choice;
      const meta = [item.type, item.intent, item.risk && `风险：${item.risk}`].filter(Boolean).join(' · ');
      return `<button class="choice-btn" type="button"><span>${escapeHtml(item.text)}</span>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</button>`;
    }).join('');
    choices.querySelectorAll('.choice-btn').forEach((button, index) => {
      button.onclick = () => {
        const input = $('chatInput');
        const item = structured.choices[index];
        input.value = typeof item === 'string' ? item : item.text;
        input.focus();
      };
    });
    wrap.appendChild(choices);
  }
  div.appendChild(wrap);

  const bar = document.createElement('div');
  bar.className = 'msg-bar';
  const stats = m.stats ? `${m.stats.tps?.toFixed(1) || ''} tok/s` : '';
  bar.innerHTML = `<span class="st"></span>`;
  bar.querySelector('.st').textContent = stats;
  const btns = document.createElement('span');
  btns.innerHTML = `<button class="mini-btn" data-act="copy">复制</button><button class="mini-btn" data-act="del">删除</button>`;
  bar.appendChild(btns);
  div.appendChild(bar);

  bar.querySelector('[data-act=copy]').onclick = (ev) => {
    navigator.clipboard.writeText(m.content);
    ev.target.textContent = '已复制';
    setTimeout(() => (ev.target.textContent = '复制'), 1200);
  };
  bar.querySelector('[data-act=del]').onclick = () => {
    state.messages = state.messages.filter((x) => x !== m);
    persist(); renderChat();
  };

  return div;
}

function appendSceneStrip(wrap, sceneData) {
  if (!sceneData || typeof sceneData !== 'object') return;
  const sceneItems = [
    ['time', '时间'], ['world', '世界'], ['location', '场所'], ['plot', '情节'], ['weather', '天气'],
    ['atmosphere', '氛围'], ['lighting', '光线'], ['sounds', '声音'], ['scents', '气味'],
    ['goal', '目标'], ['conflict', '冲突'], ['tension', '紧张度'],
  ].filter(([key]) => sceneData[key] != null && String(sceneData[key]).trim());
  const rows = sceneItems.map(([key, label]) =>
    `<span><b>${label}</b>${escapeHtml(displaySceneValue(sceneData[key]))}</span>`);
  if (Array.isArray(sceneData.participants) && sceneData.participants.length) {
    rows.push(`<div class="scene-section"><b>在场人物</b>${sceneData.participants.map((person) =>
      `<span>${escapeHtml(displayPerson(person))}</span>`).join('')}</div>`);
  }
  if (Array.isArray(sceneData.objects) && sceneData.objects.length) {
    rows.push(`<div class="scene-section"><b>可交互物品</b>${sceneData.objects.map((item) =>
      `<span>${escapeHtml(displayObject(item))}</span>`).join('')}</div>`);
  }
  if (!rows.length) return;
  const strip = document.createElement('div');
  strip.className = 'scene-strip';
  strip.innerHTML = `<div class="scene-title">场景信息</div>${rows.join('')}`;
  wrap.appendChild(strip);
}

function appendStructuredPanel(wrap, title, rows, className) {
  if (!rows.length) return;
  const panel = document.createElement('details');
  panel.className = `reply-status ${className}`;
  panel.innerHTML = `<summary>${escapeHtml(title)}</summary><div class="status-content">${rows.map(([label, value]) =>
    `<div><b>${escapeHtml(label)}</b><span>${escapeHtml(displaySceneValue(value))}</span></div>`).join('')}</div>`;
  wrap.appendChild(panel);
}

function displaySceneValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function displayPerson(value) {
  const item = value && typeof value === 'object' ? value : { name: value };
  return [item.name, item.position, item.emotion, item.action].filter(Boolean).join(' · ');
}

function displayObject(value) {
  const item = value && typeof value === 'object' ? value : { name: value };
  return [item.name, item.location, item.status].filter(Boolean).join(' · ');
}

function scrollDown() {
  const box = $('msgList');
  box.scrollTop = box.scrollHeight;
}

/* ============ 组装 + 发送 ============ */

function buildPrompt(userInput) {
  const persona = getPersona();
  const card = getCard();
  const blocks = [...state.cfg.blocks];
  // 开场白显示在聊天区而不计入历史；首次回应前作为上下文传给模型。
  if (state.cfg.greeting && !state.messages.some((message) => message.role === 'assistant')) {
    blocks.push({ name: '开场上下文', enabled: true, order: 6,
      content: '以下是已经发生的故事开场。接续玩家当前的回应推进剧情，不要重新演出开场：\n' + state.cfg.greeting });
  }

  // 未选角色时，把角色卡的 blocks 用作设定
  return assemble({
    blocks,
    entries: state.cfg.entries,
    messages: state.messages,
    userInput,
    narrativeStyle: true,
    vars: state.cfg.vars,
    memory: state.cfg.memory,
    choices: state.cfg.choices,
    responseFormat: state.cfg.responseFormat,
    scene: state.cfg.scene,
    playerState: state.cfg.playerState,
    characters: state.cfg.characterStates,
    situation: state.cfg.situation,
    persona: persona ? personaToBlock(persona) : '',
    charName: card ? (card.name || '') : '',
    userName: persona ? (persona.name || '') : '',
  });
}

function extractStructuredReplyTags(raw) {
  return serializeStructuredReply(parseStructuredReply(raw));
}

function compactReplyText(text) {
  return String(text || '').replace(/\s/g, '');
}

function originalIndexAfterCompactChars(text, count) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    seen += 1;
    if (seen >= count) return index + 1;
  }
  return text.length;
}

/** 小模型有时会把续写请求当成重新生成；丢弃重复的开头，避免正文无限膨胀。 */
function removeRepeatedContinuation(previousText, continuationText) {
  const previous = String(previousText || '').trim();
  const continuation = String(continuationText || '').trim();
  const previousCompact = compactReplyText(previous);
  const continuationCompact = compactReplyText(continuation);
  const probeLength = 120;
  if (continuationCompact.length < probeLength || !previousCompact.startsWith(continuationCompact.slice(0, probeLength))) {
    return continuation;
  }

  let common = 0;
  const limit = Math.min(previousCompact.length, continuationCompact.length);
  while (common < limit && previousCompact[common] === continuationCompact[common]) common += 1;
  if (common < probeLength) return continuation;
  return continuation.slice(originalIndexAfterCompactChars(continuation, common)).trim();
}

function normalizeRepeatParagraph(text) {
  return String(text || '').replace(/\s/g, '').replace(/[，。！？、；：“”‘’（）()《》<>「」『』,.!?;:'"\-—_]/g, '');
}

function repeatUnits(text) {
  const source = String(text || '').trim();
  if (!source) return { units: [], separator: '\n\n' };
  const paragraphs = source.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length > 1) return { units: paragraphs, separator: '\n\n' };
  const lines = source.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  if (lines.length > 1) return { units: lines, separator: '\n' };
  return { units: [source], separator: '' };
}

/** 删除同一回复内重复的段落循环，例如 A/B/C/A/B/C。 */
function collapseRepeatedParagraphs(text) {
  const { units: paragraphs, separator } = repeatUnits(text);
  if (paragraphs.length < 2) return String(text || '').trim();
  for (let pass = 0; pass < 4; pass += 1) {
    let removed = false;
    for (let cycle = Math.min(6, Math.floor(paragraphs.length / 2)); cycle >= 1; cycle -= 1) {
      for (let start = 0; start + cycle * 2 <= paragraphs.length; start += 1) {
        const left = paragraphs.slice(start, start + cycle);
        const right = paragraphs.slice(start + cycle, start + cycle * 2);
        const total = left.reduce((sum, part) => sum + normalizeRepeatParagraph(part).length, 0);
        if (total < 120 || left.some((part) => normalizeRepeatParagraph(part).length < 20)) continue;
        if (left.length && left.every((part, index) => normalizeRepeatParagraph(part) === normalizeRepeatParagraph(right[index]))) {
          paragraphs.splice(start + cycle, cycle);
          removed = true;
          break;
        }
      }
      if (removed) break;
    }
    if (!removed) {
      // 模型常在完整循环后又吐出循环开头的一两个段落（A/B/C/A/B/C/A）。
      // 只在同一回复从开头开始至少重复两轮时截断，避免误伤正常的回指。
      for (let cycle = Math.min(6, paragraphs.length - 1); cycle >= 1; cycle -= 1) {
        const base = paragraphs.slice(0, cycle);
        const baseLength = base.reduce((sum, part) => sum + normalizeRepeatParagraph(part).length, 0);
        if (baseLength < 120 || base.some((part) => normalizeRepeatParagraph(part).length < 20)) continue;
        let cursor = cycle;
        let repeats = 1;
        while (cursor + cycle <= paragraphs.length
          && base.every((part, index) => normalizeRepeatParagraph(part) === normalizeRepeatParagraph(paragraphs[cursor + index]))) {
          cursor += cycle;
          repeats += 1;
        }
        let partial = 0;
        while (cursor + partial < paragraphs.length && partial < cycle
          && normalizeRepeatParagraph(paragraphs[cursor + partial]) === normalizeRepeatParagraph(base[partial])) partial += 1;
        if (repeats >= 2 && (cursor < paragraphs.length || partial)) {
          paragraphs.splice(cursor);
          removed = true;
          break;
        }
      }
    }
    if (removed) {
      // 上面的成对删除可能留下循环的残尾（A/B/C/A），一并去掉。
      for (let cycle = Math.min(6, paragraphs.length - 1); cycle >= 1; cycle -= 1) {
        const base = paragraphs.slice(0, cycle);
        const baseLength = base.reduce((sum, part) => sum + normalizeRepeatParagraph(part).length, 0);
        if (baseLength < 120 || base.some((part) => normalizeRepeatParagraph(part).length < 20)) continue;
        let matches = true;
        for (let index = cycle; index < paragraphs.length; index += 1) {
          if (normalizeRepeatParagraph(paragraphs[index]) !== normalizeRepeatParagraph(base[(index - cycle) % cycle])) {
            matches = false;
            break;
          }
        }
        if (matches && paragraphs.length > cycle) {
          paragraphs.splice(cycle);
          break;
        }
      }
    }
    if (!removed) break;
  }
  return paragraphs.join(separator || '\n\n');
}

function collapseReplyRepetitions(raw) {
  const parsed = parseStructuredReply(raw);
  const body = collapseRepeatedParagraphs(parsed.text);
  const tags = extractStructuredReplyTags(raw);
  return [body, ...tags].filter(Boolean).join('\n\n');
}

function mergeReplyContinuation(previous, continuation) {
  const before = parseStructuredReply(previous);
  const next = parseStructuredReply(continuation);
  const continuationText = removeRepeatedContinuation(before.text, collapseRepeatedParagraphs(next.text));
  const body = [before.text, continuationText].map((text) => text.trim()).filter(Boolean).join('\n\n');
  const tags = extractStructuredReplyTags(continuation);
  const fallbackTags = extractStructuredReplyTags(previous);
  return [body, ...(tags.length ? tags : fallbackTags)].filter(Boolean).join('\n\n');
}

async function send() {
  if (state.busy || state.memoryBusy) return;
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const { messages, stats } = buildPrompt(text);

  const context = { version: state.contextVersion, configId: state.configId, cardId: state.cardId, cfg: state.cfg, messages: state.messages };
  context.messages.push({ role: 'user', content: text });
  input.value = '';
  persist();
  renderChat();
  $('statHit').textContent = `触发 ${stats.entriesHit}/${stats.entriesTotal}`;

  state.busy = true;
  $('sendBtn').disabled = true;

  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = '<div class="bubble ai-bubble"><span class="cursor"></span></div>';
  $('msgList').appendChild(div);
  scrollDown();
  const bubbleEl = div.querySelector('.bubble');
  const t0 = performance.now();

  let full = '';
  try {
    await llm.stream(messages, (delta, acc) => {
      full = collapseReplyRepetitions(acc);
      if (context.version === state.contextVersion) {
        bubbleEl.innerHTML = formatText(escapeHtml(parseStructuredReply(full).text));
        scrollDown();
      }
    }, genOpts());

    // Continue short generations into the fixed v3 body range.
    const target = getBodyTarget(context.cfg);
    let continuationCount = 0;
    while (target && continuationCount < 3) {
      const parsed = parseStructuredReply(full);
      const currentLength = getBodyLength(parsed.text);
      if (currentLength >= target) break;

      const continuationInput = `【正文补写】当前正文为${currentLength}字，目标范围为1000-2000字，目标约${TARGET_BODY_CHARS}字。请从上一段末尾继续，不重写或重复前文；补充角色反应、环境、感官、心理、对白和事件推进，并在达到目标范围后输出最终结构化数据。总正文不要超过${MAX_BODY_CHARS}字。玩家描写仍最多占正文10%，不得替玩家新增关键决定、意图、立场、目标、同意或核心行动。`;
      const continuationMessages = [
        ...messages,
        { role: 'assistant', content: `【上一段正文末尾】\n${parsed.text.slice(-1600)}` },
        { role: 'user', content: continuationInput },
      ];
      let continuation = '';
      await llm.stream(continuationMessages, (delta, acc) => {
        continuation = collapseReplyRepetitions(acc);
        const merged = mergeReplyContinuation(full, acc);
        if (context.version === state.contextVersion) {
          bubbleEl.innerHTML = formatText(escapeHtml(parseStructuredReply(merged).text));
          scrollDown();
        }
      }, genOpts());
      const merged = mergeReplyContinuation(full, continuation);
      if (getBodyLength(parseStructuredReply(merged).text) <= currentLength) break;
      full = merged;
      continuationCount += 1;
    }

    const dt = (performance.now() - t0) / 1000;
    applyStructuredReplyToConfig(full, context.cfg);
    context.messages.push({
      role: 'assistant',
      content: full,
      stats: { tps: dt > 0 ? (full.length / 1.5) / dt : 0, tokens: Math.round(full.length / 1.5) },
    });
    persistConversation(context);
    if (context.version === state.contextVersion) {
      renderStatePanel();
      renderMemory();
      renderChat();
      renderCastBar();
      maybeAutoSummarize();
    }
  } catch (err) {
    if (context.version === state.contextVersion) bubbleEl.innerHTML = `<div class="err">出错了：${escapeHtml(err.message)}</div>`;
    console.error(err);
  } finally {
    state.busy = false;
    $('sendBtn').disabled = false;
    input.focus();
  }
}

/* ============ 预览组装结果 ============ */
function previewPrompt() {
  const { messages, stats } = buildPrompt('（这里是本轮将发送的内容）');

  const html = messages.map((m) => {
    const roleTag = { system: '系统', user: '用户', assistant: 'AI' }[m.role] || m.role;
    return `<div class="pv-item pv-${m.role}">
      <div class="pv-role">${roleTag}</div>
      <div class="pv-body">${escapeHtml(m.content)}</div>
    </div>`;
  }).join('');

  $('previewBox').innerHTML = html;
  $('previewStat').textContent =
    `${messages.length} 条消息 · 约 ${LLM.estimateTokens(messages)} tokens · 世界书触发 ${stats.entriesHit}/${stats.entriesTotal}` +
    `（提示词 ${stats.byScope.prompt} / 前置 ${stats.byScope.prepend} / 后置 ${stats.byScope.append}）`;
}

/* ============ 事件绑定 ============ */
function bindEvents() {
  $('sendBtn').onclick = send;
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $('chatInput').addEventListener('input', previewPrompt);

  $('newBtn').onclick = () => {
    if (state.busy || state.memoryBusy) { alert('请等当前回复或记忆整理完成后再新建作品'); return; }
    openStoryCreator({ llm, onBlank: newConfig, onCreated: (bundle) => {
      selectConfig(bundle.configId);
      selectEditorCard(bundle.card.id);
      document.querySelector('.tab[data-tab=card]')?.click();
    } });
  };
  $('cfgName').oninput = (e) => {
    state.cfg.name = e.target.value;
    $('chatTitle').textContent = e.target.value;
    persist(); renderConfigList();
  };

  $('personaChip').onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelector('.tab[data-tab=persona]').classList.add('on');
    document.querySelectorAll('.tabpane').forEach((p) => (p.style.display = 'none'));
    $('pane-persona').style.display = 'block';
  };

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      state.tab = t.dataset.tab;
      document.querySelectorAll('.tabpane').forEach((p) => (p.style.display = 'none'));
      $('pane-' + state.tab).style.display = 'block';
      if (state.tab === 'debug') previewPrompt();
    };
  });

  $('addBlock').onclick = () => {
    state.cfg.blocks.push(makeBlock({ name: '新设定块', order: state.cfg.blocks.length }));
    persist(); renderBlocks();
  };
  $('addEntry').onclick = () => {
    state.cfg.entries.push(makeEntry({ category: '未分类' }));
    persist(); renderEntries(); renderConfigList();
  };

  $('varsOn').onchange = (e) => {
    state.cfg.vars = state.cfg.vars || {};
    state.cfg.vars.enabled = e.target.checked;
    if (e.target.checked && !state.cfg.vars.prompt) state.cfg.vars.prompt = DEFAULT_VARS_PROMPT;
    persist(); renderVars();
  };
  $('varsPrompt').oninput = (e) => {
    state.cfg.vars.prompt = e.target.value; persist();
  };
  $('varsHistory').onchange = (e) => {
    state.cfg.vars.historyLimit = parseInt(e.target.value) || 20; persist();
  };
  $('memoryOn').onchange = (e) => {
    state.cfg.memory = normalizeMemory({ summary: '', threshold: 20, keepRecent: 8, ...(state.cfg.memory || {}) });
    state.cfg.memory.enabled = e.target.checked;
    persist(); renderVars(); previewPrompt();
  };
  if ($('memoryMarkdown')) $('memoryMarkdown').oninput = (e) => {
    const parsed = parseMemoryMarkdown(e.target.value);
    state.cfg.memory = normalizeMemory({ ...(state.cfg.memory || {}), ...parsed, markdown: e.target.value });
    persist(); previewPrompt();
  };
  // 旧页面缓存仍可能保留摘要输入框，继续同步它，避免升级过程中丢失手工内容。
  if ($('memorySummary')) $('memorySummary').oninput = (e) => {
    state.cfg.memory = normalizeMemory({ ...(state.cfg.memory || {}), summary: e.target.value });
    persist(); previewPrompt();
  };
  $('memoryThreshold').onchange = (e) => {
    state.cfg.memory = state.cfg.memory || {};
    state.cfg.memory.threshold = Math.max(6, Math.min(100, parseInt(e.target.value) || 20));
    persist(); renderMemory();
  };
  $('memoryKeep').onchange = (e) => {
    state.cfg.memory = state.cfg.memory || {};
    state.cfg.memory.keepRecent = Math.max(2, Math.min(30, parseInt(e.target.value) || 8));
    persist(); renderMemory();
  };
  $('summarizeBtn').onclick = () => summarizeMemory(true);
  $('choicesOn').onchange = (e) => {
    state.cfg.choices = state.cfg.choices || {};
    state.cfg.choices.enabled = e.target.checked;
    persist(); previewPrompt();
  };
  $('formatOn').onchange = (e) => {
    state.cfg.responseFormat = state.cfg.responseFormat || {};
    state.cfg.responseFormat.enabled = e.target.checked;
    persist(); renderVars(); previewPrompt();
  };
  $('formatReview').onchange = (e) => {
    state.cfg.responseFormat = state.cfg.responseFormat || {};
    state.cfg.responseFormat.showReview = e.target.checked;
    persist(); previewPrompt();
  };
  $('greetingBox').oninput = (e) => {
    state.cfg.greeting = e.target.value; persist();
  };

  $('refreshBtn').onclick = checkHealth;
  $('apiBase').onchange = (e) => {
    llm.base = e.target.value.trim();
    store.setApiBase(llm.base);
    checkHealth();
  };

  $('refreshPreview').onclick = previewPrompt;

  $('exportBtn').onclick = () => {
    const blob = new Blob([exportConfig(state.cfg)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.cfg.name || 'config'}.json`;
    a.click();
  };
  $('backupExportBtn').onclick = () => {
    const blob = new Blob([store.exportWorkspaceBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `StoryRealm-完整备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('backupImportBtn').onclick = () => $('backupFile').click();
  $('backupFile').onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const id = store.importWorkspaceBackup(reader.result);
        const nextId = id && store.loadConfig(id) ? id : Object.keys(store.listConfigs())[0];
        if (nextId) selectConfig(nextId);
        else newConfig();
        alert('完整备份已恢复');
      } catch (error) {
        alert('备份恢复失败：' + error.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state.cfg = importConfig(reader.result);
        state.messages = [];
        store.saveConfig(state.configId, state.cfg);
        persist(); renderBlocks(); renderEntries(); renderVars(); renderCastBar(); renderChat();
        $('cfgName').value = state.cfg.name;
        $('chatTitle').textContent = state.cfg.name;
        renderConfigList();
        alert('导入成功');
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  $('clearChat').onclick = () => {
    if (confirm('清空当前角色在此作品下的所有消息？')) {
      state.messages = [];
      store.saveChat(state.configId, [], state.cardId);
      renderChat(); renderCastBar();
    }
  };
}

// 全局错误捕获：异常直接显示在页面上，并写入 <title> 便于排查
function showFatal(msg, stack) {
  document.title = '⚠ ' + msg;

  const box = document.createElement('div');
  box.id = 'fatalBox';
  box.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#501313;' +
    'color:#fceceb;padding:12px 16px;font:12px/1.6 Consolas,monospace;' +
    'white-space:pre-wrap;max-height:40vh;overflow:auto';
  box.textContent = '⚠ ' + msg + '\n' + (stack || '');
  document.body.appendChild(box);
}
window.addEventListener('error', (e) => showFatal(e.message, `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => showFatal('Promise: ' + e.reason));

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    showFatal('init 失败: ' + err.message, err.stack);
    console.error(err);
  });
});
