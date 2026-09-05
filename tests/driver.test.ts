import { describe, expect, it } from 'vitest'
import {
  FALLBACK_CONCLUSION,
  FALLBACK_DEEPEN_QUESTION,
  generateDeepenQuestion,
  resolveDriverSource,
} from '../src/driver'
import { advisorJoinPrompt, ADVISOR_TOOL_GUIDANCE } from '../src/providers/advisor-prompt'
import type { Session, EpochHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

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

  it('guidance for tool-enabled advisors prioritizes web search over unknown knowledge', () => {
    expect(ADVISOR_TOOL_GUIDANCE).toContain('优先使用联网工具')
    expect(ADVISOR_TOOL_GUIDANCE).toContain('web_search')
    expect(ADVISOR_TOOL_GUIDANCE).toContain('web_fetch')
    expect(ADVISOR_TOOL_GUIDANCE).toContain('不要编造')
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

describe('driver cancellation semantics (stop during generation)', () => {
  it('propagates the caller abort instead of pushing a static fallback question', async () => {
    const controller = new AbortController()
    const fakeCtx = {
      llm: {
        async *stream(options: { signal?: AbortSignal }) {
          yield { type: 'reasoning-delta', text: '想' } as never
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          })
        },
      },
    } as unknown as Context
    const session = {
      messages: [{ role: 'main', content: '问题', ts: 0 }],
    } as never
    setTimeout(() => controller.abort(), 20)
    await expect(
      generateDeepenQuestion(fakeCtx, session, { provider: 'fake-provider', model: 'fake-model' }, controller.signal),
    ).rejects.toThrow()
  })

  it('still falls back to the static text on a real failure (no abort)', async () => {
    const fakeCtx = {
      llm: {
        async *stream() {
          throw new Error('provider exploded')
        },
      },
    } as unknown as Context
    const session = {
      messages: [{ role: 'main', content: '问题', ts: 0 }],
    } as never
    const question = await generateDeepenQuestion(
      fakeCtx,
      session,
      { provider: 'fake-provider', model: 'fake-model' },
      undefined,
    )
    expect(question).toBe(FALLBACK_DEEPEN_QUESTION)
  })
})
