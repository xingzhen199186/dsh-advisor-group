import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const clientPath = resolve('lib/client.js')
const source = readFileSync(clientPath, 'utf8')

// dsh-startup-guard only recognises ["'] quoted ids, not backtick template
// strings. The minifier can rewrite the banner, so we fail the build early.
if (!source.includes('id: "dsh-advisor-group"')) {
  console.error(
    '[check-client-id] ❌ lib/client.js does not contain `id: "dsh-advisor-group"`. ' +
      'Do not enable minify for the client bundle.',
  )
  process.exit(1)
}

console.log('[check-client-id] ✅ client bundle id uses double quotes')