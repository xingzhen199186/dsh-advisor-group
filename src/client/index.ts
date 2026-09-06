/**
 * dsh-advisor-group browser half.
 *
 * Renders a durable advisor-group consultation as a retro CRT chat-group card
 * in the DSH web conversation flow. The node is assembled from the durable
 * session events:
 *
 *   advisor-group/start   -> start
 *   advisor-group/message -> update (live bubbles)
 *   advisor-group/end     -> update (final synopsis)
 */
import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationStepDataMap,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatNodeDataMap,
  ChatNodeViewProps,
} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: activates the `settings.plugin.item` keyed slot declaration
// contributed by the settings-plugins package (cross-collaboration goes
// through cordis services; value imports fail the client bundle-purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: activates the `slots` Cordis service declaration (provided at
// runtime by the UI renderer package).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  AdvisorGroupAdvisorInfo,
  AdvisorGroupEndData,
  AdvisorGroupMessageData,
  AdvisorGroupStartData,
} from '../session-events'
import { renderMarkdown } from './markdown'
import type { AdvisorConfig as AdvisorConfigShape, Config as AdvisorGroupConfig } from '../config'
import { DEFAULT_ADVISOR_PROMPT } from '../defaults'

function advisorGroupToken(): string {
  return (globalThis as { __ADVISOR_GROUP_TOKEN__?: string }).__ADVISOR_GROUP_TOKEN__ ?? ''
}

function authHeaders(): Record<string, string> {
  const token = advisorGroupToken()
  return token ? { 'x-advisor-group-token': token } : {}
}

/**
 * Browser-side twin of `sanitizeAdvisorContent` (host module cannot be
 * imported by the client bundle). The SSE live overlay streams the RAW model
 * output, whose length usually EXCEEDS the sanitized durable message — so the
 * merge below must sanitize whichever content it picks or the raw tool-call
 * markup would keep rendering until the overlay is gone.
 */
const CLIENT_RAW_TOOL_CALL_BLOCK = /<(?:[｜|]{1,2})?(?:tool_calls|DSML)[\s\S]*?<\/(?:[｜|]{1,2})?(?:tool_calls|DSML)\s*>/g
const CLIENT_RAW_TOOL_CALL_TAIL =
  /<(?:[｜|]{1,2})?(?:tool_calls|DSML)[\s\S]{0,60}?(?:<invoke|<parameter|<[｜|]{1,2}DSML)[\s\S]*$/g
const CLIENT_EMPTY_BODY_NOTICE =
  '（顾问未生成正文：输出仅为工具调用描述，请参考其思维链与工具调用记录。）'

export function sanitizeClientContent(content: string): string {
  if (!content.trim()) return content
  const cleaned = content
    .replace(CLIENT_RAW_TOOL_CALL_BLOCK, '')
    .replace(CLIENT_RAW_TOOL_CALL_TAIL, '')
    .trim()
  return cleaned || CLIENT_EMPTY_BODY_NOTICE
}

export interface AdvisorGroupState {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly question: string
  readonly context?: string
  readonly advisors: readonly AdvisorGroupAdvisorInfo[]
  readonly messages: readonly AdvisorGroupMessageData[]
  readonly status: 'running' | 'completed' | 'cancelled'
  readonly summary?: AdvisorGroupEndData['summary']
}

interface AdvisorGroupChatData {
  readonly sessionId: string
  readonly status: 'running' | 'completed' | 'cancelled'
  readonly question: string
  readonly context?: string
  readonly advisors: readonly AdvisorGroupAdvisorInfo[]
  readonly messages: readonly AdvisorGroupMessageData[]
  readonly summary?: AdvisorGroupEndData['summary']
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'advisor-group': AdvisorGroupChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'advisor-group': AdvisorGroupChatData
  }
}

function locationOf(context: ConversationNodeContext<AdvisorGroupState>): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function viewData(state: AdvisorGroupState): AdvisorGroupChatData {
  return {
    sessionId: state.sessionId,
    status: state.status,
    question: state.question,
    ...(state.context === undefined ? {} : { context: state.context }),
    advisors: state.advisors,
    messages: state.messages,
    ...(state.summary === undefined ? {} : { summary: state.summary }),
  }
}

export const advisorGroupDefinition: ConversationNodeDefinition<AdvisorGroupState> = {
  kind: 'advisor-group',
  target: 'chat',
  match: (event) => {
    if (event.type === 'advisor-group/start') {
      return { id: event.data.sessionId, role: 'start' }
    }
    if (
      event.type === 'advisor-group/message' ||
      event.type === 'advisor-group/delta' ||
      event.type === 'advisor-group/end' ||
      event.type === 'advisor-group/resume'
    ) {
      return { id: event.data.sessionId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'advisor-group/start') {
      throw new Error('advisor-group requires advisor-group/start')
    }
    const data = match.event.data
    return {
      sessionId: data.sessionId,
      turn: data.turn,
      step: data.step,
      question: data.question,
      ...(data.context === undefined ? {} : { context: data.context }),
      advisors: data.advisors,
      messages: [
        {
          sessionId: data.sessionId,
          turn: data.turn,
          step: data.step,
          role: 'main',
          content: data.question,
        },
      ],
      status: 'running',
    }
  },
  update: (context, match) => {
    if (match.event.type === 'advisor-group/message') {
      const data = match.event.data
      const existingIndex = context.state.messages.findIndex(
        (message) =>
          message.role === 'advisor' &&
          message.advisorId === data.advisorId &&
          (data.round === undefined || message.round === undefined || message.round === data.round),
      )
      if (existingIndex >= 0) {
        const messages = [...context.state.messages]
        messages[existingIndex] = { ...messages[existingIndex], ...data }
        return { ...context.state, messages }
      }
      return {
        ...context.state,
        messages: [...context.state.messages, data],
      }
    }
    if (match.event.type === 'advisor-group/delta') {
      const delta = match.event.data
      const existing = context.state.messages.find(
        (message) =>
          message.role === 'advisor' &&
          message.advisorId === delta.advisorId &&
          (delta.round === undefined || message.round === undefined || message.round === delta.round),
      )
      if (!existing) {
        return {
          ...context.state,
          messages: [
            ...context.state.messages,
            {
              sessionId: delta.sessionId,
              turn: delta.turn,
              step: delta.step,
              role: 'advisor' as const,
              advisorId: delta.advisorId,
              advisorName: delta.advisorName,
              ...(delta.round === undefined ? {} : { round: delta.round }),
              content: delta.contentDelta ?? '',
              thinking: delta.thinkingDelta ?? '',
            },
          ],
        }
      }
      return {
        ...context.state,
        messages: context.state.messages.map((message) =>
          message.role === 'advisor' &&
          message.advisorId === delta.advisorId &&
          (delta.round === undefined || message.round === undefined || message.round === delta.round)
            ? {
                ...message,
                content: message.content + (delta.contentDelta ?? ''),
                thinking: (message.thinking ?? '') + (delta.thinkingDelta ?? ''),
              }
            : message,
        ),
      }
    }
    if (match.event.type === 'advisor-group/end') {
      return {
        ...context.state,
        status: match.event.data.summary.stopped ? 'cancelled' : 'completed',
        summary: match.event.data.summary,
      }
    }
    if (match.event.type === 'advisor-group/resume') {
      // Stopped -> resumed: the card returns to LIVE until the next end event.
      return { ...context.state, status: 'running' }
    }
    return context.state
  },
  publication: (match) =>
    match.event.type === 'advisor-group/message' || match.event.type === 'advisor-group/delta'
      ? 'animation-frame'
      : 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'step' || context.state === undefined) return null
    return {
      kind: 'step',
      turn: context.state.turn,
      step: context.state.step,
      key: 'advisor-group',
      value: viewData(context.state),
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return buildChatNode(
      context,
      'advisor-group',
      context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      viewData(context.state),
    )
  },
}

/**
 * Build the chat-target view Node for one assembled advisor-group Context.
 *
 * The generic `ConversationNodeDefinition.buildViewNode` only declares the
 * `{ key, kind, id, target, data }` face; DSH's chat snapshot builder reads
 * the chat-specific extras (`anchorSeq` / `location` / `visibility`) at
 * runtime. The factory returns them through a function call so the object is
 * not subject to fresh-literal excess-property checks against the generic
 * type — the same technique the official chat definitions use.
 */
function buildChatNode(
  context: ConversationNodeContext<AdvisorGroupState>,
  kind: string,
  anchorSeq: number,
  data: AdvisorGroupChatData,
): {
  key: string
  kind: string
  id: string
  target: 'chat'
  anchorSeq: number
  location: ConversationLocation
  visibility: 'visible' | 'hidden'
  data: AdvisorGroupChatData
} {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: locationOf(context),
    visibility: 'visible',
    data,
  }
}

