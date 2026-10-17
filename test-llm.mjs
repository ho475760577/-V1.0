/** llama.cpp 流式通信回归：思考内容不能进入可见回复或历史。 */
import assert from 'node:assert/strict';
import { LLM, stripThinking } from './js/llm.js';

assert.equal(stripThinking('<think>内部推理</think>正文'), '正文');
assert.equal(stripThinking('<think>未闭合的内部推理'), '');
assert.equal(stripThinking('正文</think>'), '正文');
assert.equal(stripThinking('<|channel>thought\n保密推理\n<channel|>Scene\n{"location":"会议室"}'), '<Scene>\n{"location":"会议室"}');

const calls = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  calls.push(body);
  const deltas = body.messages.at(-1)?.content === '第二轮'
    ? ['<think>第二轮推理</think>', '第二轮正文']
    : ['<thi', 'nk>内部推理', '</think>', '正文第一句', '正文第二句'];
  const stream = deltas.map((content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('')
    + 'data: [DONE]\n\n';
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
};

try {
  const llm = new LLM('http://test.local');
  const chunks = [];
  const full = await llm.stream([
    { role: 'system', content: '系统设定' },
    { role: 'user', content: '继续' },
  ], (delta) => chunks.push(delta), { max_tokens: 900 });
  assert.equal(full, '正文第一句正文第二句');
  assert.equal(chunks.join(''), full);
  assert.ok(!full.includes('<think>'));
  assert.deepEqual(calls[0].messages.at(-1), { role: 'user', content: '继续' });
  assert.equal(calls[0].reasoning, 'off');
  assert.equal(calls[0].reasoning_budget, 0);
  assert.equal(calls[0].reasoning_format, 'none');
  assert.equal(calls[0].max_tokens, 900);

  const second = await llm.stream([
    { role: 'system', content: '系统设定' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: full },
    { role: 'user', content: '第二轮' },
  ], () => {}, { max_tokens: 900 });
  assert.equal(second, '第二轮正文');
  assert.deepEqual(calls[1].messages.at(-1), { role: 'user', content: '第二轮' });
  assert.ok(!calls[1].messages.some((message) => message.role === 'assistant' && message.content === ''), '二轮请求不应追加空 assistant 前缀');

  let retries = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    retries++;
    if (retries === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_format'" } }), { status: 400 });
    assert.ok(!('reasoning_format' in request));
    assert.ok(!('chat_template_kwargs' in request));
    const stream = ['<|chan', 'nel>thought', '不可见推理', '<channel|>Scene', '{"location":"会议室"}', '</Scene>']
      .map((content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('')
      + 'data: [DONE]\n\n';
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const streamed = [];
  const compatible = await llm.stream([{ role: 'user', content: '检查兼容' }], (delta) => streamed.push(delta), { max_tokens: 800 });
  assert.equal(compatible, '<Scene>{"location":"会议室"}</Scene>');
  assert.ok(!streamed.join('').includes('不可见推理'));
  assert.equal(retries, 2);
  console.log('PASS 流式思考过滤、二轮历史和篇幅参数');
} finally {
  globalThis.fetch = oldFetch;
}
