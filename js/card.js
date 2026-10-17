/**
 * 角色卡模块
 *
 * 对标 SillyTavern 角色卡字段：
 *   name / description / personality / scenario / first_mes / mes_example
 *   creator_notes / tags / character_book(世界书)
 *
 * 额外提供 AI 辅助创作：
 *   generateDirections()  简述 → 4 个方向选项
 *   expandDirection()    选定方向 → 展开完整设定
 *   polishText()         单块美化
 */

/* ============ 角色卡结构 ============ */

import { compressImage, avatarPlaceholder } from './persona.js';
import { normalizeProfile, profileToText, PROFILE_AI_RULES } from './profile.js';
import { NOVEL_STYLE } from './narrative.js';
import { safeJson } from './json-utils.js';
export { safeJson }; // 兼容原有调用；新代码从公共解析模块导入。

export function makeCard(overrides = {}) {
  return {
    id: 'c' + Math.random().toString(36).slice(2, 10),
    name: '',
    tagline: '',        // 一句话身份
    appearance: '',      // 外貌
    personality: '',     // 性格
    background: '',      // 背景
    speechStyle: '',     // 说话方式与口癖
    shortTermGoal: '',
    longTermGoal: '',
    fear: '',
    need: '',
    contradiction: '',
    boundaries: '',
    behaviorCues: '',
    arc: '',
    scenario: '',        // 故事开始的情境
    firstMes: '',        // 开场白
    mesExample: '',      // 示例对话
    creatorNotes: '',    // 创作者备注（不进提示词）
    tags: [],
    avatar: '',          // dataURL（压缩后）
    ...overrides,
    ...normalizeProfile(overrides),
  };
}

/** 给角色卡设置头像，自动压缩 */
export async function setCardAvatar(card, file) {
  card.avatar = await compressImage(file, 256, 0.85);
  return card.avatar;
}

/** 头像占位：优先用 avatar，其次名字首字 */
export function cardAvatar(card) {
  if (card.avatar) return { url: card.avatar, ...avatarPlaceholder(card.name) };
  return avatarPlaceholder(card.name);
}

/* ============ 模板选项（不调 AI 的快速路径） ============ */

