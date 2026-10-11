/** 人物资料回归：不访问真实模型或浏览器存储。node test-profile.mjs */
import assert from 'node:assert/strict';
import { makeCard, cardToBlocks, exportCard, importCard, classifyStory, expandDirection, generateExample } from './js/card.js';
import { makePersona, personaToBlock } from './js/persona.js';
import { PROFILE_KEYS, normalizeProfile, profileEditor, profileToText } from './js/profile.js';
import { assemble, makeBlock } from './js/assembler.js';
import * as store from './js/store.js';

globalThis.localStorage = {
  values: new Map(),
  getItem(k) { return this.values.get(k) ?? null; },
  setItem(k, v) { this.values.set(k, String(v)); },
  removeItem(k) { this.values.delete(k); },
};
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

const details = {
  gender: 'female', genderCustom: '', pronoun: '', age: '28岁', height: '172 cm',
  build: '匀称，站姿挺拔', clothing: '深色夹克与登山鞋', voice: '清亮，语速平稳',
  features: '短发，左眉有一道旧疤', abilities: '识图与野外导航',
  goals: '找到失踪的探险队', boundaries: '尊重个人决定，称呼用名字',
};

await test('空白角色和玩家不猜性别、不指定代词', () => {
  assert.equal(makeCard().gender, '');
  assert.equal(makePersona().pronoun, '');
  assert.equal(profileToText(makeCard()), '');
  assert.equal(personaToBlock(makePersona()), null);
});
await test('性别输入兼容中文、英文和自定义；数值年龄保留', () => {
  assert.equal(normalizeProfile({ gender: '女', age: 28 }).gender, 'female');
  assert.equal(normalizeProfile({ gender: '女', age: 28 }).age, '28');
  assert.equal(normalizeProfile({ gender: 'MALE' }).gender, 'male');
  assert.equal(normalizeProfile({ gender: '无性别仿生人' }).genderCustom, '无性别仿生人');
  assert.equal(normalizeProfile({ age: { invalid: true } }).age, '');
});
await test('角色卡与玩家身份各自存储全部人物字段', () => {
  const card = makeCard({ name: '顾岚', ...details });
  const player = makePersona({ name: '周川', ...details, gender: 'male' });
  store.saveCard(card); store.savePersona(player);
  for (const key of PROFILE_KEYS) {
    assert.equal(store.loadCard(card.id)[key], card[key]);
    assert.equal(store.loadPersona(player.id)[key], player[key]);
  }
  assert.notEqual(store.loadCard(card.id).gender, store.loadPersona(player.id).gender);
});
await test('男女选择展开对应详情，旧资料保持未设定', () => {
  assert.match(profileEditor(details), /女性人物细节/);
  assert.match(profileEditor({ ...details, gender: 'male' }), /男性人物细节/);
  assert.match(profileEditor({ name: '旧角色' }), /value="" selected>未设定/);
  for (const key of PROFILE_KEYS.filter((k) => k !== 'genderCustom')) {
    assert.ok(profileEditor(details).includes(`data-k="${key}"`));
    assert.ok(profileEditor(details, 'data-pk').includes(`data-pk="${key}"`));
  }
});
await test('切换性别不丢详情，自动代词对应性别', () => {
  const female = profileToText(details);
  const male = profileToText({ ...details, gender: 'male' });
  assert.match(female, /叙述代词：她/); assert.match(male, /叙述代词：他/);
  assert.ok(female.includes(details.abilities) && male.includes(details.abilities));
  assert.match(profileToText({ ...details, pronoun: 'TA' }), /叙述代词：TA/);
});
await test('自定义性别显示说明输入框，旧说明不混入男性设定', () => {
  const p = { ...details, gender: 'custom', genderCustom: '无性别仿生人' };
  assert.match(profileEditor(p), /data-k="genderCustom"/);
  assert.match(profileToText(p), /性别：无性别仿生人/);
  assert.ok(!profileToText({ ...p, gender: 'male' }).includes('仿生人'));
});
await test('人物输入正确转义，不生成新的 HTML 属性或元素', () => {
  const html = profileEditor({ age: '28" autofocus onfocus="bad', features: '</textarea><script>bad()</script>' });
  assert.ok(html.includes('28&quot; autofocus onfocus=&quot;bad'));
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
});
await test('角色卡导出导入保留全部人物字段与原有长文本', () => {
  const card = makeCard({ name: '顾岚', ...details, appearance: '短发\n\n【人物资料】\n常带微笑',
    background: '做过向导\n\n如今寻找线索', personality: '谨慎', creatorNotes: '仅自己看' });
  const raw = exportCard(card);
  const back = importCard(raw);
  for (const key of [...PROFILE_KEYS, 'appearance', 'background', 'personality', 'creatorNotes']) {
    assert.equal(back[key], card[key], key);
  }
  assert.ok(JSON.parse(raw).data.description.includes('性别：女'));
});
await test('外部普通角色卡的【人物资料】段不会被删除', () => {
  const card = importCard({ data: { name: '外部卡', description: '【人物资料】\n未知出身的旅客。' } });
  assert.ok(card.appearance.includes('未知出身的旅客'));
  assert.equal(card.gender, '');
});
await test('新资料进入角色设定，创作者备注不进入', () => {
  const blocks = cardToBlocks(makeCard({ ...details, creatorNotes: '私人编辑备注' }));
  const all = blocks.map((b) => b.content).join('\n');
  for (const value of Object.values(details).filter(Boolean)) {
    if (value !== 'female') assert.ok(all.includes(value));
  }
  assert.ok(all.includes('性别：女') && !all.includes('私人编辑备注'));
});
await test('玩家的外貌、背景与详情进入提示词，私人备注不进入', () => {
  const text = personaToBlock(makePersona({ ...details, gender: 'male',
    appearance: '黑发、戴眼镜', background: '曾在山城工作', note: '私人备注' }));
  for (const value of ['性别：男', '28岁', '黑发、戴眼镜', '曾在山城工作', details.goals]) assert.ok(text.includes(value));
  assert.ok(!text.includes('私人备注') && text.includes('不要替'));
});
await test('没有或只有一个设定块时，玩家性别也进入 system', () => {
  for (const blocks of [[], [makeBlock({ content: '主设定' })]]) {
    const out = assemble({ blocks, persona: personaToBlock(makePersona({ gender: 'female', age: '30岁' })) });
    assert.ok(out.messages.find((m) => m.role === 'system').content.includes('性别：女'));
  }
});
await test('AI 故事分类回填资料，并兼容中文性别与数值年龄', async () => {
  let request;
  const result = await classifyStory({ async chat(messages) {
    request = messages[0].content;
    return { content: JSON.stringify({ name: '顾岚', ...details, gender: '女', age: 28 }) };
  } }, '顾岚是一位28岁的女性向导。');
  assert.equal(result.gender, 'female'); assert.equal(result.age, '28');
  assert.equal(result.abilities, details.abilities);
  assert.ok(request.includes('gender') && request.includes('不要混入玩家资料'));
});
await test('AI 展开与示例对话使用人物资料', async () => {
  const card = await expandDirection({ async chat(messages) {
    assert.ok(messages[0].content.includes('gender'));
    return { content: JSON.stringify({ name: '顾岚', ...details }) };
  } }, { name: '顾岚' }, '女性向导');
  assert.equal(card.gender, 'female'); assert.equal(card.height, details.height);
  await generateExample({ async chat(messages) {
    assert.ok(messages[0].content.includes('性别：女'));
    assert.ok(messages[0].content.includes(details.goals));
    return { content: '「先查看地图。」' };
  } }, card);
});

console.log(`\n人物资料回归：${passed} 项通过。`);
