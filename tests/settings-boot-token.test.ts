import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleConfigRequest, isSameOriginPageRequest } from '../src/settings-api'

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

describe('boot-token handshake', () => {
  it('hands the per-boot token to the app page', async () => {
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

  it('refuses a request without browser provenance headers', async () => {
    const out = response()
    await handler()(request('/advisor-group/boot-token'), out.res)
    expect(out.status()).toBe(403)
  })

  it('refuses a cross-site page', async () => {
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

describe('isSameOriginPageRequest', () => {
  it('accepts same-origin provenance', () => {
    expect(
      isSameOriginPageRequest(request('/x', { host: 'h:1', 'sec-fetch-site': 'same-origin' })),
    ).toBe(true)
  })

  it('accepts a legacy client whose referer host matches', () => {
    expect(
      isSameOriginPageRequest(request('/x', { host: 'h:1', referer: 'http://h:1/index.html' })),
    ).toBe(true)
  })

  it('refuses a referer from another host', () => {
    expect(isSameOriginPageRequest(request('/x', { host: 'h:1', referer: 'http://other:2/' }))).toBe(
      false,
    )
  })

  it('refuses unparseable provenance', () => {
    expect(isSameOriginPageRequest(request('/x', { host: 'h:1', origin: 'not a url' }))).toBe(false)
  })
})
