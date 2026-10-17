/**
 * 回复渲染：把 AI 的输出转成 HTML
 *
 * 核心是 <Reply Example> 标签 —— AI风月 让模型在里面输出 HTML 代码，
 * 前端渲染成状态栏 / UI。ST 做不到这点是其最大短板。
 *
 * 安全策略：走 iframe sandbox + srcdoc，模型产的 HTML 无法触碰主页面
 */

import { mergeMemory, normalizeMemory, parseMemoryMarkdown } from './memory.js';

const REPLY_RE = /<Reply Example>([\s\S]*?)<\/Reply Example>/gi;
const STATE_RE = /<State>([\s\S]*?)<\/State>/gi;
const CHOICES_RE = /<Choices>([\s\S]*?)<\/Choices>/gi;
const SCENE_RE = /<Scene>([\s\S]*?)<\/Scene>/gi;
const CHANGES_RE = /<Changes>([\s\S]*?)<\/Changes>/gi;
const MEMORY_RE = /<Memory>([\s\S]*?)<\/Memory>/gi;
const REVIEW_RE = /<Review>([\s\S]*?)<\/Review>/gi;
const PLAYER_RE = /<Player>([\s\S]*?)<\/Player>/gi;
const CHARACTERS_RE = /<Characters>([\s\S]*?)<\/Characters>/gi;
const SITUATION_RE = /<Situation>([\s\S]*?)<\/Situation>/gi;

function removeThinkingTags(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<\/think>/gi, '')
    .replace(/<(?:\|channel\|?|channel\|)>\s*(?:thought|analysis|reasoning)\b[\s\S]*?(?=<(?:\|channel\|?|channel\|)>\s*(?:final|commentary|Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)\b)/gi, '')
    .replace(/<(?:\|channel\|?|channel\|)>\s*(?:thought|analysis|reasoning)\b[\s\S]*$/gi, '')
    .trim();
}

const SCENE_TEXT_FIELDS = ['time', 'world', 'location', 'plot', 'weather', 'atmosphere', 'lighting', 'goal', 'conflict'];
const SCENE_LIST_FIELDS = ['sounds', 'scents'];
const STRUCTURED_TAG_NAMES = 'Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review';

/** 模型有时会把结构化标签输出成 HTML 实体，或漏掉开头的尖括号。 */
function normalizeStructuredTags(raw) {
  let source = String(raw || '');
  const names = STRUCTURED_TAG_NAMES;
  source = source
    .replace(new RegExp(`&lt;\\s*(/\\s*(?:${names})|(?:${names}))\\s*&gt;`, 'gi'), '<$1>')
    .replace(new RegExp(`<channel\\|>\\s*(${names})\\b`, 'gi'), '<$1>')
    .replace(new RegExp(`<\\|channel\\|?>\\s*(${names})\\b`, 'gi'), '<$1>')
    .replace(new RegExp(`(^|[\\r\\n])\\s*((?:${names}))\\s*(?:&gt;|&#62;|&#x3e;)`, 'gi'), '$1<$2>');
  source = closeUnterminatedStructuredTags(source);
  return source;
}

