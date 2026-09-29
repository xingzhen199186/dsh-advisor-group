import { DEFAULT_ADVISOR_PROMPT } from './defaults'
import type { Config as ConfigShape } from './config'

const REPLACEMENT = '\uFFFD'
const BOM = '\uFEFF'

export type PromptGuardAction = 'ok' | 'healed' | 'stripped' | 'needs-manual'

export interface PromptGuardResult {
  action: PromptGuardAction
  value: string
  reason?: string
}

export interface PromptGuardFinding {
  advisorId: string
  action: Exclude<PromptGuardAction, 'ok'>
  reason: string
}

/**
 * Unambiguity check: same line count, and every character either equals the
 * template or is a replacement char (the byte-loss corruption signature).
 */
function matchesTemplateWithReplacement(storedLines: string[], templateLines: string[]): boolean {
  for (let i = 0; i < storedLines.length; i++) {
    const stored = storedLines[i]
    const template = templateLines[i]
    if (stored === template) continue
    if (stored.length !== template.length) return false
    for (let j = 0; j < stored.length; j++) {
      if (stored[j] !== template[j] && stored[j] !== REPLACEMENT) return false
    }
  }
  return true
}

/**
 * Advisor system-prompt corruption guard (P1, 2026-09-27).
 * Fast path is free: prompts without replacement chars pass through
 * untouched (a customized prompt is legitimate and must never be overwritten).
 * A leading BOM alone is stripped (action 'stripped', no template involved).
 * Only on a replacement char do we compare against the built-in template:
 * unambiguous (line count + per-character match) -> heal to the template;
 * anything else keeps the stored value and reports it for manual handling.
 */
export function healAdvisorSystemPrompt(
  stored: string,
  template: string = DEFAULT_ADVISOR_PROMPT,
): PromptGuardResult {
  let value = stored
  let hadBom = false
  if (value.startsWith(BOM)) {
    value = value.slice(BOM.length)
    hadBom = true
  }
  const replacements = (value.match(/\uFFFD/g) ?? []).length
  if (replacements === 0) {
    if (hadBom) return { action: 'stripped', value, reason: '开头含 BOM，已剥除' }
    return { action: 'ok', value: stored }
  }
  const storedLines = value.split('\n')
  const templateLines = template.split('\n')
  if (storedLines.length !== templateLines.length) {
    return {
      action: 'needs-manual',
      value: stored,
      reason: `含 ${replacements} 个替换符，行数 ${storedLines.length} 与模板 ${templateLines.length} 不一致，无法无歧义回填`,
    }
  }
  if (!matchesTemplateWithReplacement(storedLines, templateLines)) {
    return {
      action: 'needs-manual',
      value: stored,
      reason: `含 ${replacements} 个替换符，但与模板逐位比对存在不一致（可能含自定义内容），未回填`,
    }
  }
  return {
    action: 'healed',
    value: template,
    reason: `含 ${replacements} 个替换符${hadBom ? '，另开头含 BOM' : ''}，行数与逐位比对均与模板一致，已回填内置模板`,
  }
}

/**
 * Load-time guard over every advisor prompt. Returns the original config
 * object untouched when nothing was healed, so callers can rely on identity
 * checks to detect "no change".
 */
export function guardAdvisorPrompts(config: ConfigShape): {
  config: ConfigShape
  findings: PromptGuardFinding[]
} {
  const findings: PromptGuardFinding[] = []
  let healedAny = false
  const advisors = config.advisors.map((advisor) => {
    const result = healAdvisorSystemPrompt(advisor.systemPrompt)
    if (result.action === 'ok') return advisor
    findings.push({ advisorId: advisor.id, action: result.action, reason: result.reason ?? '' })
    if (result.action === 'healed' || result.action === 'stripped') {
      healedAny = true
      return { ...advisor, systemPrompt: result.value }
    }
    return advisor
  })
  return { config: healedAny ? { ...config, advisors } : config, findings }
}

/**
 * Shared logger for both call sites: one line per finding, stating the action
 * actually taken (healed vs left untouched) plus the concrete reason.
 * Every line carries an ISO-8601 timestamp so the host console redirect
 * (which does not timestamp lines itself) stays forensically usable.
 */
export function reportPromptGuardFindings(findings: PromptGuardFinding[]): void {
  const stamp = () => `[${new Date().toISOString()}]`
  for (const finding of findings) {
    if (finding.action === 'healed') {
      console.warn(
        `${stamp()} [dsh-advisor-group] 顾问提示词损坏，已按内置模板回填：${finding.advisorId}（${finding.reason}）`,
      )
    } else if (finding.action === 'stripped') {
      console.warn(
        `${stamp()} [dsh-advisor-group] 顾问提示词开头含 BOM，已剥除、正文未改动：${finding.advisorId}（${finding.reason}）`,
      )
    } else {
      console.warn(
        `${stamp()} [dsh-advisor-group] 顾问提示词损坏且无法无歧义回填，未改动、需人工处理：${finding.advisorId}（${finding.reason}）`,
      )
    }
  }
}
