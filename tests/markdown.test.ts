import { describe, expect, it } from 'vitest'
import { renderMarkdown, sanitizeLinkUrl } from '../src/client/markdown'

describe('markdown link sanitization', () => {
  it('allows http/https/mailto/relative links', () => {
    expect(sanitizeLinkUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(sanitizeLinkUrl('http://example.com')).toBe('http://example.com')
    expect(sanitizeLinkUrl('mailto:test@example.com')).toBe('mailto:test@example.com')
    expect(sanitizeLinkUrl('/relative/path')).toBe('/relative/path')
  })

  it('rejects javascript: and data: URLs', () => {
    expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeLinkUrl('JavaScript:alert(1)')).toBeNull()
    expect(sanitizeLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(sanitizeLinkUrl('vbscript:msgbox(1)')).toBeNull()
  })
})

describe('markdown table rendering', () => {
  it('renders a pipe table with thead and tbody', () => {
    const blocks = renderMarkdown('| 列A | 列B |\n| --- | --- |\n| 1 | 2 |') as Array<{
      type: string
      props: { children?: unknown }
    }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('table')
    expect(blocks[0]?.props.children).toBeTruthy()
  })
})

describe('markdown XSS surface', () => {
  it('emits raw HTML as text nodes, not elements', () => {
    const blocks = renderMarkdown('<script>alert(1)</script>') as Array<{
      type: string
      props: { children?: unknown[] }
    }>
    const paragraph = blocks[0]
    expect(paragraph?.type).toBe('p')
    const children = paragraph.props.children as unknown[]
    expect(children.some((child) => typeof child === 'string' && child.includes('<script>'))).toBe(true)
    expect(children.some((child) => typeof child === 'object' && (child as { type?: string }).type === 'script')).toBe(false)
  })

  it('renders a javascript: link as plain text instead of an anchor', () => {
    const blocks = renderMarkdown('[click](javascript:alert(1))') as Array<{
      type: string
      props: { children?: unknown[] }
    }>
    const paragraph = blocks[0]
    const children = paragraph?.props.children as unknown[]
    expect(children.some((child) => typeof child === 'object' && (child as { type?: string }).type === 'a')).toBe(false)
    expect(children.some((child) => typeof child === 'string' && child.includes('[click]'))).toBe(true)
  })
})
