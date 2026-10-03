import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleConfigRequest, mayReadBootToken } from '../src/settings-api'

/** Minimal IncomingMessage stand-in: the handler reads url, method and headers. */
function request(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage
}

/** Minimal ServerResponse capturing what sendJson writes. */
function response(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0
  let body = ''
  const res = {
    writeHead(next: number) {
      status = next
    },
    end(chunk?: string) {
      body = chunk ?? ''
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => body,
  }
}

/** The handshake branch answers before ctx/service are ever touched. */
function handler(token = 'boot-token-1') {
  return handleConfigRequest({} as never, {} as never, {} as never, token)
}

// The handshake writes its diagnosis into $DSH_HOME: keep it out of the real one.
let home = ''
const previousHome = process.env.DSH_HOME
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'advisor-group-boot-token-'))
  process.env.DSH_HOME = home
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (home) rmSync(home, { recursive: true, force: true })
})

/** Everything the handshake wrote, for the logging assertions. */
function logText(): string {
  try {
    return readFileSync(join(home, 'storages', 'advisor-group', 'boot-token.log'), 'utf8')
  } catch {
    return ''
  }
}

describe('boot-token handshake', () => {
  it('hands the per-boot token to a page from the app itself', async () => {
    const out = response()
    await handler()(
      request('/advisor-group/boot-token', {
        host: '127.0.0.1:19387',
        'sec-fetch-site': 'same-origin',
      }),
      out.res,
    )
    expect(out.status()).toBe(200)
    expect(JSON.parse(out.body())).toEqual({ ok: true, token: 'boot-token-1' })
  })

  it('hands the token to the desktop shell, which sends no web provenance', async () => {
    // The shell forwards the page request itself, so nothing marks its origin.
    const out = response()
    await handler()(request('/advisor-group/boot-token', { host: '127.0.0.1:19387' }), out.res)
    expect(out.status()).toBe(200)
  })

  it('refuses a foreign page', async () => {
    const out = response()
    await handler()(
      request('/advisor-group/boot-token', {
        host: '127.0.0.1:19387',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      }),
      out.res,
    )
    expect(out.status()).toBe(403)
  })

  it('records every refusal so a failure can be diagnosed from outside', async () => {
    const out = response()
    await handler()(
      request('/advisor-group/boot-token', {
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
      }),
      out.res,
    )
    expect(out.status()).toBe(403)
    expect(logText()).toContain('deny')
    expect(logText()).toContain('origin=https://evil.example')
  })

  it('still rejects a tokenless settings request from the app page', async () => {
    const out = response()
    await handler()(
      request('/advisor-group/config', {
        host: '127.0.0.1:19387',
        'sec-fetch-site': 'same-origin',
      }),
      out.res,
    )
    expect(out.status()).toBe(401)
  })
})

describe('mayReadBootToken', () => {
  it('accepts same-origin provenance', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', 'sec-fetch-site': 'same-origin' }))).toBe(
      true,
    )
  })

  it('accepts a request with no provenance at all', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1' }))).toBe(true)
  })

  it('accepts the desktop shell page, whose origin is not http', () => {
    expect(
      mayReadBootToken(request('/x', { host: 'h:1', origin: 'app://dsh', referer: 'app://dsh/' })),
    ).toBe(true)
  })

  it('accepts an opaque origin', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', origin: 'null' }))).toBe(true)
  })

  it('accepts a referer on the same host', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', referer: 'http://h:1/index.html' }))).toBe(
      true,
    )
  })

  it('refuses an origin from another host', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', origin: 'http://other:2' }))).toBe(false)
  })

  it('refuses a referer from another host', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', referer: 'https://other:2/page' }))).toBe(
      false,
    )
  })

  it('accepts when the request host is unknown, rather than guessing', () => {
    // A real HTTP/1.1 page request always carries Host, so this only spares
    // callers whose provenance cannot be compared at all.
    expect(mayReadBootToken(request('/x', { origin: 'https://evil.example' }))).toBe(true)
  })

  it('accepts unparseable provenance rather than guessing', () => {
    expect(mayReadBootToken(request('/x', { host: 'h:1', origin: 'not a url' }))).toBe(true)
  })
})
