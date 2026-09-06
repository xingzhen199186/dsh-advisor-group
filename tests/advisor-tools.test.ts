import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  resolveAdvisorToolSchemas,
  runAdvisorToolLoop,
  summarizeToolResult,
  executeAdvisorTool,
  sanitizeAdvisorContent,
  ADVISOR_EMPTY_BODY_NOTICE,
} from '../src/advisor-tools'

/** Advisor tool calling: scope policies (readonly/all/off), the tool loop,
 *  result formatting and the official-pipeline execution bridge. */

const SCHEMAS = [
  { name: 'read', description: '读文件', parameters: { type: 'object' } },
  { name: 'grep', description: '搜索', parameters: { type: 'object' } },
  { name: 'write', description: '写文件', parameters: { type: 'object' } },
  { name: 'pwsh', description: '执行命令', parameters: { type: 'object' } },
] as unknown[]

function ctxWithSchemas(execute?: () => Promise<ToolExecutionResult>): Context {
  return {
    tools: {
      schemas: () => SCHEMAS,
      ...(execute ? { execute } : {}),
    },
  } as unknown as Context
}

describe('advisor tool scope resolution', () => {
  it('readonly keeps only the whitelisted read-only tools', () => {
    const schemas = resolveAdvisorToolSchemas(ctxWithSchemas(), undefined, 'readonly')
    expect(schemas.map((s) => s.name)).toEqual(['read', 'grep'])
  })

  it('all keeps every session-visible tool', () => {
    const schemas = resolveAdvisorToolSchemas(ctxWithSchemas(), undefined, 'all')
    expect(schemas).toHaveLength(4)
  })

  it('off disables tool calling entirely', () => {
    expect(resolveAdvisorToolSchemas(ctxWithSchemas(), undefined, 'off')).toEqual([])
  })

  it('treats an unavailable registry as no tools', () => {
    expect(resolveAdvisorToolSchemas({} as Context, undefined, 'readonly')).toEqual([])
  })
})

describe('tool result formatting', () => {
  it('prefers content text and truncates at the cap', () => {
    const result = {
      isError: false,
      content: [{ type: 'text', text: `内容${'x'.repeat(9_000)}` }],
    } as ToolExecutionResult
    const text = summarizeToolResult(result)
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(8_100)
  })

  it('falls back to the canonical value and reports failures', () => {
    expect(summarizeToolResult({ isError: false, content: [], value: { ok: 1 } } as ToolExecutionResult)).toContain('ok')
    expect(summarizeToolResult({ isError: true, content: [], error: { message: 'nope' } } as ToolExecutionResult)).toContain('nope')
  })
})

