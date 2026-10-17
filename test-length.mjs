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
