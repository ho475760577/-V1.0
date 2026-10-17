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
  { key: 'dynamics', label: '关系与推进', question: '人物关系会怎样变化？哪些事件能推动关系或主线，什么情况下人物会犹豫、拒绝或暂时退开？', options: ['从互不信任到并肩合作，每一步都需要共同经历', '关系变化与现实风险并行，重要选择会留下后果', '保留多条路线，由玩家行动决定走向'] },
  { key: 'opening', label: '开场与节奏', question: '你们从什么场景开始？希望慢慢相处、轻松探索，还是一开场就出现事件？', options: ['偶然相遇，慢慢了解彼此', '共同接到一个任务', '突发事件，让你们不得不合作'] },
];

const text = (value) => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, text(record(value)[key])]));
const normalizeSceneDraft = (value) => {
  const raw = record(value);
  const scene = {};
  for (const key of ['time', 'world', 'location', 'plot', 'weather', 'atmosphere', 'lighting', 'goal', 'conflict']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) scene[key] = text(raw[key]);
  }
  for (const key of ['sounds', 'scents']) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const input = Array.isArray(raw[key]) ? raw[key] : text(raw[key]).split(/[,，\n]/);
    scene[key] = [...new Set(input.map(text).filter(Boolean))].slice(0, 8);
  }
  for (const key of ['participants', 'objects']) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const fields = key === 'participants' ? ['name', 'position', 'emotion', 'action'] : ['name', 'location', 'status'];
    scene[key] = (Array.isArray(raw[key]) ? raw[key] : []).slice(0, 12)
      .map((item) => pick(item, fields)).filter((item) => item.name);
  }
  if (raw.tension != null && text(raw.tension)) scene.tension = Number.isFinite(Number(raw.tension)) ? Number(raw.tension) : text(raw.tension);
  return scene;
};
export const STORY_CARD_FIELDS = ['name', 'tagline', 'appearance', 'personality', 'background', 'speechStyle',
  'shortTermGoal', 'longTermGoal', 'fear', 'need', 'contradiction', 'boundaries', 'behaviorCues', 'arc', ...PROFILE_KEYS];
export const STORY_PERSONA_FIELDS = ['name', 'identity', 'appearance', 'personality', 'background', ...PROFILE_KEYS];
export const STORY_SUPPORT_FIELDS = ['name', 'identity', 'personality', 'appearance', 'background', 'relationship',
  'shortTermGoal', 'longTermGoal', 'fear', 'need', 'contradiction', 'boundaries', 'behaviorCues', 'arc'];
