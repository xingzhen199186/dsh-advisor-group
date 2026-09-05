import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  SettingsConflictError,
  type SettingsNamespace,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import { Config, type AdvisorConfig, type Config as ConfigShape } from './config'
import { PROVIDER_PRESETS } from './providers/presets'
import { subscribe } from './stream-channel'
import { readShadowSamples } from './shadow'
import type { AdvisorGroupService } from './service'

type ScopedContext = Context & {
  settings: SettingsProvider
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
    tapIndex?(transform: (html: string) => string): () => void
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Mask a stored API key so it never leaves the host in plain text. */
export function maskApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return apiKey
  if (apiKey.length <= 4) return '*'.repeat(apiKey.length)
  return `${'*'.repeat(apiKey.length - 4)}${apiKey.slice(-4)}`
}

/**
 * Whether an inbound apiKey is a mask of the previously stored key.
 *
 * Accepts both the current length-preserving mask and the legacy 8-character
 * `****<last4>` mask so an unrefreshed settings page does not overwrite the
 * real key with a mask string after upgrading.
 */
function isMaskedApiKey(incoming: string | undefined, previous: string | undefined): boolean {
  if (!incoming || !previous) return false
  if (incoming === maskApiKey(previous)) return true
  if (previous.length <= 4) return incoming === '*'.repeat(previous.length)
  return incoming === `****${previous.slice(-4)}`
}

/**
 * Return a copy of the config safe to send to the browser.
 *
 * 0.1.2-rc.1 SecretField convergence: no key material (not even a mask) leaves
 * the host. `apiKey` is returned empty and per-provider presence facts
 * (`configured` + `last4`) ride in `apiKeyMetaByProvider`, so the card can
 * render the official "已配置/未配置" badge and publish new/cleared keys
 * without ever round-tripping a mask.
 */
function sanitizeConfig(config: ConfigShape): ConfigShape {
  return {
    ...config,
    advisors: config.advisors.map((advisor) => {
      const {
        apiKeysByProvider: _apiKeysByProvider,
        clearApiKey: _clearApiKey,
        apiKeyMetaByProvider: _meta,
        ...rest
      } = advisor
      const meta: Record<string, { configured: boolean; last4?: string }> = {}
      for (const [provider, key] of Object.entries(advisor.apiKeysByProvider ?? {})) {
        if (key) meta[provider] = { configured: true, last4: key.slice(-4) }
      }
      if (advisor.apiKey && advisor.provider) {
        meta[advisor.provider] = { configured: true, last4: advisor.apiKey.slice(-4) }
      }
      return {
        ...rest,
        apiKey: '',
        ...(Object.keys(meta).length > 0 ? { apiKeyMetaByProvider: meta } : {}),
      }
    }),
  }
}

/** Credential-affecting fields: changing any of these invalidates a stored key. */
function hasSameCredentialScope(a: AdvisorConfig, b: AdvisorConfig): boolean {
  return (
    a.provider === b.provider &&
    normalizeBase(a.baseURL ?? '') === normalizeBase(b.baseURL ?? '') &&
    (a.apiKeyEnv ?? '') === (b.apiKeyEnv ?? '') &&
    (a.protocol ?? 'openai') === (b.protocol ?? 'openai') &&
    (a.authMode ?? 'x-api-key') === (b.authMode ?? 'x-api-key')
  )
}

/**
 * Reconcile inbound advisor config with the currently stored config.
 *
 * SecretField semantics (adopted from the official settings-card model):
 * - `clearApiKey: true` → drop the active key AND this provider's archived
 *   copy (the explicit "清除" action).
 * - An empty/undefined apiKey on the same credential scope → KEEP the stored
 *   key (an empty field never clears; the old mask-echo path is retained as a
 *   defensive fallback only).
 * - A new plain-text key wins and is remembered for the current provider.
 * - Credential scope changed with no new key → restore from per-provider
 *   history when one exists, otherwise the active key is undefined.
 * The transient `clearApiKey` flag is stripped before persistence.
 */