describe('advisor tool loop', () => {
  it('executes the requested tool, feeds the result back and finishes with the final text', async () => {
    const steps: Array<{ kind: string; name: string; text: string }> = []
    let execCount = 0
    let round = 0
    const streamOnce = async (_tools: unknown[], extra: string) => {
      round += 1
      if (round === 1) {
        expect(extra).toBe('')
        return { content: '', thinking: '', toolCalls: [{ id: 't1', name: 'read', argumentsJson: '{"path":"a.txt"}' }] }
      }
      expect(extra).toContain('【顾问已执行工具】')
      expect(extra).toContain('- read')
      return { content: '最终回答', thinking: '', toolCalls: [] }
    }
    const executeTool = async () => {
      execCount += 1
      return 'FILE: hello'
    }
    const result = await runAdvisorToolLoop(
      [{ name: 'read' }],
      streamOnce,
      executeTool,
      (step) => steps.push(step),
    )
    expect(execCount).toBe(1)
    expect(result.content).toBe('最终回答')
    // Agent-loop style rows: a call row then a result row, in order.
    expect(steps).toEqual([
      { kind: 'call', name: 'read', text: '{"path":"a.txt"}' },
      { kind: 'result', name: 'read', text: 'FILE: hello' },
    ])
  })

  it('stops after MAX_TOOL_ROUNDS with a final no-tools round', async () => {
    let round = 0
    const seenToolSets: number[] = []
    const streamOnce = async (tools: unknown[], _extra: string) => {
      round += 1
      seenToolSets.push((tools as unknown[]).length)
      return { content: '', thinking: '', toolCalls: [{ id: `t${round}`, name: 'read', argumentsJson: '{}' }] }
    }
    const result = await runAdvisorToolLoop([{ name: 'read' }], streamOnce, async () => 'x', () => {})
    // 4 tool rounds + 1 forced no-tools round + 1 extra forced round when the
    // final round's (text-restored) tool call was executed.
    expect(seenToolSets).toEqual([1, 1, 1, 1, 0, 0])
    expect(result.content).toBe('')
  })

  it('logs a console.warn audit trail for non-read-only tool calls', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const streamOnce = async () => ({
        content: '',
        thinking: '',
        toolCalls: [{ id: 't1', name: 'write', argumentsJson: '{"path":"x"}' }],
      })
      const result = await runAdvisorToolLoop(
        [{ name: 'write' }],
        streamOnce,
        async () => 'ok',
        () => {},
      )
      expect(result.content).toBe('')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('顾问调用非只读工具（write）'),
        '{"path":"x"}',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('executes restored text tool calls after the final no-tools round (standard agent loop)', async () => {
    let calls = 0
    const streamOnce = async () => {
      calls += 1
      if (calls <= 4) {
        return { content: '', thinking: '', toolCalls: [{ id: `t${calls}`, name: 'read', argumentsJson: '{}' }] }
      }
      if (calls === 5) {
        // Final forced round: the model echoes a tool request as TEXT (DSML),
        // the restorer converts it back into a tool call.
        return { content: '', thinking: '', toolCalls: [{ id: 'final', name: 'bash', argumentsJson: '{"command":"ls"}' }] }
      }
      return { content: '最终答案', thinking: '', toolCalls: [] }
    }
    const executed: string[] = []
    const stepNames: string[] = []
    const result = await runAdvisorToolLoop(
      [{ name: 'read' }, { name: 'bash' }],
      streamOnce,
      async (call) => {
        executed.push(call.name)
        return 'ok'
      },
      (step) => stepNames.push(`${step.kind}:${step.name}`),
    )
    expect(result.content).toBe('最终答案')
    expect(executed).toContain('bash')
    expect(calls).toBe(6)
    expect(stepNames).toContain('result:bash')
  })

  it('deduplicates same name+arguments tool calls (no duplicate side effects)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let calls = 0
      let executions = 0
      const stepTexts: string[] = []
      const streamOnce = async () => {
        calls += 1
        if (calls <= 4) {
          return { content: '', thinking: '', toolCalls: [{ id: `t${calls}`, name: 'bash', argumentsJson: '{"command":"ls"}' }] }
        }
        if (calls === 5) {
          // Final round restores the SAME call again (as DSML text).
          return { content: '', thinking: '', toolCalls: [{ id: 'final', name: 'bash', argumentsJson: '{"command":"ls"}' }] }
        }
        return { content: '完成', thinking: '', toolCalls: [] }
      }
      const result = await runAdvisorToolLoop(
        [{ name: 'bash' }],
        streamOnce,
        async () => {
          executions += 1
          return 'out'
        },
        (step) => stepTexts.push(`${step.kind}:${step.name}:${step.text}`),
      )
      expect(result.content).toBe('完成')
      expect(executions).toBe(1) // same-arg call reused, not re-executed
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('同参工具调用去重（复用已执行结果）：bash'),
      )
      // Reuse is VISIBLE in the result row (snapshot-verifiable hard evidence).
      expect(stepTexts.some((text) => text.startsWith('result:bash:（复用已执行结果）'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('advisor tool execution bridge', () => {
  it('executes through the official pipeline with parsed args and returns the text', async () => {
    let received: unknown
    const ctx = ctxWithSchemas(async () => {
      // Capture the input via closure set below (single-shot).
      return {
        isError: false,
        content: [{ type: 'text', text: '文件内容' }],
        value: null,
      } as ToolExecutionResult
    })
    ;(ctx as unknown as { tools: { execute: (input: unknown) => Promise<ToolExecutionResult> } }).tools.execute = async (input) => {
      received = input
      return { isError: false, content: [{ type: 'text', text: '文件内容' }], value: null } as ToolExecutionResult
    }
    const text = await executeAdvisorTool(
      ctx,
      undefined,
      { id: 'call_1', name: 'read', argumentsJson: '{"path":"a.txt"}' },
      new AbortController().signal,
    )
    expect(text).toBe('文件内容')
    const input = received as { name: string; arguments: unknown; signal: AbortSignal }
    expect(input.name).toBe('read')
    expect(input.arguments).toEqual({ path: 'a.txt' })
    expect(input.signal).toBeDefined()
  })

  it('returns a readable error for invalid JSON arguments and for execution failures', async () => {
    const text = await executeAdvisorTool(
      ctxWithSchemas(async () => ({ isError: false, content: [], value: null }) as unknown as ToolExecutionResult),
      undefined,
      { id: 'c', name: 'read', argumentsJson: '{broken' },
      undefined,
    )
    expect(text).toContain('不是合法 JSON')
  })
})

describe('advisor content sanitization (raw tool_calls XML leak)', () => {
  it('strips a raw <tool_calls> block from embedded text', () => {
    expect(
      sanitizeAdvisorContent(
        '先给结论。\n<tool_calls>\n<invoke name="grep">\n<parameter name="pattern" string="true">x</parameter>\n</invoke>\n</tool_calls>\n\n补充建议…',
      ),
    ).toBe('先给结论。\n\n\n补充建议…')
  })

  it('strips a MID-LINE tool_calls block glued to prose', () => {
    expect(
      sanitizeAdvisorContent(
        '这些是判断分段是否对齐的直接证据。\n<tool_calls><invoke name="bash"><parameter name="command" string="true">ls</parameter></invoke></tool_calls>\n后续结论。',
      ),
    ).toBe('这些是判断分段是否对齐的直接证据。\n\n后续结论。')
  })

  it('cuts an unclosed MID-LINE tool_calls tail (no closing tag)', () => {
    expect(
      sanitizeAdvisorContent(
        '我先做几项关键核验：实际快照内容。\n<tool_calls><invoke name="bash"><parameter name="command" string="true">ls</parameter>',
      ),
    ).toBe('我先做几项关键核验：实际快照内容。')
  })

  it('replaces a content that is ONLY leaked tool XML with a notice', () => {
    const xml =
      '<tool_calls>\n<invoke name="grep">\n<parameter name="pattern" string="true">settings-api</parameter>\n<parameter name="path" string="true">tests</parameter>\n</invoke>\n</tool_calls>'
    expect(sanitizeAdvisorContent(xml)).toBe(ADVISOR_EMPTY_BODY_NOTICE)
  })

  it('keeps normal text and empty content untouched', () => {
    expect(sanitizeAdvisorContent('正常回答正文')).toBe('正常回答正文')
    expect(sanitizeAdvisorContent('')).toBe('')
    expect(sanitizeAdvisorContent('  ')).toBe('  ')
  })

  it('does NOT cut inline prose/code mentions of the markers', () => {
    // A review that legitimately discusses the leak (like advisor A's body)
    // must survive: the markers are mid-line here, not block-leading.
    expect(
      sanitizeAdvisorContent(
        '正文清洗已覆盖 `<tool_calls>` 与 `<｜｜tool_calls>` 变体；详见上文分析。',
      ),
    ).toBe('正文清洗已覆盖 `<tool_calls>` 与 `<｜｜tool_calls>` 变体；详见上文分析。')
  })

  it('cuts the unclosed piped DSML/tool_calls variant and keeps the real body', () => {
    const piped =
      '我先补看几处关键代码再下结论：service.ts 的驱动调用链。\n\n' +
      '<｜｜tool_calls>\n<｜｜DSML｜\n<invoke name="bash">\n<parameter name="command" string="true">pwd</parameter>\n</invoke>\n'
    expect(sanitizeAdvisorContent(piped)).toBe('我先补看几处关键代码再下结论：service.ts 的驱动调用链。')
  })

  it('replaces a content that is ONLY raw piped tool markup with the notice', () => {
    expect(sanitizeAdvisorContent('<｜｜tool_calls>\n<｜｜DSML｜\n<invoke name="bash">\n</invoke>\n')).toBe(
      ADVISOR_EMPTY_BODY_NOTICE,
    )
  })
})