/* ------------------------------ Retro CRT UI ------------------------------ */

const rootStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  margin: '8px 0',
  padding: '10px 12px',
  border: '1px solid #22c55e',
  borderRadius: 4,
  background: '#0a0f0a',
  color: '#b8f5c4',
  fontFamily: "'Courier New', ui-monospace, SFMono-Regular, monospace",
  fontSize: 13,
  lineHeight: 1.5,
  position: 'relative',
  overflow: 'hidden',
  boxShadow: '0 0 12px rgba(34,197,94,0.22), inset 0 0 24px rgba(34,197,94,0.06)',
}

const scanlineStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  pointerEvents: 'none',
  background:
    'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  borderBottom: '1px dashed #2f9e44',
  paddingBottom: 4,
  marginBottom: 8,
  color: '#86efac',
  textTransform: 'uppercase',
  letterSpacing: 1,
  fontSize: 11,
}

const advisorsLineStyle: CSSProperties = {
  fontSize: 11,
  color: '#4ade80',
  marginBottom: 6,
}

const contextBoxStyle: CSSProperties = {
  border: '1px dashed #a16207',
  borderRadius: 3,
  marginBottom: 6,
  background: 'rgba(217,119,6,0.06)',
}

const contextToggleStyle: CSSProperties = {
  width: '100%',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  color: '#fbbf24',
  fontSize: 12,
  textAlign: 'left',
  padding: '3px 6px',
}

const contextBodyStyle: CSSProperties = {
  maxHeight: 180,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  padding: '4px 6px',
  color: '#fde68a',
  fontSize: 12,
  borderTop: '1px dashed #a16207',
}

const waitingStyle: CSSProperties = {
  color: '#fbbf24',
  marginTop: 6,
}



/** One tool invocation shown as a single ⛭ row (输入/输出 sections). */
export interface ToolStepView {
  name: string
  /** Call arguments preview (the `call` step). */
  input?: string
  /** Result preview (the following `result` step). */
  output?: string
  /** True when the result was an execution failure (e.g. unconfigured tool). */
  failed?: boolean
  atMs?: number
}

/** Internal announcements that must never reach the user (the tool list). */
const INTERNAL_TOOL_STEP_NAMES = new Set(['⚙️ tools', '⚙ tools'])

/** True when the tool result represents a failure — the wrapper prefix, or a
 *  JSON payload carrying `error`/`detail`/HTTP error code (unconfigured/401
 *  tools), robust to nested objects before the error key. */
function isFailedToolResult(text: string): boolean {
  if (text.startsWith('（工具执行失败')) return true
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown; code?: number } | null
    if (parsed && (parsed.error !== undefined || parsed.detail !== undefined)) return true
    if (parsed && typeof parsed.code === 'number' && parsed.code >= 400 && parsed.code <= 599) return true
  } catch {
    // Not JSON — only the wrapper prefix above counts.
  }
  return false
}

/**
 * Pair call/result tool steps into one `ToolStepView` per invocation, in
 * stream order, and drop internal announcements (「本次可用」).
 */
export function buildToolStepViews(
  steps: ReadonlyArray<{ kind: string; name: string; text: string; atMs: number }> | undefined,
): ToolStepView[] {
  const out: ToolStepView[] = []
  let last: ToolStepView | undefined
  for (const step of steps ?? []) {
    if (INTERNAL_TOOL_STEP_NAMES.has(step.name)) continue
    if (step.kind === 'call') {
      last = { name: step.name, input: step.text, atMs: step.atMs }
      out.push(last)
    } else if (step.kind === 'result') {
      if (last && last.output === undefined && last.input !== undefined) {
        last.output = step.text
        if (isFailedToolResult(step.text)) last.failed = true
      } else {
        out.push({
          name: step.name,
          output: step.text,
          atMs: step.atMs,
          ...(isFailedToolResult(step.text) ? { failed: true } : {}),
        })
      }
    }
  }
  return out.filter((view) => view.input !== undefined || view.output !== undefined)
}

const stepRowShellStyle: CSSProperties = {
  border: '1px solid rgba(34,197,94,0.28)',
  borderRadius: 3,
  margin: '5px 0',
  background: 'rgba(34,197,94,0.05)',
  overflow: 'hidden',
}

const stepRowHeaderStyle = (color: string): CSSProperties => ({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  color,
  fontSize: 12,
  textAlign: 'left',
  padding: '4px 8px',
})

const stepRowBodyStyle: CSSProperties = {
  borderTop: '1px dashed rgba(47,158,68,0.45)',
  padding: '5px 8px',
}

function StepRow({
  title,
  badges,
  defaultOpen,
  color = '#4ade80',
  body,
}: {
  title: string
  badges?: ReactNode[]
  defaultOpen: boolean
  color?: string
  body: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return createElement(
    'div',
    { style: stepRowShellStyle },
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        style: stepRowHeaderStyle(color),
      },
      createElement('span', null, open ? '▾' : '▸'),
      createElement('span', { style: { fontWeight: 700 } }, title),
      ...(badges ?? []),
    ),
    open ? createElement('div', { style: stepRowBodyStyle }, body) : null,
  )
}

/**
 * Inline thinking annotation: an UNFRAMED block that sits directly above the
 * tool row it led to (each step reads: 💭 思考文本 → ⛭ 工具), with the full
 * segment visible (scrollable) — not a separate bordered card.
 */
const thinkingInlineStyle: CSSProperties = {
  margin: '4px 0 2px',
  padding: '4px 8px',
  borderLeft: '2px solid rgba(251,191,36,0.45)',
  background: 'rgba(217,119,6,0.04)',
}

const thinkingTagStyle: CSSProperties = {
  color: '#fbbf24',
  fontSize: 11,
  marginBottom: 2,
  fontWeight: 700,
}

const descriptionBodyStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#d9f99d',
  fontSize: 12,
  padding: '2px 6px 4px',
}

/**
 * Short "next-action narrative" of a thinking segment — the visible 📋 行动·N
 * block shown directly after the 💭 思考·N panel and before the ⛭ tool row.
 * Standard-agent style: pick the FIRST SHORT sentence that says what the model
 * is about to do (action markers like 我先/接下来/我需要…), else the first
 * non-generic short sentence; hard-cap at ~140 chars. The long internal
 * monologue stays in the thinking panel.
 */
export function extractActionDescription(segment: string): string {
  const text = segment.trim()
  if (!text) return ''
  const sentences = (text.match(/[^。！？!?]+[。！？!?]?/g) ?? [])
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)
  const ACTION = /(我先|接下来|下一步|下面|准备|打算|我需要|先做|先看|先检查|先核对|先核实|先验证|先确认|先读|先搜索|先检索|先找|计划|步骤|让我先|我会|需要先|先补|先抓|先取|先查|先分析|先整理|先修改|先跟踪)/
  const GENERIC = /^(让我|我明白|好的|嗯|OK|Okay|我是|我是一位|我的角色|Let me|Sure|The user|用户)/
  // 1) First short sentence that states a planned action.
  for (const sentence of sentences.slice(0, 5)) {
    if (sentence.length <= 160 && ACTION.test(sentence)) return cut(sentence, 140)
  }
  // 2) First short non-generic sentence (no rambling intro).
  for (const sentence of sentences.slice(0, 3)) {
    if (sentence.length <= 120 && !GENERIC.test(sentence)) return cut(sentence, 120)
  }
  // 3) Fallback: the first sentence, hard-capped.
  return cut(sentences[0] ?? text, 100)
}

const thinkingBodyStyle: CSSProperties = {
  maxHeight: 200,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#fde68a',
  fontSize: 12,
  padding: '4px 6px',
}

const toolBodyStyle: CSSProperties = {
  fontSize: 12,
  color: '#38bdf8',
}

const toolIoTitleStyle: CSSProperties = {
  color: '#86efac',
  fontWeight: 700,
  margin: '2px 0 2px',
}

const toolIoBodyStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--dsh-color-muted, #8b90a0)',
  marginBottom: 6,
}

const badgeStyle = (color: string): CSSProperties => ({
  color,
  fontSize: 11,
  opacity: 0.95,
})

/** One interleaved step row for the card: 行动N → 思考N → ⛭ 工具N → … → 📄 正文. */
export type StepSeqItem =
  | { kind: 'action'; text: string; step: number }
  | { kind: 'thinking'; segment: string; step: number }
  | { kind: 'tool'; view: ToolStepView }
  | { kind: 'body' }

