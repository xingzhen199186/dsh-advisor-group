import { describe, expect, it } from 'vitest'
import { parseCorpsProposals } from '../src/settings-api'
import type { RosterRow } from '../src/session-roster'
import type { CorpsCards } from '../src/corps'

const rows: RosterRow[] = [
  { sessionId: 's1', name: '架构会话', cwd: 'I:\\a', updatedAt: 1, running: false, subagent: false, hint: '今天', hasTitle: true },
  { sessionId: 's2', name: '财务会话', cwd: 'I:\\b', updatedAt: 2, running: true, subagent: false, hint: '刚刚', hasTitle: true },
]

const cards: CorpsCards = {
  existing: { name: '老王', duty: '架构', updatedAt: 1 },
}

describe('parseCorpsProposals', () => {
  it('parses a fenced JSON object and keeps valid cards', () => {
    const text = '```json\n{"cards":[{"sessionId":"s1","name":"小架","duty":"架构评审"},{"sessionId":"s2","name":"小财","duty":"预算与对账"}]}\n```'
    expect(parseCorpsProposals(text, rows, cards)).toEqual([
      { sessionId: 's1', name: '小架', duty: '架构评审' },
      { sessionId: 's2', name: '小财', duty: '预算与对账' },
    ])
  })

  it('drops unknown ids, duplicate ids, duplicate names and invalid sizes', () => {
    const text = JSON.stringify({
      cards: [
        { sessionId: 's1', name: '小架', duty: '架构' },
        { sessionId: 's1', name: '重复id', duty: '应被丢弃' },
        { sessionId: 'nope', name: '外人', duty: '不在名单' },
        { sessionId: 's2', name: '小架', duty: '重复姓名' },
        { sessionId: 's2', name: '老王', duty: '与已有卡重名' },
        { sessionId: 's2', name: 'x'.repeat(41), duty: '太长' },
      ],
    })
    expect(parseCorpsProposals(text, rows, cards)).toEqual([
      { sessionId: 's1', name: '小架', duty: '架构' },
    ])
  })

  it('returns nothing for prose or malformed JSON', () => {
    expect(parseCorpsProposals('我觉得应该叫老王', rows, cards)).toEqual([])
    expect(parseCorpsProposals('{"cards":[', rows, cards)).toEqual([])
  })

  it('accepts a bare array as well as an object', () => {
    const text = '[{"sessionId":"s1","name":"小架","duty":"架构"}]'
    expect(parseCorpsProposals(text, rows, cards)).toEqual([
      { sessionId: 's1', name: '小架', duty: '架构' },
    ])
  })
})
