/**
 * no-network.ts — armed BEFORE anything under test is imported.
 *
 * WHY THIS IS A PRELOAD AND NOT A `beforeAll`. It used to be a `beforeAll`, and
 * that is a hole you can drive a regression through: a test file's imports are
 * evaluated before any hook runs, so a module that fetches AT IMPORT TIME — or
 * that captures `globalThis.fetch` into a module-level const at import time and
 * calls it later — was never seen by the guard. The check could not go red for
 * exactly the class of regression it existed to exclude, which is worse than no
 * check, because it reads as one.
 *
 * `bunfig.toml` [test] preload loads this file first, so these two stubs are in
 * place before the first `import` of src/. Anything that reaches the network at
 * import time throws while the module graph is still loading, and the suite
 * fails to collect — loudly, at the top, naming the URL.
 *
 * Proven to bite: an import-time `fetch()` added to src/recover.ts made
 * `bun test` exit 1 with 0 pass / 1 fail before any test ran; removing it
 * restored 0 fail. Both exit codes are in the row's build report.
 */

/** Every URL anything tried to reach. Read by the suite; must stay empty. */
export const networkAttempts: string[] = []

function refuse(what: string): never {
  networkAttempts.push(what)
  throw new Error(`recover: NETWORK ATTEMPTED — ${what}`)
}

globalThis.fetch = ((...args: unknown[]) => refuse(String(args[0]))) as unknown as typeof fetch
;(globalThis as Record<string, unknown>).XMLHttpRequest = class {
  constructor() {
    refuse('XMLHttpRequest')
  }
}
;(globalThis as Record<string, unknown>).WebSocket = class {
  constructor(url: unknown) {
    refuse(`WebSocket ${String(url)}`)
  }
}

// ===== THE SOCKET LAYER =====
//
// The stubs above are the BROWSER-shaped doors. They are not the only doors, and
// a check that covers only them cannot go red for the exfiltration that matters:
// `node:https`, `node:http`, `node:net` and `Bun.connect` all reach the network
// without touching `fetch`, and until this block existed they bypassed both the
// block AND the accounting. Same class of defect as arming after the imports,
// one layer down.
//
// Every property below was probed as writable+configurable under bun 1.3.14
// before being patched (Object.getOwnPropertyDescriptor on each).
//
// WHAT THIS STILL DOES NOT COVER, said plainly rather than left implied:
// a native addon or an FFI call that opens a socket without going through any
// of these JS entry points. There is no JS seam to intercept that, so it is an
// uncovered gap, not a silent claim. Nothing in packages/recover uses FFI.

import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

function patch(mod: Record<string, unknown>, key: string, label: string): void {
  if (typeof mod[key] !== 'function') return
  mod[key] = (...args: unknown[]) => {
    const target = args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a && typeof a === 'object') {
          const o = a as { host?: string; hostname?: string; port?: number | string; path?: string }
          if (o.host || o.hostname) return `${o.host ?? o.hostname}${o.port ? `:${o.port}` : ''}${o.path ?? ''}`
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
    return refuse(`${label} ${target}`.trim())
  }
}

for (const [name, keys] of [
  ['node:net', ['connect', 'createConnection']],
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:dgram', ['createSocket']],
] as const) {
  try {
    const mod = req(name) as Record<string, unknown>
    for (const key of keys) patch(mod, key, `${name}.${key}`)
  } catch {
    // module unavailable in this runtime — nothing to patch, nothing to claim
  }
}

// net.Socket.prototype.connect — the door a `new Socket()` walks through, which
// `net.connect` does not cover.
try {
  const net = req('node:net') as { Socket?: { prototype: Record<string, unknown> } }
  if (net.Socket?.prototype) patch(net.Socket.prototype, 'connect', 'net.Socket.connect')
} catch {
  /* as above */
}

// Bun's own TCP door.
const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun
if (bun) {
  patch(bun, 'connect', 'Bun.connect')
  patch(bun, 'listen', 'Bun.listen')
}

/** The throwing fetch itself, so a test that swaps the global can put THIS back
 *  rather than the real one. */
export const throwingFetch = globalThis.fetch
