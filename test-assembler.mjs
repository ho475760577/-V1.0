/**
 * 组装器逻辑自测
 * 运行： node test-assembler.mjs
 */
import { assemble, makeBlock, makeEntry, isEntryActive, exportConfig, importConfig, SCAN, MATCH, SCOPE } from './js/assembler.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log('\n=== 1. 关键词匹配 ===');
check('中文命中', isEntryActive(makeEntry({ keys: ['林晚'] }), '你好林晚', ''));
check('英文大小写不敏感', isEntryActive(makeEntry({ keys: ['Alice'] }), 'alice 你好', ''));
check('未命中不触发', !isEntryActive(makeEntry({ keys: ['林晚'] }), '你好陌生人', ''));
check('任一命中即可', isEntryActive(makeEntry({ keys: ['A', 'B'], match: MATCH.ANY }), '只有B', ''));
check('全部命中才触发', !isEntryActive(makeEntry({ keys: ['A', 'B'], match: MATCH.ALL }), '只有B', ''));
check('全部命中成功', isEntryActive(makeEntry({ keys: ['A', 'B'], match: MATCH.ALL }), 'A和B', ''));
check('常驻条目免关键词', isEntryActive(makeEntry({ constant: true, keys: [] }), '任意内容', ''));
check('正则语法', isEntryActive(makeEntry({ keys: ['/小(明|红)/'] }), '小红说', ''));
check('仅扫用户', !isEntryActive(makeEntry({ keys: ['秘密'], scan: SCAN.USER }), '无关', '这是秘密'));
check('仅扫AI', isEntryActive(makeEntry({ keys: ['秘密'], scan: SCAN.AI }), '无关', '这是秘密'));
check('禁用条目不触发', !isEntryActive(makeEntry({ keys: ['A'], enabled: false }), 'A', ''));

console.log('\n=== 2. 插入顺序 ===');
{
  const blocks = [
    makeBlock({ name: 'C', content: '第三个', order: 2 }),
    makeBlock({ name: 'A', content: '第一个', order: 0 }),
    makeBlock({ name: 'B', content: '第二个', order: 1 }),
  ];
  const { messages } = assemble({ blocks, userInput: 'hi' });
  const sys = messages.find((m) => m.role === 'system').content;
  check('按 order 升序拼接', sys === '第一个\n\n第二个\n\n第三个', `实际: ${JSON.stringify(sys)}`);
}

console.log('\n=== 3. 禁用块不参与 ===');
{
  const blocks = [
    makeBlock({ name: 'A', content: '启用内容', order: 0 }),
    makeBlock({ name: 'B', content: '禁用内容', order: 1, enabled: false }),
  ];
  const { messages } = assemble({ blocks, userInput: 'hi' });
  const sys = messages.find((m) => m.role === 'system').content;
  check('禁用块被排除', sys === '启用内容', `实际: ${JSON.stringify(sys)}`);
}

console.log('\n=== 4. 空块不产生空行 ===');
{
  const blocks = [makeBlock({ name: 'A', content: '有内容', order: 0 }), makeBlock({ name: 'B', content: '   ', order: 1 })];
  const { messages } = assemble({ blocks, userInput: 'hi' });
  const sys = messages.find((m) => m.role === 'system').content;
  check('空白块被过滤', sys === '有内容', `实际: ${JSON.stringify(sys)}`);
}

