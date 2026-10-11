/** 双方共用的 AI 人物资料助手：定向生成、保留编辑、一次撤销。 */
import { PROFILE_KEYS, PROFILE_FIELDS, normalizeProfile } from './profile.js';
import { safeJson } from './json-utils.js';
import { escapeHtml } from './render.js';

const sessions = new Map();
const FIXED_KEYS = new Set(['name', 'gender', 'genderCustom', 'pronoun', 'age', 'height']);
const clean = (value) => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

export function profileAIKeys(kind) {
  return [...PROFILE_KEYS, 'name', 'appearance', 'personality', 'background',
    ...(kind === 'persona' ? ['identity'] : ['tagline', 'speechStyle', 'scenario'])];
}

/** 显式白名单排除备注、头像、开场白与作品的聊天记录。 */
export function profileAIContext(source, kind) {
  return Object.fromEntries(profileAIKeys(kind).map((key) => [key, clean(source[key])]));
}

export async function generateProfile(llm, source, { kind = 'card', brief = '', mode = 'fill', field = '' } = {}) {
  if (!['card', 'persona'].includes(kind) || !['fill', 'polish'].includes(mode)) {
    throw new Error('请选择有效的人物与填写方式');
  }
  const detail = field ? PROFILE_FIELDS.slice(2).find((f) => f.key === field) : null;
  if (field && !detail) throw new Error('请选择有效的人物细节字段');
  const current = profileAIContext(source, kind);
  if (!brief.trim() && !Object.values(current).some(Boolean)) {
    throw new Error('写一句人物想法，或先选择性别、填写一项资料');
  }
  const instruction = `你是中文人物设定编辑，只整理${kind === 'persona' ? '玩家“我”的身份，不写成 AI 对方角色' : '当前 AI 角色，不混入玩家“我”的资料'}。
${detail ? `本次只处理“${detail.label}”（${field}）：已有文字就润色和具体化；没有文字就参考已有资料补全。只输出这一项，不改其他字段。保留既有事实、关系、能力限制与相处边界。` : mode === 'fill' ? '只补充空白字段，已有内容原样保留。' : '优化文字并补充空白字段，保留既有事实、关系、能力限制与相处边界，不改变人设。'}
以用户构思和已有设定为准。可为虚构人物补充相容的穿着、声音、习惯、专长和目标，具体简练，每项一到两句。
姓名、性别、年龄、身高、自定义性别和代词，未明确提供就留空，不按姓名或职业推断；不套用性别刻板性格。
gender 只用 male/female/custom/空字符串。自定义性别写在 genderCustom。pronoun 原样保留，由界面自动选择或用户手动指定。
不要写剧情续篇、开场白、私人备注、HTML 或分析过程。只输出一个 JSON 对象，所有值均为字符串，仅使用下列字段：
${(detail ? [field] : profileAIKeys(kind)).join(', ')}。不要输出代码围栏。`;
  const output = await llm.chat([
    { role: 'system', content: instruction },
    { role: 'user', content: JSON.stringify({ 人物构思: brief.trim(), 已有资料: current }) },
  ], { max_tokens: detail ? 600 : 2200, temperature: mode === 'fill' ? 0.8 : 0.65 });
  const parsed = safeJson(output.content || '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回的资料格式不完整，请重试');
  }
  const normalized = { ...profileAIContext(parsed, kind), ...normalizeProfile(parsed) };
  const result = {};
  for (const key of detail ? [field] : profileAIKeys(kind)) {
    if (key === 'pronoun') continue; // 自动代词的空值也是用户选择，不能让 AI 覆盖。
    if (!normalized[key]) continue;
    if (current[key] && ((!detail && mode === 'fill') || FIXED_KEYS.has(key))) continue;
    result[key] = normalized[key];
  }
  if (detail && !result[field]) throw new Error(`AI 未返回“${detail.label}”的有效内容，请重试`);
  return result;
}

/** 请求发出后被用户改过的字段不覆盖；撤销也只撤销仍等于 AI 结果的字段。 */
export function mergeProfileResult(current, baseline, result) {
  const next = { ...current }, changes = {};
  for (const [key, value] of Object.entries(result)) {
    if (clean(current[key]) !== clean(baseline[key]) || clean(current[key]) === clean(value)) continue;
    next[key] = value;
    changes[key] = { before: current[key] ?? '', after: value };
  }
  return { next, changes };
}

export function undoProfileResult(current, changes) {
  const next = { ...current };
  let count = 0;
  for (const [key, value] of Object.entries(changes || {})) {
    if (next[key] !== value.after) continue;
    next[key] = value.before;
    count++;
  }
  return { next, count };
}

function session(kind, id) {
  const key = `${kind}:${id}`;
  if (!sessions.has(key)) sessions.set(key, { brief: '', busy: false, status: '', undo: null,
    activeField: '', fieldStatus: {}, fieldUndos: {} });
  return sessions.get(key);
}

