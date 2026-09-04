import { createElement, type CSSProperties, type ReactNode } from 'react'

const inlineCodeStyle: CSSProperties = {
  fontFamily: "'Courier New', ui-monospace, SFMono-Regular, monospace",
  fontSize: 12,
  background: 'rgba(34,197,94,0.10)',
  border: '1px solid rgba(34,197,94,0.25)',
  borderRadius: 3,
  padding: '0 3px',
}

const codeBlockStyle: CSSProperties = {
  fontFamily: "'Courier New', ui-monospace, SFMono-Regular, monospace",
  fontSize: 12,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const preStyle: CSSProperties = {
  margin: '4px 0',
  padding: '6px 8px',
  border: '1px dashed #2f9e44',
  borderRadius: 3,
  background: 'rgba(0,0,0,0.35)',
  overflowX: 'auto',
}

const linkStyle: CSSProperties = {
  color: '#86efac',
  textDecoration: 'underline',
}

const quoteStyle: CSSProperties = {
  margin: '4px 0',
  padding: '2px 8px',
  borderLeft: '3px solid #4ade80',
  color: '#a7f3d0',
  background: 'rgba(34,197,94,0.06)',
  borderRadius: 2,
}

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  margin: '4px 0',
  width: '100%',
  fontSize: 12,
}

const thStyle: CSSProperties = {
  border: '1px solid #2f9e44',
  padding: '3px 6px',
  textAlign: 'left',
  color: '#d9f99d',
  background: 'rgba(34,197,94,0.08)',
}

const tdStyle: CSSProperties = {
  border: '1px solid #2f9e44',
  padding: '3px 6px',
  verticalAlign: 'top',
}

/**
 * Allow only safe link protocols. `javascript:` / `data:` / `vbscript:` are
 * refused and rendered as plain text instead of an anchor.
 */
export function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^mailto:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return trimmed
  return null
}

function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const regex =
    /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let key = 0
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index))
    }
    if (match[1] !== undefined) {
      nodes.push(createElement('strong', { key: `b${key}` }, match[2]))
    } else if (match[3] !== undefined) {
      nodes.push(createElement('em', { key: `i${key}` }, match[4]))
    } else if (match[5] !== undefined) {
      nodes.push(createElement('code', { key: `c${key}`, style: inlineCodeStyle }, match[6]))
    } else if (match[7] !== undefined) {
      const safeUrl = sanitizeLinkUrl(match[9] ?? '')
      if (safeUrl === null) {
        // Render unsafe links as plain text; never emit a javascript:/data: href.
        nodes.push(match[7])
      } else {
        nodes.push(
          createElement(
            'a',
            { key: `a${key}`, href: safeUrl, target: '_blank', rel: 'noreferrer', style: linkStyle },
            match[8],
          ),
        )
      }
    }
    lastIndex = index + match[0].length
    key += 1
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.startsWith('```') ||
    /^#{1,4}\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    line.startsWith('>') ||
    /^(-{3,}|\*{3,})$/.test(trimmed) ||
    /^\|.*\|/.test(trimmed)
  )
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function splitTableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map((cell) => cell.trim())
}

/**
 * Tiny markdown renderer covering what advisor models actually emit: headings,
 * bold/italic/inline code, fenced code blocks, lists, blockquotes, links,
 * tables and horizontal rules. Text is emitted exclusively as React text
 * nodes (never as HTML), so LLM output is escaped by React; the only extra
 * sanitization needed is the link protocol whitelist above.
 */
export function renderMarkdown(content: string): ReactNode[] {
  const lines = content.split('\n')
  const blocks: ReactNode[] = []
  let blockKey = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i += 1
      continue
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const code: string[] = []
      i += 1
      while (i < lines.length && lines[i].trim() !== '```') {
        code.push(lines[i])
        i += 1
      }
      i += 1 // skip closing fence
      blocks.push(
        createElement(
          'pre',
          { key: `pre${blockKey}`, style: preStyle },
          createElement('code', { style: codeBlockStyle }, code.join('\n')),
        ),
      )
      blockKey += 1
      continue
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const size = [16, 15, 14, 13][level - 1] ?? 13
      blocks.push(
        createElement(
          `h${level}` as 'h1',
          {
            key: `h${blockKey}`,
            style: {
              fontSize: size,
              fontWeight: 700,
              margin: '6px 0 2px',
              color: '#d9f99d',
              lineHeight: 1.4,
            },
          },
          inlineNodes(heading[2]),
        ),
      )
      blockKey += 1
      i += 1
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(
        createElement('hr', {
          key: `hr${blockKey}`,
          style: { border: 'none', borderTop: '1px dashed #2f9e44', margin: '6px 0' },
        }),
      )
      blockKey += 1
      i += 1
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push(
        createElement(
          'div',
          { key: `q${blockKey}`, style: quoteStyle },
          renderMarkdown(quote.join('\n')),
        ),
      )
      blockKey += 1
      continue
    }

    // Table: header row, separator row, body rows.
    if (/^\|.*\|/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      const header = splitTableRow(line)
      i += 2 // skip header + separator
      const rows: string[][] = []
      while (i < lines.length && /^\|.*\|/.test(lines[i].trim())) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push(
        createElement(
          'table',
          { key: `t${blockKey}`, style: tableStyle },
          createElement(
            'thead',
            { key: `th${blockKey}` },
            createElement(
              'tr',
              { key: `trh${blockKey}` },
              header.map((cell, index) =>
                createElement('th', { key: `thc${blockKey}-${index}`, style: thStyle }, inlineNodes(cell)),
              ),
            ),
          ),
          createElement(
            'tbody',
            { key: `tb${blockKey}` },
            rows.map((row, rowIndex) =>
              createElement(
                'tr',
                { key: `tr${blockKey}-${rowIndex}` },
                row.map((cell, cellIndex) =>
                  createElement(
                    'td',
                    { key: `td${blockKey}-${rowIndex}-${cellIndex}`, style: tdStyle },
                    inlineNodes(cell),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      blockKey += 1
      continue
    }

    // Bullet / ordered list
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line)
      const items: string[] = []
      while (
        i < lines.length &&
        (/^[-*]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))
      ) {
        items.push(lines[i].replace(/^([-*]|\d+\.)\s+/, ''))
        i += 1
      }
      blocks.push(
        createElement(
          ordered ? 'ol' : 'ul',
          {
            key: `l${blockKey}`,
            style: { margin: '4px 0', paddingLeft: 20, lineHeight: 1.5 },
          },
          items.map((item, index) =>
            createElement('li', { key: `li${blockKey}-${index}` }, inlineNodes(item)),
          ),
        ),
      )
      blockKey += 1
      continue
    }

    // Paragraph
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push(
      createElement(
        'p',
        { key: `p${blockKey}`, style: { margin: '4px 0', lineHeight: 1.5 } },
        inlineNodes(paragraph.join(' ')),
      ),
    )
    blockKey += 1
  }

  return blocks
}
