/**
 * Development mode: run both halves at once.
 *
 * Vite serves the interface with instant reloading on port 5173, and forwards
 * anything starting with /api to the Express server on 5174. Open the Vite address;
 * it behaves as one app.
 *
 * For everyday studying use `npm run build` once and then `npm start`, which serves
 * the built interface from the Express server alone on a single port.
 */

import { spawn } from 'node:child_process'
import { config } from '../src/server/config.ts'

const children = [
  spawn(process.execPath, ['src/server/index.ts'], { stdio: 'inherit', shell: false }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', shell: false }),
]

console.log(`\nServer on http://localhost:${config.port} — open the Vite address below for the interface.\n`)

function shutdown(): void {
  for (const c of children) c.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

for (const c of children) {
  c.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\nA process exited with code ${code}. Stopping the other one too.`)
      shutdown()
    }
  })
}
