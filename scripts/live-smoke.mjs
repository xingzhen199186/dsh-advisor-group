#!/usr/bin/env node
/**
 * Live smoke for the dsh-advisor-group server side (positive path).
 *
 * Usage (from the repo root, with a running `dsh web`):
 *   node scripts/live-smoke.mjs --token=<page-token> [--session=<consult-id>] [--base=http://127.0.0.1:3080]
 *
 * What it asserts:
 *   1. /advisor-group/config WITHOUT token  -> HTTP 401 (route mounted + auth enforced)
 *   2. /advisor-group/config WITH token     -> HTTP 200 + { config, dailyGuard } (positive auth path)
 *   3. /advisor-group/stream WITH token     -> stream frames (or resync/connected) for ~4s
 *      (last step requires --session, e.g. an id from storages/advisor-group/sessions/)
 */
const args = Object.fromEntries(
  (process.argv.slice(2) ?? [])
    .map((arg) => arg.replace(/^--/, '').split('='))
    .filter(([key]) => key)
    .map(([key, value]) => [key, value ?? 'true']),
)

const base = args.base ?? 'http://127.0.0.1:3080'
const token = args.token ?? ''
const sessionId = args.session ?? ''

async function statusOf(url, headers = {}) {
  try {
    const res = await fetch(url, { headers })
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json().catch(() => null) : null }
  } catch (error) {
    return { status: 0, error: String(error) }
  }
}

let failed = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? '✅' : '❌'} ${name} — ${detail}`)
  if (!pass) failed += 1
}

// 1. Unauthenticated -> 401
const noToken = await statusOf(`${base}/advisor-group/config`)
check('config without token -> 401', noToken.status === 401, `status=${noToken.status}`)

// 2. Authenticated -> 200 + config/dailyGuard
if (token) {
  const authed = await statusOf(`${base}/advisor-group/config`, { 'x-advisor-group-token': token })
  check(
    'config with token -> 200 + config/dailyGuard',
    authed.status === 200 && authed.json?.config && authed.json?.dailyGuard !== undefined,
    `status=${authed.status}`,
  )
} else {
  console.log('⚠️  --token 未提供，跳过正路径 config 检查')
}

// 3. Stream replay
if (token && sessionId) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(
      `${base}/advisor-group/stream?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`,
      { headers: { 'x-advisor-group-token': token }, signal: controller.signal },
    )
    clearTimeout(timeout)
    check('stream connected', res.ok, `status=${res.status}`)
    if (res.ok) {
      let dataFrames = 0
      let commentFrames = 0
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ done: false, value: undefined, timedOut: true }), 1500)),
        ])
        if (value) {
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('data: ')) dataFrames += 1
            else if (line.startsWith(':')) commentFrames += 1
            else if (line.startsWith('event: resync')) commentFrames += 1
          }
        }
        if (done) break
      }
      check('stream emitted frames (data or resync/connected)', dataFrames > 0 || commentFrames > 0, `data=${dataFrames} comments=${commentFrames}`)
    }
  } catch (error) {
    check('stream reachable', false, String(error))
  }
} else {
  console.log('⚠️  --session 未提供，跳过 SSE 流式检查（建议用 storages/advisor-group/sessions/<id>）')
}

console.log(failed === 0 ? '\n🎉 live smoke passed' : `\n💔 live smoke failed (${failed})`)
process.exit(failed === 0 ? 0 : 1)
