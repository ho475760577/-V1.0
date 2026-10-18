/** v3.1.0 回归：token 估算、上下文预算、消息编辑与多版本。 */
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessages, formatTokenCount } from './js/tokens.js';
import { assemble, makeBlock, makeEntry, SCOPE } from './js/assembler.js';
import {
  variantsOf, variantIndex, cycleVariant, withVariant, editMessage, regenerationPlan, applyRegeneration,
} from './js/message-actions.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

test('token 估算对空文本、中文、ASCII 保持稳定且单调', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  const cjk = estimateTokens('你好世界');
  const ascii = estimateTokens('hello world');
  assert.ok(cjk > 0 && ascii > 0);
  assert.ok(estimateTokens('你好世界，今天下雨了') > cjk);
  assert.equal(estimateMessages([{ content: '你好' }, { content: 'hello' }]),
    estimateTokens('你好') + estimateTokens('hello') + 8);
});

test('token 数量显示为易读格式', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1234), '1.2k');
  assert.equal(formatTokenCount(12000), '12k');
});

test('超预算时优先裁剪最旧历史，保留系统与最新输入', () => {
  const history = [];
  for (let index = 0; index < 40; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '旧消息'.repeat(80) });
  }
  const { messages, stats } = assemble({
    blocks: [makeBlock({ name: '主提示词', content: '系统设定' })],
    messages: history,
    userInput: '本轮输入',
    vars: { historyLimit: 40 },
    tokenBudget: 600,
  });
  assert.ok(stats.tokens <= 600, `实际 ${stats.tokens}`);
  assert.ok(stats.trimmed.historyMessages > 0);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('系统设定'));
  assert.equal(messages.at(-1).role, 'user');
  assert.equal(messages.at(-1).content, '本轮输入');
});

test('历史裁到底仍超预算时，按 order 从低优先级丢弃世界书条目', () => {
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    entries.push(makeEntry({ constant: true, scope: SCOPE.PROMPT, order: index, content: '设定'.repeat(300) }));
  }
  const { messages, stats } = assemble({ entries, userInput: '继续', tokenBudget: 1200 });
  assert.ok(stats.trimmed.worldbookEntries > 0, '应丢弃部分世界书');
  assert.ok(stats.entriesUsed < 10);
  assert.ok(stats.tokens <= 1200);
  assert.ok(messages[0].content.includes('设定'));
});

test('不传预算时保持旧输出长度', () => {
  const history = [];
  for (let index = 0; index < 10; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '消息' + index });
  }
  const result = assemble({
    blocks: [makeBlock({ name: '主提示词', content: '系统' })],
    messages: history,
    userInput: '新',
    vars: { historyLimit: 4 },
  });
  assert.equal(result.messages.length, 6);
  assert.equal(result.stats.trimmed, undefined);
  assert.ok(result.stats.tokens > 0);
});

test('记忆、场景与协议在裁剪后仍然保留', () => {
  const { messages, stats } = assemble({
    memory: { enabled: true, markdown: '# 剧情记忆\n\n## 长期记忆\n\n- 重要事实' },
    scene: { location: '旧书店' },
    responseFormat: { enabled: true },
    userInput: '继续',
    tokenBudget: 400,
  });
  const system = messages[0].content;
  assert.ok(system.includes('重要事实'));
  assert.ok(system.includes('旧书店'));
  assert.ok(system.includes('<Scene>'));
  assert.equal(stats.overBudget, true);
});

test('消息版本：追加、切换与编辑', () => {
  const first = { role: 'assistant', content: '第一版' };
  assert.deepEqual(variantsOf(first), ['第一版']);
  assert.equal(variantIndex(first), 0);

  const second = withVariant(first, '第二版');
  assert.deepEqual(variantsOf(second), ['第一版', '第二版']);
  assert.equal(second.content, '第二版');
  assert.equal(variantIndex(second), 1);

  const back = cycleVariant(second, 1);
  assert.equal(back.content, '第一版');
  assert.equal(variantIndex(back), 0);

  const edited = editMessage(second, '手动修改');
  assert.equal(edited.content, '手动修改');
  assert.equal(edited.variants, undefined);
  assert.equal(edited.rawContent, undefined);
});

test('重新生成只保留目标之前的历史与对应玩家输入', () => {
  const messages = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' },
  ];
  const plan = regenerationPlan(messages, 3);
  assert.equal(plan.baseMessages.length, 3);
  assert.equal(plan.userText, '第二问');
  assert.deepEqual(plan.promptHistory, messages.slice(0, 2));
  assert.equal(plan.replaced.content, '第二答');
  assert.equal(regenerationPlan(messages, 2), null);
});

test('重新生成结果并入版本列表并替换目标位置', () => {
  const messages = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '旧回答' },
  ];
  const next = applyRegeneration(messages, 1, { role: 'assistant', content: '新回答', stats: { tps: 1 } });
  assert.equal(next.length, 2);
  assert.equal(next[1].content, '新回答');
  assert.deepEqual(next[1].variants, ['旧回答', '新回答']);
  assert.equal(next[1].variantIndex, 1);
});

console.log(`\nv3.1.0 优化回归：${passed} 项通过。`);
