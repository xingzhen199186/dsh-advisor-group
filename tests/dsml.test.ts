import { describe, expect, it } from 'vitest'
import { parseTextToolCalls } from '../src/dsml'

const ALLOWED = new Set(['read', 'grep', 'bash', 'write'])

describe('DeepSeek DSML text tool-call restorer', () => {
  it('parses canonical DSML outer block (V4 tool_calls + ｜DSML｜ invoke/parameter)', () => {
    const content =
      '先做核验。\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="grep">\n<｜DSML｜parameter name="pattern" string="true">x</｜DSML｜parameter>\n<｜DSML｜parameter name="path" string="true">src</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>\n\n结论。'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([
      { id: 'text-0', name: 'grep', argumentsJson: '{"pattern":"x","path":"src"}' },
    ])
    expect(result.cleaned).toBe('先做核验。\n\n\n结论。')
  })

  it('parses the observed plain variant (no ｜DSML｜ prefix, optional string attr) with an UNCLOSED outer block', () => {
    const content =
      '证据。<tool_calls><invoke name="bash"><parameter name="command" string="true">ls</parameter></invoke>'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([{ id: 'text-0', name: 'bash', argumentsJson: '{"command":"ls"}' }])
    expect(result.cleaned).toBe('证据。')
  })

  it('parses the piped outer variant <｜｜tool_calls> with plain inner tags', () => {
    const content =
      '我先补看几处关键代码。\n\n<｜｜tool_calls>\n<｜｜DSML｜\n<invoke name="read">\n<parameter name="file_path" string="true">a.txt</parameter>\n</invoke>\n'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([{ id: 'text-0', name: 'read', argumentsJson: '{"file_path":"a.txt"}' }])
    expect(result.cleaned).toBe('我先补看几处关键代码。')
  })

  it('does NOT parse DSML syntax inside fenced code blocks (讲解场景)', () => {
    const content =
      '语法如下：\n```\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>\n```\n以上。'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([])
    expect(result.cleaned).toBe(content)
  })

  it('rejects a block whose parameter value contains a nested <parameter> (ambiguous boundary)', () => {
    const content =
      '<tool_calls><invoke name="grep"><parameter name="pattern" string="true">x<parameter name="y" string="true">z</parameter></parameter></invoke></tool_calls>'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([])
  })

  it('rejects a block invoking a NON-whitelisted tool name', () => {
    const content =
      '<tool_calls><invoke name="config_backup"><parameter name="a" string="true">1</parameter></invoke></tool_calls>'
    const result = parseTextToolCalls(content, ALLOWED)
    expect(result.toolCalls).toEqual([])
  })

  it('returns untouched input for empty/no-marker content', () => {
    expect(parseTextToolCalls('', ALLOWED)).toEqual({ toolCalls: [], cleaned: '' })
    expect(parseTextToolCalls('普通正文', ALLOWED)).toEqual({ toolCalls: [], cleaned: '普通正文' })
    expect(parseTextToolCalls('提及 `<tool_calls>` 语法', new Set())).toEqual({
      toolCalls: [],
      cleaned: '提及 `<tool_calls>` 语法',
    })
  })
})
