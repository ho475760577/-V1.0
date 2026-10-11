/** 人物 AI 与小说格式回归；所有模型返回均为模拟，不读取用户数据。 */
import assert from 'node:assert/strict';
import { generateProfile, profileAIContext, mergeProfileResult, undoProfileResult, profileAIEditor, bindProfileAI } from './js/profile-assist.js';
import { makeCard, cardToBlocks, generateExample, expandDirection, classifyStory, polishText } from './js/card.js';
import { makePersona } from './js/persona.js';
import { profileEditor, PROFILE_FIELDS } from './js/profile.js';
import { NOVEL_STYLE, migrateNarrativeInstructions } from './js/narrative.js';
import { LENGTH_PRESETS, applyLengthSettings } from './js/prompts.js';
import { assemble, makeBlock } from './js/assembler.js';
import { formatText, parseStructuredReply } from './js/render.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const mock = (content) => ({ async chat() { return { content: typeof content === 'string' ? content : JSON.stringify(content) }; } });

await test('请求仅包含当前人物公开字段，不发送私人备注或图片', () => {
  for (const kind of ['card', 'persona']) {
    const context = profileAIContext({ name: '周川', gender: 'male', note: '秘密', creatorNotes: '私密', avatar: '图片', firstMes: '旧开场', messages: ['聊天'] }, kind);
    assert.equal(context.name, '周川');
    for (const key of ['note', 'creatorNotes', 'avatar', 'firstMes', 'messages']) assert.ok(!(key in context));
  }
});
await test('补全只更新空白，过滤 AI 返回的未知字段', async () => {
  const source = makeCard({ name: '周川', gender: 'male', age: '30', build: '匀称' });
  const result = await generateProfile(mock({ name: '另一个人', gender: 'female', age: 22, build: '高大', voice: '低沉', note: '泄漏', id: 'changed' }), source);
  assert.deepEqual(result, { voice: '低沉' });
  assert.equal(source.name, '周川');
});
await test('优化能修改描述，但不能改已填基本事实', async () => {
  const result = await generateProfile(mock({ name: '改名', gender: 'female', pronoun: '她', age: 99, height: '199', personality: '说话简短，习惯先观察', voice: '清亮' }),
    makePersona({ name: '周川', gender: 'male', pronoun: '他', age: '30', height: '178', personality: '谨慎' }), { kind: 'persona', mode: 'polish' });
  assert.deepEqual(result, { personality: '说话简短，习惯先观察', voice: '清亮' });
});
await test('AI 可从一句构思补充资料，中文性别与数字年龄规范化', async () => {
  const result = await generateProfile(mock({ gender: '女', age: 28, abilities: '摄影', features: '短发' }), makeCard(), { brief: '28岁的女性摄影师' });
  assert.equal(result.gender, 'female'); assert.equal(result.age, '28'); assert.equal(result.abilities, '摄影');
});
await test('AI 不覆盖自动代词，避免出现女性资料配男性代词', async () => {
  const result = await generateProfile(mock({ pronoun: '他', voice: '清亮' }), makeCard({ gender: 'female' }));
  assert.ok(!('pronoun' in result)); assert.equal(result.voice, '清亮');
});
await test('男女和玩家详情每项都有独立 AI 美化与撤销入口', () => {
  for (const gender of ['male', 'female', 'custom', '']) {
    for (const attr of ['data-k', 'data-pk']) {
      const html = profileEditor({ gender }, attr);
      for (const field of PROFILE_FIELDS.slice(2)) {
        assert.ok(html.includes(`data-profile-field="${field.key}"`));
        assert.ok(html.includes(`data-profile-field-undo="${field.key}"`));
      }
      assert.ok(!html.includes('data-profile-field="age"'));
    }
  }
});
await test('单项 AI 请求携带人物上下文，但只接受目标字段', async () => {
  const result = await generateProfile({ async chat(messages, opts) {
    assert.match(messages[0].content, /本次只处理“声音特征”（voice）/);
    assert.ok(messages[1].content.includes('旅行摄影师'));
    assert.equal(opts.max_tokens, 600);
    return { content: '{"voice":"清亮，语速平稳","goals":"模型乱改目标","gender":"male"}' };
  } }, makeCard({ gender: 'female', tagline: '旅行摄影师', voice: '清亮', goals: '记录旧街巷' }), { mode: 'polish', field: 'voice' });
  assert.deepEqual(result, { voice: '清亮，语速平稳' });
});
await test('空白细节可按已有资料补全，无效字段及空结果明确报错', async () => {
  const source = makePersona({ gender: 'female', identity: '摄影师' });
  assert.deepEqual(await generateProfile(mock({ clothing: '深色夹克与登山鞋' }), source, { kind: 'persona', field: 'clothing', mode: 'polish' }), { clothing: '深色夹克与登山鞋' });
  await assert.rejects(generateProfile(mock({ goals: '非目标字段' }), source, { field: 'voice' }), /未返回/);
  await assert.rejects(generateProfile(mock({ age: '30' }), source, { field: 'age' }), /有效的人物细节字段/);
});
await test('玩家 AI 请求明确玩家视角，私密备注不出现', async () => {
  await generateProfile({ async chat(messages, options) {
    assert.match(messages[0].content, /玩家“我”的身份/);
    assert.match(messages[0].content, /已有内容原样保留/);
    assert.ok(!JSON.stringify(messages).includes('秘密笔记'));
    assert.equal(typeof options.max_tokens, 'number');
    return { content: '{"identity":"旅行摄影师"}' };
  } }, makePersona({ gender: 'male', note: '秘密笔记' }), { kind: 'persona' });
});
await test('空白输入与错误模式在调用模型前拦截', async () => {
  const failIfCalled = { chat() { throw new Error('不应调用模型'); } };
  await assert.rejects(generateProfile(failIfCalled, makeCard()), /写一句人物想法/);
  await assert.rejects(generateProfile(failIfCalled, makeCard(), { mode: 'wrong' }), /有效/);
});
await test('损坏响应、错误类型与网络失败不会修改原人物', async () => {
  const source = makeCard({ name: '顾岚' }), before = JSON.stringify(source);
  for (const output of ['失败', '[]', '{"voice":{"nested":true}}']) {
    if (output.startsWith('{')) assert.deepEqual(await generateProfile(mock(output), source), {});
    else await assert.rejects(generateProfile(mock(output), source), /格式不完整/);
  }
  await assert.rejects(generateProfile({ async chat() { throw new Error('模型离线'); } }, source), /离线/);
  assert.equal(JSON.stringify(source), before);
});
await test('等待期间手动修改的字段不被回填覆盖', () => {
  const baseline = { voice: '', goals: '找地图' };
  const { next, changes } = mergeProfileResult({ ...baseline, voice: '手动填写', note: '保留' }, baseline, { voice: 'AI 声音', goals: '找到旧地图' });
  assert.equal(next.voice, '手动填写'); assert.equal(next.goals, '找到旧地图'); assert.equal(next.note, '保留');
  assert.deepEqual(Object.keys(changes), ['goals']);
});
await test('撤销只还原本次 AI 写入，保留之后的手动编辑', () => {
  const { next, count } = undoProfileResult({ voice: '手动声音', goals: '新目标', note: '私密' }, {
    voice: { before: '', after: 'AI声音' }, goals: { before: '旧目标', after: '新目标' },
  });
  assert.equal(next.voice, '手动声音'); assert.equal(next.goals, '旧目标'); assert.equal(next.note, '私密'); assert.equal(count, 1);
});

