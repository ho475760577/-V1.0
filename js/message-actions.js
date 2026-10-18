/** 消息级操作：编辑、重新生成与多版本切换。保持纯函数，便于回归测试。 */

/** 消息的完整版本列表；旧消息只有 content，视为单版本。 */
export function variantsOf(message) {
  if (!message) return [];
  const list = Array.isArray(message.variants) ? message.variants.filter((item) => typeof item === 'string') : [];
  if (list.length) return list;
  return typeof message.content === 'string' ? [message.content] : [];
}

export function variantIndex(message) {
  const list = variantsOf(message);
  if (!list.length) return 0;
  const index = Number(message?.variantIndex);
  return Number.isInteger(index) ? Math.max(0, Math.min(list.length - 1, index)) : list.length - 1;
}

/** 切换版本，返回新的消息对象；越界时循环。 */
export function cycleVariant(message, step = 1) {
  const list = variantsOf(message);
  if (list.length < 2) return message;
  const next = (variantIndex(message) + step + list.length) % list.length;
  return { ...message, content: list[next], variantIndex: next, variants: list };
}

/** 把当前内容并入版本列表并选中它。用于重新生成完成后保留旧版本。 */
export function withVariant(message, content) {
  const list = variantsOf(message);
  const value = String(content ?? '');
  const variants = list.includes(value) ? list : [...list, value];
  return {
    ...message,
    content: value,
    variants,
    variantIndex: variants.indexOf(value),
  };
}

/** 编辑消息正文：编辑后旧版本失效，避免版本与正文不一致。 */
export function editMessage(message, content) {
  const value = String(content ?? '').trim();
  const next = { ...message, content: value };
  delete next.variants;
  delete next.variantIndex;
  delete next.rawContent;
  return next;
}

/** 找到某条 assistant 消息重新生成所需的前置历史与用户输入。 */
export function regenerationPlan(messages, index) {
  const list = Array.isArray(messages) ? messages : [];
  const target = list[index];
  if (!target || target.role !== 'assistant') return null;

  // 保留目标之前的历史（含紧邻的 user 消息），之后的内容全部丢弃。
  const baseMessages = list.slice(0, index);
  let userIndex = -1;
  for (let cursor = baseMessages.length - 1; cursor >= 0; cursor -= 1) {
    if (baseMessages[cursor].role === 'user') { userIndex = cursor; break; }
  }
  if (userIndex < 0) return null;

  return {
    baseMessages,
    promptHistory: baseMessages.slice(0, userIndex),
    userText: String(baseMessages[userIndex].content || ''),
    replaced: target,
  };
}

/** 重新生成完成后，用新回复替换目标位置，并保留旧版本。 */
export function applyRegeneration(messages, index, assistantMessage) {
  const list = Array.isArray(messages) ? messages : [];
  const target = list[index];
  if (!target) return list;
  const merged = withVariant(target, assistantMessage.content);
  merged.role = 'assistant';
  merged.stats = assistantMessage.stats;
  if (assistantMessage.rawContent) merged.rawContent = assistantMessage.rawContent;
  else delete merged.rawContent;
  const next = list.slice();
  next[index] = merged;
  return next;
}
