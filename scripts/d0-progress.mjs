// Last delta frames + any MSG/END after resume for d00bc25d.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { decompress } = require('C:/Users/WINDOWS/.dsh/profiles/web/node_modules/fzstd')

const f = 'C:/Users/WINDOWS/.dsh/sessions/--I-DSH-dsh-advisor-group--/session-b14717f1-9867-4000-ac31-f9cef5f905a7/session.jsonl.zstd'
const out = decompress(fs.readFileSync(f))
let txt = out.toString('utf8')
if (/^[0-9,]+$/.test(txt.slice(0, 64))) txt = Buffer.from(txt.split(',').map(Number)).toString('utf8')
const lines = txt.split('\n')
const deltas = lines.filter((l) => l.startsWith('{"type":"advisor-group/delta') && l.includes('d00bc25d'))
console.log('delta count:', deltas.length)
for (const l of deltas.slice(-3)) {
  const ev = JSON.parse(l)
  console.log(new Date(ev.time).toISOString().slice(11, 19), 'seq=' + ev.seq, 'cd=' + String(ev.data.contentDelta || '').length, 'td=' + String(ev.data.thinkingDelta || '').length, 'done=' + ev.data.done)
}
for (const l of lines) {
  if (!/^\{?"type":"advisor-group\/(message|end)"/.test(l)) continue
  const ev = JSON.parse(l)
  const d = ev.data || {}
  if (d.sessionId !== 'd00bc25d-1bab-4ee7-b9e4-e1f9a490a871') continue
  console.log(new Date(ev.time).toISOString().slice(11, 19), ev.type, d.role || '', 'r' + d.round, d.advisorName || '', 'c=' + String(d.content || '').length, 'stopped=' + d.summary?.stopped)
}
