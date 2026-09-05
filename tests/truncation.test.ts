import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

/**
 * Truncation surfacing (root cause: 120s advisor timeout silently ended
 * long-reasoning streams mid-thinking with no body). A timed-out advisor call
 * must mark the durable message `truncated` and the final summary must carry a
 * risk note so the main model knows the reply is incomplete.
 */

const ADVISOR: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是专家。',
}

const CONFIG: Config = {
  enabled: true,
  discussion: {
    maxRounds: 2,
    maxAdvisorsPerCall: 3,
    parallel: true,
    autoDeepen: true,
    stopOnConsensus: false,
    advisorTimeoutMs: 60,
  },
  trigger: {
    requireClassifier: true,
    allowWebFallback: true,
    confidenceThreshold: 0.6,
  },
  ui: {
    theme: 'retro-green',
    showTimestamps: true,
    autoExpand: true,
  },
  quota: {
    enabled: false,
    maxPerDay: 50,
  },
  advisors: [ADVISOR],
}

function makeService(): AdvisorGroupService {
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      // The advisor provider IS known to DSH, so callAdvisor uses ctx.llm.
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(options: { signal?: AbortSignal }) {
        // Long-reasoning shape: thinking only, then the provider hangs until
        // the combined signal aborts it (dsh-llm's real behavior: the async
        // iterator just ends / throws AbortError when the signal fires).
        yield { type: 'reasoning-delta', text: '长思考链' } as never
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        })
      },
    },
  } as unknown as Context
  return new AdvisorGroupService(fakeCtx, CONFIG)
}

describe('truncation surfacing (advisor timeout)', () => {
  it('marks the message truncated and adds a summary risk note', async () => {
    const service = makeService()
    const session = service.createSession('测试问题', undefined)
    expect(session).toBeDefined()

    const summary = await service.runOneRoundAndSummarize(session)

    const advisorMessages = session.messages.filter((message) => message.role === 'advisor')
    expect(advisorMessages).toHaveLength(1)
    expect(advisorMessages[0].content).toBe('')
    expect(advisorMessages[0].thinking).toBe('长思考链')
    expect(advisorMessages[0].truncated?.reason).toBe('timeout')

    expect(summary.riskNotes.some((note) => note.includes('截断'))).toBe(true)
  })

  it('does not mark a normal completion as truncated', async () => {
    const fakeCtx = {
      on: () => {},
      emit: () => {},
      llm: {
        listProviders: () => [{ id: 'fake-provider' }],
        async *stream() {
          yield { type: 'reasoning-delta', text: '想' } as never
          yield { type: 'text-delta', text: '答复' } as never
        },
      },
    } as unknown as Context
    const service = new AdvisorGroupService(fakeCtx, CONFIG)
    const session = service.createSession('测试问题', undefined)
    const summary = await service.runOneRoundAndSummarize(session)
    const advisorMessage = session.messages.find((message) => message.role === 'advisor')
    expect(advisorMessage?.content).toBe('答复')
    expect(advisorMessage?.truncated).toBeUndefined()
    expect(summary.riskNotes.some((note) => note.includes('截断'))).toBe(false)
  })
})
