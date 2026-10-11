/** 前端版本与模块导出回归，防止旧缓存使整个页面无法初始化。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeJson } from './js/json-utils.js';
import { safeJson as cardParser } from './js/card.js';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = (name) => fs.readFileSync(new URL('./js/' + name, import.meta.url), 'utf8');
const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
assert.ok(mapMatch, '必须在模块入口之前提供完整的脚本版本映射');
const imports = JSON.parse(mapMatch[1]).imports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

test('AI 助手从独立解析模块导入，不依赖角色卡的新导出', () => {
  assert.match(source('profile-assist.js'), /import \{ safeJson \} from '\.\/json-utils\.js'/);
  assert.ok(!/from ['"]\.\/card\.js['"]/.test(source('profile-assist.js')));
  assert.ok(!/^import\s/m.test(source('json-utils.js')));
  assert.equal(cardParser, safeJson, '旧调用兼容同一个解析函数');
});
test('解析器搬迁后保留围栏、数组、换行和截断字段的兼容行为', () => {
  assert.deepEqual(safeJson('```json\n{"voice":"清亮"}\n```'), { voice: '清亮' });
  assert.deepEqual(safeJson('说明 [{"name":"顾岚"}] 完成'), [{ name: '顾岚' }]);
  assert.deepEqual(safeJson('{"voice":"清亮\\n温和"}'), { voice: '清亮\n温和' });
  assert.deepEqual(safeJson('{"voice":"清亮",'), { voice: '清亮' });
  assert.equal(safeJson(''), null);
});
test('所有前端模块都有相同版本，不只刷新入口脚本', () => {
  const files = fs.readdirSync(new URL('./js/', import.meta.url)).filter((f) => f.endsWith('.js'));
  const versions = new Set();
  for (const file of files) {
    const key = './js/' + file;
    assert.ok(imports[key], key + ' 缺少版本映射');
    const url = new URL(imports[key], 'http://localhost/');
    assert.equal(url.pathname, '/js/' + file);
    assert.ok(url.searchParams.get('v'));
    versions.add(url.searchParams.get('v'));
  }
  assert.equal(versions.size, 1);
});
test('每个静态子模块导入都解析到明确的版本映射', () => {
  for (const key of Object.keys(imports)) {
    const text = source(path.posix.basename(key));
    for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+\.js)['"]/g)) {
      const resolved = './' + path.posix.normalize(path.posix.join(path.posix.dirname(key), match[1]));
      assert.ok(imports[resolved], key + ' 的依赖 ' + resolved + ' 未版本化');
    }
  }
});
test('入口与样式使用当前版本，映射位于模块入口前', () => {
  const entry = html.match(/<script type="module" src="([^"]+)"><\/script>/);
  assert.ok(entry);
  assert.equal('./' + entry[1], imports['./js/main.js']);
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf(entry[0]));
  const version = new URL(imports['./js/main.js'], 'http://localhost/').search;
  assert.ok(html.includes('css/style.css' + version));
});

console.log(`\n模块加载回归：${passed} 项通过。`);