export function reconcileApiKeys(incoming: ConfigShape, previous: ConfigShape): ConfigShape {
  const previousById = new Map(previous.advisors.map((advisor) => [advisor.id, advisor]))
  return {
    ...incoming,
    advisors: incoming.advisors.map((advisor) => {
      const { clearApiKey, ...advisorRest } = advisor
      const prev = previousById.get(advisor.id)
      if (!prev) {
        return {
          ...advisorRest,
          apiKeysByProvider: advisorRest.apiKeysByProvider ?? {},
        }
      }

      // Server-side per-provider key history. Preserve everything known, then
      // remember the previous active key under its own provider so a later
      // switch back can restore it.
      const history: Record<string, string> = { ...(prev.apiKeysByProvider ?? {}) }
      if (prev.apiKey && prev.provider) history[prev.provider] = prev.apiKey

      const maskedSame = isMaskedApiKey(
        advisorRest.apiKey ?? undefined,
        prev.apiKey ?? undefined,
      )
      const sameScope = hasSameCredentialScope(advisorRest, prev)

      let nextApiKey: string | undefined

      if (clearApiKey === true) {
        // Explicit clear: the user wants this provider's key gone for good.
        nextApiKey = undefined
        if (advisorRest.provider) delete history[advisorRest.provider]
      } else if (sameScope && maskedSame) {
        nextApiKey = prev.apiKey
      } else if (
        advisorRest.apiKey &&
        !isMaskedApiKey(advisorRest.apiKey ?? undefined, prev.apiKey ?? undefined)
      ) {
        // A new plaintext key for the currently selected provider.
        nextApiKey = advisorRest.apiKey
        if (advisorRest.provider) history[advisorRest.provider] = advisorRest.apiKey
      } else if (!sameScope) {
        // Provider/baseURL/protocol/auth mode changed and the client did not
        // send a new key. Restore from history if we have one for this
        // provider; otherwise clear the active key.
        nextApiKey = advisorRest.provider ? history[advisorRest.provider] : undefined
      } else {
        // Same scope, empty field → keep the stored key (SecretField semantics).
        nextApiKey = prev.apiKey
      }

      const { apiKeyMetaByProvider: _inputMeta, ...clean } = advisorRest
      return { ...clean, apiKey: nextApiKey, apiKeysByProvider: history }
    }),
  }
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += String(chunk)
      if (data.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const LOOKUP_KEYS = ['provider', 'baseURL', 'apiKey', 'apiKeyEnv', 'protocol', 'authMode', 'advisorId'] as const

async function parseLookupParams(req: IncomingMessage): Promise<Record<string, string>> {
  const url = new URL(req.url ?? '', 'http://localhost')
  const params: Record<string, string> = {}
  for (const key of LOOKUP_KEYS) {
    params[key] = url.searchParams.get(key) ?? ''
  }
  if (req.method === 'POST') {
    const raw = await readBody(req, 1024 * 1024)
    if (raw) {
      try {
        const body = JSON.parse(raw) as Record<string, unknown>
        for (const key of LOOKUP_KEYS) {
          if (typeof body[key] === 'string') params[key] = body[key]
        }
      } catch {
        // Malformed body is handled by the caller.
      }
    }
  }
  return params
}

const ALLOWED_API_KEY_ENVS = new Set(
  Object.values(PROVIDER_PRESETS).map((preset) => preset.apiKeyEnv),
)

function validateSecurity(input: ConfigShape): string | null {
  const ids = new Set<string>()
  for (const advisor of input.advisors) {
    if (ids.has(advisor.id)) {
      return `顾问 id 重复：${advisor.id}`
    }
    ids.add(advisor.id)

    if (advisor.baseURL) {
      const url = advisor.baseURL.trim()
      const allowed =
        url.startsWith('https://') ||
        url.startsWith('http://127.0.0.1') ||
        url.startsWith('http://localhost')
      if (!allowed) {
        return `顾问 ${advisor.id} 的 API 地址仅允许 https:// 或本机 http://127.0.0.1 / http://localhost`
      }
    }

    if (advisor.apiKeyEnv) {
      const env = advisor.apiKeyEnv.trim()
      if (!ALLOWED_API_KEY_ENVS.has(env)) {
        return `顾问 ${advisor.id} 的 API Key 不被允许：${env}。请使用预设供应商对应的 API Key。`
      }
    }
  }
  return null
}

function normalizeBase(baseURL?: string): string {
  return (baseURL ?? '').replace(/\/+$/, '')
}

/** Loopback hostnames explicitly permitted for local diagnostic HTTP. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/** IPv4 literals in non-public ranges (private, loopback, link-local, CGNAT meta). */
const NON_PUBLIC_IPV4 = /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[0-1])\.|192\.168\.|0\.)/i

