/** 新建作品向导回归：模拟模型与存储，不读取用户数据。 */
import assert from 'node:assert/strict';
import { STORY_STEPS, storyAnswers, askStoryQuestion, normalizeStoryDraft,
  validateStoryDraft, generateStoryDraft, buildStoryBundle } from './js/story-creator.js';
import * as store from './js/store.js';
import { personaToBlock } from './js/persona.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const mock = (value) => ({ async chat() { return { content: typeof value === 'string' ? value : JSON.stringify(value) }; } });
const fixture = () => ({
  title: '山城来信', premise: '一封旧信让两位旅伴重新调查老街的往事。',
  world: '现代山城，老街即将改造。没有超自然力量。', tone: '慢节奏探索',
  character: { name: '顾岚', gender: 'female', age: '28', tagline: '修复旧书的店主',
    personality: '谨慎细心', background: '自小在山城长大', build: '体态匀称', voice: '清亮',
    shortTermGoal: '确认旧信寄件人', longTermGoal: '保住老街书店', fear: '再次失去家人',
    need: '学会接受帮助', contradiction: '渴望亲近却习惯回避', boundaries: '不容许伤害店员',
    behaviorCues: '压力下先整理物品再回答', arc: '逐步学会信任伙伴' },
  persona: { name: '周川', gender: 'male', identity: '回乡的摄影师，与顾岚是旧识', personality: '沉稳' },
  supportingCharacters: [{ name: '陈伯', identity: '老街邮递员', relationship: '认识顾岚的父亲',
    shortTermGoal: '确认旧信是否寄错', longTermGoal: '守住老邮局', fear: '被街坊视为多管闲事',
    need: '承认自己也需要帮助', contradiction: '热心却害怕介入', boundaries: '不替当事人做决定',
    behaviorCues: '遇到压力会反复核对日期', arc: '从旁观者成为主动证人' }],
  storyMechanics: { timeline: '按线索和选择推进，不按固定轮数跳阶段',
    relationshipStages: '从旧识试探到重新信任；误解可使关系暂时退回',
    triggerRules: '找到寄件记录后才触发钟楼调查；若线索不足先出现新阻碍',
    brakeConditions: '角色明确拒绝时停止当前行动，先处理信任与安全感',
    consequences: '公开旧信会引发街坊议论，也可能获得新证词',
    npcAgency: '陈伯会主动核对邮戳，小林可能带来夜班时看到的线索' },
  worldbook: [{ type: 'event', name: '雨夜钟楼停摆', keys: ['钟楼', '老钟'], requires: ['雨夜'],
    excludes: ['钟楼已修复'], relationshipStage: '信任', content: '钟楼停摆会暴露暗门；角色可能隐瞒，也可能主动说明。' }],
  scene: { time: '秋日午后', world: '山城', location: '旧书店' },
  opening: '雨水敲着店檐。顾岚放下旧书，抬头说道：“好久不见。”',
});
let data = new Map(), failKey = null, permanent = false, writeCount = 0;
globalThis.localStorage = {
  getItem(key) { return data.get(key) ?? null; },
  setItem(key, value) {
    writeCount++;
    if (key === failKey) { if (!permanent) failKey = null; throw new Error('QuotaExceededError'); }
    data.set(key, String(value));
  },
  removeItem(key) { data.delete(key); },
};
globalThis.alert = (msg) => { throw new Error('Unexpected alert: ' + msg); };
function seed() {
  data = new Map([
    ['sil.configs', JSON.stringify({ old: { id: 'old', name: '旧作品', personaId: 'old-persona' } })],
    ['sil.cards', JSON.stringify({ 'old-card': { id: 'old-card', name: '旧人物' } })],
    ['sil.personas', JSON.stringify({ 'old-persona': { id: 'old-persona', name: '旧身份' } })],
    ['sil.chat', JSON.stringify({ 'old:old-card': [{ role: 'user', content: '保留的历史' }] })],
    ['sil.lastcard.old', 'old-card'], ['sil.current', 'old'], ['sil.persona.current', 'old-persona'],
  ]);
  failKey = null; permanent = false; writeCount = 0;
}

