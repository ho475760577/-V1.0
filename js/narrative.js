/** 正文的统一写作格式；状态与记忆标签仍交给原有解析器。 */
export const NOVEL_STYLE = '像小说一样用自然段叙述动作、神态、环境与心理，不用括号或星号包裹描写。人物说话使用中文双引号“”，不要用「」或『』标记台词；通过说话人的名字和动作自然区分人物。不要输出用于着色的 HTML。';

/** 只更新旧版内置指令，不改历史正文或用户自写的人物资料。 */
export function migrateNarrativeInstructions(content) {
  return String(content || '')
    .replace(/用「」包裹台词，用（）包裹动作(?:与神态描写|、神态、心理描写)[。]?/g, NOVEL_STYLE)
    .replace('用「」包裹。要有来有回，不要一个人说 monologue', '台词使用中文双引号“”。要有来有回，尊重玩家自行决定言行。');
}