/** Well-known cloud metadata endpoints that must never be probed. */
const METADATA_HOSTNAME = /(?:^|\.)(?:metadata\.google\.internal|metadata\.gcp\.internal|metadata\.azure\.com)$/i

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * SSRF guard for the diagnostics endpoints (models list / connection test).
 *
 * Diagnostics accept a client-supplied baseURL at request time, so the same
 * https/loopback rule as `validateSecurity` is enforced HERE as well, plus
 * stricter host rules: no IP literals (private/loopback/link-local/metadata)
 * under https, and no cloud metadata hostnames. The fetch layer additionally
 * refuses redirects (`redirect: 'error'`). DNS-rebinding protection (a domain
 * resolving to an internal address) is out of scope for a local single-user
 * host and is documented as a known limit.
 *
 * @returns the rejection reason, or null when the base URL is acceptable.
 */
export function assertSafeDiagnosticBase(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return '缺少 baseURL'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'baseURL 不是合法 URL'
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol === 'https:') {
    if (isIpLiteral(host) || NON_PUBLIC_IPV4.test(host)) {
      return 'baseURL 不允许使用 IP 字面量'
    }
    if (METADATA_HOSTNAME.test(host)) return 'baseURL 不允许访问云元数据地址'
    return null
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(host)) return null
  return 'baseURL 仅允许 https:// 或本机 http://127.0.0.1 / http://localhost'
}

/**
 * Resolve the real API key for diagnostics (models list / connection test).
 *
 * The browser form can only ever hold a masked or empty key, so a direct
 * pass-through would send `****xxxx` (or nothing) to the provider and fail
 * with HTTP 401 — exactly what happens after switching a provider away and
 * back. The host keeps the real key (`advisor.apiKey` for the active scope +
 * `apiKeysByProvider` history), so when the inbound key is empty or a mask of
 * the stored key, substitute the stored one. A fresh plaintext key typed into
 * the form always wins.
 */
export function resolveDiagnosticApiKey(
  service: Pick<AdvisorGroupService, 'getConfig'>,
  advisorId: string | undefined,
  provider: string,
  baseURL: string,
  apiKeyEnv: string,
  protocol: string,
  incomingApiKey: string,
): string {
  if (!advisorId) return incomingApiKey
  const stored = service.getConfig().advisors.find((advisor) => advisor.id === advisorId)
  if (!stored) return incomingApiKey
  const sameScope =
    stored.provider === provider &&
    normalizeBase(stored.baseURL ?? '') === normalizeBase(baseURL) &&
    (stored.apiKeyEnv ?? '') === apiKeyEnv &&
    (stored.protocol ?? 'openai') === (protocol || 'openai')
  const storedKey = sameScope ? stored.apiKey : stored.apiKeysByProvider?.[provider]
  if (!storedKey) return incomingApiKey
  // An empty field or an inbound mask of the stored key means "the stored key
  // applies here": substitute the real one. All other non-empty values are
  // treated as the user's newly typed plaintext key.
  if (!incomingApiKey || isMaskedApiKey(incomingApiKey, storedKey)) return storedKey
  return incomingApiKey
}

async function queryOpenAiModels(baseURL: string, apiKey: string): Promise<string[]> {
  const base = normalizeBase(baseURL)
  const endpoint = base.endsWith('/models') ? base : `${base}/models`
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    // Diagnostics never follow a redirect away from the validated base URL.
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as { data?: Array<{ id?: string }> }
  return (data.data ?? []).map((item) => item.id ?? '').filter(Boolean)
}

