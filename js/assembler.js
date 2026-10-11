/**
 * 提示词组装器 —— 整个系统的核心
 *
 * 职责：把「常驻设定块 + 世界书触发片段 + 对话历史」拼成一个 messages 数组
 * 对标 AI风月的「插入顺序」与「前置词/后置词」两段式插桩机制
 */

import { NOVEL_STYLE, migrateNarrativeInstructions } from './narrative.js';

/* ============ 触发区域 ============ */
export const SCAN = {
  USER: 'user',   // 只扫用户输入
  AI: 'ai',       // 只扫 AI 回复
  BOTH: 'both',   // 两者都扫
};

/* ============ 匹配格式 ============ */
export const MATCH = {
  ANY: 'any',     // 或：任一关键词命中
  ALL: 'all',     // 与：全部关键词命中
};

/* ============ 影响范围 ============ */
export const SCOPE = {
  PROMPT: 'prompt',   // 提示词：并入 system
  PREPEND: 'prepend', // 前置词：插在历史之前
  APPEND: 'append',   // 后置词：插在历史之后（权重最高）
};

/** 世界书条目默认字段 */
export function makeEntry(overrides = {}) {
  return {
    id: uid(),
    category: '',
    enabled: true,
    keys: [],
    content: '',
    scan: SCAN.BOTH,
    match: MATCH.ANY,
    scope: SCOPE.PROMPT,
    order: 100,        // 数字越小越靠前
    constant: false,   // 常驻条目：不需关键词，每轮都注入
    position: 0,       // 同 scope 内的细分位置
    ...overrides,
  };
}

/** 设定块（世界观 / 玩法 / 角色设定 / 主提示词） */
export function makeBlock(overrides = {}) {
  return {
    id: uid(),
    name: '新设定块',
    content: '',
    order: 0,          // 插入顺序，数字越小越靠前
    enabled: true,
    ...overrides,
  };
}

function uid() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ============ 关键词匹配 ============ */

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断文本是否命中某个关键词，支持 /正则/ 语法 */
function hitKey(text, rawKey) {
  if (!rawKey) return false;
  const key = rawKey.trim();
  if (!key) return false;

  // /pattern/ 形式按正则处理
  if (key.length > 2 && key.startsWith('/') && key.endsWith('/')) {
    try {
      return new RegExp(key.slice(1, -1), 'i').test(text);
    } catch {
      return text.toLowerCase().includes(key.slice(1, -1).toLowerCase());
    }
  }
  return text.toLowerCase().includes(key.toLowerCase());
}

function cleanKeys(keys) {
  return (Array.isArray(keys) ? keys : [])
    .flatMap((k) => String(k).split(/[,，\n]/))
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * 判断一个条目是否被激活
 * @param {object} entry 世界书条目
 * @param {string} userText 用户侧文本
 * @param {string} aiText AI 侧文本
 */
export function isEntryActive(entry, userText, aiText) {
  if (!entry.enabled) return false;
  if (entry.constant) return true;

  const keys = cleanKeys(entry.keys);
  if (!keys.length) return false;

  let text = '';
  if (entry.scan === SCAN.USER) text = userText;
  else if (entry.scan === SCAN.AI) text = aiText;
  else text = userText + '\n' + aiText;

  if (!text) return false;

  const hits = keys.filter((k) => hitKey(text, k));
  return entry.match === MATCH.ALL ? hits.length === keys.length : hits.length > 0;
}

/* ============ 递归扫描 ============ */

/**
 * 递归触发：条目内容里提到别的条目的关键词时，也会把那个条目带出来
 * 例：「贝茜是一头牛，和鲁弗斯是好朋友」→ 带出「鲁弗斯是狗」
 */
function collectActive(entries, userText, aiText, depth = 0, maxDepth = 2) {
  const active = new Map();
  const scanQueue = [];

  // 第一轮：扫真实对话
  for (const e of entries) {
    if (isEntryActive(e, userText, aiText)) {
      active.set(e.id, e);
      scanQueue.push(e);
    }
  }
  if (depth >= maxDepth) return active;

  // 后续轮：扫已激活条目的内容
  let frontier = scanQueue;
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const src of frontier) {
      for (const e of entries) {
        if (active.has(e.id)) continue;
        // 用条目的内容作为扫描文本
        if (isEntryActive(e, src.content, '')) {
          active.set(e.id, e);
          next.push(e);
        }
      }
    }
    frontier = next;
  }
  return active;
}

