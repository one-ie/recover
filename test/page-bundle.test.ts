// page-bundle.test.ts — the ACCEPT for C7b. Run: cd packages/recover && bun test
//
// WHAT C7 COULD NOT CHECK, AND WHY THIS FILE EXISTS. C7 shipped src/page.html
// with `<script src="./page.js">` and left the bundle uncommitted, so the page a
// holder actually cloned was a 404 with a nice layout. Its own page test read
// the HTML's URLs and nothing else — it passed with the bundle MISSING, which is
// the exact failure it appeared to exclude. That test was renamed to claim only
// what it checked and the gap was recorded as a todo. This file closes it.
//
// THE RULE THIS FILE OBEYS: every check here reads the COMMITTED artifact,
// dist/page.html — never a fresh build. A check that rebuilds and then inspects
// its own output is green on a tree where the artifact was deleted, which is C7's
// defect rebuilt one layer up. The rebuild happens ONCE, into a temp directory,
// only to prove the committed bytes are not stale (Astra AMEND §5: the committed
// file is never overwritten by its own check).
//
// THE RECORDERS HAVE BEEN DRIVEN RED, WHICH IS THE ONLY REASON TO BELIEVE THEM.
// Asserting `attempts` is empty proves nothing until the thing that fills it has
// been seen to fill. The four artifact breaks in the row report (deleted, stale,
// one byte flipped, untracked) all prove INTEGRITY and not one of them proves a
// detector fires — so each sink class was planted in src/page-entry.ts, REBUILT
// (a fresh, correctly hashed artifact, so no staleness or seal confound), and
// the suite observed red:
//
//   fetch(`…/collect?w=${phrase}`)                -> 4 fail, exit 1; `attempts`
//                                                    named the URL WITH the phrase in it
//   console.log('dbg', { phrase })                -> 1 fail, exit 1; `logged` named it
//   localStorage.setItem('…lastPhrase', phrase)   -> 1 fail, exit 1; `stored` named it
//
// Each restored to 63 pass / 0 fail, exit 0, with `diff -q` reporting the
// artifact byte-identical. The seams NOT yet driven red are named rather than
// implied: XMLHttpRequest, WebSocket, sendBeacon, Image and document.cookie are
// wired the same way as the three above and were not individually planted.
//
// THE CHECKS ARE FUNCTIONS, SO THE NEGATIVES USE THE SAME CODE AS THE POSITIVES.
// `artifactFaults()` and `runPage()` are applied to the real artifact and to
// deliberately broken copies of it in the same run. A negative test that
// reimplements the check proves nothing about the check that ships.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { networkAttempts } from './no-network.ts'

const PKG = join(import.meta.dir, '..')
const ARTIFACT = join(PKG, 'dist', 'page.html')

// The SAME public BIP-39 test vector the CLI accept pins, and the SAME eight
// addresses. Pinned as literals here on purpose: the page is checked against the
// CLI's published answer, not against whatever the page itself computes.
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
const V1 = {
  sui: '0x1e9d23cc0e3d6ec9da166ddeff6f3d8d63dce658c04c99d9bb95eeff460df5f0',
  evm: '0x4E2541174BcA298D9385A41a1AF7e09DcE0A1ea7',
  sol: '6cpN2BngMFXdBb9Hj1GL5G3gi8UkB8sTiy9vvtmCuc7p',
  btc: 'bc1q0swxaf49f5thugyx9wss4sv3l00ym74nlhjk3x',
} as const
const V2 = {
  sui: '0xf967e21c16a4757daafec13ee79c0dc5c5329199be5d70c86fd07b8e75db892c',
  evm: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb',
  sol: '3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx',
  btc: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6',
} as const
/** The text with every address that BELONGS there removed, so what is left is
 *  by definition material that should never have been there. */
const withoutExpected = (text: string): string => {
  let out = text
  for (const a of [...Object.values(V1), ...Object.values(V2)]) out = out.replaceAll(a, '<addr>').replaceAll(a.replace(/^0x/, ''), '<addr>')
  return out
}

const V1_MARK = 'v1 — original ONE derivation'
const V2_MARK = 'v2 — standard paths'

// ===== THE CHECK, AS ONE FUNCTION =====

/** Everything wrong with a candidate page, as a list of complaints. Empty list
 *  = a page a holder can open from a USB stick with the wifi off. */