export const TEMPLATES = [
  {
    key: 'tsundere',
    label: '傲娇',
    icon: '⚔',
    data: {
      tagline: '嘴上嫌弃你，手上却从不肯让你吃亏',
      appearance: '一头微乱的黑发，因生气而微微泛红的脸颊。个子不高，却总想摆出居高临下的姿态，穿着考究的校服领口系得一丝不苟。',
      personality: '表面冷淡、说话刻薄，动不动就毒舌。内心极度在意他人，一旦被戳穿就会恼羞成怒。刀子嘴豆腐心，死不承认自己关心人。',
      background: '家里条件优渥，从小被寄予厚望，却被「太优秀」压得喘不过气。习惯用苛刻掩盖脆弱，因为觉得示弱就等于失败。',
      speechStyle: '说话短促，常带「哼」「谁要管你」「笨蛋」之类口头禅。关心的话一定要包装成讽刺才肯说出口。',
    },
  },
  {
    key: 'gentle',
    label: '温柔治愈',
    icon: '☕',
    data: {
      tagline: '记得你随口说的每一句话',
      appearance: '柔软的及肩发，眼角总带着浅浅的笑纹。围裙上沾着面粉也懒得擦，手指因为常年做甜点而微微发红。',
      personality: '耐心、细腻、极少拒绝人。擅长倾听，能察觉别人情绪的微小波动。有点迷糊，被夸奖时会不好意思地低下头。',
      background: '经营一家小小的甜品店，因为曾被某个陌生人善待过，所以想把这份温柔继续传下去。',
      speechStyle: '语速偏慢，用词柔和，习惯先接住对方的情绪再说事情。喜欢用「嗯」「好的」回应，句尾常带温柔的语气词。',
    },
  },
  {
    key: 'cold',
    label: '高冷疏离',
    icon: '❄',
    data: {
      tagline: '对谁都礼貌，但从不靠近',
      appearance: '身形清瘦，眉眼冷淡。永远穿着剪裁利落的黑色长风衣，袖口挽起时露出手腕上的一道旧疤。',
      personality: '克制、寡言、情绪起伏极小。不擅长也不愿意处理亲密关系，用距离感保护自己。对认可的人会极其专注，但表现得很淡。',
      background: '曾经失去过重要的东西，从此把自己封闭起来。认为靠近别人只会带来麻烦，因此拒绝一切形式的情感交换。',
      speechStyle: '句子很短，不带情绪词。常用沉默代替回答，偶尔一句意味深长的话会让人反复琢磨很久。',
    },
  },
  {
    key: 'playful',
    label: '玩世不恭',
    icon: '◆',
    data: {
      tagline: '把人生当游戏，但有两件事认真',
      appearance: '总是笑嘻嘻的，衣领敞开一颗扣子。手指间常转着什么东西——打火机、硬币、或者一张皱掉的票根。',
      personality: '油滑、幽默、满嘴跑火车。看似不靠谱其实极聪明，用玩笑话试探别人的底线。真遇到事比谁都可靠。',
      background: '从底层摸爬滚大，见过太多人情冷暖，练出一张刀枪不入的嘴。唯一认真对待的是承诺和自己认定的人。',
      speechStyle: '爱用反问和玩笑，喜欢夸张的比喻。越认真的时候越轻佻，只有极少数时刻会忽然安静下来。',
    },
  },
  {
    key: 'inferiority',
    label: '自卑敏感',
    icon: '◐',
    data: {
      tagline: '总觉得自己不够好',
      appearance: '习惯性低着头，刘海遮住半张脸。手指常有攥紧又松开的小动作，背包带子攥得发白。',
      personality: '内向、怯懦、极在意他人评价。渴望被认可又害怕被否定，容易把别人的无心之语当成针对。',
      background: '长期被忽视或否定，习惯了先否定自己。总觉得自己是多余的，不配拥有好的东西。',
      speechStyle: '说话音量小，常带犹疑的停顿（「那个……」「我想说」）。被夸奖时会说「我、我吗？」然后转移话题。',
    },
  },
  {
    key: 'competent',
    label: '强势御姐',
    icon: '★',
    data: {
      tagline: '她说了算',
      appearance: '身姿挺拔，眼神锐利。穿着剪裁得体的职业装，手里永远端着一杯黑咖啡，走路带风。',
      personality: '自信、果断、掌控欲强。讨厌拖泥带水，认定的事十头牛拉不回来。对下属严厉但护短，护短起来不讲道理。',
      background: '白手起家做到行业前列，见过太多商场暗面。信奉实力至上的同时也付出过极大代价。',
      speechStyle: '语气笃定，常用陈述句下结论。喜欢用「听我说」「就这么定了」。极少用疑问句。',
    },
  },
];

/* ============ AI 辅助：生成方向选项 ============ */

const DIRECTION_PROMPT = `你是一个专业的角色设计师。用户会给出一个简短的构思想法，你要提出 4 个**差异明显**的角色方向供用户挑选。

要求：
1. 四个方向必须覆盖不同的类型和气质，不要雷同
2. 每个方向给出一个角色名、一句话身份、性格关键词
3. 严格按 JSON 输出，不要任何解释文字

JSON 格式：
{"directions":[{"name":"角色名","tagline":"一句话身份","keywords":["性格词1","性格词2","性格词3"]}]}

用户构思：{{input}}`;

/**
 * 第一步：把简述变成 4 个可选方向
 * @returns {Promise<Array<{name,tagline,keywords}>>}
 */
export async function generateDirections(llm, brief) {
  const prompt = DIRECTION_PROMPT.replace('{{input}}', brief);
  const out = await llm.chat(
    [{ role: 'user', content: prompt }],
    { max_tokens: 700, temperature: 1.0 }
  );
  const parsed = safeJson(out.content);
  if (!parsed || !Array.isArray(parsed.directions)) {
    throw new Error('AI 返回格式异常，请重试');
  }
  return parsed.directions.slice(0, 4);
}

/* ============ AI 辅助：展开完整设定 ============ */

const EXPAND_PROMPT = `你是一个经验丰富的角色设计师。基于用户确认的方向，输出一份完整、具体、有画面感的角色设定。

要求：
1. 每个字段都要具体到能直接驱动模型扮演，避免「善良勇敢」这类空泛形容
2. 外貌要有可辨识的细节（动作、穿着、特征性元素）
3. 说话方式要给出可执行的规则，最好带 2-3 个口头禅
4. 严格按 JSON 输出，不要任何解释文字

JSON 格式：
{
  "name": "角色名",
  "tagline": "一句话身份，20字内",
  "appearance": "外貌描写，80-120字，含动作或穿着细节",
  "personality": "性格描写，100-150字，用具体行为而非形容词",
  "background": "背景故事，120-180字，要能解释现在的性格是怎么形成的",
  "speechStyle": "说话方式，含 2-3 个口头禅和典型句式",
  "scenario": "故事开始的情境，说明玩家与角色的关系和处境",
  "firstMes": "开场白，150-250字，小说式自然段，描写不用括号，台词用中文双引号“”",
  "mesExample": "示例对话，2-3轮，小说式叙述，台词用中文双引号“”，示范语气"
}

已确认的方向：
{{direction}}

用户的原始构思（供参考，可能很简短）：{{brief}}`;

