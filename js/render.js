/**
 * 回复渲染：把 AI 的输出转成 HTML
 *
 * 核心是 <Reply Example> 标签 —— AI风月 让模型在里面输出 HTML 代码，
 * 前端渲染成状态栏 / UI。ST 做不到这点是其最大短板。
 *
 * 安全策略：走 iframe sandbox + srcdoc，模型产的 HTML 无法触碰主页面
 */

const REPLY_RE = /<Reply Example>([\s\S]*?)<\/Reply Example>/gi;
const STATE_RE = /<State>([\s\S]*?)<\/State>/gi;
const CHOICES_RE = /<Choices>([\s\S]*?)<\/Choices>/gi;
const SCENE_RE = /<Scene>([\s\S]*?)<\/Scene>/gi;
const MEMORY_RE = /<Memory>([\s\S]*?)<\/Memory>/gi;
const REVIEW_RE = /<Review>([\s\S]*?)<\/Review>/gi;

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
  try {
    const parsed = JSON.parse(String(value).trim());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
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
  return parseTaggedJson(raw, SCENE_RE);
}

/** 解析短期/长期记忆，并从正文移除 Memory 标签。 */
export function parseMemoryBlock(raw) {
  return parseTaggedJson(raw, MEMORY_RE);
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
  const scene = parseScene(raw);
  const state = parseState(scene.text);
  const memory = parseMemoryBlock(state.text);
  const choices = parseChoices(memory.text);
  const review = parseReview(choices.text);
  return {
    text: review.text,
    scene: scene.value,
    state: state.state,
    memory: memory.value,
    choices: choices.choices,
    review: review.review,
  };
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
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) values.push(...parsed.filter((x) => typeof x === 'string' && x.trim()));
    } catch {
      // 忽略格式错误的选项，不影响正文显示
    }
  }
  if (values.length) {
    const tags = [];
    CHOICES_RE.lastIndex = 0;
    while ((match = CHOICES_RE.exec(source)) !== null) tags.push({ start: match.index, end: match.index + match[0].length });
    for (let i = tags.length - 1; i >= 0; i--) text = text.slice(0, tags[i].start) + text.slice(tags[i].end);
  }
  return { text: text.trim(), choices: [...new Set(values)].slice(0, 4) };
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
