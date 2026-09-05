// Final report for consult d00bc25d: snapshot state + full conversation + end conclusion.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { decompress } = require('C:/Users/WINDOWS/.dsh/profiles/web/node_modules/fzstd')

const snap = JSON.parse(
  fs.readFileSync('C:/Users/WINDOWS/.dsh/storages/advisor-group/sessions/d00bc25d-1bab-4ee7-b9e4-e1f9a490a871.json', 'utf8'),
)
console.log('STATUS:', snap.status, '| updated:', new Date(snap.updatedAt).toISOString(), '| msgs:', snap.messages.length)
for (const m of snap.messages) {
  const head = String(m.content || '').replace(/\n/g, '⏎')
  console.log(`- [${m.role}${m.round ? ' r' + m.round : ''}] c=${head.length} t=${String(m.thinking || '').length} | ${head.slice(0, 160)}`)
}

// durable END for conclusion
const f = 'C:/Users/WINDOWS/.dsh/sessions/--I-DSH-dsh-advisor-group--/session-b14717f1-9867-4000-ac31-f9cef5f905a7/session.jsonl.zstd'
const out = decompress(fs.readFileSync(f))
let txt = out.toString('utf8')
if (/^[0-9,]+$/.test(txt.slice(0, 64))) txt = Buffer.from(txt.split(',').map(Number)).toString('utf8')
const lines = txt.split('\n')
for (const l of lines) {
  if (!l.startsWith('{"type":"advisor-group/end')) continue
  const ev = JSON.parse(l)
  const d = ev.data || {}
  if (d.sessionId !== 'd00bc25d-1bab-4ee7-b9e4-e1f9a490a871') continue
  console.log('\nEND at', new Date(ev.time).toISOString(), 'stopped=' + d.summary?.stopped)
  console.log('CONCLUSION:', String(d.summary?.conclusion || '(none)').slice(0, 4000))
  console.log('riskNotes:', JSON.stringify(d.summary?.riskNotes || []).slice(0, 400))
}
