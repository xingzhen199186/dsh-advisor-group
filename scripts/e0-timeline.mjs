// Timeline for consult e0cea1b4 + surrounding tool events.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { decompress } = require('C:/Users/WINDOWS/.dsh/profiles/web/node_modules/fzstd')

const root = 'C:/Users/WINDOWS/.dsh/sessions'
const files = []
function walk (d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('session.jsonl')) files.push(p) } }
walk(root)
for (const f of files) {
  const out = decompress(fs.readFileSync(f))
  let txt = out.toString('utf8')
  if (/^[0-9,]+$/.test(txt.slice(0, 64))) txt = Buffer.from(txt.split(',').map(Number)).toString('utf8')
  if (!txt.includes('e0cea1b4')) continue
  console.log('=== file', f)
  const lines = txt.split('\n')
  // advisor-group events for this consult
  for (const l of lines) {
    if (!/^\{?"type":"advisor-group\//.test(l)) continue
    const ev = JSON.parse(l)
    const d = ev.data || {}
    if (d.sessionId !== 'e0cea1b4-4b31-479a-b428-91717f69b8c2') continue
    const iso = new Date(ev.time).toISOString().slice(11, 19)
    if (ev.type === 'advisor-group/start') console.log(iso, 'START seq=' + ev.seq)
    else if (ev.type === 'advisor-group/message') console.log(iso, 'MSG', d.role, 'r' + d.round, d.advisorName || '', 'c=' + String(d.content).length)
    else if (ev.type === 'advisor-group/delta') console.log(iso, 'DELTA', d.advisorName, 'cd=' + String(d.contentDelta || '').length, 'td=' + String(d.thinkingDelta || '').length)
    else if (ev.type === 'advisor-group/end') console.log(iso, 'END stopped=' + d.summary?.stopped)
    else if (ev.type === 'advisor-group/resume') console.log(iso, 'RESUME')
  }
}