async function queryAnthropicModels(
  baseURL: string,
  apiKey: string,
  authMode: 'x-api-key' | 'bearer' = 'x-api-key',
): Promise<string[]> {
  const base = normalizeBase(baseURL)
  const endpoint = base.endsWith('/v1/models')
    ? base
    : base.endsWith('/v1')
      ? `${base}/models`
      : `${base}/v1/models`
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (authMode === 'bearer') {
    headers['authorization'] = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
  }
  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(15_000),
    // Diagnostics never follow a redirect away from the validated base URL.
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as { data?: Array<{ id?: string }> }
  return (data.data ?? []).map((item) => item.id ?? '').filter(Boolean)
}

async function queryGeminiModels(baseURL: string, apiKey: string): Promise<string[]> {
  const base = normalizeBase(baseURL)
  const endpoint = base.endsWith('/v1beta')
    ? `${base}/models?key=${apiKey}`
    : `${base}/v1beta/models?key=${apiKey}`
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(15_000),
    // Diagnostics never follow a redirect away from the validated base URL.
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as { models?: Array<{ name?: string }> }
  return (data.models ?? [])
    .map((item) => (item.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
}

async function handleModelsRequest(
  ctx: Context,
  service: AdvisorGroupService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = await parseLookupParams(req)
  const provider = params.provider ?? ''
  const baseURL = params.baseURL ?? ''
  const apiKey = params.apiKey ?? ''
  const apiKeyEnv = params.apiKeyEnv ?? ''
  const protocol = params.protocol ?? 'openai'
  const advisorId = params.advisorId ?? ''

  if (!provider) {
    sendJson(res, 400, { ok: false, error: '缺少 provider 参数' })
    return
  }

  // If DSH has this provider route, use the authoritative ctx.llm model list.
  try {
    const llmProviders = await ctx.llm.listProviders()
    if (llmProviders.some((item) => item.id === provider)) {
      const list = await ctx.llm.listModels(provider)
      sendJson(res, 200, { ok: true, models: list.map((item) => item.id) })
      return
    }
  } catch {
    // Fall through to direct HTTP fetch below.
  }

  const preset = Object.values(PROVIDER_PRESETS).find((item) => item.id === provider)
  const effectiveBase = normalizeBase(baseURL || preset?.baseURL)
  const effectiveEnv = apiKeyEnv || preset?.apiKeyEnv || ''
  const effectiveProtocol = (protocol || preset?.protocol || 'openai') as 'openai' | 'anthropic' | 'gemini'
  const effectiveAuthMode = preset?.authMode ?? 'x-api-key'
  const fetchBase = normalizeBase(preset?.modelsBaseURL || effectiveBase)
  const fetchProtocol = preset?.modelsBaseURL ? 'openai' : effectiveProtocol
  const fetchAuthMode = preset?.modelsAuthMode ?? (preset?.modelsBaseURL ? 'bearer' : effectiveAuthMode)

  if (!effectiveBase || (!apiKey && !effectiveEnv)) {
    sendJson(res, 400, { ok: false, error: '该预设缺少 baseURL 或 API Key' })
    return
  }
  if (!apiKey && effectiveEnv && !ALLOWED_API_KEY_ENVS.has(effectiveEnv)) {
    sendJson(res, 400, { ok: false, error: 'API Key 不能使用该环境变量名' })
    return
  }
  const baseError = assertSafeDiagnosticBase(effectiveBase)
  if (baseError) {
    sendJson(res, 400, { ok: false, error: baseError })
    return
  }

  const resolvedApiKey =
    resolveDiagnosticApiKey(service, advisorId, provider, baseURL, apiKeyEnv, protocol, apiKey) ||
    (effectiveEnv ? process.env[effectiveEnv] ?? '' : '')
  if (!resolvedApiKey) {
    sendJson(res, 400, { ok: false, error: 'API Key 未设置' })
    return
  }

  try {
    let models: string[] = []
    if (fetchProtocol === 'anthropic') {
      models = await queryAnthropicModels(fetchBase, resolvedApiKey, fetchAuthMode)
    } else if (fetchProtocol === 'gemini') {
      models = await queryGeminiModels(fetchBase, resolvedApiKey)
    } else {
      models = await queryOpenAiModels(fetchBase, resolvedApiKey)
    }
    sendJson(res, 200, { ok: true, models })
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function handleTestConnectionRequest(
  ctx: Context,
  service: AdvisorGroupService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = await parseLookupParams(req)
  const provider = params.provider ?? ''
  const baseURL = params.baseURL ?? ''
  const apiKey = params.apiKey ?? ''
  const apiKeyEnv = params.apiKeyEnv ?? ''
  const protocol = params.protocol ?? 'openai'
  const advisorId = params.advisorId ?? ''

  if (!provider) {
    sendJson(res, 400, { ok: false, error: '缺少 provider 参数' })
    return
  }

  // DSH provider route: verifying listModels is a good connection test.
  try {
    const llmProviders = await ctx.llm.listProviders()
    if (llmProviders.some((item) => item.id === provider)) {
      const list = await ctx.llm.listModels(provider)
      sendJson(res, 200, { ok: true, message: '连接成功', modelCount: list.length })
      return
    }
  } catch {
    // Fall through to direct HTTP fetch below.
  }

  const preset = Object.values(PROVIDER_PRESETS).find((item) => item.id === provider)
  const effectiveBase = normalizeBase(baseURL || preset?.baseURL)
  const effectiveEnv = apiKeyEnv || preset?.apiKeyEnv || ''
  const effectiveProtocol = (protocol || preset?.protocol || 'openai') as 'openai' | 'anthropic' | 'gemini'
  const effectiveAuthMode = preset?.authMode ?? 'x-api-key'
  const fetchBase = normalizeBase(preset?.modelsBaseURL || effectiveBase)
  const fetchProtocol = preset?.modelsBaseURL ? 'openai' : effectiveProtocol
  const fetchAuthMode = preset?.modelsAuthMode ?? (preset?.modelsBaseURL ? 'bearer' : effectiveAuthMode)

  if (!effectiveBase || (!apiKey && !effectiveEnv)) {
    sendJson(res, 400, { ok: false, error: '该预设缺少 baseURL 或 API Key' })
    return
  }
  if (!apiKey && effectiveEnv && !ALLOWED_API_KEY_ENVS.has(effectiveEnv)) {
    sendJson(res, 400, { ok: false, error: 'API Key 不能使用该环境变量名' })
    return
  }
  const baseError = assertSafeDiagnosticBase(effectiveBase)
  if (baseError) {
    sendJson(res, 400, { ok: false, error: baseError })
    return
  }

  const resolvedApiKey =
    resolveDiagnosticApiKey(service, advisorId, provider, baseURL, apiKeyEnv, protocol, apiKey) ||
    (effectiveEnv ? process.env[effectiveEnv] ?? '' : '')
  if (!resolvedApiKey) {
    sendJson(res, 400, { ok: false, error: 'API Key 未设置' })
    return
  }

  try {
    let models: string[] = []
    if (fetchProtocol === 'anthropic') {
      models = await queryAnthropicModels(fetchBase, resolvedApiKey, fetchAuthMode)
    } else if (fetchProtocol === 'gemini') {
      models = await queryGeminiModels(fetchBase, resolvedApiKey)
    } else {
      models = await queryOpenAiModels(fetchBase, resolvedApiKey)
    }
    sendJson(res, 200, { ok: true, message: '连接成功', modelCount: models.length })
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function currentRevision(
  scopedCtx: ScopedContext,
  namespace: SettingsNamespace,
): number {
  return scopedCtx.settings.describe().find((descriptor) => descriptor.ns === namespace)?.revision ?? 0
}

function handleStreamRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (!sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: '缺少 sessionId' }))
    return Promise.resolve()
  }

  // Support both SSE's native Last-Event-ID (browser auto-reconnect) and an
  // explicit query param (fresh EventSource after a page refresh). bootId lets
  // the server detect restarts and ask the client to resync instead of
  // silently dropping frames.
  const lastEventIdRaw =
    url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? '0'
  const lastEventId = Number.parseInt(String(lastEventIdRaw), 10) || 0
  const bootId = url.searchParams.get('bootId') ?? undefined

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  // Keep the handler pending until the client disconnects. This prevents the
  // web server framework from treating the SSE request as finished.
  return new Promise<void>((resolve) => {
    res.on('close', resolve)
    subscribe(sessionId, res, lastEventId, bootId)
  })
}

function handleConfigRequest(
  ctx: Context,
  scopedCtx: ScopedContext,
  service: AdvisorGroupService,
  authToken: string,
) {
  const namespace = 'advisor-group' as SettingsNamespace

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? ''
    const url = new URL(rawUrl, 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const token = String(req.headers['x-advisor-group-token'] ?? url.searchParams.get('token') ?? '')
    if (authToken && token !== authToken) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (
      req.method === 'GET' &&
      (pathname === '/advisor-group/stream' || pathname === '/advisor-group/stream/')
    ) {
      await handleStreamRequest(req, res)
      return
    }

    if (
      (req.method === 'GET' || req.method === 'POST') &&
      (pathname === '/advisor-group/test-connection' || pathname === '/advisor-group/test-connection/')
    ) {
      await handleTestConnectionRequest(ctx, service, req, res)
      return
    }

    if (
      (req.method === 'GET' || req.method === 'POST') &&
      (pathname === '/advisor-group/models' || pathname === '/advisor-group/models/')
    ) {
      await handleModelsRequest(ctx, service, req, res)
      return
    }

    if (
      req.method === 'GET' &&
      (pathname === '/advisor-group/providers' || pathname === '/advisor-group/providers/')
    ) {
      await sendProviders(ctx, res)
      return
    }

    if (
      req.method === 'POST' &&
      (pathname === '/advisor-group/stop' || pathname === '/advisor-group/stop/')
    ) {
      // User-initiated stop of the running auto-deepen pipeline. The abort
      // degrades to a graceful partial summary on the server; the tool call
      // resolves normally with a "stopped" note.
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw) as { sessionId?: unknown }
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
          sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        const stopped = service.stopConsultation(parsed.sessionId)
        sendJson(res, 200, { ok: true, stopped })
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (
      req.method === 'POST' &&
      (pathname === '/advisor-group/resume' || pathname === '/advisor-group/resume/')
    ) {
      // Resume a stopped consultation from its interruption point (also works
      // after a dsh restart via the durable snapshot). The pipeline continues
      // in the background; the card flips back to LIVE on the resume event.
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw) as { sessionId?: unknown }
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
          sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        const result = service.resumeConsultation(parsed.sessionId)
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, ...(result.reason ? { error: result.reason } : {}) })
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (
      req.method === 'GET' &&
      (pathname === '/advisor-group/shadow' || pathname === '/advisor-group/shadow/')
    ) {
      // Read-only classifier shadow samples (JSONL) — for threshold tuning.
      const summary = await readShadowSamples(200)
      sendJson(res, 200, { ok: true, ...summary })
      return
    }

    if (
      req.method === 'GET' &&
      (pathname === '/advisor-group/config' || pathname === '/advisor-group/config/')
    ) {
      sendJson(res, 200, {
        ok: true,
        config: sanitizeConfig(service.getConfig()),
        revision: currentRevision(scopedCtx, namespace),
        dailyGuard: service.getDailyGuard(),
      })
      return
    }

    if (
      req.method === 'POST' &&
      (pathname === '/advisor-group/config' || pathname === '/advisor-group/config/')
    ) {
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw) as {
          config?: ConfigShape
          expectedRevision?: number
        }
        const configInput = parsed.config ?? (parsed as unknown as ConfigShape)
        const expectedRevision =
          typeof parsed.expectedRevision === 'number'
            ? parsed.expectedRevision
            : currentRevision(scopedCtx, namespace)
        // Schemastery schema is callable: validates and returns normalized config.
        const validated = Config(configInput) as ConfigShape
        const reconciled = reconcileApiKeys(validated, service.getConfig())
        const securityError = validateSecurity(reconciled)
        if (securityError) {
          sendJson(res, 400, { ok: false, error: securityError })
          return
        }
        // Persist first, then update memory: if persistence fails the running
        // instance keeps its previous config. expectedRevision refuses stale writes.
        await scopedCtx.settings.replace(namespace, reconciled as unknown as object, expectedRevision)
        service.setConfig(reconciled)
        sendJson(res, 200, {
          ok: true,
          config: sanitizeConfig(service.getConfig()),
          revision: currentRevision(scopedCtx, namespace),
        })
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          sendJson(res, 409, { ok: false, error: '配置已被其他窗口修改，请刷新后重试。' })
          return
        }
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

async function sendProviders(ctx: Context, res: ServerResponse): Promise<void> {
  const providers: Array<{
    id: string
    name: string
    kind: 'llm' | 'preset'
    models: string[]
    baseURL?: string
    apiKeyEnv?: string
    protocol?: string
  }> = []

  // DSH configured/registered providers first (via ctx.llm).
  try {
    const llmProviders = await ctx.llm.listProviders()
    const llmResults = await Promise.all(
      llmProviders.map(async (provider) => {
        let models: string[] = []
        try {
          const list = await ctx.llm.listModels(provider.id)
          models = list.map((model) => model.id)
        } catch {
          // Some providers may not publish a model list; keep models empty.
        }
        return {
          id: provider.id,
          name: provider.name,
          kind: 'llm' as const,
          models,
        }
      }),
    )
    for (const item of llmResults) {
      if (!providers.some((entry) => entry.id === item.id)) {
        providers.push(item)
      }
    }
  } catch {
    // Ignore ctx.llm errors; presets still give the user useful choices.
  }

  // Built-in preset providers (also used by the direct-HTTP fallback).
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    if (!providers.some((item) => item.id === preset.id)) {
      providers.push({
        id: preset.id,
        name: preset.label,
        kind: 'preset',
        models: preset.defaultModels,
        baseURL: preset.baseURL,
        apiKeyEnv: preset.apiKeyEnv,
        protocol: preset.protocol,
      })
    }
  }

  sendJson(res, 200, { ok: true, providers })
}