/**
 * Interleave action announcements, thinking segments and tool views in the
 * official DSH block order (text → reasoning → tool-call), then the body.
 * Each round contributes at most one 行动 / 思考 / 工具 item; missing actions
 * are derived from the thinking segment so pre-actionDescriptions logs still
 * render sensibly.
 */
export function buildStepSequence(
  actionDescriptions: readonly string[],
  thinkingSegments: readonly string[],
  toolViews: ToolStepView[],
): StepSeqItem[] {
  const items: StepSeqItem[] = []
  const count = Math.max(actionDescriptions.length, thinkingSegments.length, toolViews.length)
  for (let index = 0; index < count; index += 1) {
    const step = index + 1
    const described = actionDescriptions[index]?.trim()
    const segment = thinkingSegments[index]
    const action =
      described ||
      (segment !== undefined && segment.trim() ? extractActionDescription(segment) : '')
    if (action) items.push({ kind: 'action', text: action, step })
    if (segment !== undefined && segment.trim()) items.push({ kind: 'thinking', segment, step })
    const view = toolViews[index]
    if (view !== undefined) items.push({ kind: 'tool', view })
  }
  items.push({ kind: 'body' })
  return items
}

/**
 * Render one consultation message as a stack of STEP rows (one row per step,
 * appearing in stream order, each independently expandable):
 *   💭 思考·1 → ⛭ 工具×1（输入/输出）→ 💭 思考·2 → ⛭ 工具×2 → … → 📄 正文
 * Main/system messages stay a single collapsible row.
 */
