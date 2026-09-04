import { describe, expect, it } from 'vitest'
import {
  FALLBACK_CONCLUSION,
  FALLBACK_DEEPEN_QUESTION,
  resolveDriverSource,
} from '../src/driver'
import { advisorJoinPrompt } from '../src/providers/advisor-prompt'
import type { Session, EpochHeader } from '@deepseek-ai/dsh-session'

function sessionLogWith(header: Partial<EpochHeader> | undefined): Session {
  return {
    requestHeader: () => (header as EpochHeader | undefined),
  } as unknown as Session
}

describe('driver source resolution (current agent model)', () => {
  it('reads provider/model from the session request header first', () => {
    const source = resolveDriverSource(
      sessionLogWith({ config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } as EpochHeader['config'] }),
      { provider: 'fallback', model: 'x' },
    )
    expect(source).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('falls back to the configured driverModel when the header is unreadable', () => {
    expect(resolveDriverSource(undefined, { provider: 'fallback', model: 'model-y' })).toEqual({
      provider: 'fallback',
      model: 'model-y',
    })
    expect(resolveDriverSource(sessionLogWith(undefined), { provider: 'fallback', model: 'model-y' })).toEqual({
      provider: 'fallback',
      model: 'model-y',
    })
  })

  it('returns undefined when neither header nor driverModel provides a route', () => {
    expect(resolveDriverSource(undefined, undefined)).toBeUndefined()
    expect(resolveDriverSource(sessionLogWith({ config: { provider: '', model: '' } as EpochHeader['config'] }), undefined)).toBeUndefined()
  })
})

describe('advisor join relay prompts', () => {
  it('tells the first advisor to answer directly', () => {
    expect(advisorJoinPrompt(1, 3)).toContain('第 1 位接入的顾问')
    expect(advisorJoinPrompt(1, 3)).toContain('最先发言')
  })

  it('tells later advisors to give their own view over the full context, not to repeat', () => {
    const prompt = advisorJoinPrompt(3, 3)
    expect(prompt).toContain('第 3 / 3 位')
    expect(prompt).toContain('第 1 至第 2 位')
    expect(prompt).toContain('独立见解')
    expect(prompt).toContain('不要简单复述')
  })
})

describe('driver fallback texts', () => {
  it('asks a deeper follow-up', () => {
    expect(FALLBACK_DEEPEN_QUESTION).toContain('分歧')
  })
  it('synthesizes the conclusion', () => {
    expect(FALLBACK_CONCLUSION).toContain('共识')
  })
})