console.log('\n=== 5. 影响范围与位置 ===');
{
  const blocks = [makeBlock({ name: '设定', content: 'SYS', order: 0 })];
  const entries = [
    makeEntry({ keys: ['触发词'], content: 'PROMPT内容', scope: SCOPE.PROMPT }),
    makeEntry({ keys: ['触发词'], content: 'PREPEND内容', scope: SCOPE.PREPEND }),
    makeEntry({ keys: ['触发词'], content: 'APPEND内容', scope: SCOPE.APPEND }),
  ];
  const history = [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复' }];
  const { messages } = assemble({ blocks, entries, messages: history, userInput: '触发词' });
  const roles = messages.map((m) => m.role);
  const idxSys = messages.findIndex((m) => m.content.includes('SYS'));
  const idxPre = messages.findIndex((m) => m.content.includes('PREPEND'));
  const idxOld = messages.findIndex((m) => m.content === '旧消息');
  const idxApp = messages.findIndex((m) => m.content.includes('APPEND'));
  const idxNew = messages.findIndex((m) => m.content === '触发词');

  check('系统块在前', idxSys === 0);
  check('前置词在历史之前', idxPre > idxSys && idxPre < idxOld, `pre=${idxPre} old=${idxOld}`);
  check('后置词在历史之后', idxApp > idxOld, `app=${idxApp} old=${idxOld}`);
  check('用户输入在最末', idxNew === messages.length - 1);
  check('消息总数为 6', messages.length === 6, `实际 ${messages.length}`);
}

console.log('\n=== 6. 递归触发 ===');
{
  const entries = [
    makeEntry({ keys: ['贝茜'], content: '贝茜是一头牛，和鲁弗斯是好朋友' }),
    makeEntry({ keys: ['鲁弗斯'], content: '鲁弗斯是一只狗' }),
    makeEntry({ keys: ['不相关'], content: '不该出现' }),
  ];
  const { messages, stats } = assemble({ entries, userInput: '看看贝茜' });
  const all = messages.map((m) => m.content).join('\n');
  check('直接命中', all.includes('贝茜是一头牛'));
  check('递归带出鲁弗斯', all.includes('鲁弗斯是一只狗'));
  check('无关条目不触发', !all.includes('不该出现'));
  check('统计命中数为 2', stats.entriesHit === 2, `实际 ${stats.entriesHit}`);
}

console.log('\n=== 7. 递归深度限制 ===');
{
  const entries = [
    makeEntry({ keys: ['L1'], content: '提到 L2' }),
    makeEntry({ keys: ['L2'], content: '提到 L3' }),
    makeEntry({ keys: ['L3'], content: '提到 L4' }),
    makeEntry({ keys: ['L4'], content: '深层内容' }),
  ];
  const { messages } = assemble({ entries, userInput: 'L1' });
  const all = messages.map((m) => m.content).join('\n');
  check('一层触发二层', all.includes('提到 L2'));
  check('二层触发三层', all.includes('提到 L3'));
  check('三层未继续（深度上限2）', !all.includes('深层内容'));
}

console.log('\n=== 8. 历史截断 ===');
{
  const blocks = [makeBlock({ name: 'S', content: 'SYS', order: 0 })];
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `消息${i}` });
  }
  const { messages } = assemble({ blocks, messages: history, userInput: '新', vars: { historyLimit: 4 } });
  check('历史被截断到 4 条 + system + 新输入', messages.length === 6, `实际 ${messages.length}`);
  check('保留的是最新的', messages.some((m) => m.content === '消息9'));
  check('丢弃了最旧的', !messages.some((m) => m.content === '消息0'));
}

console.log('\n=== 9. 截断后孤立 assistant 被清理 ===');
{
  const blocks = [makeBlock({ name: 'S', content: 'SYS', order: 0 })];
  // 构造一个截断后首条是 assistant 的场景
  const history = [{ role: 'assistant', content: '旧回复' }, { role: 'user', content: '新问题' }];
  const { messages } = assemble({ blocks, messages: history, userInput: '本次输入', vars: { historyLimit: 2 } });
  check('孤立 assistant 被剔除', !messages.some((m) => m.content === '旧回复'));
}

console.log('\n=== 10. 无任何配置时仍可用 ===');
{
  const { messages } = assemble({ blocks: [], entries: [], messages: [], userInput: '你好' });
  check('仅生成用户消息', messages.length === 1 && messages[0].role === 'user');
}

console.log('\n=== 11. 变量面板提示词注入 ===');
{
  const blocks = [makeBlock({ name: 'S', content: 'SYS', order: 0 })];
  const vars = { enabled: true, prompt: 'VARS规则' };
  const { messages } = assemble({ blocks, userInput: 'hi', vars });
  const sys = messages.find((m) => m.role === 'system').content;
  check('变量提示词并入 system', sys.includes('SYS') && sys.includes('VARS规则'));
}