await test('访谈只提取当前步骤以前的公开回答', () => {
  assert.equal(STORY_STEPS.length, 6);
  assert.deepEqual(storyAnswers({ idea: ' 山城 ', world: '现代', character: '店主', secret: '私密' }, 2), { idea: '山城', world: '现代' });
  assert.deepEqual(storyAnswers({ idea: '山城', dynamics: '慢慢建立信任' }).dynamics, '慢慢建立信任');
  assert.deepEqual(storyAnswers({ idea: { nested: 1 }, world: false }), {});
});
await test('AI 追问携带已有回答，排除之后的回答与任意附加字段', async () => {
  const result = await askStoryQuestion({ async chat(messages, opts) {
    const input = JSON.parse(messages[1].content);
    assert.equal(input.当前主题, '背景与架构');
    assert.deepEqual(input.已有回答, { idea: '山城探索' });
    assert.equal(opts.max_tokens, 450);
    return { content: '{"question":"这座山城在什么时代？","options":["现代","现代","近未来","古代","多余"]}' };
  } }, 1, { idea: '山城探索', world: '未到的回答', secret: '隐藏' });
  assert.deepEqual(result.options, ['现代', '近未来', '古代']);
});
await test('无选项的问题可使用默认参考，问题和选项限制长度', async () => {
  assert.deepEqual((await askStoryQuestion(mock({ question: '背景？', options: {} }), 1, {})).options, STORY_STEPS[1].options);
  const q = await askStoryQuestion(mock({ question: '问'.repeat(600), options: ['选'.repeat(300)] }), 1, {});
  assert.equal(q.question.length, 350); assert.equal(q.options[0].length, 180);
});
await test('非法步骤、无效 AI 问题和网络错误明确失败', async () => {
  await assert.rejects(askStoryQuestion(mock({}), 9, {}), /无效/);
  for (const output of ['不是JSON', '{}', '{"question":[]}']) await assert.rejects(askStoryQuestion(mock(output), 1, {}));
  await assert.rejects(askStoryQuestion({ chat() { throw new Error('离线'); } }, 1, {}), /离线/);
});
await test('草稿白名单过滤旧标识、私人备注及未声明字段', () => {
  const f = fixture();
  f.id = 'old'; f.messages = ['旧聊天']; f.character.id = 'old-card'; f.character.avatar = 'private';
  f.persona.note = '私密'; f.persona.id = 'old-persona'; f.scene.extra = '未知';
  f.storyMechanics.script = '不允许的字段'; f.supportingCharacters[0].id = 'foreign-id';
  const d = normalizeStoryDraft(f);
  for (const key of ['id', 'messages']) assert.ok(!(key in d));
  for (const key of ['id', 'avatar']) assert.ok(!(key in d.character));
  assert.ok(!('note' in d.persona)); assert.ok(!('id' in d.persona)); assert.ok(!('extra' in d.scene));
  assert.ok(!('script' in d.storyMechanics)); assert.ok(!('id' in d.supportingCharacters[0]));
});
await test('富场景字段经过白名单并进入作品配置', () => {
  const f = fixture();
  f.scene = {
    time: '雨夜', world: '山城', location: '旧书店', weather: '小雨', atmosphere: '压抑', lighting: '昏黄',
    sounds: ['雨声', '钟响'], scents: ['潮湿木头'],
    participants: [{ name: '顾岚', position: '柜台后', emotion: '警觉', action: '翻账本', secret: '过滤' }],
    objects: [{ name: '旧信', location: '桌面', status: '未拆封', extra: '过滤' }], goal: '确认来源', conflict: '有人监视', tension: 6,
    extra: '过滤',
  };
  const d = normalizeStoryDraft(f);
  assert.equal(d.scene.weather, '小雨'); assert.deepEqual(d.scene.sounds, ['雨声', '钟响']);
  assert.equal(d.scene.participants[0].position, '柜台后'); assert.ok(!('secret' in d.scene.participants[0]));
  assert.ok(!('extra' in d.scene));
  const { cfg } = buildStoryBundle(f);
  assert.equal(cfg.scene.objects[0].status, '未拆封'); assert.equal(cfg.scene.tension, 6);
});
await test('中文性别及数字年龄兼容，不按姓名推断性别', () => {
  const f = fixture(); f.character.gender = '女'; f.character.age = 28; delete f.persona.gender;
  const d = normalizeStoryDraft(f);
  assert.equal(d.character.gender, 'female'); assert.equal(d.character.age, '28'); assert.equal(d.persona.gender, '');
});
await test('配角与世界书数量受限，过滤无效内容并规范化关键词', () => {
  const f = fixture();
  f.supportingCharacters = Array.from({ length: 7 }, (_, i) => ({ name: '人物' + i, id: 'ignored' }));
  f.worldbook = Array.from({ length: 12 }, (_, i) => ({ name: '条目' + i, keys: '钟楼， 钟楼,书店\n雨天', content: '设定' }));
  const d = normalizeStoryDraft(f);
  assert.equal(d.supportingCharacters.length, 4); assert.equal(d.worldbook.length, 8);
  assert.deepEqual(d.worldbook[0].keys, ['钟楼', '书店', '雨天']);
  assert.ok(!('id' in d.supportingCharacters[0]));
  assert.equal(normalizeStoryDraft({ worldbook: [null, {}, { name: '空内容' }] }).worldbook.length, 0);
  const typed = normalizeStoryDraft({ worldbook: [{ type: 'event', name: '事件', keys: ['钟楼'], requires: ['雨夜'], excludes: ['修复'], relationshipStage: '信任', content: '结果' }] }).worldbook[0];
  assert.equal(typed.type, 'event'); assert.deepEqual(typed.requires, ['雨夜']); assert.deepEqual(typed.excludes, ['修复']);
});
await test('缺少必填字段时阻止创建，错误指出缺失内容', () => {
  assert.throws(() => validateStoryDraft(normalizeStoryDraft({})), /作品名称.*世界背景.*我的身份.*开场白/);
  const f = fixture(); f.persona.identity = '  ';
  assert.throws(() => buildStoryBundle(f), /我的身份/);
});
await test('直接生成前校验至少一个想法，不调用模型', async () => {
  await assert.rejects(generateStoryDraft({ chat() { throw new Error('不应调用'); } }, {}), /先写一句/);
});
await test('草稿请求使用访谈事实与小说格式，返回完整规范化资料', async () => {
  const draft = await generateStoryDraft({ async chat(messages, opts) {
    assert.match(messages[0].content, /玩家承接最多占开场正文10%/);
    assert.match(messages[0].content, /不要按姓名猜测性别/);
    assert.match(messages[0].content, /shortTermGoal/);
    assert.match(messages[0].content, /relationshipStage/);
    assert.match(messages[0].content, /storyMechanics/);
    assert.match(messages[0].content, /brakeConditions/);
    assert.match(messages[0].content, /独立目标、顾虑、边界与行为线索/);
    assert.deepEqual(JSON.parse(messages[1].content), { 访谈回答: { idea: '现代山城' } });
    assert.equal(opts.max_tokens, 6000);
    return { content: JSON.stringify(fixture()) };
  } }, { idea: '现代山城', secret: '不发送' });
  assert.equal(draft.title, '山城来信'); assert.equal(draft.character.voice, '清亮');
});
await test('草稿缺少必填人物字段时自动重试完整 JSON', async () => {
  let calls = 0;
  const result = await generateStoryDraft({ async chat(messages, opts) {
    calls++;
    assert.equal(opts.max_tokens, 6000);
    if (calls === 1) return { content: JSON.stringify({ title: '标题', premise: '处境', world: '背景', opening: '开场' }) };
    return { content: JSON.stringify({ ...fixture(), character: { name: '顾岚', personality: '谨慎' }, persona: { identity: '旧识' } }) };
  } }, { idea: '故事' });
  assert.equal(calls, 2); assert.equal(result.character.name, '顾岚'); assert.equal(result.persona.identity, '旧识');
});
await test('草稿缺少关系阶段或触发规则时自动重试补齐机制', async () => {
  let calls = 0;
  await generateStoryDraft({ async chat() {
    calls++;
    const draft = fixture();
    if (calls === 1) delete draft.storyMechanics.brakeConditions;
    return { content: JSON.stringify(draft) };
  } }, { idea: '有阶段推进和分支条件的山城故事' });
  assert.equal(calls, 2);
});
await test('剧情机制兼容数组、对象和同义字段', async () => {
  const draft = fixture();
  draft.storyMechanics = undefined;
  draft.mechanics = {
    timeline: ['相遇', '共同调查', '根据选择进入不同结局'],
    relationship_stages: [{ stage: '试探', condition: '共同确认线索' }],
    eventTriggers: { condition: '找到旧信', consequence: '出现新证词' },
    refusalConditions: ['被欺骗时暂停合作'],
    aftermath: ['公开秘密会提高风险'],
    npcActions: [{ name: '陈伯', action: '主动核对邮戳' }],
  };
  const result = await generateStoryDraft({ async chat() { return { content: JSON.stringify(draft) }; } }, { idea: '兼容机制格式' });
  assert.match(result.storyMechanics.timeline, /相遇/);
  assert.match(result.storyMechanics.relationshipStages, /共同确认线索/);
  assert.match(result.storyMechanics.triggerRules, /找到旧信/);
  assert.match(result.storyMechanics.npcAgency, /主动核对邮戳/);
});
await test('完整重试仍缺机制时定向修复并回填', async () => {
  let calls = 0;
  const repaired = { timeline: '按选择推进', relationshipStages: '共同经历后进入信任', triggerRules: '发现旧信后触发调查',
    brakeConditions: '角色拒绝时暂停', consequences: '选择会改变风险', npcAgency: '配角主动核对线索' };
  const result = await generateStoryDraft({ async chat(messages) {
    calls++;
    if (calls <= 2) { const draft = fixture(); delete draft.storyMechanics; return { content: JSON.stringify(draft) }; }
    if (calls === 3) return { content: JSON.stringify({ storyMechanics: repaired }) };
    return { content: JSON.stringify({ ...fixture(), storyMechanics: repaired }) };
  } }, { idea: '需要机制修复的故事' });
  assert.equal(calls, 4);
  assert.equal(result.storyMechanics.npcAgency, repaired.npcAgency);
});
await test('模型损坏、截断、缺项与离线时不写入任何数据', async () => {
  seed(); const before = [...data];
  for (const output of ['无效', '[]', '{"title":"未完成"', '{}']) await assert.rejects(generateStoryDraft(mock(output), { idea: '故事' }));
  await assert.rejects(generateStoryDraft({ chat() { throw new Error('离线'); } }, { idea: '故事' }), /离线/);
  assert.deepEqual([...data], before); assert.equal(writeCount, 0);
});
await test('草稿组装生成独立作品、角色卡、身份且无存储副作用', () => {
  seed(); const before = [...data], f = fixture(), source = JSON.stringify(f);
  const a = buildStoryBundle(f), b = buildStoryBundle(f);
  assert.notEqual(a.configId, b.configId); assert.notEqual(a.card.id, b.card.id); assert.notEqual(a.persona.id, b.persona.id);
  assert.equal(a.cfg.personaId, a.persona.id); assert.equal(a.card.scenario, f.world + '\n\n' + f.premise);
  assert.equal(a.card.firstMes, f.opening); assert.equal(a.cfg.greeting, f.opening);
  assert.deepEqual([...data], before); assert.equal(writeCount, 0); assert.equal(JSON.stringify(f), source);
});
await test('人物、世界背景与玩家身份均能进入实际提示词', () => {
  const { cfg, persona } = buildStoryBundle(fixture());
  const blocks = cfg.blocks.map((b) => b.content).join('\n');
  assert.match(blocks, /顾岚/); assert.match(blocks, /体态匀称/); assert.match(blocks, /现代山城/);
  assert.match(blocks, /慢节奏探索/); assert.match(personaToBlock(persona), /回乡的摄影师/);
  assert.ok(cfg.blocks.every((b) => b.id && b.enabled));
});
await test('配角常驻、世界书按词触发，缺关键词使用条目名', () => {
  const f = fixture(); f.worldbook[0].name = '钟楼'; f.worldbook[0].keys = [];
  const { cfg } = buildStoryBundle(f);
  const support = cfg.entries.find((e) => e.constant), lore = cfg.entries.find((e) => !e.constant);
  assert.match(support.content, /老街邮递员/); assert.match(support.content, /认识顾岚的父亲/);
  assert.match(support.content, /当前目标：确认旧信是否寄错/);
  assert.match(support.content, /变化方向：从旁观者成为主动证人/);
  assert.deepEqual(lore.keys, ['钟楼']); assert.equal(cfg.entries.length, 2);
  assert.equal(lore.type, 'event'); assert.deepEqual(lore.requires, ['雨夜']); assert.deepEqual(lore.excludes, ['钟楼已修复']);
  assert.equal(lore.relationshipStage, '信任'); assert.match(lore.content, /可能隐瞒/);
});
await test('主要角色驱动字段进入角色卡和模型提示词', () => {
  const { cfg, card } = buildStoryBundle(fixture());
  assert.equal(card.shortTermGoal, '确认旧信寄件人'); assert.equal(card.longTermGoal, '保住老街书店');
  const text = cfg.blocks.map((block) => block.content).join('\n');
  for (const value of ['确认旧信寄件人', '再次失去家人', '学会接受帮助', '渴望亲近却习惯回避', '逐步学会信任伙伴']) assert.ok(text.includes(value));
});
await test('阶段、触发、刹车、后果和配角自主性进入新作品提示词', () => {
  const { cfg } = buildStoryBundle(fixture());
  const mechanics = cfg.blocks.find((block) => block.name === '剧情推进与互动机制')?.content || '';
  for (const value of ['阶段与时间线', '关系阶段', '事件触发规则', '犹豫、拒绝与暂停', '选择的后续影响', '配角自主行动']) {
    assert.ok(mechanics.includes(value), `缺少机制区块：${value}`);
  }
  assert.match(mechanics, /不按固定轮数跳阶段/);
  assert.match(mechanics, /停止当前行动/);
  assert.ok(cfg.blocks.some((block) => block.content.includes('找到寄件记录后才触发钟楼调查')));
});
await test('场景与默认记忆、四选项正确初始化，旧记忆为空', () => {
  const { cfg } = buildStoryBundle(fixture());
  assert.deepEqual(cfg.scene, fixture().scene); assert.equal(cfg.memory.enabled, true);
  assert.deepEqual(cfg.memory.shortTerm, []); assert.deepEqual(cfg.memory.longTerm, []); assert.equal(cfg.memory.summary, '');
  assert.equal(cfg.choices.enabled, true); assert.equal(cfg.responseFormat.enabled, true); assert.equal(cfg.responseFormat.showReview, false);
});
await test('预览中可关闭记忆和四个选项', () => {
  const { cfg } = buildStoryBundle({ ...fixture(), memoryEnabled: false, choicesEnabled: false });
  assert.equal(cfg.memory.enabled, false); assert.equal(cfg.choices.enabled, false);
});
await test('成功保存仅添加新实体，旧作品、身份和聊天原样保留', () => {
  seed(); const oldConfigs = store.listConfigs(), oldCards = store.listCards(), oldPersonas = store.listPersonas(), oldChat = data.get('sil.chat');
  const bundle = buildStoryBundle(fixture()); store.saveStoryBundle(bundle);
  assert.equal(Object.keys(store.listConfigs()).length, 2); assert.equal(Object.keys(store.listCards()).length, 2); assert.equal(Object.keys(store.listPersonas()).length, 2);
  assert.deepEqual(store.loadConfig('old'), oldConfigs.old); assert.deepEqual(store.loadCard('old-card'), oldCards['old-card']);
  assert.deepEqual(store.loadPersona('old-persona'), oldPersonas['old-persona']); assert.equal(data.get('sil.chat'), oldChat);
  assert.equal(store.currentId(), bundle.configId); assert.equal(store.currentPersonaId(), bundle.persona.id);
  assert.equal(data.get('sil.lastcard.' + bundle.configId), bundle.card.id); assert.deepEqual(store.loadChat(bundle.configId, bundle.card.id), []);
});
await test('作品、角色或身份 ID 冲突均不覆盖已有数据', () => {
  for (const target of ['config', 'card', 'persona']) {
    seed(); const before = [...data], bundle = buildStoryBundle(fixture());
    if (target === 'config') bundle.configId = 'old';
    if (target === 'card') bundle.card.id = 'old-card';
    if (target === 'persona') { bundle.persona.id = 'old-persona'; bundle.cfg.personaId = 'old-persona'; }
    assert.throws(() => store.saveStoryBundle(bundle), /标识重复/); assert.deepEqual([...data], before); assert.equal(writeCount, 0);
  }
});
await test('身份绑定不一致时在存储之前拒绝', () => {
  seed(); const bundle = buildStoryBundle(fixture()); bundle.cfg.personaId = 'wrong';
  assert.throws(() => store.saveStoryBundle(bundle), /不完整/); assert.equal(writeCount, 0);
});
await test('六个提交位置分别失败均回滚所有修改，并保留草稿', () => {
  for (const key of ['sil.cards', 'sil.personas', 'sil.configs', 'last', 'sil.current', 'sil.persona.current']) {
    seed(); store.saveCreationDraft({ version: 1, answers: { idea: '继续保存' } });
    const bundle = buildStoryBundle(fixture()), before = new Map(data);
    failKey = key === 'last' ? 'sil.lastcard.' + bundle.configId : key;
    assert.throws(() => store.saveStoryBundle(bundle), /保存失败，未创建作品/);
    assert.deepEqual(data, before); assert.equal(store.loadCreationDraft().answers.idea, '继续保存');
  }
});
await test('无法恢复存储时明确提示部分恢复失败', () => {
  seed(); failKey = 'sil.current'; permanent = true;
  assert.throws(() => store.saveStoryBundle(buildStoryBundle(fixture())), /部分数据无法恢复/);
  failKey = null; permanent = false;
});
await test('向导草稿保存、读取、清空独立于现有作品', () => {
  seed(); const before = new Map(data);
  store.saveCreationDraft({ version: 1, phase: 'preview', draft: fixture() });
  assert.equal(store.loadCreationDraft().draft.title, '山城来信');
  store.clearCreationDraft(); assert.equal(store.loadCreationDraft(), null); assert.deepEqual(data, before);
});
console.log(`\n${passed} 项新作品向导回归全部通过。`);