function AdvisorSteps({ message }: { message: AdvisorGroupMessageData }): ReactNode {
  const isMain = message.role === 'main'
  const isSystem = message.role === 'system'
  const label = isMain
    ? 'YOU'
    : isSystem
      ? 'SYSTEM'
      : (message.advisorName ?? message.advisorId ?? 'ADVISOR')
  const group = isMain ? 'YOU' : isSystem ? 'SYSTEM' : `${label} · R${message.round ?? 1}`
  const truncated = message.truncated
  const toolViews = buildToolStepViews(message.toolSteps)
  const thinkingSegments =
    message.thinkingSegments && message.thinkingSegments.length > 0
      ? message.thinkingSegments
      : message.thinking
        ? [message.thinking]
        : []
  const baseColor = isSystem ? '#fcd34d' : '#4ade80'

  if (isMain || isSystem) {
    return createElement(StepRow, {
      title: group,
      defaultOpen: isMain,
      color: baseColor,
      body: createElement(
        'div',
        { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
        message.content,
      ),
    })
  }

  const sequence = buildStepSequence(
    message.actionDescriptions ?? [],
    thinkingSegments,
    toolViews,
  )
  const live = message as { liveBody?: string; livePhase?: 'tool' | 'answer' }
  const liveToolPhase = live.livePhase === 'tool'
  const liveAction = liveToolPhase && live.liveBody?.trim()
    ? live.liveBody.trim()
    : undefined
  const children: ReactNode[] = []
  for (const [index, item] of sequence.entries()) {
    if (item.kind === 'action') {
      // 📋 行动·N: the model's full TEXT block for this round, shown BEFORE
      // the thinking panel — official DSH order is text → reasoning → tool.
      children.push(
        createElement(
          'div',
          { key: `action-${index}`, style: thinkingInlineStyle },
          createElement('div', { style: thinkingTagStyle }, `${group} 📋 行动·${item.step}`),
          createElement('div', { style: descriptionBodyStyle }, item.text),
        ),
      )
      continue
    }
    if (item.kind === 'thinking') {
      // 💭 思考·N: full reasoning segment (collapsible), after the action row.
      children.push(
        createElement(StepRow, {
          key: `think-${index}`,
          title: `${group} 💭 思考·${item.step}`,
          badges: [
            createElement(
              'span',
              { style: badgeStyle('#fbbf24') },
              `${item.segment.length} 字符`,
            ),
          ],
          defaultOpen: false,
          color: '#fbbf24',
          body: createElement('div', { style: thinkingBodyStyle }, item.segment),
        }),
      )
      continue
    }
    if (item.kind === 'tool') {
      const view = item.view
      children.push(
        createElement(StepRow, {
          key: `tool-${index}`,
          title: `${group} ⛭ ${view.name}`,
          badges: [
            createElement(
              'span',
              { style: badgeStyle(view.failed ? '#f87171' : '#38bdf8') },
              view.output === undefined ? '调用中…' : view.failed ? '⚠ 失败' : '调用完成',
            ),
          ],
          defaultOpen: false,
          color: view.failed ? '#f87171' : '#38bdf8',
          body: createElement(
            'div',
            null,
            view.input !== undefined
              ? createElement(
                  'div',
                  { style: toolBodyStyle },
                  createElement('div', { style: toolIoTitleStyle }, '输入'),
                  createElement('div', { style: toolIoBodyStyle }, view.input),
                )
              : null,
            view.output !== undefined
              ? createElement(
                  'div',
                  { style: toolBodyStyle },
                  createElement('div', { style: toolIoTitleStyle }, '输出'),
                  createElement('div', { style: toolIoBodyStyle }, view.output),
                )
              : null,
          ),
        }),
      )
      continue
    }
    // Body: skip while a live tool round is in progress — the current round's
    // text is either already committed as a 📋 行动 row or streaming as the
    // pending action row below. 📄 正文 only renders in the answer phase or
    // after the message is finalized.
    if (liveToolPhase) continue
    children.push(
      createElement(StepRow, {
        key: `body-${index}`,
        title: `${group} 📄 正文`,
        badges: truncated
          ? [
              createElement(
                'span',
                { style: badgeStyle('#f87171') },
                truncated.reason === 'timeout' ? '⏱ 响应超时截断' : '⚠ 流中断',
              ),
            ]
          : [],
        defaultOpen: true,
        color: '#4ade80',
        body: createElement(
          'div',
          { style: { wordBreak: 'break-word' } },
          truncated
            ? createElement(
                'div',
                {
                  style: {
                    fontSize: 11,
                    color: '#f87171',
                    border: '1px solid #dc2626',
                    borderRadius: 3,
                    padding: '2px 6px',
                    display: 'inline-block',
                    marginBottom: 3,
                  },
                },
                truncated.reason === 'timeout'
                  ? '⏱ 响应超时截断 — 思考已收到，正文未完成'
                  : '⚠ 流中断 — 正文可能不完整',
              )
            : null,
          renderMarkdown(message.content),
        ),
      }),
    )
  }
  if (liveAction !== undefined) {
    children.push(
      createElement(
        'div',
        { key: 'live-action', style: thinkingInlineStyle },
        createElement(
          'div',
          { style: thinkingTagStyle },
          `${group} 📋 行动·${toolViews.length + 1}`,
        ),
        createElement('div', { style: descriptionBodyStyle }, liveAction),
      ),
    )
  }
  return createElement('div', null, children)
}

function AdvisorGroupNodeView(props: ChatNodeViewProps<'advisor-group'>): ReactNode {
  const data = props.node.data
  const sessionId = data.sessionId
  // SSE live overlay bucketed by `advisorId::round` so multi-round relays never
  // leak a later round's deltas into an earlier round's bubble (see the
  // sequential auto-deepen pipeline). Durable messages stay the base of truth.
  const [live, setLive] = useState<
    Record<
      string,
      {
        content: string
        thinking: string
        thinkingSegments: string[]
        committedLen: number
        /** Text committed at each tool boundary — the per-round 📋 行动 rows. */
        contentSegments: string[]
        committedContentLen: number
        /** Latest stream phase: 'tool' = current text is a round announcement,
         *  'answer' = current text is the final answer body. */
        phase: 'tool' | 'answer'
        /** Set when the `done` frame arrives; from then on the durable message
         *  (final answer + actionDescriptions + toolSteps) is authoritative. */
        finalized: boolean
        toolSteps: Array<{ kind: string; name: string; text: string; atMs?: number }>
      }
    >
  >({})
  const [contextCollapsed, setContextCollapsed] = useState(true)
  const lastEventIdRef = useRef(0)
  const lastBootIdRef = useRef('')

  useEffect(() => {
    if (!sessionId) return
    // Pass the last seen event id + boot id so the host can replay buffered
    // deltas after a page refresh or EventSource reconnect; the JSON payload
    // also carries eventId/bootId for dedup below.
    const es = new EventSource(
      `/advisor-group/stream?sessionId=${encodeURIComponent(sessionId)}&lastEventId=${lastEventIdRef.current}&bootId=${encodeURIComponent(lastBootIdRef.current)}&token=${encodeURIComponent(advisorGroupToken())}`,
    )
    es.onmessage = (event: MessageEvent) => {
      try {
        const delta = JSON.parse(event.data as string) as {
          advisorId: string
          round?: number
          contentDelta?: string
          thinkingDelta?: string
          phase?: 'tool' | 'answer'
          toolStep?: { kind: string; name: string; text: string; atMs?: number }
          done?: boolean
          eventId?: number
          bootId?: string
        }
        const bootId = delta.bootId ?? ''
        if (lastBootIdRef.current !== '' && bootId !== lastBootIdRef.current) {
          // Host restarted: its counter restarted too. Reset and accept new frames.
          lastBootIdRef.current = bootId
          lastEventIdRef.current = 0
          setLive({})
        } else if (bootId) {
          lastBootIdRef.current = bootId
        }
        const eventId = Number(delta.eventId ?? 0)
        if (eventId > 0 && eventId <= lastEventIdRef.current) return
        if (eventId > 0) lastEventIdRef.current = eventId
        const bucket = `${delta.advisorId}::${delta.round ?? 1}`
        setLive((prev) => {
          const current = prev[bucket] ?? {
            content: '',
            thinking: '',
            thinkingSegments: [],
            committedLen: 0,
            contentSegments: [],
            committedContentLen: 0,
            phase: 'answer',
            finalized: false,
            toolSteps: [],
          }
          let thinkingSegments = current.thinkingSegments
          let committedLen = current.committedLen
          let contentSegments = current.contentSegments
          let committedContentLen = current.committedContentLen
          if (delta.toolStep) {
            // Commit the thinking accumulated up to this tool boundary as its
            // own 思考·N row (stream order, interleaved with the tool row).
            const segment = current.thinking.slice(committedLen)
            if (segment.trim()) thinkingSegments = [...current.thinkingSegments, segment]
            committedLen = current.thinking.length
            // Commit the text accumulated up to this tool boundary as the
            // round's 📋 行动 row (official order: text → reasoning → tool).
            const contentSegment = current.content.slice(committedContentLen)
            if (contentSegment.trim()) contentSegments = [...current.contentSegments, contentSegment]
            committedContentLen = current.content.length
          }
          return {
            ...prev,
            [bucket]: {
              content: current.content + (delta.contentDelta ?? ''),
              thinking: current.thinking + (delta.thinkingDelta ?? ''),
              thinkingSegments,
              committedLen,
              contentSegments,
              committedContentLen,
              phase: delta.phase ?? current.phase,
              finalized: current.finalized || delta.done === true,
              toolSteps: delta.toolStep ? [...current.toolSteps, delta.toolStep] : current.toolSteps,
            },
          }
        })
      } catch {
        // Ignore malformed stream frames.
      }
    }
    es.addEventListener('resync', () => {
      // The host cannot replay the gap (restart or buffer overflow). Durable
      // session events already carry the full content, so reset the SSE overlay
      // and continue accepting live frames from now on.
      lastEventIdRef.current = 0
      setLive({})
    })
    return () => es.close()
  }, [sessionId])

  const mergedMessages = data.messages.map((message) => {
    if (message.role !== 'advisor') return message
    const advisorId = message.advisorId ?? ''
    const streamed = live[`${advisorId}::${message.round ?? 1}`]
    if (!streamed) return message
    // Once the server published `done`, the durable message event is the full
    // final answer (content + actionDescriptions + thinkingSegments + toolSteps)
    // and the cumulative SSE buffer must NOT override it.
    if (streamed.finalized) return message
    // Body: only the current round's uncommitted text. Text committed at tool
    // boundaries is rendered as 📋 行动 rows (official text → reasoning → tool).
    const liveBody = sanitizeClientContent(streamed.content.slice(streamed.committedContentLen))
    const content = liveBody.trim() ? liveBody : sanitizeClientContent(message.content)
    const thinking =
      (streamed.thinking?.length ?? 0) > (message.thinking?.length ?? 0)
        ? streamed.thinking
        : message.thinking
    const toolSteps =
      (streamed.toolSteps?.length ?? 0) > (message.toolSteps?.length ?? 0)
        ? streamed.toolSteps
        : message.toolSteps ?? []
    const liveSegments = streamed.thinkingSegments?.length ? streamed.thinkingSegments : []
    const baseSegments = message.thinkingSegments?.length
      ? message.thinkingSegments
      : message.thinking
        ? [message.thinking]
        : []
    const thinkingSegments = liveSegments.length ? liveSegments : baseSegments
    const liveActions = streamed.contentSegments?.length
      ? streamed.contentSegments.map((segment) => sanitizeClientContent(segment))
      : []
    const baseActions = message.actionDescriptions?.length ? message.actionDescriptions : []
    const actionDescriptions = liveActions.length ? liveActions : baseActions
    return {
      ...message,
      content,
      thinking,
      thinkingSegments,
      toolSteps,
      actionDescriptions,
      ...(streamed.phase === 'tool' ? { liveBody, livePhase: streamed.phase } : {}),
    } as typeof message & { liveBody?: string; livePhase?: 'tool' | 'answer' }
  })

  const shortId = data.sessionId.length > 8 ? data.sessionId.slice(0, 8) : data.sessionId
  const title =
    data.status === 'completed'
      ? 'ADVISOR GROUP · DONE'
      : data.status === 'cancelled'
        ? 'ADVISOR GROUP · STOPPED'
        : 'ADVISOR GROUP · LIVE'

  return createElement(
    'div',
    { style: rootStyle, role: 'log', 'aria-live': 'polite' },
    createElement('div', { style: scanlineStyle }),
    createElement(
      'div',
      { style: headerStyle },
      createElement('span', { key: 'title' }, title),
      createElement(
        'span',
        {
          key: 'stop',
          style: { display: 'flex', alignItems: 'center', gap: 8 },
        },
        data.status === 'running'
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: () => {
                  void fetch('/advisor-group/stop', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ sessionId }),
                  }).catch(() => {})
                },
                style: {
                  cursor: 'pointer',
                  border: '1px solid #e11d48',
                  background: 'transparent',
                  color: '#fda4af',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                },
              },
              '⏹ 停止',
            )
          : data.status === 'cancelled'
            ? createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    void fetch('/advisor-group/resume', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json', ...authHeaders() },
                      body: JSON.stringify({ sessionId }),
                    }).catch(() => {})
                  },
                  style: {
                    cursor: 'pointer',
                    border: '1px solid #22c55e',
                    background: 'transparent',
                    color: '#86efac',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                  },
                },
                '▶ 继续聊天',
              )
            : null,
        createElement('span', { key: 'id' }, `#${shortId}`),
      ),
    ),
    data.context
      ? createElement(
          'div',
          { style: contextBoxStyle },
          createElement(
            'button',
            {
              type: 'button',
              onClick: () => setContextCollapsed((value) => !value),
              style: contextToggleStyle,
            },
            `📋 项目背景 ${contextCollapsed ? '▸' : '▾'}`,
          ),
          !contextCollapsed
            ? createElement('div', { style: contextBodyStyle }, data.context)
            : null,
        )
      : null,
    createElement(
      'div',
      { style: advisorsLineStyle },
      `ADVISORS: ${data.advisors.map((a) => (a.avatar ? `${a.avatar} ${a.name}` : a.name)).join(' · ')}`,
    ),
    mergedMessages.map((message, index) =>
      createElement(AdvisorSteps, { key: index, message }),
    ),
    data.status === 'completed' && data.summary?.conclusion
      ? createElement(
          'div',
          {
            style: {
              borderTop: '1px dashed #2f9e44',
              marginTop: 8,
              paddingTop: 8,
            },
          },
          createElement(
            'div',
            { style: { color: '#86efac', fontWeight: 700, marginBottom: 4 } },
            '📌 综合结论',
          ),
          createElement('div', null, renderMarkdown(data.summary.conclusion)),
        )
      : null,
    data.status === 'running'
      ? createElement('div', { style: waitingStyle }, '▊ AWAITING RESPONSES…')
      : null,
  )
}

/* ------------------------- Settings tab ------------------------- */

const settingsRootStyle: CSSProperties = {
  fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
  fontSize: 13,
  maxWidth: 720,
  color: 'inherit',
}

/*
 * Card shell mirroring the official `settings.plugin.item` cards (Bash /
 * WebSearch / AgentLoop / SubagentModelSelection): one plugin settings panel
 * with a collapsible header + chevron, staged edits outlive collapsing. The
 * official PluginCard component cannot be value-imported (client bundle purity
 * gate), so the same structure and theme variables are reproduced here.
 */
