/**
 * 角色卡界面逻辑：AI 辅助创作 + 字段编辑
 */
import {
  makeCard, TEMPLATES, POLISH_OPTIONS,
  generateDirections, expandDirection, classifyStory, polishText, generateExample,
  exportCard, importCard, cardToBlocks, setCardAvatar, cardAvatar,
} from './card.js';
import { llm } from './llm.js';
import * as store from './store.js';
import { escapeHtml } from './render.js';
import { makeBlock } from './assembler.js';
import { normalizeProfile, profileEditor, profileToText } from './profile.js';
import { profileAIEditor, bindProfileAI } from './profile-assist.js';

const $ = (id) => document.getElementById(id);

const state = {
  card: null,
  directions: [],
  chosen: -1,
  busy: false,
};

/* ============ 初始化 ============ */

export function initCard(getCfg, applyBlocks, refreshAll, setActive) {
  state.getCfg = getCfg;
  state.applyBlocks = applyBlocks;
  state.refreshAll = refreshAll;
  state.setActive = setActive || (() => {});

  // 恢复上次编辑的卡；没有则新建一张并立即保存，
  // 否则 selectCard 里 loadCard 读不到会再生成新 id，导致下拉框里找不到当前卡
  const cards = store.listCards();
  const ids = Object.keys(cards).sort((a, b) => (cards[b].updatedAt || 0) - (cards[a].updatedAt || 0));

  if (ids.length) {
    selectCard(ids[0]);
  } else {
    const c = makeCard();
    store.saveCard(c);
    selectCard(c.id);
  }

  bind();
  renderTemplates();
}

/* ============ 模板快速选择 ============ */

function renderTemplates() {
  const box = $('tplList');
  if (!box) return;
  box.innerHTML = TEMPLATES.map((t) => `
    <button class="tpl" data-key="${t.key}">
      <span class="tpl-icon">${t.icon}</span>
      <span class="tpl-label">${t.label}</span>
    </button>`).join('');
  box.querySelectorAll('.tpl').forEach((el) => {
    el.onclick = () => applyTemplate(TEMPLATES.find((x) => x.key === el.dataset.key));
  });
}

function applyTemplate(tpl) {
  if (!tpl) return;
  Object.assign(state.card, tpl.data);
  if (!state.card.name) state.card.name = tpl.label;
  saveCard();
  renderCard();
  setStatus(`已套用「${tpl.label}」模板，可继续用 AI 扩写`, 'ok');
}

/* ============ AI 创作 ============ */

function setStatus(msg, type = '') {
  const box = $('aiStatus');
  if (!box) return;
  box.className = 'ai-status ' + type;
  box.textContent = msg;
}

async function runAI(fn, busyMsg, doneMsg) {
  if (state.busy) return;
  state.busy = true;
  $('aiDirBtn').disabled = true;
  $('aiExpandBtn').disabled = true;
  if ($('aiOrganizeBtn')) $('aiOrganizeBtn').disabled = true;
  setStatus(busyMsg, 'busy');
  try {
    const r = await fn();
    setStatus(doneMsg, 'ok');
    return r;
  } catch (err) {
    setStatus('失败：' + err.message, 'bad');
    console.error(err);
  } finally {
    state.busy = false;
    $('aiDirBtn').disabled = false;
    $('aiExpandBtn').disabled = state.chosen < 0;
    if ($('aiOrganizeBtn')) $('aiOrganizeBtn').disabled = false;
  }
}

async function onGenerateDirections() {
  const brief = $('aiBrief').value.trim();
  if (!brief) { setStatus('先写一句你的想法', 'bad'); return; }

  const dirs = await runAI(
    () => generateDirections(llm, brief),
    'AI 正在构思方向，约需 20 秒…',
    '挑一个方向点它，然后点「展开选中方向」'
  );
  if (dirs) {
    state.directions = dirs;
    state.chosen = -1;
    renderDirections();
  }
}