console.log('\n=== 12. 未启用变量面板时不注入 ===');
{
  const blocks = [makeBlock({ name: 'S', content: 'SYS', order: 0 })];
  const vars = { enabled: false, prompt: 'VARS规则' };
  const { messages } = assemble({ blocks, userInput: 'hi', vars });
  const sys = messages.find((m) => m.role === 'system').content;
  check('未启用则不注入', !sys.includes('VARS规则'));
}

console.log('\n=== 12b. 当前状态注入 ===');
{
  const { messages } = assemble({
    blocks: [makeBlock({ name: 'S', content: 'SYS', order: 0 })],
    userInput: 'hi',
    vars: { enabled: true, prompt: '规则', values: { 好感度: 42 } },
  });
  const sys = messages.find((m) => m.role === 'system').content;
  check('当前状态并入 system', sys.includes('好感度') && sys.includes('42'));
}

console.log('\n=== 12c. 摘要与选项提示注入 ===');
{
  const { messages } = assemble({
    blocks: [makeBlock({ name: 'S', content: 'SYS', order: 0 })],
    userInput: 'hi',
    memory: { enabled: true, summary: '林晚答应在雨停前回来。' },
    choices: { enabled: true },
  });
  const sys = messages.find((m) => m.role === 'system').content;
  check('摘要并入 system', sys.includes('林晚答应在雨停前回来'));
  check('选项规则并入 system', sys.includes('<Choices>') && sys.includes('4 个'));
}

console.log('\n=== 12d. 摘要与选项配置导入导出 ===');
{
  const cfg = { name: '记忆测试', blocks: [], entries: [], vars: null, greeting: '',
    memory: { enabled: true, summary: '旧事', threshold: 20, keepRecent: 8 }, choices: { enabled: true } };
  const back = importConfig(exportConfig(cfg));
  check('摘要配置保留', back.memory?.summary === '旧事' && back.memory.enabled);
  check('选项配置保留', back.choices?.enabled === true);
}

console.log('\n=== 12e. 结构化格式与场景配置 ===');
{
  const { messages } = assemble({
    blocks: [], userInput: '继续',
    responseFormat: { enabled: true, showReview: true },
    scene: { time: '第1天 14:30', world: '现代都市', location: '高速公路' },
  });
  const sys = messages.find((m) => m.role === 'system').content;
  check('结构化回复规范注入', sys.includes('<Scene>') && sys.includes('<Review>'));
  check('当前场景注入 system', sys.includes('高速公路') && sys.includes('第1天 14:30'));
  const cfg = importConfig(exportConfig({
    name: '场景测试', blocks: [], entries: [],
    scene: { time: '晚上', world: '架空世界', location: '旅馆' },
    responseFormat: { enabled: true, showReview: false },
  }));
  check('结构化配置导入导出', cfg.scene.location === '旅馆' && cfg.responseFormat.enabled === true);
}

console.log('\n=== 13. 空输入不产生空消息 ===');
{
  const { messages } = assemble({ blocks: [], entries: [], messages: [], userInput: '' });
  check('无消息产生', messages.length === 0, `实际 ${messages.length}`);
}

console.log('\n=== 14. 同 scope 内 order 排序 ===');
{
  const entries = [
    makeEntry({ keys: ['K'], content: 'SECOND', scope: SCOPE.PROMPT, order: 200 }),
    makeEntry({ keys: ['K'], content: 'FIRST', scope: SCOPE.PROMPT, order: 10 }),
  ];
  const { messages } = assemble({ entries, userInput: 'K' });
  const sys = messages.find((m) => m.role === 'system').content;
  check('order 小的靠前', sys.indexOf('FIRST') < sys.indexOf('SECOND'), `实际: ${sys}`);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`结果：${pass} 通过, ${fail} 失败`);
console.log('='.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
