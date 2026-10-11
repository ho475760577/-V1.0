/** 新作品创作：访谈问题 → 可编辑草稿 → 独立作品及人物。 */
import { safeJson } from './json-utils.js';
import { makeCard, cardToBlocks } from './card.js';
import { makePersona } from './persona.js';
import { makeBlock, makeEntry } from './assembler.js';
import { normalizeProfile, PROFILE_KEYS } from './profile.js';
import { NOVEL_STYLE } from './narrative.js';

export const STORY_STEPS = [
  { key: 'idea', label: '故事方向', question: '你想创建什么样的故事？一句想法、题材或想体验的关系都可以。', options: ['现代都市与日常相处', '悬疑调查与冒险', '奇幻世界与成长'] },
  { key: 'world', label: '背景与架构', question: '故事发生在什么时代、地点？这个世界有什么规则或主要矛盾？', options: ['现代山城，旧街区即将改造', '架空王国，各方势力争夺遗迹', '近未来太空站，一次意外打破日常'] },
  { key: 'character', label: '人物设定', question: '你希望与谁互动？可以说说主要人物的性别、性格、经历、外貌体型，以及想加入的配角。', options: ['外冷内热、观察敏锐的同行者', '温和可靠，但藏着一段往事的人', '行动果断，与你立场不同的搭档'] },
  { key: 'persona', label: '我是谁', question: '你在故事中扮演谁，与主要人物是什么关系？名字、性别、性格和经历都可以自由设定。', options: ['初到此地的陌生人', '多年未见的旧识', '带着共同任务的搭档'] },
  { key: 'opening', label: '开场与节奏', question: '你们从什么场景开始？希望慢慢相处、轻松探索，还是一开场就出现事件？', options: ['偶然相遇，慢慢了解彼此', '共同接到一个任务', '突发事件，让你们不得不合作'] },
];

const text = (value) => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, text(record(value)[key])]));
export const STORY_CARD_FIELDS = ['name', 'tagline', 'appearance', 'personality', 'background', 'speechStyle', ...PROFILE_KEYS];
export const STORY_PERSONA_FIELDS = ['name', 'identity', 'appearance', 'personality', 'background', ...PROFILE_KEYS];
export const STORY_SUPPORT_FIELDS = ['name', 'identity', 'personality', 'appearance', 'background', 'relationship'];

export function storyAnswers(source = {}, before = STORY_STEPS.length) {
  return Object.fromEntries(STORY_STEPS.slice(0, before).map((step) => [step.key, text(source[step.key])]).filter(([, value]) => value));
}

/** 每次只问当前主题，前面的回答只作为资料。失败时界面可退回内置问题。 */
export async function askStoryQuestion(llm, index, answers) {
  const step = STORY_STEPS[index];
  if (!step) throw new Error('无效的创作步骤');
  const output = await llm.chat([
    { role: 'system', content: '你是中文故事创作向导。根据用户之前的回答，为当前主题提出一个简短、好回答的问题，以及3个具体的参考回答。已明确的信息不要重复问；可追问未确定的细节。不替用户决定，不生成故事正文。只输出 JSON：{"question":"问题","options":["参考1","参考2","参考3"]}。' },
    { role: 'user', content: JSON.stringify({ 当前主题: step.label, 本步参考: step.question, 已有回答: storyAnswers(answers, index) }) },
  ], { max_tokens: 450, temperature: 0.75 });
  const parsed = record(safeJson(output.content || ''));
  if (!text(parsed.question)) throw new Error('AI 没有返回有效问题');
  const options = [...new Set((Array.isArray(parsed.options) ? parsed.options : []).map(text).filter(Boolean))].slice(0, 3);
  return { question: text(parsed.question).slice(0, 350), options: options.length ? options.map((x) => x.slice(0, 180)) : step.options };
}

/** 白名单避免 AI 提供的 id、旧作品引用、脚本和私人备注进入新作品。 */
export function normalizeStoryDraft(value) {
  const raw = record(value);
  const character = { ...pick(raw.character, STORY_CARD_FIELDS), ...normalizeProfile(record(raw.character)) };
  const persona = { ...pick(raw.persona, STORY_PERSONA_FIELDS), ...normalizeProfile(record(raw.persona)) };
  return {
    ...pick(raw, ['title', 'premise', 'world', 'tone', 'opening']), character, persona,
    scene: pick(raw.scene, ['time', 'world', 'location']),
    supportingCharacters: (Array.isArray(raw.supportingCharacters) ? raw.supportingCharacters : []).slice(0, 4)
      .map((person) => pick(person, STORY_SUPPORT_FIELDS)).filter((person) => person.name),
    worldbook: (Array.isArray(raw.worldbook) ? raw.worldbook : []).slice(0, 8).map((item) => ({
      ...pick(item, ['name', 'content']),
      keys: [...new Set((Array.isArray(item?.keys) ? item.keys : text(item?.keys).split(/[,，\n]/)).map(text).filter(Boolean))].slice(0, 10),
    })).filter((item) => item.name && item.content),
    memoryEnabled: raw.memoryEnabled !== false,
    choicesEnabled: raw.choicesEnabled !== false,
  };
}

