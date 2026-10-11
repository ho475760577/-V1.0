/** 新作品引导界面。草稿独立保存，确认创建之前不改动当前作品。 */
import { STORY_STEPS, STORY_CARD_FIELDS, STORY_PERSONA_FIELDS, STORY_SUPPORT_FIELDS,
  storyAnswers, askStoryQuestion, generateStoryDraft, normalizeStoryDraft, buildStoryBundle } from './story-creator.js';
import { PROFILE_FIELDS, GENDERS } from './profile.js';
import { escapeHtml } from './render.js';
import * as store from './store.js';

const esc = (value) => escapeHtml(value ?? '').replace(/"/g, '&quot;');
const labels = { name: '名字', tagline: '一句话身份', identity: '我的身份与关系', appearance: '外貌',
  personality: '性格', background: '经历与背景', speechStyle: '说话方式', gender: '性别',
  genderCustom: '自定义性别说明', pronoun: '叙述代词', relationship: '人物关系',
  ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f.label])) };
const fresh = () => ({ version: 1, index: 0, phase: 'questions', answers: {}, questions: {}, draft: null });

export function openStoryCreator({ llm, onBlank, onCreated }) {
  const dialog = document.getElementById('storyCreator');
  const body = document.getElementById('storyCreatorBody');
  if (!dialog || !body) return;
  if (dialog.open) { dialog.focus(); return; }
  const restored = store.loadCreationDraft();
  let state = restored?.version === 1 ? { ...fresh(), ...restored } : fresh();
  state.index = Math.max(0, Math.min(STORY_STEPS.length - 1, Math.floor(Number(state.index) || 0)));
  state.answers = storyAnswers(state.answers && typeof state.answers === 'object' ? state.answers : {});
  const savedQuestions = state.questions;
  state.questions = {};
  for (const step of STORY_STEPS) {
    const q = savedQuestions?.[step.key];
    if (typeof q?.question !== 'string' || !q.question.trim()) continue;
    const options = Array.isArray(q.options) ? q.options.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : [];
    state.questions[step.key] = { question: q.question.slice(0, 350), options: options.length ? options.map((x) => x.slice(0, 180)) : step.options };
  }
  state.draft = state.draft ? normalizeStoryDraft(state.draft) : null;
  if (state.phase !== 'preview' || !state.draft) state.phase = 'questions';
  let busy = false, status = '', error = false, requestId = 0, created = false;

  const save = () => store.saveCreationDraft(state);
  const close = () => {
    requestId++;
    if (!created) save();
    dialog.close();
  };
  dialog.oncancel = (event) => { event.preventDefault(); close(); };
  const field = (path, label, value, rows = 2, type = '') => {
    const disabled = busy ? 'disabled' : '';
    let control;
    if (type === 'gender' || type === 'pronoun') {
      const options = type === 'gender' ? GENDERS : ['', '他', '她', 'TA'].map((v) => ({ value: v, label: v || '自动' }));
      control = `<select data-draft-path="${path}" ${disabled}>${options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
    } else control = rows === 1 ? `<input data-draft-path="${path}" value="${esc(value)}" ${disabled}>`
      : `<textarea data-draft-path="${path}" rows="${rows}" ${disabled}>${escapeHtml(value ?? '')}</textarea>`;
    return `<label class="creator-field"><span>${label}</span>${control}</label>`;
  };
  const personFields = (prefix, person, keys) => keys.map((key) => field(`${prefix}.${key}`, key === 'identity' && prefix !== 'persona' ? '身份' : labels[key] || key,
    person[key] || '', ['name', 'tagline', 'age', 'height', 'genderCustom'].includes(key) ? 1 : 2,
    ['gender', 'pronoun'].includes(key) ? key : '')).join('');
  const personSection = (prefix, title, person, keys) => {
    const primary = ['name', prefix === 'character' ? 'tagline' : 'identity', 'gender', 'age', 'personality', 'appearance', 'background'];
    return `<details class="creator-section"><summary>${title} · ${escapeHtml(person.name || '未命名')}</summary>
      <div class="creator-fields">${personFields(prefix, person, primary)}
        <details><summary>更多人物细节（体型、穿着、能力等）</summary>${personFields(prefix, person, keys.filter((key) => !primary.includes(key)))}</details>
      </div></details>`;
  };

  function preview() {
    const d = state.draft;
    return `<p class="creator-intro">这是可修改的初稿。确认后会创建新的作品、主要角色卡和“我的身份”；配角放入本作品世界书。</p>
      <div class="creator-grid">${field('title', '作品名称', d.title, 1)}${field('tone', '氛围与节奏', d.tone, 1)}</div>
      <details class="creator-section" open><summary>故事与世界</summary><div class="creator-fields">
        ${field('premise', '故事概述与人物关系', d.premise, 3)}${field('world', '世界背景与架构', d.world, 4)}
        <div class="creator-grid">${field('scene.time', '开场时间', d.scene.time, 1)}${field('scene.world', '世界名称', d.scene.world, 1)}${field('scene.location', '开场地点', d.scene.location, 1)}</div>
      </div></details>
      ${personSection('character', '主要互动人物', d.character, STORY_CARD_FIELDS)}
      ${personSection('persona', '我是谁', d.persona, STORY_PERSONA_FIELDS)}
      ${d.supportingCharacters.map((person, i) => `<details class="creator-section"><summary>配角 · ${escapeHtml(person.name)}</summary><div class="creator-fields">${personFields(`supportingCharacters.${i}`, person, STORY_SUPPORT_FIELDS)}<button type="button" class="mini-btn" data-remove-support="${i}" ${busy ? 'disabled' : ''}>移除此配角</button></div></details>`).join('')}
      ${d.worldbook.length ? `<details class="creator-section"><summary>世界书 · ${d.worldbook.length} 条</summary><div class="creator-fields">${d.worldbook.map((entry, i) => `<div class="creator-lore">${field(`worldbook.${i}.name`, '条目名称', entry.name, 1)}${field(`worldbook.${i}.keys`, '触发关键词（逗号分隔）', entry.keys.join('，'), 1)}${field(`worldbook.${i}.content`, '设定内容', entry.content, 3)}</div>`).join('')}</div></details>` : ''}
      <details class="creator-section" open><summary>开场白</summary><div class="creator-fields">${field('opening', '开场正文', d.opening, 5)}</div></details>
      <div class="creator-options">
        <label><input type="checkbox" data-draft-toggle="memoryEnabled" ${d.memoryEnabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>启用摘要记忆</label>
        <label><input type="checkbox" data-draft-toggle="choicesEnabled" ${d.choicesEnabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>每次回复提供 4 个行动建议</label>
      </div>`;
  }

  function question() {
    const step = STORY_STEPS[state.index];
    const q = state.questions[step.key] || step;
    return `<div class="creator-progress" aria-label="创作进度">${STORY_STEPS.map((s, i) => `<span class="${i === state.index ? 'on' : ''}">${i + 1}. ${s.label}</span>`).join('')}</div>
      <p class="creator-question">${escapeHtml(q.question || step.question)}</p>
      <div class="creator-suggestions">${(q.options || step.options).slice(0, 3).map((option, i) => `<button type="button" class="mini-btn" data-suggestion="${i}" ${busy ? 'disabled' : ''}>${escapeHtml(option)}</button>`).join('')}</div>
      <label class="creator-field"><span>你的想法</span><textarea id="creatorAnswer" rows="5" maxlength="1500" placeholder="自由描述即可，不需要整理成角色卡。还没想好的部分可以交给 AI。" ${busy ? 'disabled' : ''}>${escapeHtml(state.answers[step.key] || '')}</textarea></label>
      <p class="creator-note">共 5 步，也可以只写一个想法，直接生成草稿。AI 生成前不会创建作品；关闭后可继续填写。</p>`;
  }

  function render() {
    const isPreview = state.phase === 'preview';
    body.innerHTML = `<header class="creator-head"><div><span class="mini">AI 创作向导</span><h2 id="storyCreatorTitle">${isPreview ? '检查作品草稿' : '新建作品'}</h2></div><button type="button" class="mini-btn" data-creator-action="close" aria-label="暂存并关闭">×</button></header>
      <div class="creator-scroll">${isPreview ? preview() : question()}</div>
      <footer class="creator-footer">
        <div class="creator-status ${error ? 'bad' : ''}" role="status" aria-live="polite">${escapeHtml(status)}</div>
        <div class="creator-actions">${isPreview
          ? `<button class="mini-btn" data-creator-action="questions" ${busy ? 'disabled' : ''}>返回问答</button><button class="mini-btn" data-creator-action="generate" ${busy ? 'disabled' : ''}>重新生成草稿</button><button class="mini-btn primary" data-creator-action="create" ${busy ? 'disabled' : ''}>确认创建作品</button>`
          : `<button class="mini-btn" data-creator-action="back" ${busy || state.index === 0 ? 'disabled' : ''}>上一步</button><button class="mini-btn" data-creator-action="skip" ${busy ? 'disabled' : ''}>这一步交给 AI</button><button class="mini-btn primary" data-creator-action="next" ${busy ? 'disabled' : ''}>${state.index === STORY_STEPS.length - 1 ? '生成作品草稿' : '回答，继续下一步'}</button><button class="mini-btn" data-creator-action="generate" ${busy ? 'disabled' : ''}>直接生成草稿</button>`}</div>
        <div class="creator-actions secondary"><button class="mini-btn" data-creator-action="blank" ${busy ? 'disabled' : ''}>直接创建空白作品</button><button class="mini-btn" data-creator-action="reset" ${busy ? 'disabled' : ''}>清空草稿重新填写</button><span>可先建大概，再到各面板细化</span></div>
      </footer>`;
    body.querySelectorAll('[data-creator-action]').forEach((button) => { button.onclick = () => action(button.dataset.creatorAction); });
    const input = body.querySelector('#creatorAnswer');
    if (input) input.oninput = () => { state.answers[STORY_STEPS[state.index].key] = input.value; save(); };
    body.querySelectorAll('[data-suggestion]').forEach((button) => {
      button.onclick = () => {
        const step = STORY_STEPS[state.index], q = state.questions[step.key] || step;
        input.value = q.options[Number(button.dataset.suggestion)]; input.oninput(); input.focus();
      };
    });
    // 路径仅来自当前渲染的白名单字段，不接受模型提供的属性路径。
    body.querySelectorAll('[data-draft-path]').forEach((input) => {
      const update = () => {
        const parts = input.dataset.draftPath.split('.');
        let target = state.draft;
        for (const key of parts.slice(0, -1)) target = target[key];
        const key = parts.at(-1);
        target[key] = key === 'keys' ? input.value.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean) : input.value;
        if (key === 'gender') {
          target.pronoun = '';
          const pronoun = body.querySelector(`[data-draft-path="${parts.slice(0, -1).join('.')}.pronoun"]`);
          if (pronoun) pronoun.value = '';
        }
        save();
      };
      input[input.tagName === 'SELECT' ? 'onchange' : 'oninput'] = update;
    });
    body.querySelectorAll('[data-draft-toggle]').forEach((input) => {
      input.onchange = () => { state.draft[input.dataset.draftToggle] = input.checked; save(); };
    });
    body.querySelectorAll('[data-remove-support]').forEach((button) => {
      button.onclick = () => { state.draft.supportingCharacters.splice(Number(button.dataset.removeSupport), 1); save(); render(); };
    });
  }

  async function run(task, apply, busyText) {
    if (busy) return;
    busy = true; error = false; status = busyText;
    const token = ++requestId;
    save(); render();
    try {
      const result = await task();
      if (token !== requestId || !dialog.open) return;
      apply(result); save();
    } catch (err) {
      if (token !== requestId || !dialog.open) return;
      error = true; status = '暂未完成：' + err.message + ' 你的回答和已有草稿仍保留，可重试。';
    } finally {
      if (token === requestId && dialog.open) { busy = false; render(); }
    }
  }

  async function advance(skip = false) {
    if (busy) return;
    const step = STORY_STEPS[state.index];
    if (skip) state.answers[step.key] = '交给 AI 合理设计';
    if (!state.answers[step.key]?.trim()) { error = true; status = '写一句想法，或者点击“这一步交给 AI”。'; render(); return; }
    if (state.index === STORY_STEPS.length - 1) return generate();
    state.index++;
    await run(async () => {
      try { return { question: await askStoryQuestion(llm, state.index, state.answers) }; }
      catch { return { question: STORY_STEPS[state.index], fallback: true }; }
    }, ({ question, fallback }) => {
      state.questions[STORY_STEPS[state.index].key] = question;
      status = fallback ? 'AI 提问暂不可用，已使用引导问题，你可以继续填写。' : '';
    }, 'AI 正在根据你的回答准备下一问…');
  }

  async function generate() {
    await run(() => generateStoryDraft(llm, state.answers), (draft) => {
      state.draft = draft; state.phase = 'preview'; status = '草稿已生成。展开人物和世界书可修改，确认后再创建作品。';
    }, 'AI 正在整理故事、人物和开场白，可能需要几十秒…');
  }

  async function action(name) {
    if (name === 'close') { close(); return; }
    if (busy || created) return;
    if (name === 'next') return advance();
    if (name === 'skip') return advance(true);
    if (name === 'generate') return generate();
    if (name === 'back') { state.index = Math.max(0, state.index - 1); status = ''; error = false; save(); render(); }
    if (name === 'questions') { state.phase = 'questions'; status = ''; error = false; save(); render(); }
    if (name === 'reset') { state = fresh(); status = ''; error = false; save(); render(); }
    if (name === 'blank') { close(); onBlank(); }
    if (name === 'create') {
      busy = true; error = false;
      let bundle;
      try {
        bundle = buildStoryBundle(state.draft);
        store.saveStoryBundle(bundle);
        created = true;
      } catch (err) { busy = false; error = true; status = err.message; render(); return; }
      // 存储提交成功才结束草稿；页面切换不再重复写入新作品。
      try { store.clearCreationDraft(); } catch { /* 新作品已保存，继续打开。 */ }
      close();
      onCreated(bundle);
    }
  }

  render();
  dialog.showModal();
}