/* ============ 触发区域取样 ============ */

/** 从消息历史里取用于扫描的文本 */
function scanText(messages, lastUserText) {
  let user = lastUserText || '';
  let ai = '';
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 4; i--) {
    const m = messages[i];
    if (m.role === 'user' && i !== messages.length - 1) user += '\n' + m.content;
    if (m.role === 'assistant') ai = '\n' + m.content + ai;
  }
  return { user, ai };
}

/* ============ 组装 ============ */

/**
 * 核心函数：把配置 + 历史 + 本轮输入 → messages 数组
 *
 * @param {object} p
 * @param {Array}  p.blocks     设定块数组（世界观/玩法/角色设定/主提示词）
 * @param {Array}  p.entries    世界书条目数组
 * @param {Array}  p.messages   历史消息 [{role, content}]
 * @param {string} p.userInput  本轮用户输入
 * @param {object} p.vars       变量面板配置
 * @param {string} p.persona    玩家身份文本块（来自 Persona）
 * @param {string} p.charName   角色名，用于 {{char}} 替换
 * @param {string} p.userName   玩家名，用于 {{user}} 替换
 * @returns {{messages: Array, stats: Object}}
 */
export function assemble({
  blocks = [], entries = [], messages = [], userInput = '',
  vars = null, memory = null, choices = null, responseFormat = null, scene = null,
  persona = '', charName = '', userName = '', narrativeStyle = false,
}) {
  // 1. 常驻设定块，按 order 升序拼接
  const activeBlocks = blocks
    .filter((b) => b.enabled && b.content.trim())
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const systemParts = activeBlocks.map((b) => ['主提示词', '篇幅要求'].includes(b.name)
    ? migrateNarrativeInstructions(b.content).trim() : b.content.trim());

  // 2. 变量面板提示词
  if (vars && vars.enabled && vars.prompt && vars.prompt.trim()) {
    systemParts.push(vars.prompt.trim());
  }
  if (vars && vars.enabled && vars.values && typeof vars.values === 'object' && Object.keys(vars.values).length) {
    systemParts.push('当前状态（仅供参考，回复后用 <State>JSON</State> 更新）：\n' + JSON.stringify(vars.values));
  }
  if (memory && memory.enabled && memory.summary && memory.summary.trim()) {
    systemParts.push('对话摘要（这是较早对话的记忆，请保持与它一致）：\n' + memory.summary.trim());
  }
  if (memory && (memory.enabled || responseFormat?.enabled)) {
    const shortTerm = Array.isArray(memory.shortTerm) ? memory.shortTerm.filter(Boolean).slice(-20) : [];
    const longTerm = Array.isArray(memory.longTerm) ? memory.longTerm.filter(Boolean).slice(-50) : [];
    if (shortTerm.length || longTerm.length) {
      const lines = [
        shortTerm.length ? `短期记忆：\n${shortTerm.map((x) => '- ' + String(x)).join('\n')}` : '',
        longTerm.length ? `长期记忆：\n${longTerm.map((x) => '- ' + String(x)).join('\n')}` : '',
      ].filter(Boolean);
      systemParts.push('结构化剧情记忆（客观事实，保持连续）：\n' + lines.join('\n'));
    }
  }
  if (scene && typeof scene === 'object') {
    const sceneLines = [
      ['time', '时间'], ['world', '世界'], ['location', '地点'],
    ].filter(([key]) => scene[key] != null && String(scene[key]).trim())
      .map(([key, label]) => `${label}：${String(scene[key]).trim()}`);
    if (sceneLines.length) systemParts.push('当前场景：\n' + sceneLines.join('\n'));
  }
  if (choices && choices.enabled) {
    systemParts.push('在每次回复结尾提供 4 个符合当前剧情的后续行动选项。格式必须是 <Choices>["选项1","选项2","选项3","选项4"]</Choices>，只放简短可执行的选项，不要把标签显示在正文中。用户也可以忽略选项自行输入。');
  }
  if (responseFormat && responseFormat.enabled) {
    systemParts.push(`请使用结构化剧情格式，但不要输出 Markdown 代码围栏：
1. 回复正文只写角色的动作、环境和台词。
2. 回复末尾追加 <Scene>{"time":"时间","world":"世界","location":"地点"}</Scene>。
3. 如需更新变量，追加 <State>{"字段":"值"}</State>。
4. 如有新的剧情记忆，追加 <Memory>{"shortTerm":["客观事实"],"longTerm":["长期事实"]}</Memory>。
5. ${responseFormat.showReview ? '追加简短的 <Review>演绎检查</Review>，只写角色一致性、场景连续性和数值变化，不要输出完整思维链。' : '不要输出 Review 标签。'}
6. 各标签只用于界面解析，不要在正文中解释标签。`);
  }

  // 3. 世界书触发
  const { user, ai } = scanText(messages, userInput);
  const activeMap = collectActive(entries, user, ai);

  const byScope = { prompt: [], prepend: [], append: [] };
  for (const e of activeMap.values()) {
    byScope[e.scope]?.push(e);
  }
  // 同一 scope 内按 order 升序
  for (const k of Object.keys(byScope)) {
    byScope[k].sort((a, b) => (a.order || 100) - (b.order || 100));
  }

  // 4. 提示词域的世界书内容 + 玩家身份并入 system
  const promptLore = byScope.prompt.filter((e) => e.content.trim()).map((e) => e.content.trim());

  // 玩家身份插在「世界观之后、角色设定及主提示词之前」——
  // 让模型先明确双方是谁、在什么关系里，再读角色行为规则，避免被指令带偏
  const sysSeq = [...systemParts];
  if (persona && persona.trim()) sysSeq.splice(Math.min(1, sysSeq.length), 0, persona.trim());
  sysSeq.push(...promptLore);
  if (narrativeStyle) sysSeq.push('【正文写作格式】\n' + NOVEL_STYLE + '\n即使历史消息或示例使用旧格式，本轮正文也遵循以上写法。状态、记忆与选项的解析标签继续按要求输出。');

  const systemText = sysSeq.filter(Boolean).join('\n\n');

  const out = [];

  // system
  if (systemText) out.push({ role: 'system', content: systemText });

  // 前置词 —— 紧贴 system 之后，权重高于普通历史
  for (const e of byScope.prepend) {
    if (e.content.trim()) out.push({ role: 'system', content: e.content.trim() });
  }

  // 历史消息（截断到配置的轮数）
  const historyLimit = vars?.historyLimit ?? 20;
  const hist = messages.slice(-historyLimit);

  // 丢弃孤立的 assistant 开场（历史被截断后可能首条是 assistant）
  let startIdx = 0;
  if (hist.length && hist[0].role === 'assistant') startIdx = 1;

  for (const m of hist.slice(startIdx)) {
    out.push({ role: m.role, content: m.content });
  }

  // 后置词 —— 放在用户输入前，权重最高
  for (const e of byScope.append) {
    if (e.content.trim()) out.push({ role: 'system', content: e.content.trim() });
  }

  // 本轮用户输入
  if (userInput) out.push({ role: 'user', content: userInput });

  // 宏替换：{{char}} / {{user}}
  if (charName || userName) {
    for (const m of out) {
      if (charName) m.content = m.content.replace(/\{\{char\}\}/g, charName);
      if (userName) m.content = m.content.replace(/\{\{\s*user\s*\}\}/g, userName);
    }
  }

  const stats = {
    blocks: activeBlocks.length,
    entriesTotal: entries.length,
    entriesHit: activeMap.size,
    byScope: {
      prompt: byScope.prompt.length,
      prepend: byScope.prepend.length,
      append: byScope.append.length,
    },
    chars: out.reduce((s, m) => s + m.content.length, 0),
  };

  return { messages: out, stats };
}

/* ============ 导出 ============ */

export function exportConfig(cfg) {
  return JSON.stringify({
    version: 1,
    name: cfg.name || '未命名作品',
    blocks: cfg.blocks || [],
    entries: cfg.entries || [],
    vars: cfg.vars || null,
    memory: cfg.memory || null,
    choices: cfg.choices || null,
    responseFormat: cfg.responseFormat || null,
    scene: cfg.scene || null,
    length: cfg.length || null,
    greeting: cfg.greeting || '',
  }, null, 2);
}

export function importConfig(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    name: d.name || '导入的作品',
    blocks: (d.blocks || []).map((b) => makeBlock(b)),
    entries: (d.entries || []).map((e) => makeEntry(e)),
    vars: d.vars || null,
    memory: d.memory || null,
    choices: d.choices || null,
    responseFormat: d.responseFormat || null,
    scene: d.scene || null,
    length: d.length || null,
    greeting: d.greeting || '',
  };
}