const settingsCardStyle = (open: boolean): CSSProperties => ({
  boxSizing: 'border-box',
  border: '0.5px solid var(--dsw-alias-border-l4, var(--dsh-color-border, #3a3f4b))',
  background: open
    ? 'var(--dsw-alias-bg-layer-2, #191d26)'
    : 'var(--dsw-alias-bg-layer-3, #151821)',
  borderRadius: 16,
  listStyle: 'none',
  transition: 'border-color .16s, background .16s',
})

const settingsCardHeaderStyle: CSSProperties = {
  appearance: 'none',
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  background: 'transparent',
  border: 0,
  borderRadius: 12,
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  display: 'flex',
}

const settingsHeadTextStyle: CSSProperties = {
  flexDirection: 'column',
  flex: 1,
  gap: 4,
  minWidth: 0,
  display: 'flex',
}

const settingsCardNameStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, #e6e9f0)',
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
}

const settingsCardDescriptionStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, var(--dsh-color-muted, #8b90a0))',
  fontSize: 13,
  lineHeight: 1.5,
}

const settingsCardPendingStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-module-platform, #2a2f3d)',
  color: 'var(--dsw-alias-label-secondary, #aab2c5)',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: '17px',
  whiteSpace: 'nowrap',
  flex: 'none',
}

const settingsCardBodyStyle: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2, var(--dsh-color-border, #3a3f4b))',
  margin: '0 16px',
  paddingBottom: 8,
}

const settingsCardLoadingStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, var(--dsh-color-muted, #8b90a0))',
  margin: '12px 0',
  fontSize: 12,
  lineHeight: 1.5,
}

const settingsCardFooterStyle: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2, var(--dsh-color-border, #3a3f4b))',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  padding: '12px 0 4px',
  display: 'flex',
  flexWrap: 'wrap',
}

const settingsFooterButtonStyle: CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '5px 14px',
  fontSize: 13,
  lineHeight: 1.5,
}

