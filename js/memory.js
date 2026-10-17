/**
 * 剧情记忆的数据层。
 *
 * Markdown 是给人和模型阅读、编辑的正文；shortTerm/longTerm/summary
 * 是兼容旧作品和程序去重、限量、检索所需的索引。两者始终由这里互相转换。
 */

export const MEMORY_LIMITS = Object.freeze({ shortTerm: 20, longTerm: 50 });

function cleanText(value) {
  return String(value ?? '').replace(/\r/g, '').trim();
}

function cleanList(value, limit) {
  const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return [...new Set(source
    .filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .map(cleanText).filter(Boolean))].slice(-limit);
}

function sectionKind(title) {
  const value = cleanText(title).toLowerCase();
  if (/长期|long\s*term|permanent|永久/.test(value)) return 'longTerm';
  if (/短期|short\s*term|recent|当前|近期/.test(value)) return 'shortTerm';
  if (/摘要|summary|概况|回顾/.test(value)) return 'summary';
  return null;
}

/** Parse the supported memory Markdown into the internal indexes. */
export function parseMemoryMarkdown(source) {
  const markdown = cleanText(source);
  const result = { markdown, summary: '', shortTerm: [], longTerm: [] };
  if (!markdown) return result;

  let section = null;
  const summaryLines = [];
  const shortTerm = [];
  const longTerm = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      section = sectionKind(heading[1]);
      continue;
    }
    const item = line.match(/^[-*+]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (section === 'shortTerm') {
      shortTerm.push(item ? item[1] : line);
    } else if (section === 'longTerm') {
      longTerm.push(item ? item[1] : line);
    } else if (section === 'summary') {
      summaryLines.push(item ? item[1] : line);
    }
  }
  result.summary = summaryLines.join('\n').trim();
  result.shortTerm = cleanList(shortTerm, MEMORY_LIMITS.shortTerm);
  result.longTerm = cleanList(longTerm, MEMORY_LIMITS.longTerm);

  // A Markdown document without recognized sections is still useful as a summary.
  if (!result.summary && !result.shortTerm.length && !result.longTerm.length) {
    result.summary = markdown;
  }
  return result;
}

/** Generate the canonical Markdown document used in prompts and the editor. */
export function memoryToMarkdown(memory = {}) {
  const summary = cleanText(memory.summary);
  const shortTerm = cleanList(memory.shortTerm, MEMORY_LIMITS.shortTerm);
  const longTerm = cleanList(memory.longTerm, MEMORY_LIMITS.longTerm);
  const sections = ['# 剧情记忆'];
  if (summary) sections.push('## 对话摘要\n\n' + summary);
  if (longTerm.length) sections.push('## 长期记忆\n\n' + longTerm.map((item) => '- ' + item).join('\n'));
  if (shortTerm.length) sections.push('## 短期记忆\n\n' + shortTerm.map((item) => '- ' + item).join('\n'));
  return sections.length > 1 ? sections.join('\n\n') : '';
}

/** Normalize old JSON, new Markdown, or a mixture of both into one stable shape. */
export function normalizeMemory(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const parsedMarkdown = source.markdown ? parseMemoryMarkdown(source.markdown) : {};
  const summary = cleanText(source.summary || parsedMarkdown.summary);
  const shortTerm = cleanList([...(parsedMarkdown.shortTerm || []), ...(source.shortTerm || [])], MEMORY_LIMITS.shortTerm);
  const longTerm = cleanList([...(parsedMarkdown.longTerm || []), ...(source.longTerm || [])], MEMORY_LIMITS.longTerm);
  const normalized = {
    ...source,
    enabled: source.enabled === true,
    summary,
    shortTerm,
    longTerm,
  };
  normalized.markdown = memoryToMarkdown(normalized);
  return normalized;
}

/** Merge a parsed model update without allowing malformed values to erase memory. */
export function mergeMemory(previous = {}, incoming = {}) {
  const base = normalizeMemory(previous);
  const next = normalizeMemory(incoming);
  return normalizeMemory({
    ...base,
    ...next,
    enabled: base.enabled || next.enabled,
    summary: next.summary || base.summary,
    shortTerm: [...base.shortTerm, ...next.shortTerm],
    longTerm: [...base.longTerm, ...next.longTerm],
  });
}

/** Convert the legacy JSON Memory payload to the canonical Markdown form. */
export function memoryFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return normalizeMemory(payload);
}

