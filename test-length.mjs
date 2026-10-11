/** 篇幅回归测试：真实 main.js 事件 + 内存 DOM/存储 + 模拟 llama.cpp HTTP。
 * 运行：node test-length.mjs；不访问模型、不读取用户的浏览器数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as assembler from './js/assembler.js';
import * as prompts from './js/prompts.js';
import * as render from './js/render.js';
import * as persona from './js/persona.js';
import * as profile from './js/profile.js';
import * as profileAssist from './js/profile-assist.js';
import * as narrative from './js/narrative.js';
import * as store from './js/store.js';
import { LLM } from './js/llm.js';
import { cardToBlocks, makeCard } from './js/card.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}

globalThis.localStorage = {
  data: new Map(),
  getItem(key) { return this.data.get(key) ?? null; },
  setItem(key, value) { this.data.set(key, String(value)); },
  removeItem(key) { this.data.delete(key); },
};
globalThis.alert = (message) => { throw new Error(message); };

class Element {
  constructor() {
    this._html = ''; this.queries = new Map(); this.textContent = ''; this.value = '';
    this.style = {}; this.dataset = {}; this.children = []; this.checked = false;
    this.classList = { add() {}, remove() {} };
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = value; this.queries.clear(); }
  appendChild(el) { this.children.push(el); }
  setAttribute() {}
  addEventListener() {}
  focus() {}
  querySelector() { return new Element(); }
  querySelectorAll(selector) {
    if (selector !== '.len-card') return [];
    if (this.queries.has(selector)) return this.queries.get(selector);
    const elements = [...this.innerHTML.matchAll(/data-k="([^"]+)"/g)].map((match) => {
      const el = new Element(); el.dataset.k = match[1]; return el;
    });
    this.queries.set(selector, elements);
    return elements;
  }
}

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./js/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '');
function makeApp() {
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], new Element()]));
  const context = vm.createContext({
    ...assembler, ...prompts, ...render, ...persona, ...profile, ...profileAssist, ...narrative, store, LLM, llm: new LLM(),
    localStorage, console, performance, setTimeout,
    initCard() {}, alert() {}, confirm: () => true,
    FileReader: class {
      readAsText(file) { this.result = file.text; this.onload(); }
    },
    navigator: { clipboard: { async writeText() {} } },
    window: { addEventListener() {} },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => new Element(),
      querySelectorAll: () => [], querySelector: () => new Element(),
      addEventListener() {},
    },
  });
  vm.runInContext(source + `\nglobalThis.app = {
    state, newConfig, selectConfig, renderLength, bindEvents, send, buildPrompt,
    applyCardToConfig, persist,
  };`, context, { filename: 'main.js' });
  context.app.bindEvents();
  return { ...context.app, elements };
}

const requests = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  assert.equal(typeof body.max_tokens, 'number', 'max_tokens 必须是数字而不是对象');
  assert.ok(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0);
  const reply = { choices: [{ delta: { content: '图书馆安静下来。' } }] };
  return new Response('data: ' + JSON.stringify(reply) + '\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

const app = makeApp();
function apply(key, text = prompts.getPrompt(key)) {
  app.elements.lenPresets.querySelectorAll('.len-card').find((el) => el.dataset.k === key).onclick();
  app.elements.lenPrompt.value = text;
  app.elements.lenApply.onclick();
}
async function send() {
  const before = requests.length;
  app.elements.chatInput.value = '继续观察周围。';
  await app.send();
  assert.equal(requests.length, before + 1, '必须实际调用 HTTP');
  assert.equal(app.state.messages.at(-1)?.role, 'assistant', '请求应成功完成并保存回复');
  assert.ok(requests.at(-1).messages.some((m) => m.role === 'system' && m.content.includes(narrative.NOVEL_STYLE)), '真实发送必须包含小说格式');
  return requests.at(-1);
}

try {
  await test('未应用篇幅时，真实发送使用数字默认值 3000', async () => {
    app.newConfig();
    assert.ok(app.elements.lenStat.textContent.includes('待应用'));
    assert.equal((await send()).max_tokens, 3000);
  });
  for (const preset of prompts.LENGTH_PRESETS) {
    await test(`${preset.label}档：实际请求同时包含篇幅提示词、数字上限和结构化预留`, async () => {
      apply(preset.key);
      const body = await send();
      assert.equal(body.max_tokens, prompts.SUGGESTED_TOKENS[preset.key] + 800);
      assert.ok(body.messages.some((m) => m.role === 'system' && m.content.includes(prompts.getPrompt(preset.key))));
    });
  }
  await test('四个行动选项另留预算；纯正文保持原档位上限', () => {
    app.state.cfg.choices.enabled = true;
    assert.equal(prompts.generationOptions(app.state.cfg).max_tokens, 4600);
    app.state.cfg.responseFormat.enabled = false;
    app.state.cfg.choices.enabled = false;
    assert.equal(prompts.generationOptions(app.state.cfg).max_tokens, 3600);
  });
  await test('只选档位或编辑草稿时不改变已应用设置', () => {
    const before = JSON.stringify(app.state.cfg);
    app.elements.lenPresets.querySelectorAll('.len-card').find((el) => el.dataset.k === 'short').onclick();
    app.elements.lenPrompt.value = '一段尚未应用的草稿。';
    app.elements.lenPrompt.oninput();
    assert.equal(JSON.stringify(app.state.cfg), before);
    assert.ok(app.elements.lenStat.textContent.startsWith('待应用'));
  });
  await test('自定义篇幅不会覆盖主提示词，重复应用不堆积设定块', () => {
    const main = app.state.cfg.blocks.find((b) => b.name === '主提示词');
    main.content = '只叙述角色已知的信息。';
    apply('medium', '只写约500字，使用短段落。');
    apply('medium', '只写约500字，使用短段落。');
    assert.equal(main.content, '只叙述角色已知的信息。');
    assert.equal(app.state.cfg.blocks.filter((b) => b.name === '篇幅要求').length, 1);
  });
  const savedId = app.state.configId;
  await test('刷新重新加载作品，恢复已应用档位和自定义文本', () => {
    const reload = makeApp();
    reload.selectConfig(savedId);
    assert.equal(reload.elements.lenPrompt.value, '只写约500字，使用短段落。');
    assert.ok(reload.elements.lenStat.textContent.startsWith('已应用：中档'));
  });
  await test('切换作品恢复各自设置，新作品明确显示待应用', () => {
    store.saveConfig('length_other', {
      name: '另一作品', blocks: [], entries: [], vars: {},
      ...prompts.applyLengthSettings({ blocks: [] }, 'short', '只回复两句话。'),
    });
    app.selectConfig('length_other');
    assert.equal(app.elements.lenPrompt.value, '只回复两句话。');
    app.selectConfig(savedId);
    assert.equal(app.elements.lenPrompt.value, '只写约500字，使用短段落。');
    app.newConfig();
    assert.ok(app.elements.lenStat.textContent.startsWith('待应用'));
    assert.equal(app.state.cfg.vars.maxTokens, undefined);
  });
  await test('重新应用角色卡后篇幅提示仍注入模型', () => {
    app.selectConfig(savedId);
    app.applyCardToConfig(cardToBlocks(makeCard({ name: '向导', scenario: '旧图书馆' })));
    assert.equal(app.elements.lenPrompt.value, '只写约500字，使用短段落。');
    assert.ok(app.buildPrompt('继续').messages[0].content.includes('只写约500字'));
  });
  await test('实际导入事件恢复档位、文本和数字预算', () => {
    const backup = assembler.exportConfig(app.state.cfg);
    app.selectConfig('length_other');
    app.elements.importFile.onchange({ target: { files: [{ text: backup }], value: 'backup.json' } });
    assert.equal(app.elements.lenPrompt.value, '只写约500字，使用短段落。');
    assert.equal(app.state.cfg.length.preset, 'medium');
    assert.equal(prompts.generationOptions(app.state.cfg).max_tokens, 900);
  });
  await test('空白篇幅提示词不会清空现有设定', () => {
    const before = JSON.stringify(app.state.cfg);
    app.elements.lenPrompt.value = '  ';
    app.elements.lenApply.onclick();
    assert.equal(JSON.stringify(app.state.cfg), before);
    assert.match(app.elements.lenStat.textContent, /不能为空/);
  });
  await test('旧版篇幅可恢复，原预设迁移后没有相互冲突的字数指令', () => {
    const legacy = { blocks: [assembler.makeBlock({ name: '主提示词', content: prompts.getPrompt('epic') })], vars: { maxTokens: 3600 } };
    assert.equal(prompts.getLengthSettings(legacy).key, 'epic');
    prompts.applyLengthSettings(legacy, 'short', prompts.getPrompt('short'));
    assert.equal(legacy.blocks.length, 1);
    assert.equal(legacy.blocks[0].name, '篇幅要求');
    assert.ok(!assembler.assemble({ blocks: legacy.blocks }).messages[0].content.includes('2000'));
  });
  await test('旧版自定义主提示词不会被预设自动覆盖', () => {
    const legacy = { blocks: [assembler.makeBlock({ name: '主提示词', content: '我的自定义设定' })], vars: { maxTokens: 1800 } };
    assert.equal(prompts.getLengthSettings(legacy).prompt, '我的自定义设定');
    prompts.applyLengthSettings(legacy, 'short', prompts.getPrompt('short'));
    assert.equal(legacy.blocks[0].content, '我的自定义设定');
  });
  await test('非法导入预算回退，数字字符串转换为数字', () => {
    for (const bad of [{ max_tokens: 900 }, {}, [], true, null, '', 'abc', -1, 0, 1.5, Infinity]) {
      assert.deepEqual(prompts.generationOptions({ vars: { maxTokens: bad } }), {});
    }
    assert.deepEqual(prompts.generationOptions({ vars: { maxTokens: '900' } }), { max_tokens: 900 });
  });
  await test('禁用或删除篇幅设定块后不继续限制输出预算', () => {
    const cfg = prompts.applyLengthSettings({ blocks: [] }, 'short', prompts.getPrompt('short'));
    cfg.blocks[0].enabled = false;
    assert.deepEqual(prompts.generationOptions(cfg), {});
    cfg.blocks = [];
    assert.deepEqual(prompts.generationOptions(cfg), {});
  });
  await test('首次发送包含角色身份和开场，且不会改写作品设定', async () => {
    app.newConfig();
    app.applyCardToConfig(cardToBlocks(makeCard({ name: '顾岚', tagline: '旧书店主', personality: '谨慎' })));
    app.state.cfg.greeting = '顾岚递来一封蓝色的信：“请看看地址。”';
    const before = JSON.stringify(app.state.cfg.blocks);
    const body = await send();
    assert.match(body.messages[0].content, /姓名：顾岚/);
    assert.match(body.messages[0].content, /身份：旧书店主/);
    assert.match(body.messages[0].content, /蓝色的信/);
    assert.equal(JSON.stringify(app.state.cfg.blocks), before);
    assert.ok(!app.buildPrompt('读信').messages[0].content.includes('以下是已经发生的故事开场'));
  });
  await test('首次回复失败留下用户消息时，重试仍保留开场上下文', () => {
    app.state.messages = [{ role: 'user', content: '我接过信' }];
    assert.match(app.buildPrompt('继续').messages[0].content, /蓝色的信/);
  });
  console.log(`\n篇幅及实际发送回归：${passed} 项通过；HTTP 均为模拟请求。`);
} finally {
  globalThis.fetch = oldFetch;
}