export function profileAIEditor(kind, id) {
  const s = session(kind, id);
  return `<section class="profile-ai" aria-label="AI 人物资料助手">
    <label class="mini" for="${kind}-profile-brief">让 AI 帮你填写人物</label>
    <textarea id="${kind}-profile-brief" class="cf-ta" data-profile-brief rows="2" placeholder="一句话即可，例如：沉稳的山城摄影师，喜欢独自旅行。已有资料时可留空。">${escapeHtml(s.brief)}</textarea>
    <div class="btn-row">
      <button class="mini-btn primary" data-profile-mode="fill" ${s.busy ? 'disabled' : ''}>AI 补全空白</button>
      <button class="mini-btn" data-profile-mode="polish" ${s.busy ? 'disabled' : ''}>AI 优化设定</button>
      <button class="mini-btn" data-profile-undo ${!s.undo || s.busy ? 'disabled' : ''}>撤销本次填写</button>
    </div>
    <p class="profile-hint">补全只填空白；优化会润色已有描述并补充细节，保留已填姓名、性别、年龄和身高。生成后可继续修改。</p>
    <div class="ai-status" role="status" aria-live="polite" data-profile-status>${escapeHtml(s.status)}</div>
  </section>`;
}

/** 每次重绘重新绑定；异步结果只应用于发起请求的当前人物。 */
export function bindProfileAI(root, { kind, id, llm, load, save, currentId, refresh }) {
  const panel = root?.querySelector('.profile-ai');
  if (!panel) return;
  const s = session(kind, id);
  const brief = panel.querySelector('[data-profile-brief]');
  brief.oninput = () => { s.brief = brief.value; };
  const repaint = () => { if (currentId() === id) refresh(); };
  const report = (message, field = '') => {
    s.status = message;
    if (field) s.fieldStatus[field] = message;
  };
  const run = async (mode, field = '') => {
      if (s.busy) return;
      const source = load(id);
      if (!source) return;
      const baseline = profileAIContext(source, kind);
      s.brief = brief.value;
      s.busy = true;
      s.activeField = field;
      const label = PROFILE_FIELDS.find((f) => f.key === field)?.label;
      report(field ? `AI 正在美化“${label}”…` : 'AI 正在整理人物资料，请稍候…', field);
      repaint();
      try {
        const result = await generateProfile(llm, source, { kind, brief: s.brief, mode, field });
        const latest = load(id);
        if (!latest || currentId() !== id) {
          report('已切换人物，未应用这次生成结果；可重新生成。', field);
          return;
        }
        const { next, changes } = mergeProfileResult(latest, baseline, result);
        const count = Object.keys(changes).length;
        if (count) {
          save(next);
          for (const key of Object.keys(changes)) delete s.fieldUndos[key];
          s.undo = changes;
          if (field) s.fieldUndos[field] = changes;
        }
        report(count ? `${field ? `“${label}”已美化` : `已填写 ${count} 项`}，可继续编辑或撤销。${kind === 'card' ? '检查后点击“应用到作品设定”。' : '已自动保存。'}`
          : '没有可更新的字段；已填写或生成期间修改的内容均已保留。', field);
      } catch (error) {
        report('填写失败：' + error.message, field);
      } finally {
        s.busy = false;
        s.activeField = '';
        repaint();
      }
  };
  panel.querySelectorAll('[data-profile-mode]').forEach((button) => {
    button.onclick = () => run(button.dataset.profileMode);
  });
  const undo = (field = '') => {
    const changes = field ? s.fieldUndos[field] : s.undo;
    if (s.busy || !changes || currentId() !== id) return;
    const latest = load(id);
    if (!latest) return;
    const { next, count } = undoProfileResult(latest, changes);
    if (count) save(next);
    if (s.undo === changes) s.undo = null;
    for (const key of Object.keys(changes)) {
      if (s.fieldUndos[key] === changes) delete s.fieldUndos[key];
      s.fieldStatus[key] = count ? '已撤销 AI 填写，后续手动修改已保留。' : '已保留你的手动修改。';
    }
    report(count ? `已撤销 ${count} 项 AI 填写，保留你后续手动修改的内容。` : '没有可撤销的字段，你后续的修改已保留。', field);
    repaint();
  };
  panel.querySelector('[data-profile-undo]').onclick = () => undo();
  (root.querySelectorAll?.('[data-profile-field]') || []).forEach((button) => {
    const key = button.dataset.profileField;
    button.disabled = s.busy;
    button.textContent = s.busy && s.activeField === key ? 'AI 处理中…' : 'AI 美化';
    button.onclick = () => run('polish', key);
  });
  (root.querySelectorAll?.('[data-profile-field-undo]') || []).forEach((button) => {
    const key = button.dataset.profileFieldUndo;
    button.disabled = s.busy || !s.fieldUndos[key];
    button.onclick = () => undo(key);
  });
  (root.querySelectorAll?.('[data-profile-field-status]') || []).forEach((element) => {
    element.textContent = s.fieldStatus[element.dataset.profileFieldStatus] || '';
  });
}
