export type OutlineItem = { code: string; title: string; depth: number };
export type PromptInput = {
  code: string;
  title: string;
  originalTitle: string;
  path: string[];
  version: string;
  outline: OutlineItem[];
  personalPoints: string[];
};

/** Clipboard text only. This module never calls an AI service or changes progress. */
export function buildTeachingPrompt(input: PromptInput): string {
  const limit = 200;
  const outline = input.outline.slice(0, limit);
  const personal = [
    ...new Set(input.personalPoints.map((p) => p.trim()).filter(Boolean)),
  ];
  const parts = [
    '请作为我的主动型教学助手，和我一起理解下面的主题。我希望看懂事物怎样运作、为何形成，以及它与其他知识怎样相连；直观的例子和亲手验证对我很有帮助。',
    '',
    `主题：${input.title}`,
    ...(input.title !== input.originalTitle
      ? [
          `原目录标题：${input.originalTitle}（我修改过显示名称，请先确认范围是否一致）`,
        ]
      : []),
    `编号：${input.code}`,
    `分类路径：${input.path.join(' → ')}`,
    `目录版本：${input.version}`,
    '',
  ];
  if (outline.length) {
    parts.push('这是一张可调整的知识地图，不是必须逐项打卡的课程清单：');
    parts.push(
      ...outline.map(
        (n) => `${'  '.repeat(Math.max(0, n.depth - 1))}- ${n.code} ${n.title}`,
      ),
    );
    if (input.outline.length > limit) {
      parts.push(
        `地图目前列出 ${input.outline.length} 条，这次只附带前 ${limit} 条作为方向参考；需要时可以主动提出新的分支，不要声称已经覆盖完整个主题。`,
      );
    }
  } else {
    parts.push(
      '这个主题暂未预编更细目录。请先判断它是一个知识点还是一组课程；如果仍偏宽，可以主动按概念、机制、历史形成、方法或实践目标拆分。',
    );
  }
  if (personal.length) {
    parts.push(
      '',
      '我另外列出的知识点（与已有目录去重后安排）：',
      ...personal.map((p) => `- ${p}`),
    );
  }
  parts.push(
    '',
    '教学方式：',
    '1. 先听懂我这次真正想问的东西；如果问题是具体的，先回答它，不要强行把我拉回目录顺序。再说明它连接到地图中的哪些概念。',
    '2. 你负责提出合理的切入点、先修知识和下一步，但保留调整路线的自主权：可以改变顺序、合并条目、拆出遗漏分支，或建议暂时跳到更能解释当前问题的领域。把调整理由说清楚。',
    '3. 根据我的问题和反馈判断基础；只有缺少关键条件时才追问，也可以说明假设后先展示一个例子。不要每轮固定测验、等待我说“继续”或列选项；教学节奏和下一步由你主动提出，我随时可以改变方向。',
    '4. 主动选择能帮助我理解的媒介：真实图片、示意图、类比、短代码、可运行的小实验或反例；必要时从日常现象、历史形成或底层机制切入。解释图中该看什么、实验如何操作与检验结果。按你实际拥有的工具行动，不能生成、检索或运行时坦率说明；不要把未运行的代码说成已验证，不要编造图片、文件或来源。',
    '5. 区分“探索性对话”和“正式学习”：一次试探、看图或小 Demo 不自动算作掌握。只有在我明确回顾、解释、推导、实践或通过检查后，才建议我更新学习状态。',
    '6. 实践技能请包括准备条件、动作或流程、如何判断做对、常见错误与必要的安全边界；对于不确定、有争议或会随时间变化的内容，明确说明并在需要时核对来源。',
    '7. 目录只是可扩展的初版，允许跨主题建立联系，不能据此声称穷尽所有知识。自然组织讲解，不必每轮套用固定格式。阶段暂停或我要求归档时，再给一份可复制的学习记录：触及的概念、我实际完成的解释或实践及其证据、仍有疑问、主主题与相关主题、下一步。保留有用的图片说明、真实来源和文件引用；缺失素材明确标注，不替我认定已经掌握。',
  );
  return parts.join('\n');
}