export function registerAdvisorSettingsAndRoutes(
  ctx: Context,
  config: ConfigShape,
  service: AdvisorGroupService,
): void {
  const inject = (ctx as unknown as {
    inject(keys: string[], callback: (scoped: ScopedContext) => void): void
  }).inject
  if (!inject) return

  inject(['settings', 'webServer'], (scoped) => {
    const scopedCtx = scoped as ScopedContext
    const namespace = 'advisor-group' as SettingsNamespace
    const scope = scopedCtx.settings.register(
      namespace,
      Config,
      { base: config },
    )

    service.setConfig(scope.get())

    // Let the toggle tool persist the enabled flag through the same settings
    // namespace the settings tab uses.
    service.setPersistEnabled(async (enabled) => {
      await scopedCtx.settings.update(namespace, { enabled })
    })

    const watchDisposer = scope.watch((next) => {
      service.setConfig(next)
    })

    // Per-boot shared token: the host injects it into the served index and the
    // client sends it on every /advisor-group/* request. Not a substitute for a
    // real auth layer, but it stops other local processes / CSRF-style requests
    // from reading settings or subscribing to the SSE stream.
    const authToken = randomUUID()
    const indexTapDisposer = scopedCtx.webServer.tapIndex
      ? scopedCtx.webServer.tapIndex((html) =>
          html.replace(
            '<head>',
            `<head><script>globalThis.__ADVISOR_GROUP_TOKEN__ = ${JSON.stringify(authToken)}</script>`,
          ),
        )
      : null

    const routeDisposer = scopedCtx.webServer.register({
      kind: 'prefix',
      path: '/advisor-group',
      handler: handleConfigRequest(ctx, scopedCtx, service, authToken),
    })

    ctx.effect(() => () => {
      watchDisposer()
      routeDisposer()
      indexTapDisposer?.()
    }, 'dsh-advisor-group: settings watcher + config routes')
  })
}