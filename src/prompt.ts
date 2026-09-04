import type { Config } from './config'

/**
 * Build the system-prompt section that teaches the main model when to call
 * ask_advisors. Keep it concise: it is injected into every model step.
 */
export function buildAdvisorPrompt(
  config: Config,
  repeatPressure?: { count: number; text?: string },
): string {
  if (!config.enabled || config.advisors.length === 0) return ''

  const advisorNames = config.advisors
    .slice(0, 3)
    .map((advisor) => advisor.name)
    .join('、')

  const lines = [
    '## 顾问群使用边界',
    '你可以调用 ask_advisors 向专家顾问请教。请遵守以下边界：',
    '',
    '1. 优先调用 ask_advisors 的情况：',
    '   - 专业/长尾世界知识：法律、医疗、金融、税务、行业经验、复杂理论等；',
    '   - 高风险判断：医疗建议、法律承诺、投资决策、安全漏洞评估等；',
    '   - 你对自己的答案没有把握（confidence 低于阈值）；',
    '   - 需要多个视角或资深经验才能给出可靠结论；',
    '   - 用户消息中明确 @顾问群、点名“顾问群/顾问模型”，或要求专家会诊：必须立即调用，不要跳过。',
    '2. 不要调用 ask_advisors 的情况：',
    '   - 可以直接联网查证的事实：新闻、价格、天气、API 文档、版本号等；',
    '   - 简单常识、日常闲聊、纯创意；',
    '   - 用户明确要求快速回答、不需要专家讨论。',
    '3. 如果前置分类器建议先联网搜索，请先执行 web search；只有搜索无法解决或属于专业/高风险时再调用 ask_advisors。',
    '4. 当你对自己没有把握时：先自评一个 0-1 的 confidence，并在调用 ask_advisors 时传入 confidence 字段，例如 confidence: 0.4。',
    '5. 调用 ask_advisors 时，context 参数必须包含两部分背景信息：',
    '   a) 当前项目的大致情况（领域/目标/技术栈/关键约束，一到三句话概括）；',
    '   b) 遇到问题的具体细节（做了什么、期望什么、实际发生了什么、已尝试哪些步骤、相关报错或现象）。',
    '   如果某项信息确实未知，明确写“该项背景未知”，不要留空 context，也不要让顾问在缺少背景的情况下猜测。',
    '6. 拿到顾问结论后：自行判断、综合并执行，不要原样复制整段顾问回复。',
    '7. 发起新咨询：插件会自动进行多轮深挖（默认 autoDeepen：每轮结束由驱动模型基于全部讨论生成更深入的追问，顾问按顺序 A→B→C 接力回答，直到 maxRounds 轮），并自动产出综合结论——你无需再手动 followUp；只有想追加一轮固定主题时才传 sessionId+followUp。',
  ]

  if (repeatPressure && repeatPressure.count >= 3) {
    lines.push(
      '',
      `【强制升级】当前会话中同一问题已被用户重复 ${repeatPressure.count} 次仍未解决。你必须立即调用 ask_advisors，把用户最新一次的问题原样作为 question 传入，并在 context 中补充项目概况与已尝试步骤；不得再让用户重复或自行空转。`,
    )
  } else if (repeatPressure && repeatPressure.count > 1) {
    lines.push(
      '',
      `【提醒】当前会话中同一问题已出现 ${repeatPressure.count} 次。若本轮仍无法解决，必须调用 ask_advisors 升级到顾问群。`,
    )
  }

  lines.push(`当前可用的顾问：${advisorNames}（完整列表见设置页）。`)
  return lines.join('\n')
}