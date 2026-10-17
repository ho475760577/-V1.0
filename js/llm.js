/**
 * llama.cpp 通信层
 * 走 /v1/chat/completions（OpenAI 兼容端点）
 */

const DEFAULT_BASE = 'http://127.0.0.1:8080';

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** 兼容会把思考直接放进 message.content 的模型；思考不进入历史和界面。 */
export function stripThinking(text) {
  let source = String(text || '');
  source = source.replace(/<think>[\s\S]*?<\/think>/gi, '');
  source = source.replace(/<think>[\s\S]*$/i, '');
  source = source.replace(/<\/think>/gi, '');
  source = source.replace(/<(?:\|channel\|?|channel\|)>\s*(?:thought|analysis|reasoning)\b[\s\S]*?(?=<(?:\|channel\|?|channel\|)>\s*(?:final|commentary|Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)\b)/gi, '');
  source = source.replace(/<(?:\|channel\|?|channel\|)>\s*(?:thought|analysis|reasoning)\b[\s\S]*$/gi, '');
  source = source.replace(/<(?:\|channel\|?|channel\|)>\s*(Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)\b/gi, '<$1>');
  source = source.replace(/<(?:\|channel\|?|channel\|)>\s*(?:final|commentary)\b/gi, '');
  return source.trim();
}

function reasoningFilter() {
  let pending = '';
  let inThink = false;
  let inChannelThought = false;
  const channelPrefixCandidates = ['<|channel|>', '<|channel>', '<channel|>'];

  const suffixPrefixLength = (value, token) => {
    const lower = value.toLowerCase();
    const target = token.toLowerCase();
    for (let n = Math.min(value.length, token.length - 1); n > 0; n--) {
      if (lower.endsWith(target.slice(0, n))) return n;
    }
    return 0;
  };

  const channelHeader = (value) => /<(?:\|channel\|?|channel\|)>\s*(thought|analysis|reasoning|final|commentary|Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)\b/i.exec(value);
  const partialChannelPrefix = (value) => Math.max(0, ...channelPrefixCandidates.map((token) => suffixPrefixLength(value, token)));
  const partialChannelHeaderIndex = (value) => {
    const marker = /<(?:\|channel\|?|channel\|)>\s*/ig;
    let match;
    while ((match = marker.exec(value)) !== null) {
      const rest = value.slice(marker.lastIndex).toLowerCase();
      if (['thought', 'analysis', 'reasoning', 'final', 'commentary', 'scene', 'player', 'characters', 'situation', 'state', 'changes', 'memory', 'choices', 'review']
        .some((label) => label.startsWith(rest) && rest.length < label.length)) return match.index;
    }
    return -1;
  };

  return {
    push(chunk, final = false) {
      pending += String(chunk || '');
      let visible = '';
      while (pending) {
        if (inChannelThought) {
          const header = channelHeader(pending);
          if (header) {
            pending = pending.slice(header.index);
            inChannelThought = false;
            continue;
          }
          if (final) { pending = ''; break; }
          const partialHeader = partialChannelHeaderIndex(pending);
          const hold = partialChannelPrefix(pending);
          if (partialHeader >= 0) pending = pending.slice(partialHeader);
          else if (hold) pending = pending.slice(-hold);
          else pending = '';
          break;
        }
        if (inThink) {
          const close = pending.toLowerCase().indexOf(THINK_CLOSE);
          if (close < 0) {
            if (final) pending = '';
            break;
          }
          pending = pending.slice(close + THINK_CLOSE.length);
          inThink = false;
          continue;
        }

        const open = pending.toLowerCase().indexOf(THINK_OPEN);
        const channel = channelHeader(pending);
        if (open >= 0 && (!channel || open < channel.index)) {
          visible += pending.slice(0, open);
          pending = pending.slice(open + THINK_OPEN.length);
          inThink = true;
          continue;
        }
        if (channel) {
          visible += pending.slice(0, channel.index);
          const label = channel[1];
          pending = pending.slice(channel.index + channel[0].length);
          if (/^(thought|analysis|reasoning)$/i.test(label)) inChannelThought = true;
          else if (/^(Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)$/i.test(label)) visible += `<${label}>`;
          continue;
        }
        const partialHeader = partialChannelHeaderIndex(pending);
        if (partialHeader >= 0) {
          visible += pending.slice(0, partialHeader);
          pending = pending.slice(partialHeader);
          break;
        }

        if (final) {
          visible += pending;
          pending = '';
        } else {
          const hold = Math.max(suffixPrefixLength(pending, THINK_OPEN), partialChannelPrefix(pending));
          if (hold) {
            visible += pending.slice(0, -hold);
            pending = pending.slice(-hold);
            break;
          }
          visible += pending;
          pending = '';
        }
      }
      return visible;
    },
  };
}