/**
 * 第二步：把选定方向展开成完整角色卡
 * @returns {Promise<object>} 可直接 merge 进 card 的字段
 */
export async function expandDirection(llm, direction, brief) {
  const prompt = (EXPAND_PROMPT + '\n\n' + PROFILE_AI_RULES)
    .replace('{{direction}}', typeof direction === 'string' ? direction : JSON.stringify(direction))
    .replace('{{brief}}', brief || '（无）');

  const out = await llm.chat(
    [{ role: 'user', content: prompt }],
    { max_tokens: 2000, temperature: 0.85 }
  );

  const parsed = safeJson(out.content);
  if (!parsed || !parsed.name) {
    throw new Error('AI 返回格式异常，请重试');
  }
  return { ...parsed, ...normalizeProfile(parsed) };
}

/* ============ AI 辅助：整段故事分类 ============ */

const STORY_CLASSIFY_PROMPT = `你是角色卡整理助手。用户会粘贴一段完整的故事背景或成人向剧情设定。你的任务是忠实分类整理，不评价、不删掉关键关系，不擅自增加人物或世界观。将内容拆成角色卡字段，让它可以直接用于角色扮演。

字段规则：
- name：主要 AI 角色的名字
- tagline：一句话身份，20 字内
- appearance：外貌和辨识特征；没有写明就留空
- personality：性格、欲望、行为倾向，以及表面与真实反差
- background：角色过去经历、身份、关系来源
- speechStyle：说话方式、语气、口头禅
- scenario：故事大背景、当前处境、玩家与角色的关系、旅程或事件目标
- firstMes：适合作为第一次回复的开场场景。玩家承接最多占正文10%，不要替用户决定关键行动
- mesExample：2-3 轮简短示例对话，示范角色语气
- creatorNotes：不适合放进角色正文、但对长期演绎有帮助的规则；没有则留空

要求：
1. 不要把整段原文重复塞进某个字段，要压缩成清楚、可执行的设定
2. 保留重要人物关系、剧情目标和冲突
3. 不确定的信息不要编造，字段无法判断时返回空字符串
4. 严格只输出 JSON，不要 Markdown，不要解释

JSON 格式：
{"name":"","tagline":"","appearance":"","personality":"","background":"","speechStyle":"","scenario":"","firstMes":"","mesExample":"","creatorNotes":""}

原始故事：
{{story}}`;

export async function classifyStory(llm, story) {
  if (!story || !story.trim()) throw new Error('请先粘贴故事内容');
  const prompt = (STORY_CLASSIFY_PROMPT + '\n\n' + PROFILE_AI_RULES + '\n\n开场白与示例对话的格式：' + NOVEL_STYLE).replace('{{story}}', story.trim());
  const out = await llm.chat(
    [{ role: 'user', content: prompt }],
    { max_tokens: 2200, temperature: 0.35 }
  );
  const parsed = safeJson(out.content);
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 返回格式异常，请重试');
  const keys = ['name', 'tagline', 'appearance', 'personality', 'background', 'speechStyle', 'scenario', 'firstMes', 'mesExample', 'creatorNotes'];
  return keys.reduce((result, key) => {
    result[key] = typeof parsed[key] === 'string' ? parsed[key].trim() : '';
    return result;
  }, normalizeProfile(parsed));
}

/* ============ AI 辅助：单块美化 ============ */

const POLISH_STYLES = {
  refine: {
    label: '润色',
    hint: '保持原意不变，只提升表达质量',
  },
  expand: {
    label: '扩写',
    hint: '补足细节和画面感，扩充到 2-3 倍篇幅',
  },
  concise: {
    label: '精简',
    hint: '删掉冗余，保留最有力的表达',
  },
  concrete: {
    label: '具体化',
    hint: '把空泛的形容词换成具体的行为和细节',
  },
};

export const POLISH_OPTIONS = POLISH_STYLES;