async function onExpand() {
  if (state.chosen < 0) { setStatus('先选一个方向', 'bad'); return; }
  const dir = state.directions[state.chosen];
  const brief = $('aiBrief').value.trim();

  const data = await runAI(
    () => expandDirection(llm, dir, brief),
    'AI 正在展开完整设定，约需 60 秒…',
    '完成，已填入下方，可继续编辑'
  );
  if (data) {
    Object.assign(state.card, {
      ...normalizeProfile(data),
      name: data.name || state.card.name,
      tagline: data.tagline || '',
      appearance: data.appearance || '',
      personality: data.personality || '',
      background: data.background || '',
      speechStyle: data.speechStyle || '',
      scenario: data.scenario || '',
      firstMes: data.firstMes || '',
      mesExample: data.mesExample || '',
    });
    saveCard();
    renderCard();
  }
}

async function onOrganizeStory() {
  const story = $('aiStory')?.value.trim();
  if (!story) { setStatus('先粘贴一段故事内容', 'bad'); return; }
  const data = await runAI(
    () => classifyStory(llm, story),
    'AI 正在拆分故事设定，可能需要几十秒…',
    '整理完成，已回填角色卡，请检查后再应用到作品'
  );
  if (!data) return;
  Object.assign(state.card, data);
  saveCard();
  renderCard();
}

/* ============ 方向选项 ============ */

function renderDirections() {
  const box = $('dirList');
  if (!state.directions.length) { box.innerHTML = ''; return; }

  box.innerHTML = state.directions.map((d, i) => `
    <div class="dir-card ${i === state.chosen ? 'on' : ''}" data-i="${i}">
      <div class="dc-top">
        <span class="dc-name">${escapeHtml(d.name || '未命名')}</span>
        ${d.keywords?.length ? `<span class="dc-kw">${d.keywords.map((k) => `<em>${escapeHtml(k)}</em>`).join('')}</span>` : ''}
      </div>
      <div class="dc-tag">${escapeHtml(d.tagline || '')}</div>
    </div>`).join('');

  box.querySelectorAll('.dir-card').forEach((el) => {
    el.onclick = () => {
      state.chosen = parseInt(el.dataset.i);
      renderDirections();
      $('aiExpandBtn').disabled = false;
    };
  });
}

/* ============ 卡片管理 ============ */

export function selectCard(id) {
  // 读不到就用传入的 id 建一张新卡并立刻保存，保证下拉框能选中它
  let c = store.loadCard(id);
  if (!c) {
    c = makeCard({ id });
    store.saveCard(c);
  }
  state.card = c;
  renderCardSelect();
  renderCard();
}

function saveCard() {
  store.saveCard(state.card);
  renderCardSelect();
}

function renderCardSelect() {
  const sel = $('cardSelect');
  if (!sel) return; // 初始化早期可能被抢先调用

  const cards = store.listCards();

  // 自愈：当前编辑的卡不在列表里（历史脏数据 / 版本切换导致），
  // 先把它补存进去，否则下拉框为空而编辑区有内容，用户会以为功能丢了
  if (state.card && !cards[state.card.id]) {
    cards[state.card.id] = { ...state.card, updatedAt: Date.now() };
    store.saveCard(state.card);
  }

  const ids = Object.keys(cards).sort((a, b) => (cards[b].updatedAt || 0) - (cards[a].updatedAt || 0));
  sel.innerHTML = ids
    .map((id) => `<option value="${id}" ${id === state.card?.id ? 'selected' : ''}>${escapeHtml(cards[id].name || '未命名角色')}</option>`)
    .join('');
}

/* ============ 字段编辑 ============ */

const FIELDS = [
  { key: 'name', label: '角色名', type: 'input' },
  { key: 'tagline', label: '一句话身份', type: 'input', hint: '20字内，一句话说清他是谁' },
  { key: 'appearance', label: '外貌', type: 'area', rows: 3, hint: '要有可辨识的细节：动作、穿着、特征' },
  { key: 'personality', label: '性格', type: 'area', rows: 3, hint: '用具体行为描述，而非形容词堆砌' },
  { key: 'background', label: '背景', type: 'area', rows: 3, hint: '解释现在的性格是怎么形成的' },
  { key: 'speechStyle', label: '说话方式', type: 'area', rows: 2, hint: '含 2-3 个口头禅' },
  { key: 'scenario', label: '故事情境', type: 'area', rows: 2, hint: '玩家与角色的关系和处境' },
  { key: 'firstMes', label: '开场白', type: 'area', rows: 4, hint: '像小说一样直接描写，台词使用中文双引号“”' },
  { key: 'mesExample', label: '示例对话', type: 'area', rows: 5, hint: '2-3轮，示范语气和格式' },
  { key: 'creatorNotes', label: '创作者备注', type: 'area', rows: 2, hint: '不进提示词，仅自己看' },
];