/* 本地模型可能默认开启思考，默认关闭思维链，
   否则 token 会被烧进 reasoning_content 或混入正文，影响篇幅。
   采样参数针对「长篇角色扮演」调过一轮：
   - max_tokens 默认 3000，StoryRealm 固定回复预算会覆盖；实际字数仍受模型和上下文影响
   - repeat_penalty 设为 1.08、frequency_penalty 设 0.3，
     在长篇输出中压住段落循环，同时保留一定的细节展开空间
   - presence_penalty 0.15 给一点话题延展动力
   - min_p 比 top_p 更稳，能保住低概率但合理的用词 */
function baseBody(opts = {}) {
  return {
    temperature: 0.9,
    top_p: 0.95,
    min_p: 0.05,
    typical_p: 1.0,
    repeat_penalty: 1.08,
    frequency_penalty: 0.3,
    presence_penalty: 0.15,
    max_tokens: 3000,
    stream: false,
    reasoning: 'off',
    reasoning_budget: 0,
    reasoning_format: 'none',
    ...opts,
    chat_template_kwargs: { enable_thinking: false, ...(opts.chat_template_kwargs || {}) },
  };
}

function compatibilityVariants(options) {
  const base = { ...options };
  const withoutReasoning = { ...base };
  delete withoutReasoning.reasoning;
  delete withoutReasoning.reasoning_budget;
  delete withoutReasoning.reasoning_format;
  delete withoutReasoning.chat_template_kwargs;
  const variants = [base];
  if (Object.keys(withoutReasoning).length !== Object.keys(base).length) variants.push(withoutReasoning);
  const withoutFormat = { ...withoutReasoning };
  delete withoutFormat.response_format;
  if (Object.keys(withoutFormat).length !== Object.keys(withoutReasoning).length) variants.push(withoutFormat);
  const maxCompletion = { ...withoutFormat };
  if (maxCompletion.max_tokens != null) {
    maxCompletion.max_completion_tokens = maxCompletion.max_tokens;
    delete maxCompletion.max_tokens;
    variants.push(maxCompletion);
  }
  return variants;
}

function mentionsUnsupportedOption(message) {
  return /unknown|unsupported|unrecognized|not supported|invalid|extra fields?|additional properties/i.test(message);
}

async function completionRequest(base, messages, options, stream, signal) {
  const variants = compatibilityVariants(baseBody(options));
  let lastError;
  for (let index = 0; index < variants.length; index += 1) {
    const body = { ...variants[index], stream, model: base.model, messages };
    const response = await fetch(`${base.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body),
    });
    if (response.ok) return { response, body };
    const detail = await response.text();
    lastError = new Error(`模型返回 ${response.status}: ${detail.slice(0, 200)}`);
    const optionCanBeRemoved = index < variants.length - 1 && mentionsUnsupportedOption(detail);
    if (!optionCanBeRemoved) throw lastError;
    const current = variants[index];
    const unsupportedField = ['reasoning', 'reasoning_budget', 'reasoning_format', 'chat_template_kwargs', 'response_format']
      .find((key) => Object.hasOwn(current, key) && detail.toLowerCase().includes(key));
    const maxTokenAlias = /max_tokens/.test(detail) && /max_completion_tokens/.test(detail);
    const nextIndex = variants.findIndex((variant, candidate) => candidate > index && (
      unsupportedField && Object.hasOwn(current, unsupportedField) && !Object.hasOwn(variant, unsupportedField)
      || maxTokenAlias && Object.hasOwn(variant, 'max_completion_tokens')
    ));
    if (nextIndex < 0) throw lastError;
    index = nextIndex - 1;
  }
  throw lastError || new Error('模型请求失败');
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
    const { signal, ...bodyOpts } = opts;
    const { response: res } = await completionRequest(this, messages, bodyOpts, false, signal);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return {
      content: stripThinking(msg.content || ''),
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
    const { signal, ...bodyOpts } = opts;
    const { response: res } = await completionRequest(this, messages, bodyOpts, true, signal);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const filter = reasoningFilter();

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
            const visible = filter.push(delta);
            if (visible) {
              full += visible;
              onToken(visible, full);
            }
          }
        } catch { /* 跳过不完整行 */ }
      }
    }
    const tail = filter.push('', true);
    if (tail) {
      full += tail;
      onToken(tail, full);
    }
    return stripThinking(full);
  }

  /** 估算 token 数（中文按 1.5 字/token 粗算，仅用于预算提示） */
  static estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) chars += (m.content || '').length;
    return Math.ceil(chars / 1.5);
  }
}

export const llm = new LLM();
