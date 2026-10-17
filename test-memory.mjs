/** Markdown 剧情记忆的数据层回归。 */
import assert from 'node:assert/strict';
import { mergeMemory, memoryToMarkdown, normalizeMemory, parseMemoryMarkdown } from './js/memory.js';
import { parseStructuredReply, serializeStructuredReply } from './js/render.js';
import { assemble } from './js/assembler.js';

const markdown = `# 剧情记忆

## 对话摘要
苏青已经发现数据异常的来源。

## 长期记忆
- 苏青负责核心功能。
- 沈煜要求所有结论有数据支撑。

## 短期记忆
- 会议进入正式辩论。
- 沈煜给出三分钟期限。`;

const parsed = parseMemoryMarkdown(markdown);
assert.equal(parsed.summary, '苏青已经发现数据异常的来源。');
assert.deepEqual(parsed.longTerm, ['苏青负责核心功能。', '沈煜要求所有结论有数据支撑。']);
assert.deepEqual(parsed.shortTerm, ['会议进入正式辩论。', '沈煜给出三分钟期限。']);

const normalized = normalizeMemory({ enabled: true, markdown });
assert.match(normalized.markdown, /## 长期记忆/);
assert.match(normalized.markdown, /沈煜给出三分钟期限/);

const merged = mergeMemory(normalized, { shortTerm: ['沈煜给出三分钟期限。', '苏青翻开平板。'] });
assert.equal(merged.shortTerm.filter((x) => x === '沈煜给出三分钟期限。').length, 1);
assert.match(memoryToMarkdown(merged), /苏青翻开平板。/);

const reply = parseStructuredReply(`正文\n<Memory>${markdown}</Memory>`);
assert.deepEqual(reply.memory.shortTerm, parsed.shortTerm);
assert.deepEqual(reply.memory.longTerm, parsed.longTerm);
const unterminated = parseStructuredReply('正文\n<Memory>\n## 长期记忆\n- 未闭合事实');
assert.deepEqual(unterminated.memory.longTerm, ['未闭合事实']);
assert.match(serializeStructuredReply(reply).find((block) => block.startsWith('<Memory>')), /## 长期记忆/);

const prompt = assemble({
  userInput: '继续',
  responseFormat: { enabled: true },
  memory: normalized,
}).messages.find((message) => message.role === 'system').content;
assert.match(prompt, /剧情记忆（Markdown/);
assert.match(prompt, /苏青负责核心功能/);

console.log('PASS Markdown 记忆解析、合并、提示词注入与旧格式兼容');

