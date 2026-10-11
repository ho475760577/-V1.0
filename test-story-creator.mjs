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
    personality: '谨慎细心', background: '自小在山城长大', build: '体态匀称', voice: '清亮' },
  persona: { name: '周川', gender: 'male', identity: '回乡的摄影师，与顾岚是旧识', personality: '沉稳' },
  supportingCharacters: [{ name: '陈伯', identity: '老街邮递员', relationship: '认识顾岚的父亲' }],
  worldbook: [{ name: '钟楼', keys: ['钟楼', '老钟'], content: '老街的钟楼每逢雨天会停摆。' }],
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
  assert.equal(STORY_STEPS.length, 5);
  assert.deepEqual(storyAnswers({ idea: ' 山城 ', world: '现代', character: '店主', secret: '私密' }, 2), { idea: '山城', world: '现代' });
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
  const d = normalizeStoryDraft(f);
  for (const key of ['id', 'messages']) assert.ok(!(key in d));
  for (const key of ['id', 'avatar']) assert.ok(!(key in d.character));
  assert.ok(!('note' in d.persona)); assert.ok(!('id' in d.persona)); assert.ok(!('extra' in d.scene));
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
    assert.match(messages[0].content, /不替玩家决定言行/);
    assert.match(messages[0].content, /不要按姓名猜测性别/);
    assert.deepEqual(JSON.parse(messages[1].content), { 访谈回答: { idea: '现代山城' } });
    assert.equal(opts.max_tokens, 3600);
    return { content: JSON.stringify(fixture()) };
  } }, { idea: '现代山城', secret: '不发送' });
  assert.equal(draft.title, '山城来信'); assert.equal(draft.character.voice, '清亮');
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
  const f = fixture(); f.worldbook[0].keys = [];
  const { cfg } = buildStoryBundle(f);
  const support = cfg.entries.find((e) => e.constant), lore = cfg.entries.find((e) => !e.constant);
  assert.match(support.content, /老街邮递员/); assert.match(support.content, /认识顾岚的父亲/);
  assert.deepEqual(lore.keys, ['钟楼']); assert.equal(cfg.entries.length, 2);
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
