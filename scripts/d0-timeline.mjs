// Timeline for d00bc25d: advisor-group events + surrounding tool/call/result + any errors.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { decompress } = require('C:/Users/WINDOWS/.dsh/profiles/web/node_modules/fzstd')

const f = 'C:/Users/WINDOWS/.dsh/sessions/--I-DSH-dsh-advisor-group--/session-b14717f1-9867-4000-ac31-f9cef5f905a7/session.jsonl.zstd'
const out = decompress(fs.readFileSync(f))
let txt = out.toString('utf8')
if (/^[0-9,]+$/.test(txt.slice(0, 64))) txt = Buffer.from(txt.split(',').map(Number)).toString('utf8')
const lines = txt.split('\n')
for (const l of lines) {
  if (!/^\{?"type":"advisor-group\//.test(l)) continue
  const ev = JSON.parse(l)
  const d = ev.data || {}
  if (d.sessionId !== 'd00bc25d-1bab-4ee7-b9e4-e1f9a490a871') continue
  const iso = new Date(ev.time).toISOString().slice(11, 19)
  if (ev.type === 'advisor-group/delta') continue  if (ev.type === 'advisor-group/start') console.log(iso, 'START seq=' + ev.seq)
  else if (ev.type === 'advisor-group/message') console.log(iso, 'MSG', d.role, 'r' + d.round, d.advisorName || '', 'c=' + String(d.content).length, 't=' + String(d.thinking).length)
  else if (ev.type === 'advisor-group/end') console.log(iso, 'END stopped=' + d.summary?.stopped, 'concl=' + String(d.summary?.conclusion).length)
  else if (ev.type === 'advisor-group/resume') console.log(iso, 'RESUME')
}
// tool calls + results around this consult (any with error)
for (const l of lines) {
  if (!/^\{?"type":"tool\/(call|result)"/.test(l)) continue
  const ev = JSON.parse(l)
  const m = ev.data?.message
  const text = JSON.stringify(m || '')
  if (!text.includes('d00bc25d')) continue
  const iso = new Date(ev.time).toISOString().slice(11, 19)
  console.log(iso, ev.type, 'seq=' + ev.seq, 'isError=' + ev.data?.message?.content?.some?.(c => c?.isError), text.slice(0, 160))
}
