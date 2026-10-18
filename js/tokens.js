/**
 * token 估算与上下文预算辅助。
 *
 * 这里不追求与某个 tokenizer 完全一致，而是给出稳定、偏保守的估算，
 * 用于界面仪表和「超预算先裁历史」的保护。真正精确的计数可由
 * llama.cpp 的 /tokenize 提供，不依赖它也能安全工作。
 */

const CJK_MIN = 0x2e80;
const CJK_MAX = 0x9fff;
const CJK_EXT_MIN = 0xf900;
const CJK_EXT_MAX = 0xfaff;
const FULLWIDTH_MIN = 0xff00;
const FULLWIDTH_MAX = 0xffef;

/** 单个字符的粗略 token 权重：中日韩 0.75，ASCII 约 0.29，其他 0.6。 */
function weightOf(code) {
  if ((code >= CJK_MIN && code <= CJK_MAX) || (code >= CJK_EXT_MIN && code <= CJK_EXT_MAX)) return 0.75;
  if (code >= FULLWIDTH_MIN && code <= FULLWIDTH_MAX) return 0.6;
  if (code < 128) return code === 32 ? 0.25 : 0.3;
  return 0.6;
}

export function estimateTokens(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  let total = 0;
  for (const char of text) total += weightOf(char.codePointAt(0));
  return Math.max(1, Math.ceil(total));
}

/** 每条消息有少量模板开销，按 4 token 计。 */
export function estimateMessageTokens(message) {
  return estimateTokens(message?.content) + 4;
}

export function estimateMessages(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** 简洁显示：1234 -> 1.2k。 */
export function formatTokenCount(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 10000) return Math.round(number / 1000) + 'k';
  if (number >= 1000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(number));
}
