/** AI 输出 JSON 解析；独立于角色卡和界面，避免业务模块间导出依赖。 */
/* ============ 解析辅助 ============ */

/**
 * 从模型输出里抠出 JSON
 * 容忍 ```json 围栏、前后废话、以及字段内的换行转义
 */
export function safeJson(text) {
  if (!text) return null;

  // 1. 优先剥 markdown 围栏
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 2. 定位第一个 { 或 [
  const b1 = s.indexOf('{');
  const b2 = s.indexOf('[');
  let start = -1;
  if (b1 === -1) start = b2;
  else if (b2 === -1) start = b1;
  else start = Math.min(b1, b2);
  if (start === -1) return null;

  const open = s[start];
  const close = open === '{' ? '}' : ']';

  // 3. 括号配对（跳过字符串内的括号）
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); }
        catch (e) { break; }
      }
    }
  }

  // 4. 括号配对失败 → 修复常见的「尾逗号 / 中文引号」后再试
  const repaired = s.slice(start)
    .replace(/,\s*([}\]])/g, '$1')          // 去掉尾逗号
    .replace(/[“”]/g, '"')               // 中文引号转义
    .replace(/[‘’]/g, "'");
  try { return JSON.parse(repaired); } catch { /* 继续兜底 */ }

  // 5. 最后兜底：逐字段正则捞（模型只漏了尾部逗号时有效）
  const loose = looseExtract(s);
  return loose;
}

/** 兜底：按 "key": "value" 逐个正则提取 */
function looseExtract(s) {
  const out = {};
  const re = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const k = m[1];
    let v = m[2];
    try { v = JSON.parse('"' + v + '"'); } catch { v = m[2]; }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

