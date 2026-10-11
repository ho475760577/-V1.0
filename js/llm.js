/**
 * llama.cpp 通信层
 * 走 /v1/chat/completions（OpenAI 兼容端点）
 */

const DEFAULT_BASE = 'http://127.0.0.1:8080';

/* 本机 Melody1437 是 thinking 模型，默认关闭思维链，
   否则 token 全被烧进 reasoning_content，正文返回空串。
   采样参数针对「长篇角色扮演」调过一轮：
   - max_tokens 默认 3000，作品可按篇幅档位覆盖；不保证固定字数
   - repeat_penalty 压到 1.05、frequency_penalty 设 0.2，
     默认 1.1 的重复惩罚会让模型为了避重复而提前收尾
   - presence_penalty 0.15 给一点话题延展动力
   - min_p 比 top_p 更稳，能保住低概率但合理的用词 */
function baseBody(opts = {}) {
  return {
    temperature: 0.9,
    top_p: 0.95,
    min_p: 0.05,
    typical_p: 1.0,
    repeat_penalty: 1.05,
    frequency_penalty: 0.2,
    presence_penalty: 0.15,
    max_tokens: 3000,
    stream: false,
    ...opts,
    chat_template_kwargs: { enable_thinking: false },
  };
}

export class LLM {
  constructor(base = DEFAULT_BASE) {
    this.base = base;
    this.model = 'local';
  }

  async health() {
    try {
      const r = await fetch(`${this.base}/health`);
      if (!r.ok) throw new Error('loading');
      return true;
    } catch {
      return false;
    }
  }

  async models() {
    const r = await fetch(`${this.base}/v1/models`);
    return r.json();
  }

  /** 非流式生成 */
  async chat(messages, opts = {}) {
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody(opts), model: this.model, messages }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`模型返回 ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return {
      content: msg.content || '',
      reasoning: msg.reasoning_content || '',
      timings: data.timings || {},
      usage: data.usage || {},
    };
  }

  /**
   * 流式生成，逐字回调
   * @param {Array} messages
   * @param {(delta:string, full:string)=>void} onToken
   */
  async stream(messages, onToken, opts = {}) {
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody(opts), stream: true, model: this.model, messages }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`模型返回 ${res.status}: ${t.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            onToken(delta, full);
          }
        } catch { /* 跳过不完整行 */ }
      }
    }
    return full;
  }

  /** 估算 token 数（中文按 1.5 字/token 粗算，仅用于预算提示） */
  static estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) chars += (m.content || '').length;
    return Math.ceil(chars / 1.5);
  }
}

export const llm = new LLM();