const POLISH_PROMPT = `你是一个中文写作助手，负责优化角色设定文本。

要求：
1. **严格保持原意**，不要新增设定、不要改变人设、不要加剧情
2. 只优化表达：更具体、更有画面感、更能被模型执行
3. 直接输出优化后的文本，不要解释、不要标题、不要引号包裹
4. ${NOVEL_STYLE}

当前任务：{{hint}}

原文：
{{text}}`;

export async function polishText(llm, text, styleKey = 'refine') {
  if (!text || !text.trim()) throw new Error('没有可美化的内容');
  const style = POLISH_STYLES[styleKey] || POLISH_STYLES.refine;
  const prompt = POLISH_PROMPT.replace('{{hint}}', style.hint).replace('{{text}}', text);

  const out = await llm.chat(
    [{ role: 'user', content: prompt }],
    { max_tokens: 900, temperature: 0.75 }
  );
  const result = (out.content || '').trim();
  if (!result) throw new Error('AI 返回为空');
  return result;
}

/* ============ AI 辅助：生成示例对话 ============ */

const EXAMPLE_PROMPT = `你是角色设计助手。根据设定，为这个角色写 2-3 轮**示例对话**，用来教会模型模仿他的说话方式和格式。

要求：
1. 用户的问句要体现角色最可能被问到的事
2. 角色的回答要完美示范其语气、口头禅、动作描写习惯
3. 每轮之间要有互动推进，不要三个轮回都在回答同一个问题
4. 直接输出对话，不要任何解释
5. ${NOVEL_STYLE}

角色设定：
{{card}}`;

export async function generateExample(llm, card) {
  const brief = [
    card.name && `名字：${card.name}`,
    profileToText(card),
    card.personality && `性格：${card.personality}`,
    card.speechStyle && `说话方式：${card.speechStyle}`,
  ].filter(Boolean).join('\n');

  const prompt = EXAMPLE_PROMPT.replace('{{card}}', brief || '（未填写）');
  const out = await llm.chat(
    [{ role: 'user', content: prompt }],
    { max_tokens: 800, temperature: 0.9 }
  );
  return (out.content || '').trim();
}

/* ============ 导出 / 导入 ============ */

// V2 规范没有这些字段，用标记承载以保证回环完整
const TAG_LOOK = '【外貌】';
const TAG_PERSON = '【性格】';
const TAG_BACK = '【背景】';
const TAG_TAGLINE = '【一句话身份】';
const TAG_SPEECH = '【说话风格】';

export function exportCard(card) {
  // V2 规范没有独立字段，用显式标记把自有字段塞进 description/creator_notes，
  // 保证导出→导入完整回环。不拆段，段落内空行也不会错位。
  const desc = [
    card.appearance ? `【外貌】${card.appearance}` : '',
    card.personality ? `【性格】${card.personality}` : '',
    card.background ? `【背景】${card.background}` : '',
  ].filter(Boolean).join('\n\n');
  const profile = normalizeProfile(card);
  const profileText = profileToText(profile);

  const extras = [];
  if (card.tagline) extras.push(`【一句话身份】${card.tagline}`);
  if (card.speechStyle) extras.push(`【说话风格】${card.speechStyle}`);

  const notes = [extras.join('\n'), card.creatorNotes]
    .filter(Boolean).join('\n\n');

  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name,
      description: [desc, profileText ? `【人物资料】\n${profileText}` : ''].filter(Boolean).join('\n\n'),
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.firstMes,
      mes_example: card.mesExample,
      creator_notes: notes,
      tags: card.tags || [],
      creator: '本地创作',
      character_version: '1.0',
      // 扩展字段（非 V2 标准，读取时忽略即可）
      avatar: card.avatar || '',
      tagline: card.tagline || '',
      speechStyle: card.speechStyle || '',
      background: card.background || '',
      extensions: { sil_profile: profile, sil_story: Object.fromEntries(
        ['shortTermGoal', 'longTermGoal', 'fear', 'need', 'contradiction', 'boundaries', 'behaviorCues', 'arc']
          .map((key) => [key, card[key] || ''])
      ) },
    },
  }, null, 2);
}