function closeUnterminatedStructuredTags(source) {
  const tagRe = new RegExp(`<(${STRUCTURED_TAG_NAMES})>(?=\\s*[{[])`, 'gi');
  const matches = [...source.matchAll(tagRe)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const closing = new RegExp(`</${match[1]}>`, 'i');
    const tail = source.slice(match.index + match[0].length);
    const jsonEnd = findJsonEnd(tail);
    if (jsonEnd < 0) continue;
    const existingClose = closing.exec(tail);
    if (existingClose && existingClose.index >= jsonEnd) continue;
    const nextTag = tail.search(/<(?:Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)>/i);
    if (nextTag >= 0 && nextTag < jsonEnd) continue;
    const afterJson = tail.slice(jsonEnd).match(/^\s*/)?.[0].length || 0;
    const insertAt = match.index + match[0].length + jsonEnd + afterJson;
    source = source.slice(0, insertAt) + `</${match[1]}>` + source.slice(insertAt);
  }
  // Markdown Memory has no JSON brackets for locating its end.
  const markdownMemoryRe = /<Memory>(?=\s*(?:#{1,6}\s|[-*+]\s))/gi;
  const markdownMatches = [...source.matchAll(markdownMemoryRe)];
  for (let index = markdownMatches.length - 1; index >= 0; index -= 1) {
    const match = markdownMatches[index];
    const tail = source.slice(match.index + match[0].length);
    if (/<\/Memory>/i.test(tail)) continue;
    const nextTag = tail.search(/<(?:Scene|Player|Characters|Situation|State|Changes|Memory|Choices|Review)>/i);
    const end = nextTag >= 0 ? match.index + match[0].length + nextTag : source.length;
    source = source.slice(0, end) + '</Memory>' + source.slice(end);
  }
  return source;
}

function findJsonEnd(source) {
  const start = source.search(/[\\[{]/);
  if (start < 0) return -1;
  const stack = [];
  let quoted = false, escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if (!open || (open === '{' && char !== '}') || (open === '[' && char !== ']')) return -1;
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}

/** 从模型回复中提取变量状态，支持 State 标签和 JSON 代码块。 */
export function parseState(raw) {
  const source = String(raw || '');
  let state = null;
  let text = source;

  STATE_RE.lastIndex = 0;
  const taggedValues = [];
  let tagged;
  while ((tagged = STATE_RE.exec(source)) !== null) {
    const parsed = parseStateJson(tagged[1]);
    if (parsed) taggedValues.push({ parsed, start: tagged.index, end: tagged.index + tagged[0].length });
  }
  if (taggedValues.length) {
    state = Object.assign({}, ...taggedValues.map((x) => x.parsed));
    text = source;
    for (let i = taggedValues.length - 1; i >= 0; i--) {
      const item = taggedValues[i];
      text = text.slice(0, item.start) + text.slice(item.end);
    }
  }

  if (!state) {
    const fenced = source.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      state = parseStateJson(fenced[1]);
      if (state) text = source.replace(fenced[0], '');
    }
  }

  return { text: text.trim(), state };
}

function parseStateJson(value) {
  const parsed = parseJsonLike(value);
  return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : null;
}

function parseJsonLike(value) {
  const source = String(value || '').trim();
  const candidates = [source,
    source.replace(/\\(["'])/g, '$1'),
    source.replace(/"(shortTerm|longTerm)_\[\]"?/g, '"$1":[]'),
  ];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Try the next narrowly scoped repair. */ }
  }
  return null;
}

function parseTaggedJson(raw, regex, fallback = null) {
  const source = String(raw || '');
  regex.lastIndex = 0;
  let text = source;
  let value = fallback;
  const tags = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    const parsed = parseStateJson(match[1]);
    // 解析失败时保留原标签，避免模型偶尔输出坏 JSON 就让正文消失。
    if (!parsed) continue;
    value = value && typeof value === 'object' ? { ...value, ...parsed } : parsed;
    tags.push({ start: match.index, end: match.index + match[0].length });
  }
  for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  return { text: text.trim(), value };
}

/** 解析时间、世界和地点，并从正文移除 Scene 标签。 */
export function parseScene(raw) {
  const parsed = parseTaggedJson(raw, SCENE_RE);
  return { ...parsed, value: normalizeScene(parsed.value) };
}

function normalizeScene(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of SCENE_TEXT_FIELDS) {
    if (value[key] == null) continue;
    const text = String(value[key]).trim();
    out[key] = text;
  }
  for (const key of SCENE_LIST_FIELDS) {
    if (Array.isArray(value[key])) {
      const list = value[key].map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
      out[key] = list;
    } else if (value[key] != null && String(value[key]).trim()) {
      out[key] = String(value[key]).trim();
    }
  }
  if (Array.isArray(value.participants)) {
    out.participants = value.participants.map(normalizeParticipant).filter((item) => item.name).slice(0, 12);
  }
  if (Array.isArray(value.objects)) {
    out.objects = value.objects.map(normalizeObject).filter((item) => item.name).slice(0, 16);
  }
  if (Object.hasOwn(value, 'participants') && !Array.isArray(value.participants)) out.participants = [];
  if (Object.hasOwn(value, 'objects') && !Array.isArray(value.objects)) out.objects = [];
  if (value.tension != null) out.tension = value.tension;
  return out;
}

function parseStructuredValue(raw, regex, expected) {
  const source = String(raw || '');
  regex.lastIndex = 0;
  let text = source;
  let value = null;
  const tags = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    try {
      const parsed = parseJsonLike(match[1]);
      if ((expected === 'array' && Array.isArray(parsed))
        || (expected === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
        value = parsed;
        tags.push({ start: match.index, end: match.index + match[0].length });
      }
    } catch { /* Keep malformed tags visible for recovery. */ }
  }
  for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  return { text: text.trim(), value };
}

export function parsePlayerState(raw) {
  return parseStructuredValue(raw, PLAYER_RE, 'object');
}

export function parseCharacters(raw) {
  const parsed = parseStructuredValue(raw, CHARACTERS_RE, 'array');
  const characters = (parsed.value || []).map((item) => item && typeof item === 'object' && !Array.isArray(item) ? {
    name: String(item.name || '').trim(),
    mood: String(item.mood || '').trim(),
    relationship: String(item.relationship || '').trim(),
    goal: String(item.goal || '').trim(),
    status: String(item.status || '').trim(),
  } : null).filter((item) => item?.name).slice(0, 12);
  return { ...parsed, value: parsed.value === null ? null : characters };
}

export function parseSituation(raw) {
  const parsed = parseStructuredValue(raw, SITUATION_RE, 'object');
  if (!parsed.value) return parsed;
  const value = {};
  for (const key of ['risks', 'openThreads']) {
    if (Array.isArray(parsed.value[key])) value[key] = parsed.value[key].map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
  }
  return { ...parsed, value };
}

function normalizeParticipant(value) {
  const item = value && typeof value === 'object' ? value : { name: value };
  return {
    name: String(item.name || '').trim(),
    position: String(item.position || '').trim(),
    emotion: String(item.emotion || '').trim(),
    action: String(item.action || '').trim(),
  };
}

function normalizeObject(value) {
  const item = value && typeof value === 'object' ? value : { name: value };
  return {
    name: String(item.name || '').trim(),
    location: String(item.location || '').trim(),
    status: String(item.status || '').trim(),
  };
}

/** 解析本轮变化并从正文移除 Changes 标签。 */
export function parseChanges(raw) {
  const parsed = parseTaggedJson(raw, CHANGES_RE);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return parsed;
  const value = { ...parsed.value };
  for (const key of ['summary', 'time', 'location']) {
    if (value[key] != null) value[key] = String(value[key]).trim();
  }
  for (const key of ['discoveries', 'relationships', 'state', 'events', 'goals']) {
    if (Array.isArray(value[key])) value[key] = value[key].map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  }
  return { ...parsed, value };
}

/** 解析短期/长期记忆，并从正文移除 Memory 标签。 */
export function parseMemoryBlock(raw) {
  const source = String(raw || '');
  MEMORY_RE.lastIndex = 0;
  let text = source;
  let value = null;
  const tags = [];
  let match;
  while ((match = MEMORY_RE.exec(source)) !== null) {
    const body = match[1].trim();
    let parsed = parseJsonLike(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed = normalizeMemory(parsed);
    } else if (body && !/^[{[]/.test(body)) {
      const markdown = parseMemoryMarkdown(body);
      parsed = normalizeMemory(markdown);
    } else {
      // JSON 记忆损坏时保留原标签，避免错误内容覆盖已有记忆。
      continue;
    }
    value = value ? mergeMemory(value, parsed) : parsed;
    tags.push({ start: match.index, end: match.index + match[0].length });
  }
  for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  return { text: text.trim(), value };
}

/** 解析简短演绎检查，不将其当作正文显示。 */
export function parseReview(raw) {
  const source = String(raw || '');
  REVIEW_RE.lastIndex = 0;
  let text = source;
  const reviews = [];
  const tags = [];
  let match;
  while ((match = REVIEW_RE.exec(source)) !== null) {
    if (match[1].trim()) reviews.push(match[1].trim());
    tags.push({ start: match.index, end: match.index + match[0].length });
  }
  for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  return { text: text.trim(), review: reviews.join('\n\n') };
}

/** 一次完成所有结构化回复标签的解析。 */
export function parseStructuredReply(raw) {
  const source = normalizeStructuredTags(removeThinkingTags(raw));
  const scene = parseScene(source);
  const player = parsePlayerState(scene.text);
  const characters = parseCharacters(player.text);
  const situation = parseSituation(characters.text);
  const state = parseState(situation.text);
  const memory = parseMemoryBlock(state.text);
  const changes = parseChanges(memory.text);
  const choices = parseChoices(changes.text);
  const review = parseReview(choices.text);
  return {
    text: review.text,
    scene: scene.value,
    player: player.value,
    characters: characters.value,
    situation: situation.value,
    changes: changes.value,
    state: state.state,
    memory: memory.value,
    choices: choices.choices,
    review: review.review,
  };
}

/** Serialize one canonical copy of each successfully parsed structured block. */
export function serializeStructuredReply(parsed) {
  const blocks = [
    ['Scene', parsed.scene], ['Player', parsed.player], ['Characters', parsed.characters],
    ['Situation', parsed.situation], ['Changes', parsed.changes], ['State', parsed.state],
    ['Memory', parsed.memory], ['Choices', parsed.choices], ['Review', parsed.review],
  ];
  return blocks.filter(([, value]) => value != null).map(([name, value]) => {
    const content = name === 'Review' ? String(value)
      : name === 'Memory' && value && typeof value === 'object' && value.markdown
        ? String(value.markdown)
        : JSON.stringify(value);
    return `<${name}>${content}</${name}>`;
  });
}

/** 从模型回复中提取可选行动，并从可见正文移除 Choices 标签。 */
export function parseChoices(raw) {
  const source = String(raw || '');
  CHOICES_RE.lastIndex = 0;
  let text = source;
  const values = [];
  let match;
  while ((match = CHOICES_RE.exec(source)) !== null) {
    try {
      const parsed = parseJsonLike(match[1]);
      if (Array.isArray(parsed)) {
        values.push(...parsed.map(normalizeChoice).filter(Boolean));
      } else {
        values.push(...recoverChoiceObjects(match[1]));
      }
    } catch {
      values.push(...recoverChoiceObjects(match[1]));
    }
  }
  if (values.length) {
    const tags = [];
    CHOICES_RE.lastIndex = 0;
    while ((match = CHOICES_RE.exec(source)) !== null) tags.push({ start: match.index, end: match.index + match[0].length });
    for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  } else {
    // Bad JSON action blocks are UI metadata, not story prose.
    CHOICES_RE.lastIndex = 0;
    const malformed = [];
    while ((match = CHOICES_RE.exec(source)) !== null) malformed.push({ start: match.index, end: match.index + match[0].length });
    for (let i = malformed.length - 1; i >= 0; i--) text = text.slice(0, malformed[i].start) + text.slice(malformed[i].end);
  }
  const seen = new Set();
  const choices = values.filter((choice) => {
    const key = typeof choice === 'string' ? choice : choice.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
  return { text: text.trim(), choices };
}

function recoverChoiceObjects(source) {
  const repaired = String(source || '').replace(/\\(["'])/g, '$1');
  const values = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < repaired.length; index += 1) {
    const char = repaired[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth += 1; }
    else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const parsed = parseJsonLike(repaired.slice(start, index + 1));
        const choice = normalizeChoice(parsed);
        if (choice) values.push(choice);
        start = -1;
      }
    }
  }
  return values;
}

function normalizeChoice(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = String(value.text || value.action || '').trim();
  if (!text) return null;
  return {
    text,
    type: String(value.type || '自由行动').trim(),
    intent: String(value.intent || '').trim(),
    risk: String(value.risk || '').trim(),
  };
}

/** 把 AI 回复拆成「文本段」和「HTML 面板段」 */
export function parseReply(raw) {
  const segments = [];
  let last = 0;
  let m;
  REPLY_RE.lastIndex = 0;

  while ((m = REPLY_RE.exec(raw)) !== null) {
    if (m.index > last) {
      const text = raw.slice(last, m.index);
      if (text.trim()) segments.push({ type: 'text', content: text });
    }
    const code = m[1].trim();
    if (code) segments.push({ type: 'html', content: code });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    const text = raw.slice(last);
    if (text.trim()) segments.push({ type: 'text', content: text });
  }
  return segments.length ? segments : [{ type: 'text', content: raw }];
}

/**
 * 生成 iframe 的 srcdoc
 * sandbox 属性禁止脚本执行，模型产的 HTML 只能当样式和结构看
 */
function buildSrcdoc(innerHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:"Microsoft YaHei","PingFang SC",sans-serif;
    background:transparent;color:#e8e6e3;padding:14px 16px;
    font-size:14px;line-height:1.7;
  }
  .panel{
    background:rgba(30,30,34,.92);
    border:1px solid rgba(255,255,255,.12);
    border-radius:10px;padding:14px 16px;
  }
  img{max-width:100%;border-radius:8px;display:block}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid rgba(255,255,255,.15);padding:6px 9px;text-align:left}
  hr{border:none;border-top:1px solid rgba(255,255,255,.12);margin:10px 0}
  a{color:#7aa2f7}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:3px}
</style>
</head><body>${innerHtml}</body></html>`;
}

/** 生成一个已设置好 sandbox 的 iframe */
export function buildPanelFrame(code) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('srcdoc', buildSrcdoc(code));
  iframe.style.cssText =
    'width:100%;height:220px;border:none;border-radius:10px;background:transparent;display:block';
  iframe.setAttribute('title', '回复面板');
  return iframe;
}

/**
 * 把纯文本渲染成带格式的 HTML
 * 小说式正文，保留引号并高亮台词；旧版成对引号兼容显示。
 */
export function formatText(text) {
  let html = escapeHtml(text);

  // *动作* → 斜体灰显
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // 只处理配对引号，流式输出中未闭合的引号保持普通文字。
  html = html.replace(/“[^“”]*”|「[^「」]*」|『[^『』]*』/g, (quote) =>
    '<span class="quote">' + quote + '</span>');
  // 换行
  html = html.replace(/\n/g, '<br>');

  return html;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
