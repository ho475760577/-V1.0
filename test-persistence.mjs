import assert from 'node:assert/strict';
import * as store from './js/store.js';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
  get length() { return values.size; },
  key(index) { return [...values.keys()][index] ?? null; },
};
globalThis.location = { origin: 'http://127.0.0.1:5173' };

const requests = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (!options.method) return new Response(JSON.stringify({ workspace: null, updatedAt: 0 }), { status: 200 });
  return new Response(JSON.stringify({ ok: true, updatedAt: Date.now() }), { status: 200 });
};

store.saveConfig('persisted', { name: '可恢复作品' });
store.saveChat('persisted', [{ role: 'user', content: '保留这段' }]);
const result = await store.initializePersistence();
assert.equal(result.source, 'local');
assert.equal(store.loadConfig('persisted').name, '可恢复作品');
assert.equal(store.loadChat('persisted')[0].content, '保留这段');
assert.ok(requests.some(({ options }) => options.method === 'PUT'), '本地数据应上传到工作区文件');

globalThis.fetch = oldFetch;
console.log('PASS 本地存储启动同步与文件副本上传');