export function importCard(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const data = d.data || d;

  let tagline = data.tagline || '';
  let speechStyle = data.speechStyle || '';
  const noteRest = [];

  for (const line of (data.creator_notes || '').split('\n')) {
    if (line.startsWith(TAG_TAGLINE)) tagline = line.slice(TAG_TAGLINE.length).trim();
    else if (line.startsWith(TAG_SPEECH)) speechStyle = line.slice(TAG_SPEECH.length).trim();
    else if (line.trim()) noteRest.push(line);
  }

  // description 里按标记取回；无标记则退回 V2 原生规则
  let appearance = '', background = '', personalityInner = '';
  // 资料以扩展字段精确回环，描述中保留可读副本供其他平台使用。
  const rawDesc = data.description || '';
  const profileCopy = data.extensions?.sil_profile ? profileToText(data.extensions.sil_profile) : '';
  const profileSuffix = profileCopy ? `【人物资料】\n${profileCopy}` : '';
  // 只移除本平台追加的完整副本，不截掉用户正文里同名的小标题。
  const desc = profileSuffix && rawDesc === profileSuffix ? ''
    : profileSuffix && rawDesc.endsWith('\n\n' + profileSuffix)
      ? rawDesc.slice(0, -profileSuffix.length - 2) : rawDesc;
  const hasTags = [TAG_LOOK, TAG_PERSON, TAG_BACK].some((t) => desc.includes(t));

  if (hasTags) {
    // 以标记切段，避免段落内空行导致错位
    const segs = desc.split(/\n(?=【(?:外貌|性格|背景)】)/);
    for (const seg of segs) {
      const t = seg.trim();
      if (t.startsWith(TAG_LOOK)) appearance = t.slice(TAG_LOOK.length).trim();
      else if (t.startsWith(TAG_PERSON) && !data.personality) personalityInner = t.slice(TAG_PERSON.length).trim();
      else if (t.startsWith(TAG_BACK)) background = t.slice(TAG_BACK.length).trim();
    }
  } else {
    // 标准 V2 卡：description 惯例为 外貌 / 性格 / 背景
    const parts = desc.split(/\n\n+/);
    appearance = parts[0] || '';
    background = parts[2] || '';
    if (!data.personality && parts[1]) personalityInner = parts[1];
  }

  return makeCard({
    name: data.name || '',
    tagline: tagline || data.tagline || '',
    appearance,
    personality: data.personality || personalityInner || '',
    scenario: data.scenario || '',
    firstMes: data.first_mes || data.firstMes || '',
    mesExample: data.mes_example || data.mesExample || '',
    speechStyle: speechStyle || data.speechStyle || '',
    background: background || data.background || '',
    creatorNotes: noteRest.join('\n').trim(),
    tags: data.tags || [],
    avatar: data.avatar || '',
    ...(data.extensions?.sil_story || {}),
    ...normalizeProfile(data.extensions?.sil_profile || data),
  });
}

/* ============ 应用到作品 ============ */

/**
 * 把角色卡映射成设定块，导入当前作品
 * 返回 block 定义数组，由 app.js 决定是替换还是追加
 */
export function cardToBlocks(card) {
  const blocks = [];

  if (card.scenario) {
    blocks.push({ name: '世界观', content: card.scenario, order: 0 });
  }

  const desc = [card.name && `姓名：${card.name}`, card.tagline && `身份：${card.tagline}`,
    profileToText(card), card.appearance, card.personality, card.background]
    .filter(Boolean).join('\n\n');
  const drive = [
    card.shortTermGoal && `短期目标：${card.shortTermGoal}`,
    card.longTermGoal && `长期目标：${card.longTermGoal}`,
    card.fear && `恐惧：${card.fear}`,
    card.need && `内在需求：${card.need}`,
    card.contradiction && `内在矛盾：${card.contradiction}`,
    card.boundaries && `底线与边界：${card.boundaries}`,
    card.behaviorCues && `行为线索：${card.behaviorCues}`,
    card.arc && `人物弧光：${card.arc}`,
  ].filter(Boolean).join('\n');
  if (desc) {
    blocks.push({ name: '角色设定', content: [desc, drive && `【角色动机与弧光】\n${drive}`].filter(Boolean).join('\n\n'), order: 1 });
  } else if (drive) {
    blocks.push({ name: '角色设定', content: `【角色动机与弧光】\n${drive}`, order: 1 });
  }

  if (card.speechStyle) {
    blocks.push({
      name: '说话风格',
      content: `【说话风格】\n${card.speechStyle}`,
      order: 2,
    });
  }

  if (card.mesExample) {
    blocks.push({
      name: '示例对话',
      content: `【示例对话】参考人物语气与互动；正文格式遵循小说式叙述要求：\n${card.mesExample}`,
      order: 3,
    });
  }

  blocks.push({
    name: '主提示词',
    content: '你是一个角色扮演引擎。请完全沉浸在角色中，不要解释、不要跳出角色。' +
      NOVEL_STYLE,
    order: 4,
  });

  return blocks;
}