/** Collapsible header shared by the loading and settled card states. */
function settingsCardHeader(
  open: boolean,
  dirty: boolean,
  onToggle: () => void,
): ReactNode {
  return createElement(
    'button',
    {
      type: 'button',
      style: settingsCardHeaderStyle,
      'aria-expanded': open,
      'aria-label': `${open ? '收起' : '展开'}设置：顾问群`,
      onClick: onToggle,
    },
    createElement(
      'span',
      { style: settingsHeadTextStyle },
      createElement('span', { style: settingsCardNameStyle }, '顾问群'),
      createElement(
        'span',
        { style: settingsCardDescriptionStyle },
        '多顾问模型咨询：触发条件、讨论轮次与顾问列表。',
      ),
    ),
    dirty ? createElement('span', { style: settingsCardPendingStyle }, '未保存') : null,
    createElement(
      'svg',
      {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: {
          flex: 'none',
          transition: 'transform .16s',
          transform: open ? 'rotate(180deg)' : 'none',
        },
      },
      createElement('path', {
        d: 'M3 6 L8 10.5 L13 6',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    ),
  )
}

const settingsSectionStyle: CSSProperties = {
  border: '1px solid var(--dsh-color-border, #3a3f4b)',
  borderRadius: 8,
  padding: '10px 12px',
  marginBottom: 10,
  background: 'transparent',
}

const settingsLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  marginBottom: 4,
  color: 'var(--dsh-color-muted, #8b90a0)',
}

const settingsInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid var(--dsh-color-border, #3a3f4b)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  caretColor: 'inherit',
}

const advisorCardStyle: CSSProperties = {
  border: '1px solid var(--dsh-color-border, #3a3f4b)',
  borderRadius: 6,
  padding: 8,
  marginBottom: 8,
  display: 'grid',
  gap: 6,
}

const AVATAR_OPTIONS = [
  '🧠', '⚖️', '👨‍💻', '👩‍💻', '💼', '🏥', '📊', '🔬',
  '💰', '🌐', '🛠️', '📚', '🎯', '⚙️', '🚀', '🛡️',
]

interface ProviderOption {
  id: string
  name: string
  kind: 'llm' | 'preset'
  models: string[]
  baseURL?: string
  apiKeyEnv?: string
  protocol?: string
}

function AdvisorGroupSettingsTab(): ReactNode {
  const [config, setConfig] = useState<AdvisorGroupConfig | null>(null)
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [revision, setRevision] = useState(0)
  const [customModes, setCustomModes] = useState<Set<string>>(new Set())
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({})
  const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>({})
  const [testingConnection, setTestingConnection] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dailyGuard, setDailyGuard] = useState<{ used: number; enabled: boolean; limit: number; remaining: number } | null>(null)
  const savedJsonRef = useRef('')
  // SecretField convergence (2026-09-05): the server never returns key
  // material (not even a mask) — per-provider presence facts ride in
  // `apiKeyMetaByProvider`, and an empty apiKey field means "keep the stored
  // key". No client-side key memory is needed anymore.

  const reload = async (): Promise<void> => {
    setMsg('')
    setError('')
    try {
      const [configData, providerData] = await Promise.all([
        fetch('/advisor-group/config', { headers: authHeaders() }).then(
          (r) => r.json() as Promise<{
            ok?: boolean
            config?: AdvisorGroupConfig
            revision?: number
            dailyGuard?: { used: number; enabled: boolean; limit: number; remaining: number }
            error?: string
          }>,
        ),
        fetch('/advisor-group/providers', { headers: authHeaders() }).then(
          (r) => r.json() as Promise<{ ok?: boolean; providers?: ProviderOption[]; error?: string }>,
        ),
      ])
      if (configData.ok && configData.config) {
        setConfig(configData.config)
        savedJsonRef.current = JSON.stringify(configData.config)
        if (typeof configData.revision === 'number') setRevision(configData.revision)
        if (configData.dailyGuard) setDailyGuard(configData.dailyGuard)
      } else {
        setError(configData.error ?? '加载配置失败')
      }
      if (providerData.ok && providerData.providers) {
        setProviders(providerData.providers)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // JSON identity against the last loaded/saved snapshot drives the "未保存"
  // badge and the footer button states (staged edits outlive collapsing).
  const dirty =
    config !== null && savedJsonRef.current !== '' && JSON.stringify(config) !== savedJsonRef.current

  if (!config) {
    return createElement(
      'li',
      { style: settingsCardStyle(true) },
      settingsCardHeader(true, false, () => setOpen((value) => !value)),
      createElement(
        'div',
        { style: settingsCardBodyStyle },
        createElement('p', { style: settingsCardLoadingStyle }, error || '加载中…'),
      ),
    )
  }

  const updateAdvisor = (index: number, patch: Partial<AdvisorConfigShape>): void => {
    const advisors = config.advisors.map((advisor, i) =>
      i === index ? { ...advisor, ...patch } : advisor,
    )
    setConfig({ ...config, advisors })
  }

  const removeAdvisor = (index: number): void => {
    const advisors = config.advisors.filter((_, i) => i !== index)
    setConfig({ ...config, advisors })
  }

  const addAdvisor = (): void => {
    setConfig({
      ...config,
      advisors: [
        ...config.advisors,
        {
          id: `advisor-${Date.now()}`,
          name: '新顾问',
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          systemPrompt: DEFAULT_ADVISOR_PROMPT,
        },
      ],
    })
  }

  const loadModels = async (index: number): Promise<void> => {
    const advisor = config.advisors[index]
    if (!advisor) return
    setFetchingModels((prev) => ({ ...prev, [advisor.id]: true }))
    setError('')
    setMsg('')
    try {
      const res = await fetch('/advisor-group/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          advisorId: advisor.id,
          provider: advisor.provider,
          baseURL: advisor.baseURL ?? '',
          apiKey: advisor.apiKey ?? '',
          apiKeyEnv: advisor.apiKeyEnv ?? '',
          protocol: advisor.protocol ?? 'openai',
        }),
      })
      const data = (await res.json()) as { ok?: boolean; models?: string[]; error?: string }
      if (data.ok && data.models) {
        setFetchedModels((prev) => ({ ...prev, [advisor.id]: data.models ?? [] }))
        setMsg(`已获取 ${advisor.name} 的模型列表（${data.models.length} 个）`)
      } else {
        setError(data.error ?? '获取模型列表失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchingModels((prev) => ({ ...prev, [advisor.id]: false }))
    }
  }

  const testConnection = async (index: number): Promise<void> => {
    const advisor = config.advisors[index]
    if (!advisor) return
    setTestingConnection((prev) => ({ ...prev, [advisor.id]: true }))
    setError('')
    setMsg('')
    try {
      const res = await fetch('/advisor-group/test-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          advisorId: advisor.id,
          provider: advisor.provider,
          baseURL: advisor.baseURL ?? '',
          apiKey: advisor.apiKey ?? '',
          apiKeyEnv: advisor.apiKeyEnv ?? '',
          protocol: advisor.protocol ?? 'openai',
        }),
      })
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string }
      if (data.ok) {
        setMsg(`✅ ${advisor.name} 连接成功${data.message ? `：${data.message}` : ''}`)
      } else {
        setError(`❌ ${advisor.name} 连接失败：${data.error ?? '未知错误'}`)
      }
    } catch (e) {
      setError(`❌ ${advisor.name} 连接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTestingConnection((prev) => ({ ...prev, [advisor.id]: false }))
    }
  }

  const save = async (): Promise<void> => {
    setMsg('')
    setError('')
    setSaving(true)
    try {
      // `apiKeyMetaByProvider` is server-derived display metadata — never
      // echoed back (the schema would drop or reject it); `clearApiKey` stays
      // in the payload as the explicit clear intent.
      const configPayload: AdvisorGroupConfig = {
        ...config,
        advisors: config.advisors.map(({ apiKeyMetaByProvider: _meta, ...rest }) => rest),
      }
      const res = await fetch('/advisor-group/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ config: configPayload, expectedRevision: revision }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        revision?: number
        config?: AdvisorGroupConfig
        error?: string
      }
      if (data.ok) {
        // Adopt the server's canonical (sanitized) config: it carries the
        // authoritative per-provider key facts and drops transient flags.
        if (data.config) {
          setConfig(data.config)
          savedJsonRef.current = JSON.stringify(data.config)
        } else {
          savedJsonRef.current = JSON.stringify(configPayload)
        }
        if (typeof data.revision === 'number') setRevision(data.revision)
        setMsg('配置已保存')
        setError('')
      } else {
        setError(data.error ?? '保存失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const label = (text: string): ReactNode =>
    createElement('label', { style: settingsLabelStyle }, text)

  return createElement(
    'li',
    { style: settingsCardStyle(open) },
    settingsCardHeader(open, dirty, () => setOpen((value) => !value)),
    open
      ? createElement(
          'div',
          { style: settingsCardBodyStyle },
          createElement(
            'div',
            { style: settingsRootStyle },
            createElement(
              'div',
              { style: settingsSectionStyle },
              createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('input', {
          type: 'checkbox',
          checked: config.enabled,
          onChange: (e: { target: { checked: boolean } }) =>
            setConfig({ ...config, enabled: e.target.checked }),
        }),
        label('启用顾问群'),
      ),
      createElement(
        'div',
        {
          style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
        },
        createElement('input', {
          type: 'checkbox',
          checked: config.quota.enabled,
          onChange: (e: { target: { checked: boolean } }) =>
            setConfig({ ...config, quota: { ...config.quota, enabled: e.target.checked } }),
        }),
        label('启用每日咨询上限（成本安全阀）'),
      ),
      createElement(
        'div',
        { style: { marginTop: 6 } },
        label(`每日上限次数（${config.quota.enabled ? '生效中' : '已关闭，不拦截'}）`),
        createElement('input', {
          type: 'number',
          min: 1,
          max: 100000,
          value: String(config.quota.maxPerDay),
          disabled: !config.quota.enabled,
          onChange: (e: { target: { value: string } }) =>
            setConfig({
              ...config,
              quota: { ...config.quota, maxPerDay: Math.max(1, Number(e.target.value)) },
            }),
          style: { ...settingsInputStyle, width: 120, marginTop: 4 },
        }),
      ),
    ),
    createElement(
      'div',
      { style: settingsSectionStyle },
      dailyGuard
        ? createElement(
            'div',
            {
              style: {
                fontSize: 12,
                color:
                  !dailyGuard.enabled || dailyGuard.remaining > 0
                    ? 'var(--dsh-color-muted, #8b90a0)'
                    : '#e11d48',
              },
            },
            dailyGuard.enabled
              ? dailyGuard.remaining > 0
                ? `今日剩余咨询次数：${dailyGuard.remaining} / ${dailyGuard.limit}（UTC 日切）`
                : `今日咨询次数已用尽（${dailyGuard.used} / ${dailyGuard.limit}），将于 UTC 日切后恢复。`
              : `今日已咨询 ${dailyGuard.used} 次（每日上限已关闭）。`,
          )
        : null,
    ),
    createElement(
      'div',
      { style: settingsSectionStyle },
      createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 } },
        createElement(
          'div',
          null,
          label('讨论轮数上限'),
          createElement('input', {
            type: 'number',
            min: 0,
            value: String(config.discussion.maxRounds),
            onChange: (e: { target: { value: string } }) =>
              setConfig({
                ...config,
                discussion: {
                  ...config.discussion,
                  maxRounds: Number(e.target.value),
                },
              }),
            style: settingsInputStyle,
          }),
        ),
        createElement(
          'div',
          null,
          label('单次最多顾问数'),
          createElement('input', {
            type: 'number',
            min: 1,
            value: String(config.discussion.maxAdvisorsPerCall ?? 3),
            onChange: (e: { target: { value: string } }) =>
              setConfig({
                ...config,
                discussion: {
                  ...config.discussion,
                  maxAdvisorsPerCall: Math.max(1, Number(e.target.value)),
                },
              }),
            style: settingsInputStyle,
          }),
        ),
        createElement(
          'div',
          null,
          label('单顾问超时（毫秒）'),
          createElement('input', {
            type: 'number',
            min: 1000,
            max: 600000,
            step: 1000,
            value: String(config.discussion.advisorTimeoutMs ?? 600000),
            onChange: (e: { target: { value: string } }) =>
              setConfig({
                ...config,
                discussion: {
                  ...config.discussion,
                  advisorTimeoutMs: Math.max(1000, Number(e.target.value)),
                },
              }),
            style: settingsInputStyle,
          }),
        ),
        createElement(
          'div',
          null,
          label('驱动模型生成超时（毫秒）'),
          createElement('input', {
            type: 'number',
            min: 1000,
            max: 1200000,
            step: 1000,
            value: String(config.discussion.driverTimeoutMs ?? 600000),
            onChange: (e: { target: { value: string } }) =>
              setConfig({
                ...config,
                discussion: {
                  ...config.discussion,
                  driverTimeoutMs: Math.max(1000, Number(e.target.value)),
                },
              }),
            style: settingsInputStyle,
          }),
        ),
      ),
      createElement(
        'div',
        { style: { marginTop: 8 } },
        label('置信度阈值（0-1，低于此值升级顾问群）'),
        createElement('input', {
          type: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          value: String(config.trigger.confidenceThreshold ?? 0.6),
          onChange: (e: { target: { value: string } }) =>
            setConfig({
              ...config,
              trigger: {
                ...config.trigger,
                confidenceThreshold: Number(e.target.value),
              },
            }),
          style: settingsInputStyle,
        }),
      ),
    ),
    createElement(
      'div',
      { style: settingsSectionStyle },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('input', {
          type: 'checkbox',
          checked: config.discussion.autoDeepen,
          onChange: (e: { target: { checked: boolean } }) =>
            setConfig({ ...config, discussion: { ...config.discussion, autoDeepen: e.target.checked } }),
        }),
        label('自动多轮深挖（每轮后驱动模型生成深入追问，顾问按 A→B→C 顺序接力，直到轮数上限）'),
      ),
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
        createElement('input', {
          type: 'checkbox',
          checked: config.trigger.requireClassifier,
          onChange: (e: { target: { checked: boolean } }) =>
            setConfig({ ...config, trigger: { ...config.trigger, requireClassifier: e.target.checked } }),
        }),
        label('启用前置分类器'),
      ),
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
        createElement('input', {
          type: 'checkbox',
          checked: config.trigger.allowWebFallback,
          onChange: (e: { target: { checked: boolean } }) =>
            setConfig({ ...config, trigger: { ...config.trigger, allowWebFallback: e.target.checked } }),
        }),
        label('分类器建议时允许返回联网搜索提示'),
      ),
    ),
    createElement(
      'div',
      { style: settingsSectionStyle },
      createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
        createElement('strong', null, `顾问列表（${config.advisors.length}）`),
        createElement(
          'button',
          {
            type: 'button',
            onClick: addAdvisor,
            style: { cursor: 'pointer' },
          },
          '＋ 添加顾问',
        ),
      ),
      config.advisors.map((advisor, index) =>
        createElement(
          'div',
          { key: advisor.id, style: advisorCardStyle },
          createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
            createElement('strong', null, advisor.name || advisor.id),
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => removeAdvisor(index),
                style: { cursor: 'pointer', color: '#e11d48' },
              },
              '删除',
            ),
          ),
          label(`ID · ${advisor.id}`),
          createElement('input', {
            value: advisor.name,
            onChange: (e: { target: { value: string } }) => updateAdvisor(index, { name: e.target.value }),
            style: settingsInputStyle,
          }),
          label('头像'),
          createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 } },
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => updateAdvisor(index, { avatar: undefined }),
                style: {
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '2px 6px',
                  border: advisor.avatar === undefined || advisor.avatar === ''
                    ? '2px solid #4ade80'
                    : '1px solid var(--dsh-color-border, #333)',
                  background: 'transparent',
                },
              },
              '无',
            ),
            AVATAR_OPTIONS.map((emoji) =>
              createElement(
                'button',
                {
                  key: emoji,
                  type: 'button',
                  onClick: () => updateAdvisor(index, { avatar: emoji }),
                  style: {
                    cursor: 'pointer',
                    fontSize: 18,
                    padding: '2px 6px',
                    border: advisor.avatar === emoji
                      ? '2px solid #4ade80'
                      : '1px solid var(--dsh-color-border, #333)',
                    background: advisor.avatar === emoji ? 'rgba(74,222,128,.15)' : 'transparent',
                  },
                },
                emoji,
              ),
            ),
          ),
          createElement('input', {
            placeholder: '自定义 emoji（可选）',
            value: advisor.avatar ?? '',
            onChange: (e: { target: { value: string } }) => updateAdvisor(index, { avatar: e.target.value }),
            style: { ...settingsInputStyle, marginTop: 4 },
          }),
          label('供应商'),
          createElement(
            'select',
            {
              'aria-label': '供应商',
              value:
                customModes.has(advisor.id) || !providers.some((p) => p.id === advisor.provider)
                  ? '__custom__'
                  : advisor.provider,
              onChange: (e: { target: { value: string } }) => {
                const value = e.target.value
                if (value === '__custom__') {
                  const next = new Set(customModes)
                  next.add(advisor.id)
                  setCustomModes(next)
                  return
                }
                const next = new Set(customModes)
                next.delete(advisor.id)
                setCustomModes(next)
                const provider = providers.find((p) => p.id === value)
                if (provider?.kind === 'llm') {
                  updateAdvisor(index, {
                    provider: value,
                    baseURL: undefined,
                    // SecretField semantics: the field starts empty; the server
                    // keeps the stored key unless a new plaintext one is typed
                    // or the explicit clear flag is set.
                    apiKey: '',
                    clearApiKey: false,
                    apiKeyEnv: undefined,
                    protocol: undefined,
                  })
                } else {
                  updateAdvisor(index, {
                    provider: value,
                    apiKey: '',
                    clearApiKey: false,
                    ...(provider?.baseURL ? { baseURL: provider.baseURL } : {}),
                    ...(provider?.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
                    ...(provider?.protocol
                      ? { protocol: provider.protocol as 'openai' | 'anthropic' | 'gemini' }
                      : {}),
                  })
                }
              },
              style: settingsInputStyle,
            },
            createElement('option', { value: '', disabled: true }, '请选择供应商'),
            providers.map((provider) =>
              createElement(
                'option',
                { key: provider.id, value: provider.id },
                `${provider.kind === 'llm' ? 'DSH 内置' : '预设'} · ${provider.name}（${provider.id}）`,
              ),
            ),
            createElement('option', { value: '__custom__' }, '自定义供应商…'),
          ),
          customModes.has(advisor.id) || !providers.some((p) => p.id === advisor.provider)
            ? createElement('input', {
                placeholder: '自定义 provider 标识',
                value: advisor.provider,
                onChange: (e: { target: { value: string } }) => updateAdvisor(index, { provider: e.target.value }),
                style: { ...settingsInputStyle, marginTop: 4 },
              })
            : null,
          label('模型'),
          createElement(
            'div',
            { style: { display: 'flex', gap: 4 } },
            createElement('input', {
              'aria-label': '模型',
              list: `advisor-models-${index}`,
              placeholder: 'model',
              value: advisor.model,
              onChange: (e: { target: { value: string } }) => updateAdvisor(index, { model: e.target.value }),
              style: {
                ...settingsInputStyle,
                marginTop: 4,
                border: advisor.model && advisor.model.trim()
                  ? undefined
                  : '1px solid #e11d48',
              },
            }),
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => void loadModels(index),
                disabled: !!fetchingModels[advisor.id],
                style: { cursor: 'pointer', marginTop: 4, whiteSpace: 'nowrap' },
              },
              fetchingModels[advisor.id] ? '获取中…' : '获取模型列表',
            ),
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => void testConnection(index),
                disabled: !!testingConnection[advisor.id],
                style: { cursor: 'pointer', marginTop: 4, whiteSpace: 'nowrap' },
              },
              testingConnection[advisor.id] ? '测试中…' : '测试连接',
            ),
          ),
          !advisor.model?.trim()
            ? createElement(
                'div',
                { style: { color: '#e11d48', fontSize: 12, marginTop: 2 } },
                '⚠️ 模型未配置，ask_advisors 将跳过整轮咨询。',
              )
            : null,
          createElement('datalist', { id: `advisor-models-${index}` }, [
            ...(fetchedModels[advisor.id] ?? providers.find((p) => p.id === advisor.provider)?.models ?? []),
            ...(advisor.model &&
            !(fetchedModels[advisor.id] ?? providers.find((p) => p.id === advisor.provider)?.models ?? []).includes(
              advisor.model,
            )
              ? [advisor.model]
              : []),
          ].map((model) => createElement('option', { key: model, value: model }, model))),
          (fetchedModels[advisor.id] ?? []).length > 0
            ? createElement(
                'div',
                {
                  style: {
                    maxHeight: 150,
                    overflowY: 'auto',
                    border: '1px solid var(--dsh-color-border, #333)',
                    borderRadius: 4,
                    marginTop: 4,
                  },
                },
                (fetchedModels[advisor.id] ?? []).map((model) =>
                  createElement(
                    'button',
                    {
                      key: model,
                      type: 'button',
                      onClick: () => updateAdvisor(index, { model }),
                      style: {
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        padding: '3px 6px',
                        background: 'transparent',
                        border: 'none',
                        color: 'inherit',
                        fontSize: 12,
                      },
                    },
                    model,
                  ),
                ),
              )
            : null,
          ...(providers.find((p) => p.id === advisor.provider)?.kind === 'llm'
            ? [
                createElement(
                  'div',
                  { style: { fontSize: 12, color: 'var(--dsh-color-muted, #8b90a0)', marginTop: 4 } },
                  '✅ DSH 内置 Provider：复用 DSH 已配置凭据，无需填写 API 地址/Key。',
                ),
              ]
            : (() => {
                // SecretField form (official settings-card model): the server
                // reports only presence facts; the input starts empty and keeps
                // the stored key until a new plaintext one is typed or the
                // explicit clear button is pressed.
                const keyMeta = advisor.apiKeyMetaByProvider?.[advisor.provider]
                const keyConfigured = keyMeta?.configured === true
                return [
                  label('API 地址'),
                  createElement('input', {
                    'aria-label': 'API 地址',
                    placeholder: 'https://api.example.com/v1',
                    value: advisor.baseURL ?? '',
                    onChange: (e: { target: { value: string } }) =>
                      updateAdvisor(index, { baseURL: e.target.value }),
                    style: settingsInputStyle,
                  }),
                  createElement(
                    'div',
                    { style: { display: 'flex', alignItems: 'flex-end', gap: 6, flexWrap: 'wrap' } },
                    createElement(
                      'div',
                      { style: { flex: 1, minWidth: 200 } },
                      createElement(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        label('API Key'),
                        createElement(
                          'span',
                          {
                            style: {
                              fontSize: 11,
                              padding: '1px 8px',
                              borderRadius: 999,
                              background: keyConfigured
                                ? 'rgba(22,163,74,.15)'
                                : 'var(--dsh-color-muted, #8b90a0)',
                              color: keyConfigured ? '#16a34a' : 'inherit',
                            },
                          },
                          keyConfigured ? `已配置 ••••${keyMeta?.last4 ?? ''}` : '未配置',
                        ),
                      ),
                      createElement('input', {
                        type: 'password',
                        'aria-label': 'API Key',
                        placeholder: keyConfigured ? '输入新 Key 可覆盖；留空保持不变' : 'sk-...',
                        value: advisor.apiKey ?? '',
                        onChange: (e: { target: { value: string } }) =>
                          updateAdvisor(index, { apiKey: e.target.value, clearApiKey: false }),
                        style: { ...settingsInputStyle, marginTop: 4 },
                      }),
                    ),
                    keyConfigured
                      ? createElement(
                          'button',
                          {
                            type: 'button',
                            disabled: saving,
                            onClick: () => updateAdvisor(index, { apiKey: '', clearApiKey: true }),
                            style: {
                              cursor: 'pointer',
                              border: '1px solid var(--dsh-color-border, #3a3f4b)',
                              background: 'transparent',
                              color: 'inherit',
                              borderRadius: 4,
                              padding: '4px 10px',
                              fontSize: 12,
                              whiteSpace: 'nowrap',
                            },
                          },
                          '清除',
                        )
                      : null,
                  ),
                  createElement(
                    'div',
                    { style: { fontSize: 12, color: 'var(--dsh-color-muted, #8b90a0)', marginTop: 2 } },
                    keyConfigured
                      ? '已保存该供应商的 API Key（仅显示末 4 位）；留空保存保持原 Key，输入新 Key 覆盖。'
                      : '直接填入 API Key，保存到本地配置。',
                  ),
                  label('协议'),
                  createElement(
                    'select',
                    {
                      'aria-label': '协议',
                      value: advisor.protocol ?? 'openai',
                      onChange: (e: { target: { value: string } }) =>
                        updateAdvisor(index, { protocol: e.target.value as 'openai' | 'anthropic' | 'gemini' }),
                      style: settingsInputStyle,
                    },
                    createElement('option', { value: 'openai' }, 'OpenAI 兼容'),
                    createElement('option', { value: 'anthropic' }, 'Anthropic'),
                    createElement('option', { value: 'gemini' }, 'Gemini'),
                  ),
                ]})()),
          createElement('textarea', {
            'aria-label': 'systemPrompt',
            placeholder: 'systemPrompt',
            rows: 2,
            value: advisor.systemPrompt,
            onChange: (e: { target: { value: string } }) => updateAdvisor(index, { systemPrompt: e.target.value }),
            style: { ...settingsInputStyle, marginTop: 4, resize: 'vertical' },
          }),
          (() => {
            // Tool calling scope, per advisor: only the direct-http channel
            // supports it, so an advisor on a DSH built-in provider (without a
            // direct baseURL/apiKeyEnv) shows an explicit "cannot configure".
            const isBuiltin = providers.some((p) => p.id === advisor.provider && p.kind === 'llm')
            const supportsTools = !isBuiltin || Boolean(advisor.baseURL || advisor.apiKeyEnv)
            const globalDefault = config.discussion.advisorTools ?? 'readonly'
            const mode = advisor.tools ?? globalDefault
            const modeLabel: Record<string, string> = {
              readonly: '只读工具',
              all: '全部会话工具（含可写，慎用）',
              off: '关闭',
            }
            // Mirrors the server-side ADVISOR_TOOL_GUIDANCE (runtime injection,
            // never persisted into advisor.systemPrompt).
            const toolPromptNote =
              '工具启用时，系统提示词会自动追加：『对于你不了解、不熟悉的内容，尤其是项目背景、代码细节、仓库状态等不在知识范围内的情况，请优先使用联网工具（如 web_search、web_fetch）搜索核实后再作答，不要编造未核实的事实。』'
            if (supportsTools) {
              return [
                label(
                  `顾问工具调用范围（未单独设置时跟随全局默认：${modeLabel[globalDefault] ?? globalDefault}）`,
                ),
                createElement(
                  'select',
                  {
                    'aria-label': '顾问工具调用范围',
                    value: mode,
                    onChange: (e: { target: { value: string } }) =>
                      updateAdvisor(index, { tools: e.target.value as 'readonly' | 'all' | 'off' }),
                    style: settingsInputStyle,
                  },
                  createElement('option', { value: 'readonly' }, '只读工具'),
                  createElement('option', { value: 'all' }, '全部会话工具（含可写，慎用）'),
                  createElement('option', { value: 'off' }, '关闭'),
                ),
                mode === 'off'
                  ? null
                  : createElement(
                      'div',
                      {
                        style: {
                          fontSize: 12,
                          color: 'var(--dsh-color-muted, #8b90a0)',
                          border: '1px dashed var(--dsh-color-border, #3a3f4b)',
                          borderRadius: 4,
                          padding: '4px 6px',
                          marginTop: 4,
                        },
                      },
                      toolPromptNote,
                    ),
              ]
            }
            return [
              label('顾问工具调用范围'),
              createElement(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: 'var(--dsh-color-muted, #8b90a0)',
                    border: '1px solid var(--dsh-color-border, #3a3f4b)',
                    borderRadius: 4,
                    padding: '4px 6px',
                  },
                },
                '❌ 当前为 DSH 内置通道（复用 DSH 凭据），不支持工具调用；为其配置 API 地址 / Key / 环境变量以走直连通道后即可启用（工具指引提示词也会随之生效）。',
              ),
            ]
          })(),
          label('思考模式 / 思考强度（未设置 = 跟随模型与供应商默认）'),
          createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 4 } },
            createElement(
              'select',
              {
                'aria-label': '思考模式',
                value: advisor.thinking ?? '',
                onChange: (e: { target: { value: string } }) =>
                  updateAdvisor(index, {
                    thinking: e.target.value === '' ? undefined : (e.target.value as 'enabled' | 'disabled'),
                  }),
                style: settingsInputStyle,
              },
              createElement('option', { value: '' }, '思考：默认'),
              createElement('option', { value: 'enabled' }, '思考：开启'),
              createElement('option', { value: 'disabled' }, '思考：关闭'),
            ),
            createElement(
              'select',
              {
                'aria-label': '思考强度',
                value: advisor.reasoningEffort ?? '',
                onChange: (e: { target: { value: string } }) =>
                  updateAdvisor(index, {
                    reasoningEffort: e.target.value === ''
                      ? undefined
                      : (e.target.value as 'off' | 'low' | 'high' | 'max'),
                  }),
                style: settingsInputStyle,
              },
              createElement('option', { value: '' }, '强度：默认'),
              createElement('option', { value: 'off' }, 'off（不思考）'),
              createElement('option', { value: 'low' }, 'low（低）'),
              createElement('option', { value: 'high' }, 'high（高）'),
              createElement('option', { value: 'max' }, 'max（最大）'),
            ),
          ),
          createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 4 } },
            createElement('input', {
              type: 'number',
              placeholder: 'temperature',
              value: advisor.temperature ?? '',
              onChange: (e: { target: { value: string } }) =>
                updateAdvisor(index, { temperature: e.target.value === '' ? undefined : Number(e.target.value) }),
              style: { ...settingsInputStyle, width: 90 },
            }),
            createElement('input', {
              type: 'number',
              placeholder: 'maxTokens',
              value: advisor.maxTokens ?? '',
              onChange: (e: { target: { value: string } }) =>
                updateAdvisor(index, { maxTokens: e.target.value === '' ? undefined : Number(e.target.value) }),
              style: { ...settingsInputStyle, width: 120 },
            }),
          ),
        ),
      ),
    ),
    createElement(
      'div',
      { style: settingsCardFooterStyle },
      msg
        ? createElement('span', { style: { flex: 1, minWidth: 0, color: '#16a34a', fontSize: 12 } }, msg)
        : null,
      error
        ? createElement('span', { style: { flex: 1, minWidth: 0, color: '#e11d48', fontSize: 12 } }, error)
        : null,
      createElement(
        'button',
        {
          type: 'button',
          disabled: !dirty || saving,
          onClick: () => void reload(),
          style: {
            ...settingsFooterButtonStyle,
            border: '1px solid var(--dsw-alias-border-l2, var(--dsh-color-border, #3a3f4b))',
            background: 'transparent',
            color: 'inherit',
          },
        },
        '放弃更改',
      ),
      createElement(
        'button',
        {
          type: 'button',
          disabled: !dirty || saving,
          onClick: () => void save(),
          style: {
            ...settingsFooterButtonStyle,
            background: 'var(--dsw-alias-label-primary, #e6e9f0)',
            color: 'var(--dsw-alias-bg-layer-3, #151821)',
          },
        },
        saving ? '保存中…' : '保存设置',
      ),
    ),
          ),
        )
      : null,
  )
}

export const name = 'dsh-advisor-group'

export const inject = ['uiConversation', 'slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 0.1.2-rc.1 conversation model: business event Definitions are registered
  // with the target-neutral `uiConversation` registry; the chat target's view
  // builder turns their `buildViewNode` results into renderable chat Nodes.
  ctx.uiConversation.events.register(advisorGroupDefinition)

  // Keyed Chat renderer seat, dispatched by ChatNodeKind (= renderer key).
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'advisor-group',
        locale: 'chat',
      },
      AdvisorGroupNodeView,
    ),
  )

  // Settings plugin card, keyed by the settings namespace the card edits.
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'advisor-group',
      },
      AdvisorGroupSettingsTab,
    ),
  )
}