let nextId = 0;
function harness(llm) {
  const id = 'test-ui-' + (++nextId);
  let activeId = id, value = makePersona({ id, name: '周川' }), saves = 0;
  const brief = { value: '旅行摄影师' }, undo = {}, fill = { dataset: { profileMode: 'fill' } }, polish = { dataset: { profileMode: 'polish' } };
  const panel = {
    querySelector: (s) => s === '[data-profile-brief]' ? brief : undo,
    querySelectorAll: () => [fill, polish],
  };
  const fieldButtons = Object.fromEntries(['voice', 'goals'].map((key) => [key, { dataset: { profileField: key } }]));
  const fieldUndos = Object.fromEntries(['voice', 'goals'].map((key) => [key, { dataset: { profileFieldUndo: key } }]));
  const root = { querySelector: () => panel, querySelectorAll: (selector) =>
    selector === '[data-profile-field]' ? Object.values(fieldButtons) : selector === '[data-profile-field-undo]' ? Object.values(fieldUndos) : [] };
  bindProfileAI(root, { kind: 'persona', id, llm,
    load: () => value, save: (updated) => { value = updated; saves++; }, currentId: () => activeId, refresh() {},
  });
  return { id, fill, polish, undo, fieldButtons, fieldUndos, get value() { return value; }, get saves() { return saves; },
    switch() { activeId = 'other-person'; }, edit(key, text) { value[key] = text; } };
}
await test('单项按钮仅保存该字段，可就地撤销且不能再次撤销', async () => {
  const h = harness(mock({ voice: '清亮，语速平稳', goals: '不应修改' }));
  h.edit('voice', '清亮'); h.edit('goals', '原有目标');
  await h.fieldButtons.voice.onclick();
  assert.equal(h.value.voice, '清亮，语速平稳'); assert.equal(h.value.goals, '原有目标');
  h.fieldUndos.voice.onclick();
  assert.equal(h.value.voice, '清亮'); assert.equal(h.value.goals, '原有目标');
  const saves = h.saves; h.undo.onclick(); assert.equal(h.saves, saves);
});
await test('多个细节分别保留撤销，手动修改目标字段后不被撤销覆盖', async () => {
  const h = harness(mock({ voice: '清亮', goals: '寻找古地图' }));
  await h.fieldButtons.voice.onclick(); await h.fieldButtons.goals.onclick();
  h.fieldUndos.voice.onclick();
  assert.equal(h.value.voice, ''); assert.equal(h.value.goals, '寻找古地图');
  h.edit('goals', '手动更改目标'); h.fieldUndos.goals.onclick();
  assert.equal(h.value.goals, '手动更改目标');
});
await test('单项与整页 AI 共用忙碌锁，防止重复生成互相覆盖', async () => {
  let resolve, calls = 0;
  const h = harness({ chat() { calls++; return new Promise((r) => { resolve = r; }); } });
  const pending = h.fieldButtons.voice.onclick();
  await h.fill.onclick(); await h.fieldButtons.goals.onclick();
  assert.equal(calls, 1);
  h.edit('voice', '等待期间手动修改'); resolve({ content: '{"voice":"AI版本"}' }); await pending;
  assert.equal(h.value.voice, '等待期间手动修改'); assert.equal(h.saves, 0);
});
await test('实际按钮事件防重复请求、保存结果并支持一次撤销', async () => {
  let resolve, calls = 0;
  const h = harness({ chat() { calls++; return new Promise((r) => { resolve = r; }); } });
  const pending = h.fill.onclick();
  assert.match(profileAIEditor('persona', h.id), /data-profile-mode="fill" disabled/);
  await h.fill.onclick(); assert.equal(calls, 1);
  resolve({ content: '{"voice":"清亮","goals":"拍摄山城"}' }); await pending;
  assert.equal(h.value.voice, '清亮'); assert.equal(h.saves, 1);
  h.edit('voice', '用户修改'); h.undo.onclick();
  assert.equal(h.value.voice, '用户修改'); assert.equal(h.value.goals, ''); assert.equal(h.saves, 2);
  h.undo.onclick(); assert.equal(h.saves, 2);
});
await test('生成期间切换人物时，不把结果写到其他人物', async () => {
  let resolve;
  const h = harness({ chat() { return new Promise((r) => { resolve = r; }); } });
  const pending = h.fill.onclick(); h.switch(); resolve({ content: '{"voice":"低沉"}' }); await pending;
  assert.equal(h.saves, 0); assert.match(profileAIEditor('persona', h.id), /已切换人物/);
});
await test('AI 失败后按钮恢复，原资料完整', async () => {
  const h = harness({ async chat() { throw new Error('连接失败'); } });
  await h.polish.onclick(); assert.equal(h.saves, 0);
  const html = profileAIEditor('persona', h.id);
  assert.match(html, /填写失败/); assert.ok(!html.includes('data-profile-mode="fill" disabled'));
});
await test('AI 填入细节后自动展开，性别未知仍能看到结果', () => {
  assert.match(profileEditor({ abilities: '摄影' }), /<details class="profile-details" open>/);
});
await test('所有篇幅档位及角色卡都采用小说式格式', () => {
  for (const preset of LENGTH_PRESETS) assert.ok(preset.content.includes(NOVEL_STYLE));
  assert.ok(cardToBlocks(makeCard()).some((b) => b.content.includes(NOVEL_STYLE)));
});
await test('兼容旧主提示词和篇幅指令，不改普通正文括号', () => {
  const legacy = '用「」包裹台词，用（）包裹动作与神态描写。';
  assert.equal(migrateNarrativeInstructions(legacy), NOVEL_STYLE);
  const plain = '照片摄于山城（海拔500米）。她说：“你好。”';
  assert.equal(migrateNarrativeInstructions(plain), plain);
  const out = assemble({ blocks: [makeBlock({ name: '主提示词', content: legacy })], narrativeStyle: true, choices: { enabled: true }, responseFormat: { enabled: true } });
  const system = out.messages[0].content;
  assert.ok(system.includes(NOVEL_STYLE) && !system.includes(legacy));
  assert.ok(system.includes('<Scene>') && system.includes('<Choices>'));
});
await test('迁移旧篇幅预设时保留同一块，避免重复字数要求', () => {
  for (const preset of LENGTH_PRESETS) {
    const old = preset.content.replace(NOVEL_STYLE, preset.key === 'epic' ? '' : '用「」包裹台词，用（）包裹动作与神态描写。')
      .replace('台词使用中文双引号“”。要有来有回，尊重玩家自行决定言行。', '用「」包裹。要有来有回，不要一个人说 monologue');
    const cfg = { blocks: [makeBlock({ name: '主提示词', content: old })] };
    applyLengthSettings(cfg, 'short', LENGTH_PRESETS[0].content);
    assert.equal(cfg.blocks.length, 1); assert.equal(cfg.blocks[0].name, '篇幅要求');
  }
});
await test('小说台词保留中文引号并高亮，流式半句不产生坏标签', () => {
  assert.equal(formatText('她推开门。\n“回来了？”'), '她推开门。<br><span class="quote">“回来了？”</span>');
  assert.equal(formatText('“还没说完'), '“还没说完');
  assert.equal(formatText('山城（海拔500米）'), '山城（海拔500米）');
  assert.equal(formatText('「旧台词」'), '<span class="quote">「旧台词」</span>');
  assert.ok(!formatText('“<script>test</script>”').includes('<script>'));
});
await test('小说格式与场景、记忆、行动选项解析兼容', () => {
  const out = parseStructuredReply('风拂过门廊。“走吧。”\n<Scene>{"location":"门廊"}</Scene>\n<Choices>["跟上","等候","询问","查看地图"]</Choices>');
  assert.equal(out.scene.location, '门廊'); assert.equal(out.choices.length, 4);
});
await test('各类 AI 创作入口统一要求小说式描写', async () => {
  const seen = [];
  const llm = { async chat(messages) { seen.push(messages[0].content); return { content: '{"name":"顾岚"}' }; } };
  await generateExample(llm, makeCard({ name: '顾岚' }));
  await expandDirection(llm, { name: '顾岚' }, '山城摄影师');
  await classifyStory(llm, '顾岚住在山城。');
  await polishText(llm, '她走到门边。');
  for (const content of seen) {
    assert.ok(content.includes('小说'));
    assert.ok(!content.includes('用（）写动作') && !content.includes('用「」包裹台词'));
  }
});

console.log(`\n人物 AI 与小说格式回归：${passed} 项通过。`);
