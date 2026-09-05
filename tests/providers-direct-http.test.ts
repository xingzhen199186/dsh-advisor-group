import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { streamDirectHttp, callDirectHttp } from '../src/providers/direct-http'
import { callViaCtxLlm, type TranscriptEntry } from '../src/providers/ctx-llm'
import type { AdvisorConfig } from '../src/config'
import type { Context } from '@deepseek-ai/cordis'

/** Local fake LLM server covering the three protocol families plus fault cases. */
function advisor(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    id: 'contract-anchor',
    name: '契约顾问',
    provider: 'contract-test',
    model: 'fake-model',
    systemPrompt: '你是契约测试专家。',
    protocol: 'openai',
    apiKey: 'sk-contract-key',
    ...overrides,
  }
}

describe('direct-http provider contract', () => {
  let server: Server
  let baseURL: string
  let lastOpenAiBody: unknown
  let lastAnthropicBody: unknown

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? ''
      if (path.includes('/chat/completions') && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
          if (path.includes('tools-openai')) {
            lastOpenAiBody = body
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n')
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n')
            res.write('data: {"choices":[{"delta":{"content":"正文"}}]}\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          if (body.stream === false) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: '非流式答复' } }] }))
            return
          }
          const route = path.includes('truncated')
            ? 'truncated'
            : path.includes('empty')
              ? 'empty'
              : path.includes('401')
                ? '401'
                : path.includes('malformed')
                  ? 'malformed'
                  : path.includes('slow')
                    ? 'slow'
                    : 'ok'
          if (route === '401') {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid key' }))
            return
          }
          if (route === 'slow') {
            // Headers arrive immediately; the body streams one thinking chunk
            // and then stalls well past the client's 80ms timeout — the
            // mid-stream read aborts and must degrade to a marked truncation.
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: {"choices":[{"delta":{"reasoning_content":"慢思考"}}]}\n\n')
            setTimeout(() => res.end(), 800)
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          if (route === 'empty') {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write('data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n')
          if (route === 'ok' || route === 'malformed') {
            if (route === 'malformed') res.write('data: {broken json\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            // truncated: destroy mid-flight after the three frames
            setTimeout(() => res.destroy(), 40)
          }
        })
        return
      }
      if (path.includes('/v1/messages') && req.method === 'POST') {
        if (path.includes('tools-anthropic')) {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            // eslint-disable-next-line no-console
            lastAnthropicBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
          res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } }))
          res.write(frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }))
          res.write(frame({ type: 'content_block_stop', index: 0 }))
          res.write(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }))
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"推演"}}\n\n')
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"结论"}}\n\n')
        res.end()
        return
      }
      if (path.includes('/v1beta/models/') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini 答复' }] } }] }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    baseURL = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })

  const transcript: TranscriptEntry[] = [
    { role: 'main', name: '主模型', content: '契约问题' },
    { role: 'advisor', name: '顾问A', content: '背景' },
  ]

  it('streams OpenAI-compatible chunks (text + reasoning) and completes on [DONE]', async () => {
    const deltas: Array<{ text?: string; thinking?: string }> = []
    const result = await streamDirectHttp(
      advisor({ baseURL, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      (delta) => deltas.push(delta),
    )
    expect(result.content).toBe('你好，世界')
    expect(result.thinking).toBe('思考中')
    expect(deltas).toEqual([{ thinking: '思考中' }, { text: '你好' }, { text: '，世界' }])
  })

  it('keeps partial content on a mid-stream connection drop and marks network truncation', async () => {
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/truncated`, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
    )
    expect(result.content).toBe('你好，世界')
    expect(result.truncated?.reason).toBe('network')
  })

  it('returns empty content for a stream with only [DONE]', async () => {
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/empty`, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
    )
    expect(result.content).toBe('')
  })

  it('throws on non-2xx without echoing the api key', async () => {
    await expect(
      streamDirectHttp(
        advisor({ baseURL: `${baseURL}/401`, protocol: 'openai', apiKey: 'sk-contract-key' }),
        transcript,
        () => {},
      ),
    ).rejects.toThrow(/401/)
    let error: Error | undefined
    try {
      await streamDirectHttp(
        advisor({ baseURL: `${baseURL}/401`, protocol: 'openai', apiKey: 'sk-contract-key' }),
        transcript,
        () => {},
      )
      expect.fail('should have rejected')
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).not.toContain('sk-contract-key')
  })

  it('streams Anthropic thinking and text deltas', async () => {
    const result = await streamDirectHttp(
      advisor({ baseURL, protocol: 'anthropic', authMode: 'x-api-key', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
    )
    expect(result.content).toBe('结论')
    expect(result.thinking).toBe('推演')
  })

  it('supports OpenAI tool-calling: tools in body, tool_calls parsed, final text streamed', async () => {
    const tools = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/tools-openai`, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
      undefined,
      undefined,
      tools,
    )
    const body = lastOpenAiBody as { tools?: Array<{ type: string; function: { name: string; parameters: unknown } }> }
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ])
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'read', argumentsJson: '{"path":"a.txt"}' },
    ])
    expect(result.content).toBe('正文')
  })

  it('supports Anthropic tool-calling: tool_use blocks parsed with input_json_delta', async () => {
    const tools = [{ name: 'read', description: '读文件', parameters: { type: 'object' } }]
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/tools-anthropic`, protocol: 'anthropic', authMode: 'x-api-key', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
      undefined,
      undefined,
      tools,
    )
    const body = lastAnthropicBody as { tools?: Array<{ name: string; description?: string; input_schema: unknown }> }
    expect(body.tools).toEqual([{ name: 'read', description: '读文件', input_schema: { type: 'object' } }])
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'read', argumentsJson: '{"path":"a"}' },
    ])
    expect(result.content).toBe('')
  })

  it('uses the Gemini generateContent endpoint and returns the answer', async () => {
    const result = await streamDirectHttp(
      advisor({ baseURL, protocol: 'gemini', apiKey: 'gemini-key' }),
      transcript,
      () => {},
    )
    expect(result.content).toBe('Gemini 答复')
  })

  it('non-stream callDirectHttp returns the final message content', async () => {
    const content = await callDirectHttp(
      advisor({ baseURL, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
    )
    expect(content).toBe('非流式答复')
  })

  it('ignores malformed SSE frames and keeps valid ones', async () => {
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/malformed`, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
    )
    expect(result.content).toBe('你好，世界')
  })

  it('honors the configurable timeout (timeoutMs) by truncating a slow provider', async () => {
    const started = Date.now()
    const result = await streamDirectHttp(
      advisor({ baseURL: `${baseURL}/slow`, protocol: 'openai', apiKey: 'sk-contract-key' }),
      transcript,
      () => {},
      undefined,
      80,
    )
    expect(Date.now() - started).toBeLessThan(700)
    expect(result.truncated?.reason).toBe('timeout')
    expect(result.thinking).toBe('慢思考')
  })
})

describe('ctx.llm provider contract', () => {
  it('forwards provider/model/system/messages with a combined signal and aggregates deltas', async () => {
    let captured: {
      provider?: string
      model?: string
      system?: string
      messages?: unknown[]
      signal?: AbortSignal
    } = {}
    const fakeCtx = {
      llm: {
        async *stream(options: {
          provider?: string
          model?: string
          system?: string
          messages?: unknown[]
          signal?: AbortSignal
        }) {
          captured = options
          yield { type: 'reasoning-delta', text: '理由' } as never
          yield { type: 'text-delta', text: '答复' } as never
        },
      },
    } as unknown as Context

    const deltas: Array<{ text?: string; thinking?: string }> = []
    const result = await callViaCtxLlm(
      fakeCtx,
      advisor({ protocol: 'openai', apiKey: '' }),
      [{ role: 'main', name: '主模型', content: '问题' }],
      new AbortController().signal,
      (delta) => deltas.push(delta),
      77_000,
    )

    expect(captured.provider).toBe('contract-test')
    expect(captured.model).toBe('fake-model')
    expect(captured.system).toContain('契约测试专家')
    expect(captured.messages).toHaveLength(1)
    expect(captured.signal).toBeDefined()
    expect(result.content).toBe('答复')
    expect(result.truncated).toBeUndefined()
    expect(deltas).toEqual([{ thinking: '理由' }, { text: '答复' }])
  })

  it('marks a provider timeout as truncated instead of a silent empty body', async () => {
    const fakeCtx = {
      llm: {
        async *stream(options: { signal?: AbortSignal }) {
          // Long-reasoning shape: thinking only, then the provider hangs until
          // the combined signal aborts it (dsh-llm throws AbortError here).
          yield { type: 'reasoning-delta', text: '长思考链' } as never
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          })
        },
      },
    } as unknown as Context

    const result = await callViaCtxLlm(
      fakeCtx,
      advisor({ protocol: 'openai', apiKey: '' }),
      [{ role: 'main', name: '主模型', content: '问题' }],
      undefined,
      undefined,
      40,
    )
    expect(result.content).toBe('')
    expect(result.thinking).toBe('长思考链')
    expect(result.truncated?.reason).toBe('timeout')
  })

  it('propagates caller abort as cancellation, not truncation', async () => {
    const controller = new AbortController()
    const fakeCtx = {
      llm: {
        async *stream(options: { signal?: AbortSignal }) {
          yield { type: 'text-delta', text: 'x' } as never
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          })
        },
      },
    } as unknown as Context
    setTimeout(() => controller.abort(), 30)
    await expect(
      callViaCtxLlm(
        fakeCtx,
        advisor({ protocol: 'openai', apiKey: '' }),
        [{ role: 'main', name: '主模型', content: '问题' }],
        controller.signal,
        undefined,
        10_000,
      ),
    ).rejects.toThrow()
  })
})
