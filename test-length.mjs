/** StoryRealm v3 固定回复格式回归；模型请求使用模拟 HTTP。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIN_BODY_CHARS, MAX_BODY_CHARS, TARGET_BODY_CHARS, getBodyLength, getBodyTarget, generationOptions } from './js/prompts.js';
import { assemble, exportConfig, importConfig, makeBlock } from './js/assembler.js';
import { parseStructuredReply, serializeStructuredReply } from './js/render.js';
import { LLM } from './js/llm.js';
import { NOVEL_STYLE } from './js/narrative.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('正文长度为固定 1000-2000 字，目标 1400 字', () => {
  assert.equal(MIN_BODY_CHARS, 1000);
  assert.equal(MAX_BODY_CHARS, 2000);
  assert.equal(TARGET_BODY_CHARS, 1400);
  assert.equal(getBodyTarget(), 1400);
  assert.equal(getBodyLength('甲 乙\n丙'), 3);
});

test('token 预算是内部固定值，不读取作品档位', () => {
  assert.deepEqual(generationOptions(), { max_tokens: 4600 });
  assert.deepEqual(generationOptions({ vars: { maxTokens: 900 } }), { max_tokens: 4600 });
});

test('页面已移除篇幅档位与编辑面板', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(!/篇幅\s*Tab|lenPresets|lenPrompt|lenApply|id="length"/i.test(html));
});

test('每次结构化回复都要求固定正文长度并禁止思维链', () => {
  const { messages } = assemble({
    blocks: [makeBlock({ name: '主提示词', content: '自定义主提示词。' })],
    responseFormat: { enabled: true }, narrativeStyle: true,
  });
  const system = messages[0].content;
  assert.match(system, /1000-2000/);
  assert.match(system, /目标约 1400/);
  assert.match(system, /不要输出思维链/);
  assert.match(system, /<Player>/);
  assert.match(system, /<Characters>/);
  assert.match(system, /不得将沉默、僵硬、顺从、依赖或生理反应推断为同意/);
  assert.match(system, /亲属或监护关系不得自行改写为恋爱或性关系/);
  assert.ok(system.includes(NOVEL_STYLE));
});

test('结构化状态和行动建议不计入正文长度', () => {
  const raw = `正文内容。\n<Scene>{"location":"旧书店"}</Scene>\n<Player>{"status":"站在门边"}</Player>\n<Changes>{"events":["发现旧信"]}</Changes>\n<Choices>["询问","查看","离开","等待"]</Choices>`;
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.text, '正文内容。');
  assert.equal(parsed.scene.location, '旧书店');
  assert.equal(parsed.player.status, '站在门边');
  assert.equal(getBodyLength(parsed.text), 5);
});

test('修复模型通道标记、未闭合场景标签和局部损坏的 Memory/Choices', () => {
  const scene = JSON.stringify({ time: '周二下午三点', location: '会议室', participants: [{ name: '苏青' }] });
  const slash = String.fromCharCode(92);
  const malformedChoices = `<Choices>[{"text":"展示数据","type":"use","intent":"提供证据","risk":"分析出错时有信誉风险"},{"text":"请林悦补充报告","type":"move", "intent${slash}":${slash}"寻求盟友支持${slash}", "risk${slash}":${slash}"可能显得缺乏独立处理能力${slash}"}]</Choices>`;
  const raw = `<|channel>thought\n<channel|>Scene\n${scene}\n\n苏青抬起头，会议仍在继续。\n<Memory>{"shortTerm":["苏青否认数据问题"],"longTerm_[]}</Memory>\n${malformedChoices}\n<Memory>{"shortTerm":["苏青否认数据问题"],"longTerm":[]}</Memory>\n${malformedChoices}`;
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.scene.location, '会议室');
  assert.deepEqual(parsed.memory.shortTerm, ['苏青否认数据问题']);
  assert.deepEqual(parsed.memory.longTerm, []);
  assert.equal(parsed.choices.length, 2);
  assert.equal(parsed.choices[1].intent, '寻求盟友支持');
  assert.equal(parsed.text, '苏青抬起头，会议仍在继续。');
  const compacted = serializeStructuredReply(parsed).join('\n');
  assert.equal((compacted.match(/<Memory>/g) || []).length, 1);
  assert.equal((compacted.match(/<Choices>/g) || []).length, 1);
  assert.ok(!compacted.includes('channel') && !compacted.includes('thought'));
});

test('无尖括号与损坏结构块不会污染正文或被误算为正文长度', () => {
  const raw = `真正的正文在这里。\nScene\n时间：深夜\n地点：客厅\nPlayer\n{损坏的数据}\nMemory\n## 长期记忆\n- 已发生的事实`;
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.text, '真正的正文在这里。');
  assert.equal(getBodyLength(parsed.text), 9);
  assert.equal(parsed.scene.location, '客厅');
  assert.deepEqual(parsed.unparsed.map((item) => item.name), ['Player']);
});

test('兼容聊天模型输出的分行 Scene 标签和转义 Memory 结束标签', () => {
  const raw = `小说正文仍然保留。\nScene\n时间：深夜\n世界：现代都市\n地点：家中客厅\n情节：等待玩家回应\nPlayer\n{"status":"待玩家决定","values":{}}\nCharacters\n[{"name":"林婉柔","mood":"克制"}]\nMemory\n## 长期记忆\n- 已确认的事实\n&lt;/Memory&gt;`;
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.text, '小说正文仍然保留。');
  assert.equal(parsed.scene.location, '家中客厅');
  assert.equal(parsed.player.status, '待玩家决定');
  assert.equal(parsed.characters[0].name, '林婉柔');
  assert.deepEqual(parsed.memory.longTerm, ['已确认的事实']);
});

test('模型把回复整体包进代码围栏时仍能分离结构数据', () => {
  const parsed = parseStructuredReply('```json\nScene\n时间：深夜\n地点：客厅\nPlayer\n{"status":"等待玩家决定"}\n```');
  assert.equal(parsed.text, '');
  assert.equal(parsed.scene.location, '客厅');
  assert.equal(parsed.player.status, '等待玩家决定');
});

test('Scene 键值行后面的正文不会被当成场景数据吞掉', () => {
  const parsed = parseStructuredReply('Scene\n时间：深夜\n地点：客厅\n\n她把文件推到桌子中央，等候对方回答。');
  assert.equal(parsed.scene.time, '深夜');
  assert.equal(parsed.scene.location, '客厅');
  assert.equal(parsed.text, '她把文件推到桌子中央，等候对方回答。');
});

test('混用键值行和 JSON 字段、Windows 换行时正文仍保持完整', () => {
  const raw = 'Scene\r\n时间：深夜\r\n地点：客厅\r\nparticipants":[{"name":"来访者"}]\r\nobjects":[{"name":"文件"}],"tension":7\r\n\r\n她把文件推到桌子中央。\r\nPlayer\r\n{"status":"等待回答"}';
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.scene.location, '客厅');
  assert.equal(parsed.player.status, '等待回答');
  assert.equal(parsed.text, '她把文件推到桌子中央。');
});

test('失败 JSON 与正文之间的段落边界受到保护', () => {
  const parsed = parseStructuredReply('<Scene>不是合法 JSON\n\n她继续解释数据来源。');
  assert.equal(parsed.text, '她继续解释数据来源。');
  assert.deepEqual(parsed.unparsed.map((item) => item.name), ['Scene']);
  const history = [parsed.text, ...serializeStructuredReply({ ...parsed, unparsed: [] })].filter(Boolean).join('\n\n');
  assert.ok(history.startsWith('她继续解释数据来源。'));
  assert.ok(!history.includes('<Scene>') && !history.includes('不是合法 JSON'));
});

test('未闭合 Markdown 记忆中的空行不会被误当成正文边界', () => {
  const parsed = parseStructuredReply('<Memory>## 长期记忆\n- 已确认事实\n\n## 短期记忆\n- 本轮发现');
  assert.deepEqual(parsed.memory.longTerm, ['已确认事实']);
  assert.deepEqual(parsed.memory.shortTerm, ['本轮发现']);
  assert.equal(parsed.text, '');
});

test('纯正文补写不生成空的结构块覆盖原场景和记忆', () => {
  assert.deepEqual(serializeStructuredReply(parseStructuredReply('只有故事正文。')), []);
});

test('新旧作品配置导入导出不保存篇幅档位', () => {
  const source = { name: '山城来信', blocks: [], entries: [], greeting: '雨夜开场', length: { preset: 'epic' } };
  const serialized = exportConfig(source);
  assert.ok(!serialized.includes('"length"'));
  const imported = importConfig(JSON.parse(serialized));
  assert.equal(imported.greeting, '雨夜开场');
  assert.ok(!('length' in imported));
});

test('模型通信仍明确关闭推理并接受固定生成预算', async () => {
  const oldFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>隐藏</think>正文' } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const llm = new LLM('http://test.local');
    const reply = await llm.chat([{ role: 'user', content: '继续' }], generationOptions());
    assert.equal(body.max_tokens, 4600);
    assert.equal(body.reasoning_budget, 0);
    assert.equal(body.reasoning, 'off');
    assert.equal(reply.content, '正文');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

for (const [name, fn] of tests) {
  await fn();
  console.log('PASS ' + name);
}
console.log(`\nStoryRealm v3 回复格式回归：${tests.length} 项通过。`);