export const STORY_MECHANIC_FIELDS = ['timeline', 'relationshipStages', 'triggerRules', 'brakeConditions', 'consequences', 'npcAgency'];

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
  ], { max_tokens: 450, temperature: 0.75, response_format: { type: 'json_object' } });
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
    scene: normalizeSceneDraft(raw.scene),
    supportingCharacters: (Array.isArray(raw.supportingCharacters) ? raw.supportingCharacters : []).slice(0, 4)
      .map((person) => pick(person, STORY_SUPPORT_FIELDS)).filter((person) => person.name),
    storyMechanics: pick(raw.storyMechanics, STORY_MECHANIC_FIELDS),
    worldbook: (Array.isArray(raw.worldbook) ? raw.worldbook : []).slice(0, 8).map((item) => ({
      ...pick(item, ['name', 'content', 'relationshipStage']),
      type: ['general', 'character', 'location', 'organization', 'rule', 'item', 'event', 'relationship'].includes(text(item?.type)) ? text(item.type) : 'general',
      keys: [...new Set((Array.isArray(item?.keys) ? item.keys : text(item?.keys).split(/[,，\n]/)).map(text).filter(Boolean))].slice(0, 10),
      requires: [...new Set((Array.isArray(item?.requires) ? item.requires : text(item?.requires).split(/[,，\n]/)).map(text).filter(Boolean))].slice(0, 10),
      excludes: [...new Set((Array.isArray(item?.excludes) ? item.excludes : text(item?.excludes).split(/[,，\n]/)).map(text).filter(Boolean))].slice(0, 10),
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

function parseGeneratedDraft(content) {
  const parsed = safeJson(content || '');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('AI 草稿格式不完整，请重试');
  const draft = normalizeStoryDraft(parsed);
  const missingMechanics = STORY_MECHANIC_FIELDS.filter((key) => !draft.storyMechanics[key]);
  if (missingMechanics.length) throw new Error('AI 草稿缺少剧情推进机制：' + missingMechanics.join('、'));
  return validateStoryDraft(draft);
}

export async function generateStoryDraft(llm, answers) {
  const input = storyAnswers(answers);
  if (!Object.keys(input).length) throw new Error('先写一句故事想法，也可以选择交给 AI 构思');
  const system = `你是中文互动小说创作助手。根据访谈回答创建一份可继续编辑的作品初稿。
严格遵守用户已给定的事实、性别、关系、故事方向和边界。未决定之处可做合理创作，但不把猜测包装为用户要求。没有提供的年龄、身高可留空；不要按姓名猜测性别。
区分主要 AI 人物与玩家“我”，两者资料分开；只设一名主要互动人物，配角最多4名。背景、目标和人物关系应相互一致，不预先决定后续剧情结果。
主要人物和重要配角都要有独立目标、顾虑、边界与行为线索，不能只作为推动主角剧情的工具。关系阶段要写明进入条件、典型表现和停滞或退回的可能；关键事件要写触发条件、风险来源、可能分支和事后余波。推进节点只能作弹性参考，不按轮数机械跳转。拒绝、犹豫和暂停必须被尊重，并真实改变当前情境。
人物资料具体而精炼，世界背景简明完整，开场白约150字。${NOVEL_STYLE} 玩家承接最多占开场正文10%，不要替玩家决定关键行动，不输出分析过程。
主要人物必须填写 name，以及 personality、background、tagline 三者至少一项；玩家必须填写 persona.identity。即使用户没有明确提供，也要根据故事方向做简短合理设计，不要把必填字段留空。
仅输出一个完整 JSON 对象，不要代码围栏、解释或分析，字段如下：
{
 "title":"作品名", "premise":"初始处境、矛盾、人物关系", "world":"时代、地点、世界规则、故事架构", "tone":"氛围与节奏",
 "character":${JSON.stringify(Object.fromEntries(STORY_CARD_FIELDS.map((key) => [key, ''])))},
 "persona":${JSON.stringify(Object.fromEntries(STORY_PERSONA_FIELDS.map((key) => [key, ''])))},
 "supportingCharacters":[{"name":"配角名字","identity":"身份","personality":"性格","appearance":"外貌","background":"经历","relationship":"与主角或玩家的关系","shortTermGoal":"当前目标","longTermGoal":"长期目标","fear":"顾虑","need":"内在需求","contradiction":"内在矛盾","boundaries":"行为底线","behaviorCues":"压力下的行为","arc":"可能的变化方向"}],
 "storyMechanics":{"timeline":"重要阶段与可变节点；不以固定轮数强制推进","relationshipStages":"关系阶段、进入条件、典型表现、停滞或退回条件","triggerRules":"可触发的关键事件、必要条件、排除条件及其可能后果","brakeConditions":"人物会拒绝、暂停或撤退的情形，以及如何响应","consequences":"重要选择之后的余波、风险变化和关系调整","npcAgency":"配角各自的目标、主动行动及其与主线的交叉方式"},
 "worldbook":[{"type":"location|organization|rule|item|event|relationship|character|general","name":"条目名","keys":["触发关键词"],"requires":["必须已发生的事件或状态词"],"excludes":["发生后不再适用的事件或状态词"],"relationshipStage":"可留空；关系阶段门槛","content":"设定、触发条件与可能后果；描述可分支结果，不预设剧情必然发生"}],
 "scene":{"time":"故事开始时间","world":"世界名称","location":"开场地点","plot":"当前情节","weather":"天气","atmosphere":"氛围","lighting":"光线","sounds":["现场声音"],"scents":["现场气味"],"participants":[{"name":"人物","position":"位置","emotion":"情绪","action":"当前动作"}],"objects":[{"name":"物品","location":"位置","status":"状态"}],"goal":"开场目标","conflict":"初始冲突","tension":0}, "opening":"小说式开场白"
}
gender 只用 male/female/custom/空字符串，自定义说明写 genderCustom。字段使用字符串，supportingCharacters/worldbook 使用数组；无配角或额外世界书时返回空数组。storyMechanics 每项写成可执行的简短规则，不能把具体事件写成必然发生的剧情。必须填写 title、premise、world、character.name、人物基本设定、persona.identity 和 opening。`;
  const user = { role: 'user', content: JSON.stringify({ 访谈回答: input }) };
  let firstError;
  try {
    const output = await llm.chat([{ role: 'system', content: system }, user], {
      max_tokens: 6000, temperature: 0.75, response_format: { type: 'json_object' },
    });
    return parseGeneratedDraft(output.content);
  } catch (error) {
    firstError = error;
  }

  // 小模型偶尔会在嵌套 JSON 的末尾截断；用更明确的短指令自动重试一次，保留原始错误给最终提示。
  try {
    const retry = await llm.chat([
      { role: 'system', content: `${system}\n这是一次格式修复重试。请从头生成完整 JSON，优先保证 character.name、character.personality、persona.identity 和 opening 有非空内容，宁可减少配角和世界书，也不要截断。` },
      user,
    ], { max_tokens: 6000, temperature: 0.55, response_format: { type: 'json_object' } });
    return parseGeneratedDraft(retry.content);
  } catch {
    throw firstError;
  }
}

/** 只组装，不写存储；预览、取消或生成失败不会修改当前作品。 */
export function buildStoryBundle(value) {
  const draft = validateStoryDraft(normalizeStoryDraft(value));
  const scenario = [draft.world, draft.premise].join('\n\n');
  const card = makeCard({ ...draft.character, scenario, firstMes: draft.opening });
  const persona = makePersona(draft.persona);
  const blocks = cardToBlocks(card).map((block) => makeBlock(block));
  if (draft.tone) blocks.push(makeBlock({ name: '故事氛围与节奏', order: 5, content: draft.tone }));
  const mechanics = Object.entries({
    timeline: '阶段与时间线', relationshipStages: '关系阶段', triggerRules: '事件触发规则',
    brakeConditions: '犹豫、拒绝与暂停', consequences: '选择的后续影响', npcAgency: '配角自主行动',
  }).filter(([key]) => draft.storyMechanics[key]).map(([key, label]) => `【${label}】\n${draft.storyMechanics[key]}`);
  if (mechanics.length) blocks.push(makeBlock({ name: '剧情推进与互动机制', order: 6, content: mechanics.join('\n\n') }));
  const entries = draft.worldbook.map((item) => makeEntry({ type: item.type, category: item.name,
    keys: item.keys.length ? item.keys : [item.name], requires: item.requires, excludes: item.excludes,
    relationshipStage: item.relationshipStage, content: item.content }));
  for (const person of draft.supportingCharacters) {
    entries.push(makeEntry({ category: '登场人物', keys: [person.name], constant: true,
      content: `【配角：${person.name}】\n${[
        person.identity && `身份：${person.identity}`, person.personality && `性格：${person.personality}`,
        person.appearance && `外貌：${person.appearance}`, person.background && `背景：${person.background}`,
        person.relationship && `人物关系：${person.relationship}`,
        person.shortTermGoal && `当前目标：${person.shortTermGoal}`, person.longTermGoal && `长期目标：${person.longTermGoal}`,
        person.fear && `顾虑：${person.fear}`, person.need && `内在需求：${person.need}`,
        person.contradiction && `内在矛盾：${person.contradiction}`, person.boundaries && `行为边界：${person.boundaries}`,
        person.behaviorCues && `行为线索：${person.behaviorCues}`, person.arc && `变化方向：${person.arc}`,
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
