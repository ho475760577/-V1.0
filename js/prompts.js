/**
 * 主提示词预设
 *
 * 分档：短/中/长/超长。字数是正文目标，实际输出由模型决定。
 * 关键点：明确写出字数下限 + 场景/动作/心理/对话的配比，
 *        否则模型默认会写 300-500 字就收尾。
 */

import { makeBlock } from './assembler.js';
import { NOVEL_STYLE, migrateNarrativeInstructions } from './narrative.js';

export const LENGTH_PRESETS = [
  {
    key: 'short',
    label: '短',
    hint: '200字以内，适合快节奏对答',
    content: `你是一个角色扮演引擎。请完全沉浸在角色中，不要解释、不要跳出角色。
${NOVEL_STYLE}
本次回复控制在 200 字以内，简洁有力。`,
  },

  {
    key: 'medium',
    label: '中',
    hint: '约500 字，兼顾描写与推进',
    content: `你是一个角色扮演引擎。请完全沉浸在角色中，不要解释、不要跳出角色。

【输出要求】
- ${NOVEL_STYLE}
- 本次回复约 500 字，不要提前收尾
- 场景描写要有画面感：光线、气味、温度、声音等细节
- 结尾不要总结、不要提问，自然地把话头留给用户`,
  },

  {
    key: 'long',
    label: '长',
    hint: '约1000 字，充分展开',
    content: `你是一个角色扮演引擎。请完全沉浸在角色中，不要解释、不要跳出角色。

【输出要求】
- ${NOVEL_STYLE}
- 本次回复不少于 1000 字，必须写满
- 结构：环境场景 → 对方动作神态 → 心理活动 → 台词 → 事件推进
- 每个段落都要有细节支撑，不要用概括性的句子带过
- 结尾不要总结、不要提问，自然收在某个动作或情境上，把话头留给用户

【禁止】
- 禁止在写够字数前草草收尾
- 禁止用「他们聊了很久」这类概述替代实际描写
- 禁止跳出角色解释你的行为`,
  },

  {
    key: 'epic',
    label: '超长',
    hint: '不少于2000 字，充分展开场景与细节',
    content: `你是一个角色扮演引擎。请完全沉浸在角色中，不要解释、不要跳出角色。

【核心要求：篇幅】
${NOVEL_STYLE}
- 本次回复必须不少于 2000 字，不写满不算完成
- 绝对禁止提前收尾。宁可场景铺陈得慢，也不能草草结束
- 不要用任何概述句代替实际描写（如「接下来的时间里他们做了很多事」）

【结构配比】（2000 字的分量）
1. 环境与氛围（~400 字）
   空间布局、光线色温、声音质感、气味、温度、在场的人与物件
2. 角色动作与神态（~600 字）
   肢体语言的连续变化，从细微到明显。带停顿、迟疑、下意识的动作

3. 角色心理（~400 字）
   内心活动的自然展开：他怎么想、为什么这么想、在犹豫什么

4. 台词（~400 字）
   台词使用中文双引号“”。要有来有回，尊重玩家自行决定言行。

5. 事件推进（~200 字）
   这一段要有实际变化：新信息、冲突、决定、意外

【描写标准】
- 动作拆到最小单位：「端起杯子」要写成「手指搭在杯沿，停顿一秒，抬起又放下」
- 五感要具体：不说「很香」，说「桂花的甜香混着旧纸页的霉味」
- 允许有留白和静默段落，但必须有氛围承载

【禁止】
- 禁止写够字数前草草收尾
- 禁止用概述跳过场景
- 禁止跳出角色解释行为
- 禁止在结尾提问或总结`,
  },
];

/** 按 key 取内容，找不到回退到 long */
export function getPrompt(key) {
  return (LENGTH_PRESETS.find((p) => p.key === key) || LENGTH_PRESETS[2]).content;
}

/** 正文的建议 token 预算；token 与中文字数没有固定换算关系。 */
export const SUGGESTED_TOKENS = {
  short: 400,
  medium: 900,
  long: 1800,
  epic: 3600,
};

const LENGTH_BLOCK_NAME = '篇幅要求';

/** 读取本作品已应用的设置，同时兼容旧版只保存 maxTokens 的作品。 */
export function getLengthSettings(cfg = {}) {
  const blocks = cfg.blocks || [];
  const block = blocks.find((b) => b.id === cfg.length?.blockId && b.name === LENGTH_BLOCK_NAME)
    || blocks.find((b) => b.name === LENGTH_BLOCK_NAME);
  const savedPreset = LENGTH_PRESETS.find((p) => p.key === cfg.length?.preset);
  const legacyPreset = LENGTH_PRESETS.find((p) => SUGGESTED_TOKENS[p.key] === Number(cfg.vars?.maxTokens));
  const legacyBlock = !block && !cfg.length && legacyPreset
    ? blocks.find((b) => b.name === '主提示词') : null;
  const appliedBlock = block || legacyBlock;
  const key = (savedPreset || legacyPreset)?.key || 'epic';
  return {
    key,
    prompt: appliedBlock ? migrateNarrativeInstructions(appliedBlock.content) : getPrompt(key),
    applied: !!appliedBlock,
    enabled: appliedBlock?.enabled !== false,
    block: appliedBlock,
  };
}

/** 使用独立设定块，避免应用角色卡时覆盖篇幅，或覆盖用户的主提示词。 */
export function applyLengthSettings(cfg, key, prompt) {
  if (!LENGTH_PRESETS.some((p) => p.key === key)) throw new Error('请选择有效的篇幅档位');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('篇幅提示词不能为空');
  cfg.blocks = cfg.blocks || [];
  let block = cfg.blocks.find((b) => b.name === LENGTH_BLOCK_NAME);
  if (!block) {
    // 旧版会把整份预设写进主提示词；只迁移可确认的原始预设。
    const normalize = (text) => migrateNarrativeInstructions(text).replaceAll(NOVEL_STYLE, '')
      .replace(/\r\n/g, '\n').replace(/\n+/g, '\n').trim();
    block = cfg.blocks.find((b) => b.name === '主提示词'
      && LENGTH_PRESETS.some((p) => normalize(b.content) === normalize(p.content)));
  }
  if (!block) {
    block = makeBlock({ name: LENGTH_BLOCK_NAME, order: 99 });
    cfg.blocks.push(block);
  }
  block.name = LENGTH_BLOCK_NAME;
  block.content = prompt.trim();
  block.enabled = true;
  cfg.length = { preset: key, blockId: block.id };
  cfg.vars = { ...(cfg.vars || {}), maxTokens: SUGGESTED_TOKENS[key] };
  return cfg;
}

/** 无效的导入值不下发；状态、记忆和选项另外预留输出空间。 */
export function generationOptions(cfg = {}) {
  if (cfg.length) {
    const block = cfg.blocks?.find((b) => b.id === cfg.length.blockId && b.name === LENGTH_BLOCK_NAME);
    if (!block?.enabled || !block.content?.trim()) return {};
  }
  const raw = cfg.vars?.maxTokens;
  if (typeof raw !== 'number' && typeof raw !== 'string') return {};
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap <= 0) return {};
  const extra = (cfg.responseFormat?.enabled ? 800 : cfg.vars?.enabled ? 400 : 0)
    + (cfg.choices?.enabled ? 200 : 0);
  if (!Number.isSafeInteger(cap + extra)) return {};
  return { max_tokens: cap + extra };
}