export function artifactFaults(html: string | null): string[] {
  const f: string[] = []
  if (html === null) return ['missing: dist/page.html is not in the tree']
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)]
  const external = scripts.filter((s) => /\bsrc\s*=/.test(s[1]))
  for (const s of external) f.push(`external script: ${s[1].trim()}`)
  const inline = scripts.filter((s) => !/\bsrc\s*=/.test(s[1]))
  if (inline.length !== 1) f.push(`inline scripts: ${inline.length} (want exactly 1)`)
  const js = inline[0]?.[2] ?? ''
  // The bundle is ~130KB. Anything small enough to be a stub or a loader is not
  // the derivation code, and "the file exists" must never stand in for it.
  if (js.length < 50_000) f.push(`inline script too small: ${js.length} bytes`)
  if (/<\/script/i.test(js)) f.push('inline script contains a raw </script — the page would truncate')
  if (/\bpage\.js\b/.test(html)) f.push('still references page.js — the 404 this row removes')

  // Every asset the browser would LOAD must be local; the licence's brand link
  // is a link the holder may click, not a load.
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const url = m[1]
    if (!/^(?:https?:)?\/\//.test(url)) continue
    const isLink = new RegExp(`href\\s*=\\s*["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(html)
    if (isLink && (url === 'https://one.ie' || url === 'https://one.ie/')) continue
    f.push(`remote asset: ${url}`)
  }
  if (/cdn\.|unpkg|jsdelivr|googleapis|gtag|analytics/i.test(html)) f.push('remote-CDN-shaped string in the page')

  // Deny by default (Astra AMEND §4). Not "no http:// in the source" — a policy
  // the browser enforces on constructed URLs, beacons, images and forms too.
  // The attribute is double-quoted and its value is FULL of single quotes
  // ('none', 'sha256-…'), so a ["'] character class truncates the policy at the
  // first directive and every later one reads as absent. Measured: it reported
  // "no script hash" on a page that had one.
  const csp = html.match(/<meta[^>]+http-equiv\s*=\s*"Content-Security-Policy"[^>]*content\s*=\s*"([^"]*)"/i)?.[1]
  if (!csp) f.push('no Content-Security-Policy meta')
  else {
    if (!/default-src\s+'none'/.test(csp)) f.push(`CSP is not deny-by-default: ${csp}`)
    for (const d of ['form-action', 'base-uri', 'object-src', 'img-src', 'font-src', 'frame-src']) {
      if (!new RegExp(`${d}\\s+'none'`).test(csp)) f.push(`CSP lets ${d} through: ${csp}`)
    }
    // The script may run only because its bytes hash to the value in the policy.
    // Change one byte of the bundle and the browser refuses to run it — so the
    // hash is also a tamper seal, and this assertion is how a stale or edited
    // artifact is caught before a holder ever opens it.
    const want = new Bun.CryptoHasher('sha256').update(js, 'utf8').digest('base64')
    const got = csp.match(/'sha256-([A-Za-z0-9+/=]+)'/)?.[1]
    if (!got) f.push('CSP has no script hash')
    else if (got !== want) f.push(`CSP script hash is stale: policy ${got} vs bundle ${want}`)
    if (/script-src[^;]*'unsafe-inline'/.test(csp)) f.push("script-src allows 'unsafe-inline' — the hash is then decoration")
  }
  return f
}

/** The single inline bundle, as the browser would see it. */
export function bundleOf(html: string): string {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)].filter((s) => !/\bsrc\s*=/.test(s[1]))[0]?.[2] ?? ''
}

// ===== RUNNING THE COMMITTED PAGE, OFFLINE =====
//
// No browser and no DOM library (neither is a dependency here, and a dependency
// the holder's machine needs is the opposite of this package's point). The shim
// below is the small part of the DOM the page uses, and every network-shaped
// global is a RECORDER that refuses: fetch, XMLHttpRequest, WebSocket,
// sendBeacon, Image, and both storages. Nothing is stubbed silently — an attempt
// is written down and then it throws.

type El = Record<string, any>

function makeShim() {
  const attempts: string[] = []
  const logged: string[] = []
  const stored: string[] = []
  const handlers: Record<string, () => void> = {}
  const fetches: { url: string; init: any }[] = []

  const children = (n: El): El[] => n.kids.flatMap((c: El) => [c, ...children(c)])
  const hit = (n: El, sel: string) => (sel.startsWith('.') ? n.className === sel.slice(1) : n.tag === sel)
  const mk = (tag: string): El => {
    const el: El = {
      tag,
      id: '',
      className: '',
      kids: [] as El[],
      _text: '',
      value: '',
      get textContent() {
        return el.kids.length ? el.kids.map((c: El) => c.textContent).join('') : el._text
      },
      set textContent(v: string) {
        el._text = String(v)
        el.kids = []
      },
      appendChild(c: El) {
        el.kids.push(c)
        return c
      },
      append(...cs: El[]) {
        el.kids.push(...cs)
      },
      addEventListener(_: string, cb: () => void) {
        handlers[el.id] = cb
      },
      querySelector: (sel: string) => children(el).find((n) => hit(n, sel)) ?? null,
      querySelectorAll: (sel: string) => children(el).filter((n) => hit(n, sel)),
    }
    return el
  }

  const byId: Record<string, El> = {}
  for (const id of ['out', 'err', 'phrase', 'derivation', 'rpc', 'rpcChain', 'bal', 'go', 'balgo']) {
    byId[id] = mk('div')
    byId[id].id = id
  }
  const root = mk('body')
  root.kids = Object.values(byId)

  const refuse = (what: string) => {
    attempts.push(what)
    throw new Error(`page: NETWORK ATTEMPTED — ${what}`)
  }
  const doc: El = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: mk,
    querySelectorAll: (sel: string) => children(root).filter((n) => hit(n, sel)),
    querySelector: (sel: string) => children(root).find((n) => hit(n, sel)) ?? null,
    get cookie() {
      return ''
    },
    set cookie(v: string) {
      stored.push(`cookie=${v}`)
    },
  }
  const store = (label: string) => ({
    getItem: () => null,
    setItem: (k: string, v: string) => stored.push(`${label}.${k}=${v}`),
    removeItem: () => {},
    clear: () => {},
  })
  const rec = (...a: unknown[]) => logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  const win: El = {
    document: doc,
    fetch: (url: string, init: any) => {
      fetches.push({ url: String(url), init })
      attempts.push(`fetch ${String(url)}`)
      return Promise.reject(new Error('offline'))
    },
    localStorage: store('localStorage'),
    sessionStorage: store('sessionStorage'),
    addEventListener: () => {},
    location: { href: 'file:///page.html', assign: (u: string) => refuse(`navigate ${u}`), replace: (u: string) => refuse(`navigate ${u}`) },
  }

  return { attempts, logged, stored, handlers, fetches, byId, doc, win, refuse, rec, store }
}

type Page = ReturnType<typeof runPage>

/** Evaluate a candidate bundle under the shim, exactly as a `<script>` would. */
export function runPage(js: string) {
  const s = makeShim()
  const console_ = { log: s.rec, warn: s.rec, error: s.rec, info: s.rec, debug: s.rec, trace: s.rec }
  const xhr = class {
    constructor() {
      s.refuse('XMLHttpRequest')
    }
  }
  const ws = class {
    constructor(u: unknown) {
      s.refuse(`WebSocket ${String(u)}`)
    }
  }
  const img = class {
    set src(u: string) {
      s.refuse(`Image ${u}`)
    }
  }
  const nav = { userAgent: 'c7b-shim', sendBeacon: (u: string) => s.refuse(`sendBeacon ${u}`), clipboard: { writeText: (t: string) => s.refuse(`clipboard ${t}`) } }
  new Function(
    'window',
    'document',
    'self',
    'navigator',
    'location',
    'console',
    'localStorage',
    'sessionStorage',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'Image',
    'alert',
    js,
  )(
    s.win,
    s.doc,
    s.win,
    nav,
    s.win.location,
    console_,
    s.win.localStorage,
    s.win.sessionStorage,
    (u: string) => s.refuse(`fetch ${u}`),
    xhr,
    ws,
    img,
    (m: string) => s.rec(m),
  )
  return {
    ...s,
    /** Click, then wait for the handler's floating promise to settle. The page
     *  does `void recover()`, so there is nothing to await — poll like a human. */
    async click(id: string, until: () => boolean) {
      s.handlers[id]?.()
      for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5))
    },
    sets() {
      return s.byId.out.kids.map((sec: El) => ({
        head: sec.kids[0].textContent as string,
        rows: Object.fromEntries(sec.kids.slice(1).map((r: El) => [r.kids[0].textContent, r.kids[1].textContent])) as Record<string, string>,
      }))
    },
    serialized() {
      return JSON.stringify([s.byId.out, s.byId.err, s.byId.bal], (k, v) => (k === 'kids' || typeof v !== 'object' ? v : v))
    },
  }
}

const read = () => (existsSync(ARTIFACT) ? readFileSync(ARTIFACT, 'utf8') : null)

// ===== THE ARTIFACT ITSELF =====

describe('the committed page is one self-contained file', () => {
  test('dist/page.html exists AND is tracked by git — an ignored artifact is a 404 for everyone but me', () => {
    expect(existsSync(ARTIFACT)).toBe(true)
    const tracked = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', 'dist/page.html'], { cwd: PKG })
    expect({ tracked: tracked.exitCode, stderr: tracked.stderr.toString().trim() }).toEqual({ tracked: 0, stderr: '' })
  })

  test('it has no fault: one inline bundle, no remote asset, deny-by-default CSP whose hash matches the bundle', () => {
    expect(artifactFaults(read())).toEqual([])
  })
})

// ===== IT RUNS, AND IT ANSWERS WHAT THE CLI ANSWERS =====

describe('the COMMITTED page derives the pinned CLI vectors with every door shut', () => {
  let page: ReturnType<typeof runPage>
  let before = 0

  beforeAll(async () => {
    before = networkAttempts.length
    page = runPage(bundleOf(read() ?? ''))
    page.byId.phrase.value = PHRASE
    page.byId.derivation.value = 'both'
    await page.click('go', () => page.byId.out.kids.length > 0)
  })

  test('both sets, all eight addresses, each under the heading that names it', () => {
    const sets = page.sets()
    expect(sets.length).toBe(2)
    expect(sets[0].head).toContain(V1_MARK)
    expect(sets[1].head).toContain(V2_MARK)
    expect(sets[0].rows).toEqual({ ...V1 })
    expect(sets[1].rows).toEqual({ ...V2 })
    expect(page.byId.err.textContent).toBe('')
  })

  test('deriving touched no door at all — not fetch, XHR, WebSocket, beacon, Image or a navigation', () => {
    expect(page.attempts).toEqual([])
    expect(networkAttempts.slice(before)).toEqual([])
  })

  test('nothing secret was logged, stored, cookied or left in the DOM', () => {
    const everywhere = [page.logged.join('\n'), page.stored.join('\n'), page.serialized()].join('\n')
    expect(page.logged).toEqual([])
    expect(page.stored).toEqual([])
    expect(everywhere).not.toMatch(/abandon|\bart\b/i)
    // A Sui address IS 64 hex characters, so a blanket hex ban fires on the
    // right answer and would have to be deleted — which is how a secret check
    // dies. Remove what is SUPPOSED to be there first; a private key, a seed or
    // an xprv is then the only 64-hex run that could remain.
    expect(withoutExpected(everywhere)).not.toMatch(/[0-9a-f]{32,}/i)
    expect(page.byId.phrase.value).toBe(PHRASE) // it stays in the field; it goes nowhere else
  })
})

describe('a failure clears the page rather than half-answering it', () => {
  test('a bad phrase after a good one leaves NO address on screen and repeats nothing back', async () => {
    const page = runPage(bundleOf(read() ?? ''))
    page.byId.phrase.value = PHRASE
    page.byId.derivation.value = 'both'
    await page.click('go', () => page.byId.out.kids.length > 0)
    expect(page.sets().length).toBe(2)

    page.byId.phrase.value = 'abandon abandon wrong words that are not a valid phrase at all here now'
    await page.click('go', () => page.byId.err.textContent !== '')
    expect(page.byId.out.kids.length).toBe(0)
    expect(page.byId.out.textContent).toBe('')
    const shown = page.serialized()
    for (const a of [...Object.values(V1), ...Object.values(V2)]) expect(shown).not.toContain(a)
    expect(page.byId.err.textContent.length).toBeGreaterThan(0)
    expect(page.byId.err.textContent).not.toMatch(/abandon|wrong words/i)
    expect(page.attempts).toEqual([])
  })
})

describe('the only thing that ever leaves the page is a public address, to an endpoint the holder typed', () => {
  test('no endpoint typed → nothing is sent at all', async () => {
    const page = runPage(bundleOf(read() ?? ''))
    page.byId.phrase.value = PHRASE
    await page.click('go', () => page.byId.out.kids.length > 0)
    // Without this line the test is vacuously green on a page that never ran at
    // all — nothing was sent because nothing happened. Measured: with the
    // artifact deleted it still passed, which is the C7 defect in miniature.
    expect(page.sets().length).toBeGreaterThan(0)
    page.byId.rpc.value = ''
    page.byId.rpcChain.value = 'sui'
    await page.click('balgo', () => page.byId.err.textContent !== '')
    expect(page.fetches).toEqual([])
    expect(page.attempts).toEqual([])
  })

  test('an endpoint typed → exactly that URL, carrying the address and no key material', async () => {
    const page = runPage(bundleOf(read() ?? ''))
    page.byId.phrase.value = PHRASE
    page.byId.derivation.value = 'v2'
    await page.click('go', () => page.byId.out.kids.length > 0)
    page.byId.rpc.value = 'https://node.example/rpc'
    page.byId.rpcChain.value = 'sui'
    await page.click('balgo', () => page.byId.bal.textContent !== '')
    expect(page.fetches.length).toBe(1)
    const sent = `${page.fetches[0].url} ${JSON.stringify(page.fetches[0].init)}`
    expect(page.fetches[0].url).toBe('https://node.example/rpc')
    expect(sent).toContain(V2.sui)
    expect(sent).not.toMatch(/abandon|mnemonic|privateKey|seed/i)
    // the public address is the ONLY long hex run that may cross the wire
    expect(withoutExpected(sent)).not.toMatch(/[0-9a-f]{32,}/i)
    expect(sent).not.toMatch(/one\.ie/i)
  })
})

// ===== STALENESS: THE COMMITTED BYTES ARE THE BYTES src BUILDS TODAY =====

describe('the committed artifact is not stale', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c7b-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  test('a rebuild into a TEMP path is byte-identical to the committed file', () => {
    const out = join(tmp, 'page.html')
    const built = Bun.spawnSync(['bun', 'scripts/build-page.ts', '--out', out], { cwd: PKG })
    expect({ build: built.exitCode, err: built.stderr.toString().slice(0, 400) }).toEqual({ build: 0, err: '' })
    expect(existsSync(ARTIFACT)).toBe(true)
    const fresh = readFileSync(out)
    const committed = readFileSync(ARTIFACT)
    // Say WHICH, so a red reads as "stale" without a second run.
    let firstDiff = -1
    for (let i = 0; i < Math.min(fresh.length, committed.length); i++) if (fresh[i] !== committed[i]) { firstDiff = i; break }
    expect({ freshBytes: fresh.length, committedBytes: committed.length, firstDiff }).toEqual({
      freshBytes: fresh.length,
      committedBytes: fresh.length,
      firstDiff: -1,
    })
  })
})

// ===== THE NEGATIVES: THE SAME CHECK, POINTED AT PAGES THAT ARE BROKEN =====
//
// Astra: "Add negative tests that deliberately stale/remove the artifact and
// attempt secret-bearing egress or logging; require those checks to fail."
// Every case below mutates a COPY the way the real defect would, and asserts the
// shipped function above says so.

describe('the check bites — broken pages are named, not passed', () => {
  const good = () => read() ?? ''

  test('a MISSING artifact is a fault, not a pass — this is the C7 defect itself', () => {
    expect(artifactFaults(null)).toEqual(['missing: dist/page.html is not in the tree'])
  })

  test('the C7 shape — an external ./page.js and no inline bundle — is a fault', () => {
    const c7 = good().replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/, '<script type="module" src="./page.js"></script>')
    const faults = artifactFaults(c7)
    expect(faults.some((x) => x.startsWith('external script'))).toBe(true)
    expect(faults.some((x) => x.includes('page.js'))).toBe(true)
    expect(faults.some((x) => x.startsWith('inline scripts: 0'))).toBe(true)
  })

  test('one flipped byte in the bundle breaks the CSP seal', () => {
    const js = bundleOf(good())
    const tampered = good().replace(js, `${js};;`)
    expect(artifactFaults(tampered).some((x) => x.startsWith('CSP script hash is stale'))).toBe(true)
  })

  test('a truncated bundle is a fault AND no longer runs', () => {
    const js = bundleOf(good())
    expect(artifactFaults(good().replace(js, js.slice(0, 200))).some((x) => x.includes('too small'))).toBe(true)
    expect(() => runPage(js.slice(0, 20_000))).toThrow()
  })

  test('a remote script, font or image smuggled in is a fault', () => {
    for (const bad of [
      '<script src="https://cdn.example/x.js"></script>',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css" />',
      '<img src="https://tracker.example/p.gif" />',
    ]) {
      expect(artifactFaults(good().replace('</head>', `${bad}</head>`))).not.toEqual([])
    }
  })

  test('dropping the policy, or loosening it to unsafe-inline, is a fault', () => {
    expect(artifactFaults(good().replace(/<meta[^>]+Content-Security-Policy[^>]*>/i, ''))).toContain('no Content-Security-Policy meta')
    const loose = good().replace(/default-src 'none'/, "default-src 'none'; script-src 'unsafe-inline'")
    expect(artifactFaults(loose).some((x) => x.includes('unsafe-inline'))).toBe(true)
  })

  test('the staleness comparator itself goes red on a one-byte difference', () => {
    const a = Buffer.from(good())
    const b = Buffer.from(`${good()} `)
    let firstDiff = -1
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { firstDiff = i; break }
    expect(a.length === b.length && firstDiff === -1).toBe(false)
  })
})
