/** 角色卡与玩家身份共用的人物资料、字段和提示词。 */
import { escapeHtml } from './render.js';

export const GENDERS = [
  { value: '', label: '未设定' },
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'custom', label: '自定义' },
];

export const PROFILE_FIELDS = [
  { key: 'age', label: '年龄', hint: '例如：26岁；未知可留空' },
  { key: 'height', label: '身高', hint: '例如：178 cm' },
  { key: 'build', label: '体型与体态', hint: '体格、比例、站姿与行动习惯' },
  { key: 'clothing', label: '穿着与风格', hint: '常穿的服装、配饰、整体风格' },
  { key: 'voice', label: '声音特征', hint: '音色、语速、口音；具体说话习惯可写在说话方式中' },
  { key: 'features', label: '个人特征', hint: '发型、面部特征、妆容或胡须、伤疤、习惯动作' },
  { key: 'abilities', label: '能力与专长', hint: '职业技能、擅长与不擅长的事' },
  { key: 'goals', label: '目标与动机', hint: '当前想做什么、重视什么、为什么行动' },
  { key: 'boundaries', label: '相处偏好与边界', hint: '喜欢怎样被称呼、交往方式、不能接受的行为' },
];
export const PROFILE_KEYS = ['gender', 'genderCustom', 'pronoun', ...PROFILE_FIELDS.map((f) => f.key)];

const text = (value) => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/** 不按姓名/旧代词推断性别；兼容 AI 返回的中文和英文选项。 */
export function normalizeProfile(source = {}) {
  const result = Object.fromEntries(PROFILE_KEYS.map((key) => [key, text(source[key])]));
  const aliases = { '男': 'male', '男性': 'male', '女': 'female', '女性': 'female',
    '未设定': '', '未知': '', 'unknown': '', '自定义': 'custom', 'other': 'custom' };
  const raw = result.gender;
  const key = raw.toLowerCase();
  if (Object.hasOwn(aliases, key)) result.gender = aliases[key];
  else if (GENDERS.some((g) => g.value === key)) result.gender = key;
  else if (raw) { result.gender = 'custom'; result.genderCustom ||= raw; }
  if (!['', '他', '她', 'TA'].includes(result.pronoun)) result.pronoun = '';
  return result;
}

export function profileToText(source) {
  const p = normalizeProfile(source);
  const gender = p.gender === 'custom' ? p.genderCustom : GENDERS.find((g) => g.value === p.gender)?.label;
  const pronoun = p.pronoun || ({ male: '他', female: '她' }[p.gender] || '');
  return [
    p.gender && gender ? `性别：${gender}` : '',
    pronoun ? `叙述代词：${pronoun}` : '',
    ...PROFILE_FIELDS.map((f) => p[f.key] ? `${f.label}：${p[f.key]}` : ''),
  ].filter(Boolean).join('\n');
}

/** 同一套输入用于双方；切换性别只变标题和填写提示，保留已填资料。 */
export function profileEditor(source, attr = 'data-k') {
  const p = normalizeProfile(source);
  const prefix = attr === 'data-pk' ? 'persona' : 'card';
  const title = { male: '男性人物细节', female: '女性人物细节', custom: '自定义人物细节' }[p.gender] || '详细人物设定';
  const esc = (value) => escapeHtml(value).replace(/"/g, '&quot;');
  const field = (f, compact = false) => `<div class="cf">
    <label class="mini" for="${prefix}-${f.key}">${f.label}</label>
    ${compact ? `<input id="${prefix}-${f.key}" class="cf-in" ${attr}="${f.key}" value="${esc(p[f.key])}" placeholder="${esc(f.hint)}">`
      : `<textarea id="${prefix}-${f.key}" class="cf-ta" ${attr}="${f.key}" rows="2" placeholder="${esc(f.hint)}">${escapeHtml(p[f.key])}</textarea>`}
    ${compact ? '' : `<div class="profile-field-tools">
      <button type="button" class="cf-ai" data-profile-field="${f.key}" aria-label="${f.label}：AI 美化" title="只美化这一项；空白时根据人物设定补全">AI 美化</button>
      <button type="button" class="cf-ai" data-profile-field-undo="${f.key}" aria-label="${f.label}：撤销美化" disabled>撤销</button>
    </div><div class="profile-field-status" data-profile-field-status="${f.key}" role="status" aria-live="polite"></div>`}
  </div>`;
  return `<section class="profile-editor" aria-label="人物资料">
    <div class="profile-grid">
      <div class="cf"><label class="mini" for="${prefix}-gender">性别</label>
        <select id="${prefix}-gender" class="cf-in" ${attr}="gender">${GENDERS.map((g) => `<option value="${g.value}" ${p.gender === g.value ? 'selected' : ''}>${g.label}</option>`).join('')}</select>
      </div>
      <div class="cf"><label class="mini" for="${prefix}-pronoun">叙述代词</label>
        <select id="${prefix}-pronoun" class="cf-in" ${attr}="pronoun">${['', '他', '她', 'TA'].map((v) => `<option value="${v}" ${p.pronoun === v ? 'selected' : ''}>${v || '自动（按性别）'}</option>`).join('')}</select>
      </div>
      ${field(PROFILE_FIELDS[0], true)}${field(PROFILE_FIELDS[1], true)}
    </div>
    ${p.gender === 'custom' ? `<div class="cf"><label class="mini" for="${prefix}-genderCustom">性别说明</label><input id="${prefix}-genderCustom" class="cf-in" ${attr}="genderCustom" value="${esc(p.genderCustom)}" placeholder="填写这个人物的性别设定"></div>` : ''}
    <details class="profile-details" ${p.gender || PROFILE_FIELDS.slice(2).some((f) => p[f.key]) ? 'open' : ''}>
      <summary>${title}</summary>
      <p class="profile-hint">每项都可单独 AI 美化；留空时根据已有设定补全。切换性别会保留已填内容。</p>
      ${PROFILE_FIELDS.slice(2).map((f) => field(f)).join('')}
    </details>
  </section>`;
}

export const PROFILE_AI_RULES = `同时整理人物资料字段：gender（male/female/custom/空字符串）、genderCustom（自定义性别说明）、age（年龄）、height（身高）、build（体型体态）、clothing（穿着）、voice（声音）、features（个人特征）、abilities（能力专长）、goals（目标动机）、boundaries（相处偏好与边界）。资料只属于主要 AI 角色，不要混入玩家资料。原文或构思未明确的性别、年龄等资料留空，不依据姓名猜测性别。所有字段使用字符串。`;
