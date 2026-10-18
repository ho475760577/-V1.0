/**
 * UI 与存储层自测（不依赖浏览器，用最小 DOM 桩）
 * 运行： node test-ui.mjs
 */
import { makeCard, cardToBlocks, exportCard, importCard, setCardAvatar, cardAvatar, classifyStory } from './js/card.js';
import { makePersona, personaToBlock, PERSONA_PRESETS, avatarPlaceholder } from './js/persona.js';
import { parseState, parseChoices, parseStructuredReply } from './js/render.js';
import * as S from './js/store.js';

/* ============ 最小 DOM 桩 ============ */
const els = {};
globalThis.localStorage = {
  _d: {},
  get length() { return Object.keys(this._d).length; },
  key(index) { return Object.keys(this._d)[index] ?? null; },
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.document = {
  getElementById(id) { return els[id] || null; },
  createElement: () => ({
    style: {}, classList: { add() {}, remove() {} },
    appendChild() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  }),
  addEventListener() {},
};
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.prompt = () => '1';
globalThis.FileReader = class {};
globalThis.Blob = class { constructor() {} };

function stub() {
  return {
    innerHTML: '', style: {}, value: '', checked: false,
    dataset: {}, files: [],
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {}, onclick: null, onchange: null, oninput: null,
  };
}

function resetDOM(ids) {
  for (const k of Object.keys(els)) delete els[k];
  for (const id of ids) els[id] = stub();
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/* ============ 完整作品备份恢复 ============ */
console.log('\n=== 完整作品备份恢复 ===');
{
  S.saveConfig('backup_story', { name: '完整故事', entries: [{ type: 'event', requires: ['雨夜'] }] });
  S.saveCard({ id: 'backup_card', name: '顾岚', shortTermGoal: '找到旧信' });
  S.savePersona({ id: 'backup_persona', name: '周川', identity: '摄影师' });
  S.saveChat('backup_story', [{ role: 'user', content: '打开信件' }], 'backup_card');
  localStorage.setItem('sil.lastcard.backup_story', 'backup_card');
  S.saveCreationDraft({ version: 1, answers: { idea: '山城故事' } });
  const backup = S.exportWorkspaceBackup();
  S.deleteConfig('backup_story'); S.deleteCard('backup_card'); S.clearChat('backup_story', 'backup_card');
  S.importWorkspaceBackup(backup);
  check('恢复作品、角色、身份和聊天', S.loadConfig('backup_story')?.entries[0].requires[0] === '雨夜'
    && S.loadCard('backup_card')?.shortTermGoal === '找到旧信'
    && S.loadPersona('backup_persona')?.identity === '摄影师'
    && S.loadChat('backup_story', 'backup_card')[0].content === '打开信件');
  check('恢复聊天角色绑定和未完成草稿', localStorage.getItem('sil.lastcard.backup_story') === 'backup_card'
    && S.loadCreationDraft()?.answers.idea === '山城故事');
  const before = JSON.stringify(S.listConfigs());
  try { S.importWorkspaceBackup({ schema: 'wrong', version: 1, data: {} }); } catch {}
  check('无效备份不会覆盖当前作品', JSON.stringify(S.listConfigs()) === before);
}

/* ============ 1. 角色卡界面渲染完整性 ============ */
console.log('\n=== 1. 角色卡界面渲染完整性 ===');
{
  resetDOM(['cardEditor', 'cardSelect', 'newCardBtn', 'delCardBtn', 'aiDirBtn',
    'aiExpandBtn', 'aiBrief', 'aiStatus', 'dirList', 'tplList',
    'impCardFile', 'applyCard', 'expCard', 'impCard']);

  const CU = await import('./js/card-panel.js');
  try {
    CU.initCard(() => ({}), () => {}, () => {}, () => {});
    check('初始化未崩溃', true);
  } catch (e) {
    check('初始化未崩溃', false, e.message);
  }

  const h = els.cardEditor.innerHTML;

  const buttons = ['设为当前角色', '应用到作品设定', '导出', '导入', '上传头像'];
  for (const b of buttons) check(`按钮「${b}」存在`, h.includes(b));

  const fields = ['角色名', '一句话身份', '外貌', '性格', '背景', '说话方式',
    '当前目标', '长期目标', '恐惧与顾虑', '内在需求', '内在矛盾', '底线与边界', '行为线索', '人物弧光',
    '故事情境', '开场白', '示例对话', '创作者备注'];
  for (const f of fields) check(`字段「${f}」存在`, h.includes(f));

  const polishCount = (h.match(/data-ai="polish"/g) || []).length;
  check('AI 美化按钮覆盖基础资料与角色驱动字段', polishCount === 16, `实际 ${polishCount}`);
  check('人物细节单项美化按钮 7 个', (h.match(/data-profile-field="/g) || []).length === 7);
  check('AI 生成示例对话按钮', h.includes('AI 生成示例对话'));

  const tplCount = (els.tplList.innerHTML.match(/class="tpl"/g) || []).length;
  check('模板 6 个', tplCount === 6, `实际 ${tplCount}`);
}

/* ============ 2. DOM 缺失时不崩溃 ============ */
console.log('\n=== 2. DOM 缺失时容错 ===');
{
  resetDOM([]);
  const CU = await import('./js/card-panel.js');
  try {
    CU.initCard(() => ({}), () => {}, () => {}, () => {});
    check('无 DOM 时不崩溃', true);
  } catch (e) {
    check('无 DOM 时不崩溃', false, e.message);
  }
}

/* ============ 2b. 空数据时当前卡必须真实存在 ============ */
console.log('\n=== 2b. 空数据时当前卡可被下拉框选中 ===');
{
  // 清掉所有角色卡
  for (const id of Object.keys(S.listCards())) S.deleteCard(id);

  resetDOM(['cardEditor', 'cardSelect', 'newCardBtn', 'delCardBtn', 'aiDirBtn',
    'aiExpandBtn', 'aiBrief', 'aiStatus', 'dirList', 'tplList',
    'impCardFile', 'applyCard', 'expCard', 'impCard']);

  const CU = await import('./js/card-panel.js');
  CU.initCard(() => ({}), () => {}, () => {}, () => {});

  const stored = Object.keys(S.listCards());
  check('无卡时自动创建一张', stored.length === 1, `实际 ${stored.length}`);

  // 关键：下拉框必须包含当前编辑的卡
  const optCount = (els.cardSelect.innerHTML.match(/<option/g) || []).length;
  check('下拉框包含该卡', optCount >= 1, `实际 ${optCount} 个选项`);
  check('下拉框有 selected 标记',
    els.cardSelect.innerHTML.includes('selected'), true);

  check('编辑区已渲染内容', els.cardEditor.innerHTML.includes('角色名'));
}

/* ============ 3. Persona 存储 CRUD ============ */
console.log('\n=== 3. Persona 存储 CRUD ===');
{
  const p = makePersona({ name: '沈砚', identity: '记者', personality: '执拗' });
  S.savePersona(p);
  check('保存后可读取', S.loadPersona(p.id)?.name === '沈砚');
  S.setCurrentPersonaId(p.id);
  check('当前身份 ID 已记录', S.currentPersonaId() === p.id);
  check('列表包含该身份', p.id in S.listPersonas());

  S.deletePersona(p.id);
  check('删除后读不到', S.loadPersona(p.id) == null);
  check('删除时清理当前 ID', S.currentPersonaId() === null);
}

/* ============ 3b. 作品配置与绑定数据隔离 ============ */
console.log('\n=== 3b. 作品配置隔离 ===');
{
  S.saveConfig('cfg_a', { name: '作品A', blocks: [{ content: 'A' }], entries: [{ content: '世界A' }], personaId: 'p_a' });
  S.saveConfig('cfg_b', { name: '作品B', blocks: [{ content: 'B' }], entries: [{ content: '世界B' }], personaId: 'p_b' });
  const a = S.loadConfig('cfg_a');
  const b = S.loadConfig('cfg_b');
  check('作品 A 的设定独立', a.blocks[0].content === 'A' && a.entries[0].content === '世界A');
  check('作品 B 的设定独立', b.blocks[0].content === 'B' && b.entries[0].content === '世界B');
  check('作品绑定不同身份', a.personaId !== b.personaId);
}

/* ============ 4. 多角色聊天隔离 ============ */
console.log('\n=== 4. 多角色聊天隔离 ===');
{
  const cfg = 'cfg_t';
  S.saveChat(cfg, [{ role: 'user', content: 'A' }], 'card_a');
  S.saveChat(cfg, [{ role: 'user', content: 'B' }], 'card_b');
  S.saveChat(cfg, [{ role: 'user', content: 'NONE' }], null);

  check('A 的对话独立', S.loadChat(cfg, 'card_a')[0].content === 'A');
  check('B 的对话独立', S.loadChat(cfg, 'card_b')[0].content === 'B');
  check('无角色槽独立', S.loadChat(cfg, null)[0].content === 'NONE');
  check('不存在的角色返回空数组',
    Array.isArray(S.loadChat(cfg, 'nope')) && S.loadChat(cfg, 'nope').length === 0);
  check('统计有对话的角色数', Object.keys(S.chatsOfConfig(cfg)).length === 2);

  S.clearChat(cfg, 'card_a');
  check('清空单角色不影响其他', S.loadChat(cfg, 'card_b')[0].content === 'B');

  S.clearChat(cfg, null);
  check('清空无角色槽', S.loadChat(cfg, null).length === 0);
}

/* ============ 5. Persona 文本生成 ============ */
console.log('\n=== 5. Persona 文本生成 ===');
{
  const blk = personaToBlock(makePersona({
    name: '沈砚', identity: '新来的记者', personality: '执拗',
  }));
  check('含名字', blk.includes('沈砚'));
  check('含身份', blk.includes('新来的记者'));
  check('含性格', blk.includes('执拗'));
  check('含防替身约束', blk.includes('不要替'));
  check('保留 {{user}} 占位', blk.includes('{{user}}'));

  check('全空返回 null', personaToBlock(makePersona()) === null);
  check('null 输入安全', personaToBlock(null) === null);

  check('身份预设 6 套', PERSONA_PRESETS.length === 6);
  for (const t of PERSONA_PRESETS) {
    check(`预设「${t.label}」字段完整`, !!(t.data.identity && t.data.personality));
  }
}

/* ============ 6. 头像占位 ============ */
console.log('\n=== 6. 头像占位 ===');
{
  check('取名字首字', avatarPlaceholder('林晚').text === '林');
  check('空名兜底为 ?', avatarPlaceholder('').text === '?');
  const c1 = avatarPlaceholder('林晚');
  const c2 = avatarPlaceholder('林晚');
  check('同名字色相稳定', c1.color === c2.color);

  const card = makeCard({ name: '锦瑟' });
  check('无头像时用占位', cardAvatar(card).text === '锦');
  check('有头像时优先', cardAvatar({ ...card, avatar: 'data:image/jpeg;base64,x' }).url.length > 0);
}

/* ============ 7. 角色卡导入导出（含头像） ============ */
console.log('\n=== 7. 角色卡导入导出 ===');
{
  const card = makeCard({
    name: '林晚', tagline: '咖啡馆店主', appearance: '黑长发',
    personality: '冷淡但关心人', background: '独自经营三年',
    speechStyle: '说话简短', creatorNotes: '备注', avatar: 'data:image/jpeg;base64,abc',
    shortTermGoal: '找回旧钥匙', arc: '从疏离走向信任',
  });
  const back = importCard(exportCard(card));
  check('名字', back.name === '林晚');
  check('一句话身份', back.tagline === '咖啡馆店主');
  check('外貌', back.appearance === '黑长发');
  check('性格', back.personality === '冷淡但关心人');
  check('背景', back.background === '独自经营三年');
  check('说话方式', back.speechStyle === '说话简短');
  check('创作者备注', back.creatorNotes === '备注');
  check('头像保留', back.avatar === 'data:image/jpeg;base64,abc');
  check('角色驱动字段导入导出', back.shortTermGoal === card.shortTermGoal && back.arc === card.arc);
}

/* ============ 8. cardToBlocks 映射 ============ */
console.log('\n=== 8. cardToBlocks 映射 ===');
{
  const blocks = cardToBlocks(makeCard({
    scenario: '咖啡馆', appearance: '黑发', personality: '冷淡',
    background: '三年', speechStyle: '简短', mesExample: '「来了。」',
  }));
  const names = blocks.map((b) => b.name);
  check('生成 5 个块', blocks.length === 5, `实际 ${blocks.length}`);
  check('含世界观', names.includes('世界观'));
  check('含角色设定', names.includes('角色设定'));
  check('含说话风格', names.includes('说话风格'));
  check('含示例对话', names.includes('示例对话'));
  check('含主提示词', names.includes('主提示词'));
  check('order 连续递增', blocks.every((b, i) => b.order === i));
}

/* ============ 8b. AI 故事分类 ============ */
console.log('\n=== 8b. AI 故事分类 ===');
{
  const fakeLlm = {
    async chat() {
      return { content: '```json\n{"name":"苏瑶","scenario":"长途旅行","background":"守寡后独自生活","personality":"表面端庄，私下主动","firstMes":"她看向后视镜。"}\n```' };
    },
  };
  const result = await classifyStory(fakeLlm, '一段完整故事');
  check('AI 分类保留角色名', result.name === '苏瑶');
  check('AI 分类填入故事情境', result.scenario === '长途旅行');
  check('AI 分类填入背景', result.background === '守寡后独自生活');
  check('AI 分类空字段安全', result.speechStyle === '' && result.creatorNotes === '');
}

/* ============ 结果 ============ */
console.log('\n=== 9. 变量面板状态解析 ===');
{
  const tagged = parseState('台词\n<State>{"好感度":42,"地点":"图书馆"}</State>');
  check('解析 State 标签', tagged.state?.好感度 === 42 && tagged.state?.地点 === '图书馆');
  check('从可见文本移除 State', !tagged.text.includes('<State>') && tagged.text.includes('台词'));
  const multi = parseState('<State>{"好感度":42}</State>正文<State>{"地点":"门口"}</State>');
  check('合并多个 State 标签', multi.state?.好感度 === 42 && multi.state?.地点 === '门口' && multi.text === '正文');

  const fenced = parseState('回复\n```json\n{"天气":"晴"}\n```');
  check('兼容 JSON 代码块', fenced.state?.天气 === '晴');
  check('普通 JSON 不误解析', parseState('{"只是":"正文"}').state === null);
  check('非法状态安全返回', parseState('<State>{bad}</State>').state === null);
  const choices = parseChoices('正文\n<Choices>["去图书馆","继续追问","离开现场","观察四周"]</Choices>');
  check('解析四个行动选项', choices.choices.length === 4 && choices.choices[0] === '去图书馆');
  check('从正文移除选项标签', choices.text === '正文');
  check('限制重复选项', parseChoices('<Choices>["A","A","B","C","D"]</Choices>').choices.length === 4);

  const structured = parseStructuredReply([
    '（苏瑶看向窗外）「继续走吧。」',
    '<Scene>{"time":"第1天 14:30","world":"现代都市","location":"高速公路"}</Scene>',
    '<State>{"好感度":5}</State>',
    '<Memory>{"shortTerm":["苏瑶主动试探"],"longTerm":["两人开始旅行"]}</Memory>',
    '<Review>人物行为与当前关系一致。</Review>',
    '<Choices>["继续开车","询问目的地","停车休息","自己输入"]</Choices>',
  ].join('\n'));
  check('结构化回复提取场景', structured.scene?.location === '高速公路');
  check('结构化回复提取状态', structured.state?.好感度 === 5);
  check('结构化回复提取记忆', structured.memory?.shortTerm?.[0] === '苏瑶主动试探');
  check('结构化回复提取检查和选项', structured.review.includes('人物行为') && structured.choices.length === 4);
  check('结构化标签从正文移除', !structured.text.includes('<Scene>') && structured.text.includes('继续走吧'));
  const malformed = parseStructuredReply('正文\n<Scene>{bad}</Scene>');
  check('坏 Scene 数据从正文隔离并可查看', malformed.text === '正文' && malformed.unparsed[0]?.name === 'Scene');

  const codeOnly = parseStructuredReply('Scene\n时间：深夜\nPlayer\n{bad}');
  check('无尖括号结构标签被隔离出正文', codeOnly.text === '' && codeOnly.scene?.time === '深夜' && codeOnly.unparsed.length === 1);

  const rich = parseStructuredReply([
    '环境描写',
    '<Scene>{"time":"夜里","world":"归墟档案","location":"高速公路","plot":"等待玩家回应","weather":"小雨","lighting":"路灯","sounds":["雨声"],"participants":[{"name":"苏瑶","position":"车内","emotion":"警觉","action":"握紧方向盘"}],"objects":[{"name":"旧信","location":"副驾驶","status":"未拆封"}],"goal":"找到钟楼","conflict":"有人跟踪","tension":7}</Scene>',
    '<Changes>{"discoveries":["发现旧信"],"events":["车辆驶入小巷"],"goals":["确认信件来源"]}</Changes>',
    '<Choices>[{"text":"检查旧信","type":"investigate","intent":"寻找线索","risk":"可能暴露行踪"}]</Choices>',
  ].join('\n'));
  check('解析富场景环境', rich.scene?.weather === '小雨' && rich.scene?.participants?.[0]?.position === '车内');
  check('解析场景头情节', rich.scene?.world === '归墟档案' && rich.scene?.plot === '等待玩家回应');
  check('解析场景物品与目标冲突', rich.scene?.objects?.[0]?.status === '未拆封' && rich.scene?.conflict === '有人跟踪');
  check('解析本轮变化', rich.changes?.discoveries?.[0] === '发现旧信' && rich.changes?.events?.[0] === '车辆驶入小巷');
  check('解析带元数据行动选项', rich.choices?.[0]?.text === '检查旧信' && rich.choices?.[0]?.risk === '可能暴露行踪');

  const escaped = parseStructuredReply('正文\n&lt;Scene&gt;{"time":"凌晨2点","location":"卧室"}&lt;/Scene&gt;');
  check('兼容 HTML 转义的场景标签', escaped.scene?.location === '卧室' && escaped.text === '正文');

  const missingOpen = parseStructuredReply('正文\nScene&gt;{"time":"凌晨2点","location":"卧室"}&lt;/Scene&gt;');
  check('兼容漏掉左尖括号的场景标签', missingOpen.scene?.location === '卧室' && missingOpen.text === '正文');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`结果：${pass} 通过, ${fail} 失败`);
console.log('='.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