function renderCard() {
  const box = $('cardEditor');
  const c = state.card;
  if (!box || !c) return;

  box.innerHTML = `
    <div class="ce-head">
      <span class="ce-title">角色设定</span>
      <div class="btn-row">
        <button id="setActive" class="mini-btn">设为当前角色</button>
        <button id="applyCard" class="mini-btn primary">应用到作品设定</button>
        <button id="expCard" class="mini-btn">导出</button>
        <button id="impCard" class="mini-btn">导入</button>
        <input id="impCardFile" type="file" accept=".json" hidden>
      </div>
    </div>

    <div class="c-av-row">
      <span id="cAv" class="c-av"></span>
      <div class="c-av-btns">
        <button id="cUpImg" class="mini-btn">上传头像</button>
        ${c.avatar ? '<button id="cDelImg" class="mini-btn">移除</button>' : ''}
        <input id="cImgFile" type="file" accept="image/*" hidden>
      </div>
    </div>

    <div class="ce-fields">
      ${FIELDS.map((f) => `
        ${f.key === 'appearance' ? profileAIEditor('card', c.id) + profileEditor(c) : ''}
        <div class="cf">
          <label class="mini">${f.label}${f.hint ? `<span class="cf-hint">${f.hint}</span>` : ''}</label>
          ${f.type === 'input'
            ? `<input class="cf-in" data-k="${f.key}" value="${escapeHtml(c[f.key] || '')}">`
            : `<textarea class="cf-ta" data-k="${f.key}" rows="${f.rows || 3}">${escapeHtml(c[f.key] || '')}</textarea>`}
          ${f.key === 'mesExample' ? `<button class="cf-ai" data-ai="example">AI 生成示例对话</button>` : ''}
          ${f.key !== 'creatorNotes' && f.key !== 'name' ? `<button class="cf-ai" data-ai="polish" data-k="${f.key}">AI 美化</button>` : ''}
        </div>`).join('')}
    </div>`;

  bindProfileAI(box, {
    kind: 'card', id: c.id, llm, load: store.loadCard,
    save: (updated) => { state.card = updated; saveCard(); },
    currentId: () => state.card?.id, refresh: renderCard,
  });

  // 头像
  const av = cardAvatar(c);
  const avEl = box.querySelector('#cAv');
  if (avEl) {
    avEl.style.cssText = av.url ? `background-image:url(${av.url})` : `background:${av.color}`;
    avEl.textContent = av.url ? '' : escapeHtml(av.text);
  }

  const upBtn = box.querySelector('#cUpImg');
  if (upBtn) upBtn.onclick = () => box.querySelector('#cImgFile')?.click();

  const imgInput = box.querySelector('#cImgFile');
  if (imgInput) {
    imgInput.onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        await setCardAvatar(state.card, f);
        saveCard();
        renderCard();
        setStatus('头像已更新', 'ok');
      } catch (err) {
        setStatus('头像上传失败：' + err.message, 'bad');
      }
      e.target.value = '';
    };
  }

  const delImg = box.querySelector('#cDelImg');
  if (delImg) {
    delImg.onclick = () => {
      state.card.avatar = '';
      saveCard();
      renderCard();
    };
  }

  box.querySelectorAll('[data-k]').forEach((el) => {
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
    el[ev] = () => {
      state.card[el.dataset.k] = el.value;
      if (el.dataset.k === 'gender') state.card.pronoun = '';
      saveCard();
      if (el.dataset.k === 'gender') renderCard();
    };
  });

  // AI 美化按钮
  box.querySelectorAll('[data-ai=polish]').forEach((btn) => {
    btn.onclick = async () => {
      const k = btn.dataset.k;
      const text = state.card[k];
      if (!text || !text.trim()) { setStatus('这一栏是空的，先写点什么', 'bad'); return; }

      // 让用户选风格
      const styleKey = prompt('选择美化方式：\n1 = 润色（保持原意）\n2 = 扩写（补细节）\n3 = 精简（去冗余）\n4 = 具体化（换掉空泛形容）', '1');
      const map = { 1: 'refine', 2: 'expand', 3: 'concise', 4: 'concrete' };
      const style = map[String(styleKey).trim()] || 'refine';

      const old = text;
      btn.disabled = true;
      btn.textContent = 'AI 处理中…';
      try {
        const r = await polishText(llm, text, style);
        state.card[k] = r;
        saveCard();
        renderCard();
        setStatus(`「${FIELDS.find((f) => f.key === k)?.label}」已美化`, 'ok');
        // 保留撤销能力
        if (confirm('已替换内容。\n\n确定 = 保留新内容\n取消 = 恢复原文')) {
          // 保留
        } else {
          state.card[k] = old;
          saveCard();
          renderCard();
        }
      } catch (err) {
        setStatus('失败：' + err.message, 'bad');
      } finally {
        btn.disabled = false;
        btn.textContent = 'AI 美化';
      }
    };
  });

  // AI 生成示例对话
  const exBtn = box.querySelector('[data-ai=example]');
  if (exBtn) {
    exBtn.onclick = async () => {
      exBtn.disabled = true;
      exBtn.textContent = 'AI 生成中…';
      setStatus('正在根据设定生成示例对话…', 'busy');
      try {
        const r = await generateExample(llm, state.card);
        state.card.mesExample = r;
        saveCard();
        renderCard();
        setStatus('示例对话已生成', 'ok');
      } catch (err) {
        setStatus('失败：' + err.message, 'bad');
      } finally {
        exBtn.disabled = false;
      }
    };
  }

  // 应用到作品
  const applyBtn = box.querySelector('#applyCard') || $('applyCard');
  if (applyBtn) applyBtn.onclick = () => {
    if (!state.card.name && !state.card.personality && !state.card.appearance && !profileToText(state.card)) {
      setStatus('角色卡还是空的', 'bad');
      return;
    }
    const blocks = cardToBlocks(state.card);
    if (state.card.firstMes) {
      state.getCfg().greeting = state.card.firstMes;
    }
    state.applyBlocks(blocks);
    state.refreshAll();
    saveCard();
    setStatus('已应用到作品设定', 'ok');
  };

  // 设为当前聊天角色
  const actBtn = box.querySelector('#setActive');
  if (actBtn) {
    actBtn.onclick = () => {
      saveCard();
      state.setActive(state.card.id);
      setStatus(`「${state.card.name || '该角色'}」已设为当前聊天角色`, 'ok');
    };
  }

  $('expCard') && ($('expCard').onclick = () => {
    const blob = new Blob([exportCard(state.card)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.card.name || 'card'}.json`;
    a.click();
  });

  $('impCard') && ($('impCard').onclick = () => $('impCardFile') && $('impCardFile').click());
  $('impCardFile') && ($('impCardFile').onchange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const c = importCard(reader.result);
        c.id = 'c' + Date.now().toString(36);
        state.card = c;
        saveCard();
        renderCard();
        setStatus('导入成功', 'ok');
      } catch (err) {
        setStatus('导入失败：' + err.message, 'bad');
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  });
}

/* ============ 事件绑定 ============ */

function bind() {
  const set = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };

  set('aiDirBtn', 'onclick', onGenerateDirections);
  set('aiExpandBtn', 'onclick', onExpand);
  set('aiOrganizeBtn', 'onclick', onOrganizeStory);

  set('newCardBtn', 'onclick', () => {
    const c = makeCard();
    store.saveCard(c);
    selectCard(c.id);
  });

  set('delCardBtn', 'onclick', () => {
    if (!confirm('删除这张角色卡？')) return;
    store.deleteCard(state.card.id);
    const ids = Object.keys(store.listCards());
    if (ids.length) {
      selectCard(ids[0]);
    } else {
      // 全删光时补一张空白卡，保持界面可用
      const c = makeCard();
      store.saveCard(c);
      selectCard(c.id);
    }
  });

  set('cardSelect', 'onchange', (e) => selectCard(e.target.value));
}