export function validateStoryDraft(draft) {
  const missing = [
    [draft.title, '作品名称'], [draft.world, '世界背景'], [draft.premise, '故事概述'],
    [draft.character?.name, '主要人物名字'],
    [draft.character?.personality || draft.character?.background || draft.character?.tagline, '主要人物设定'],
    [draft.persona?.identity, '我的身份'], [draft.opening, '开场白'],
  ].filter(([value]) => !text(value)).map(([, label]) => label);
  if (missing.length) throw new Error('请补充：' + missing.join('、'));
  return draft;
}

export async function generateStoryDraft(llm, answers) {
  const input = storyAnswers(answers);
  if (!Object.keys(input).length) throw new Error('先写一句故事想法，也可以选择交给 AI 构思');
  const output = await llm.chat([
    { role: 'system', content: `你是中文互动小说创作助手。根据访谈回答创建一份可继续编辑的作品初稿。
严格遵守用户已给定的事实、性别、关系、故事方向和边界。未决定之处可做合理创作，但不把猜测包装为用户要求。没有提供的年龄、身高可留空；不要按姓名猜测性别。
区分主要 AI 人物与玩家“我”，两者资料分开；只设一名主要互动人物，配角最多4名。背景、目标和人物关系应相互一致，不预先决定后续剧情结果。
人物资料每项一两句，世界背景简明完整，开场白约150字。${NOVEL_STYLE} 不替玩家决定言行，不输出分析过程。
仅输出完整 JSON 对象，不要代码围栏，字段如下：
{
 "title":"作品名", "premise":"初始处境、矛盾、人物关系", "world":"时代、地点、世界规则、故事架构", "tone":"氛围与节奏",
 "character":${JSON.stringify(Object.fromEntries(STORY_CARD_FIELDS.map((key) => [key, ''])))},
 "persona":${JSON.stringify(Object.fromEntries(STORY_PERSONA_FIELDS.map((key) => [key, ''])))},
 "supportingCharacters":[{"name":"配角名字","identity":"身份","personality":"性格","appearance":"外貌","background":"经历","relationship":"与主角或玩家的关系"}],
 "worldbook":[{"name":"地点/势力/规则名","keys":["触发词"],"content":"可供剧情调用的简短设定"}],
 "scene":{"time":"故事开始时间","world":"世界名称","location":"开场地点"}, "opening":"小说式开场白"
}
gender 只用 male/female/custom/空字符串，自定义说明写 genderCustom。字段使用字符串，supportingCharacters/worldbook 使用数组；无配角或额外世界书时返回空数组。必须填写 title、premise、world、character.name、人物基本设定、persona.identity 和 opening。` },
    { role: 'user', content: JSON.stringify({ 访谈回答: input }) },
  ], { max_tokens: 3600, temperature: 0.8 });
  const parsed = safeJson(output.content || '');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('AI 草稿格式不完整，请重试');
  return validateStoryDraft(normalizeStoryDraft(parsed));
}

/** 只组装，不写存储；预览、取消或生成失败不会修改当前作品。 */
export function buildStoryBundle(value) {
  const draft = validateStoryDraft(normalizeStoryDraft(value));
  const scenario = [draft.world, draft.premise].join('\n\n');
  const card = makeCard({ ...draft.character, scenario, firstMes: draft.opening });
  const persona = makePersona(draft.persona);
  const blocks = cardToBlocks(card).map((block) => makeBlock(block));
  if (draft.tone) blocks.push(makeBlock({ name: '故事氛围与节奏', order: 5, content: draft.tone }));
  const entries = draft.worldbook.map((item) => makeEntry({ category: item.name,
    keys: item.keys.length ? item.keys : [item.name], content: item.content }));
  for (const person of draft.supportingCharacters) {
    entries.push(makeEntry({ category: '登场人物', keys: [person.name], constant: true,
      content: `【配角：${person.name}】\n${[
        person.identity && `身份：${person.identity}`, person.personality && `性格：${person.personality}`,
        person.appearance && `外貌：${person.appearance}`, person.background && `背景：${person.background}`,
        person.relationship && `人物关系：${person.relationship}`,
      ].filter(Boolean).join('\n')}` }));
  }
  const configId = 'cfg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return { configId, card, persona, cfg: {
    name: draft.title, blocks, entries,
    vars: { enabled: false, prompt: '', historyLimit: 20 },
    memory: { enabled: draft.memoryEnabled, summary: '', threshold: 20, keepRecent: 8, shortTerm: [], longTerm: [] },
    choices: { enabled: draft.choicesEnabled }, responseFormat: { enabled: true, showReview: false },
    scene: draft.scene, greeting: draft.opening, personaId: persona.id,
  } };
}
