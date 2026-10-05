import { describe, expect, it, vi } from 'vitest'
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
      id: 'sess-1',
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

  it('logs the real failure reason instead of silently degrading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fakeCtx = {
        llm: {
          async *stream() {
            throw new Error('provider exploded')
          },
        },
      } as unknown as Context
      const session = {
        id: 'sess-1',
        messages: [{ role: 'main', content: '问题', ts: 0 }],
      } as never
      const question = await generateDeepenQuestion(
        fakeCtx,
        session,
        { provider: 'fake-provider', model: 'fake-model' },
        undefined,
      )
      expect(question).toBe(FALLBACK_DEEPEN_QUESTION)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('驱动模型生成失败（fake-provider/fake-model）'),
        'sess-1',
        expect.stringContaining('provider exploded'),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('warns on an empty stream (reasoning-only, no exception) and still falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fakeCtx = {
        llm: {
          async *stream() {
            yield { type: 'reasoning-delta', text: '想' } as never
            yield { type: 'reasoning-delta', text: '再想' } as never
          },
        },
      } as unknown as Context
      const session = {
        id: 'sess-1',
        messages: [{ role: 'main', content: '问题', ts: 0 }],
      } as never
      const question = await generateDeepenQuestion(
        fakeCtx,
        session,
        { provider: 'fake-provider', model: 'fake-model' },
        undefined,
      )
      expect(question).toBe(FALLBACK_DEEPEN_QUESTION)
      expect(warn).toHaveBeenCalledTimes(1)
      const [prefix, sessionId, detail] = warn.mock.calls[0] ?? []
      expect(String(prefix)).toContain('驱动模型空响应（fake-provider/fake-model）')
      expect(sessionId).toBe('sess-1')
      expect(String(detail)).toContain('chunks=2 textDeltas=0 reasoningDeltas=2')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('driver advisor accounting (rounds are not extra advisors)', () => {
  /** Capture the system prompt and the user prompt the driver actually sends. */
  function captureCtx(): { ctx: Context; seen: () => { system: string; prompt: string } } {
    let system = ''
    let prompt = ''
    const ctx = {
      llm: {
        async *stream(options: { system?: string; messages?: Array<{ content?: Array<{ text?: string }> }> }) {
          system = options.system ?? ''
          prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
          yield { type: 'text-delta', text: '追问' } as never
        },
      },
    } as unknown as Context
    return { ctx, seen: () => ({ system, prompt }) }
  }

  it('says how many advisors took part and labels each turn with its round', async () => {
    const { ctx, seen } = captureCtx()
    const session = {
      id: 'sess-1',
      messages: [
        { role: 'main', content: '原始问题', ts: 0 },
        { role: 'advisor', advisorId: 'a1', advisorName: '顾问', content: '第一轮意见', round: 1, ts: 1 },
        { role: 'advisor', advisorId: 'a1', advisorName: '顾问', content: '第二轮意见', round: 2, ts: 2 },
      ],
    } as never

    await generateDeepenQuestion(ctx, session, { provider: 'fake-provider', model: 'fake-model' }, undefined)

    const { system, prompt } = seen()
    // One advisor answered twice → the roster must say one, not two.
    expect(system).toContain('本次讨论共有 1 位顾问（顾问）')
    expect(system).toContain('不要把同一位顾问的多轮发言数成多位顾问')
    // …and the transcript keeps each repeated turn distinguishable by round.
    expect(prompt).toContain('[顾问 · 第 1 轮]')
    expect(prompt).toContain('[顾问 · 第 2 轮]')
  })

  it('counts distinct advisors rather than transcript entries', async () => {
    const { ctx, seen } = captureCtx()
    const session = {
      id: 'sess-2',
      messages: [
        { role: 'advisor', advisorId: 'a1', advisorName: '甲', content: 'x', round: 1, ts: 1 },
        { role: 'advisor', advisorId: 'a2', advisorName: '乙', content: 'y', round: 1, ts: 2 },
        { role: 'advisor', advisorId: 'a1', advisorName: '甲', content: 'z', round: 2, ts: 3 },
      ],
    } as never

    await generateDeepenQuestion(ctx, session, { provider: 'fake-provider', model: 'fake-model' }, undefined)

    expect(seen().system).toContain('本次讨论共有 2 位顾问（甲、乙）')
  })
})
