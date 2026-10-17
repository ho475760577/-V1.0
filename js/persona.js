/**
 * 玩家身份（Persona）—— 对标 SillyTavern 的 User Persona
 *
 * 这是「我」是谁的设定。与角色卡（对方是谁）相对。
 * 注入到 system 消息中，让模型知道它在跟什么样的人说话。
 */
import { normalizeProfile, profileToText } from './profile.js';

export function makePersona(overrides = {}) {
  return {
    id: 'p' + Math.random().toString(36).slice(2, 10),
    name: '',          // 玩家名字，替换提示词里的 {{user}}
    identity: '',      // 身份：我是谁、和对方是什么关系
    personality: '',   // 我的性格（影响对方如何对我）
    note: '',          // 给自己看的备注，不进提示词
    avatar: '',        // dataURL
    appearance: '',    // 我的外貌
    background: '',    // 经历与背景
    ...overrides,
    ...normalizeProfile(overrides),
  };
}

/** 把 Persona 转成注入 system 的文本块 */
export function personaToBlock(persona) {
  if (!persona) return null;

  const parts = [];

  if (persona.name) {
    parts.push(`{{user}} 的名字是「${persona.name}」。`);
  }
  const profile = profileToText(persona);
  if (profile) parts.push(profile);
  if (persona.appearance) parts.push(`外貌：${persona.appearance}`);
  if (persona.background) parts.push(`背景：${persona.background}`);

  if (persona.identity) {
    parts.push(`身份：${persona.identity}`);
  }

  if (persona.personality) {
    parts.push(`性格：${persona.personality}`);
  }

  if (!parts.length) return null;

  return `【玩家身份】\n${parts.join('\n')}\n\n请始终以 {{user}} 的上述身份作为互动对象。可以在正文中用不超过10%的篇幅承接玩家已经明确的言行，但不要替 {{user}} 决定关键行动、立场或目标。`;
}

/** 身份预设 */
export const PERSONA_PRESETS = [
  {
    key: 'self',
    label: '我自己',
    icon: '☺',
    data: {
      identity: '一个普通的年轻人，没有特殊背景。',
      personality: '真实、有自己的判断，不盲目顺从。',
    },
  },
  {
    key: 'newcomer',
    label: '初来乍到',
    icon: '🌱',
    data: {
      identity: '刚来到这个城市的新人，对一切都不熟悉，没有根基。',
      personality: '谨慎、好奇、愿意倾听，但会怀疑不合理的说法。',
    },
  },
  {
    key: 'insider',
    label: '圈内人',
    icon: '🎯',
    data: {
      identity: '已经在圈子里混了很久的老手，人脉广，知道不少内幕。',
      personality: '老练、圆滑，说话留半句，不会轻易交底。',
    },
  },
  {
    key: 'outsider',
    label: '外来者',
    icon: '🌍',
    data: {
      identity: '来自完全不同背景的人，带��与这里格格不入的视角。',
      personality: '直接、不懂人情世故，但也因此能看穿本地人忽略的真相。',
    },
  },
  {
    key: 'student',
    label: '学生',
    icon: '📚',
    data: {
      identity: '还在读书的年轻人，涉世未深。',
      personality: '好奇、理想主义，对黑暗的现实既恐惧又好奇。',
    },
  },
  {
    key: 'nobody',
    label: '无名者',
    icon: '👤',
    data: {
      identity: '没有身份证明，没有人脉，被这个世界当作不存在的人。',
      personality: '沉默、警觉，只在必要时候开口。',
    },
  },
];

/* ============ 头像处理 ============ */

/**
 * 把图片文件压缩成正方形 dataURL
 * @param {File} file
 * @param {number} size 输出边长
 * @param {number} quality JPEG 质量
 * @returns {Promise<string>} dataURL
 */
export function compressImage(file, size = 256, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // 正方形居中裁剪
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;

        ctx.fillStyle = '#1e1e22';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 无头像时的占位图：取名字首字 + 稳定色相 */
export function avatarPlaceholder(name) {
  const ch = (name || '?').trim().charAt(0) || '?';
  let hash = 0;
  for (const c of (name || '?')) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  const hue = Math.abs(hash) % 360;
  return {
    text: ch,
    color: `hsl(${hue}, 45%, 42%)`,
  };
}
