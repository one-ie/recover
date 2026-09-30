// recover.test.ts — the ACCEPT for C7. Run: cd packages/recover && bun test
//
// NETWORK DISABLED. Every test in this file runs with `globalThis.fetch` and
// `XMLHttpRequest` replaced by stubs that THROW. That is the difference between
// a tool that happens not to call the network and one that cannot: a test which
// merely omits a fetch can never go red on a new import that adds one.
//
// THE FIXTURES ARE LITERAL AND CROSS-IMPLEMENTATION. Comparing recoverWallet()
// to recoverWallet() is a tautology — it would pass a broken derivation
// forever. The eight addresses below are pinned as constants. The v2 set was
// measured independently from one.ie/web's own separate implementation
// (src/lib/derive-multichain.ts, deriveStandardAddresses) as well as from the
// SDK; the two codebases agree byte-for-byte, which is what makes this a check
// rather than an echo.
//
// The phrase is the BIP-39 canonical all-`abandon` test vector — a PUBLIC test
// vector published in the BIP-39 specification, not anybody's key. Committing
// it is correct.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealVault, type VaultBlob } from '@oneie/sdk/vault-file'

import { main } from '../src/cli.ts'
import { networkAttempts, throwingFetch } from './no-network.ts'

import {
  addressesFromPhrase,
  assertNotOneServer,
  balanceRequest,
  fetchBalance,
  labelFor,
  phraseFromVault,
  parseVaultBlob,
  RecoverError,
  recoverBoth,
  renderSets,
  SAFE_MESSAGE,
  signerBundle,
} from '../src/recover.ts'

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

// v1 — the HKDF derivation every key minted before the standard-paths ruling
// keeps. An ABSENT derivation marker means v1, forever.
const V1 = {
  sui: '0x1e9d23cc0e3d6ec9da166ddeff6f3d8d63dce658c04c99d9bb95eeff460df5f0',
  evm: '0x4E2541174BcA298D9385A41a1AF7e09DcE0A1ea7',
  sol: '6cpN2BngMFXdBb9Hj1GL5G3gi8UkB8sTiy9vvtmCuc7p',
  btc: 'bc1q0swxaf49f5thugyx9wss4sv3l00ym74nlhjk3x',
} as const

// v2 — the standard BIP-44/SLIP-0010 paths. This is the web wallet's set.
const V2 = {
  sui: '0xf967e21c16a4757daafec13ee79c0dc5c5329199be5d70c86fd07b8e75db892c',
  evm: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb',
  sol: '3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx',
  btc: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6',
} as const

// The two headings a holder actually reads, pinned here so the labelling check
// cannot move with the code it checks.
const V1_MARK = 'v1 — original ONE derivation'
const V2_MARK = 'v2 — standard paths'

// ===== NETWORK DISABLED — armed in the PRELOAD, before these imports ran =====
//
// The stubs live in test/no-network.ts, loaded by bunfig.toml's [test] preload,
// so they are installed BEFORE the `import`s above are evaluated. That ordering
// is the fix for the hole a `beforeAll` left: an import-time request, or a
// module that captures the real fetch at import time and calls it later, was
// invisible to a hook that had not run yet. `networkAttempts` is the preload's
// own list — it counts everything, including anything during module loading.

// ===== THE ACCOUNTING RUNS AFTER EVERY TEST, NOT ONCE IN THE MIDDLE =====
//
// A single `expect(networkAttempts).toEqual([])` sitting among the derivation
// tests is checked BEFORE the vault and CLI tests run, so an attempt made by any
// later path went unaccounted — and those are exactly the paths whose errors the
// production code CATCHES, which is what good error handling does. The counter
// could not go red for the case it exists to catch: same class as arming the
// guards after the imports, one step further along.
//
// afterEach attributes an attempt to the test that made it and then advances the
// watermark, so one offender does not cascade into every test after it. afterAll
// is the backstop for anything made outside a test body — during module loading,
// or in a hook.
let accountedTo = 0
afterEach(() => {
  expect(networkAttempts.slice(accountedTo)).toEqual([])
  accountedTo = networkAttempts.length
})
afterAll(() => {
  expect(networkAttempts).toEqual([])
})

const addrMap = (rows: { chain: string; address: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.chain, r.address]))

describe('the four addresses, both derivations, pinned as literals', () => {
  test('v1 — recovers byte-identical', async () => {
    const set = await addressesFromPhrase(PHRASE, 'v1')
    expect(set.derivation).toBe('v1')
    expect(addrMap(set.addresses)).toEqual({ ...V1 })
  })

  test('v2 — recovers the web wallet four addresses byte-identical', async () => {
    const set = await addressesFromPhrase(PHRASE, 'v2')
    expect(set.derivation).toBe('v2')
    expect(addrMap(set.addresses)).toEqual({ ...V2 })
  })

  test('an absent derivation marker is v1, never v2', async () => {
    const set = await addressesFromPhrase(PHRASE, undefined)
    expect(set.derivation).toBe('v1')
    expect(addrMap(set.addresses)).toEqual({ ...V1 })
  })

  test('the two sets are DIFFERENT — a collapse to one set is the silent bug', async () => {
    const both = await recoverBoth(PHRASE)
    expect(addrMap(both.v1.addresses)).toEqual({ ...V1 })
    expect(addrMap(both.v2.addresses)).toEqual({ ...V2 })
    for (const chain of ['sui', 'evm', 'sol', 'btc'] as const) {
      expect(V1[chain]).not.toBe(V2[chain])
    }
  })

  // THE LABEL TEXT IS PINNED AS A LITERAL, and that is the point of this test.
  //
  // It first called labelFor() to find each block — so swapping the two labels
  // inside labelFor swapped the test's expectations with them and it stayed
  // green. Measured: with `v2` and `v1` transposed, 30 pass / 0 fail. A check
  // that moves with the thing it checks cannot catch the row's named silent
  // bite, where a holder reads the wrong heading and sends to addresses their
  // key does not own. The marks below are constants; a swap now fails.
  test('renderSets prints each address under the LITERAL label of the derivation that owns it', async () => {
    const both = await recoverBoth(PHRASE)
    const rendered = renderSets([both.v1, both.v2])

    // the two headings, as a holder reads them — not as the code names them
    expect(labelFor('v1')).toContain(V1_MARK)
    expect(labelFor('v2')).toContain(V2_MARK)
    expect(rendered).toContain(V1_MARK)
    expect(rendered).toContain(V2_MARK)

    const v1At = rendered.indexOf(V1_MARK)
    const v2At = rendered.indexOf(V2_MARK)
    expect(v1At).toBeGreaterThanOrEqual(0)
    expect(v2At).toBeGreaterThan(v1At)
    const v1Block = rendered.slice(v1At, v2At)
    const v2Block = rendered.slice(v2At)
    for (const chain of ['sui', 'evm', 'sol', 'btc'] as const) {
      expect(v1Block).toContain(V1[chain])
      expect(v1Block).not.toContain(V2[chain])
      expect(v2Block).toContain(V2[chain])
      expect(v2Block).not.toContain(V1[chain])
    }
  })

  test('the CLI prints the production rendering, not a second one of its own', async () => {
    const both = await recoverBoth(PHRASE)
    const file = join(tmpdir(), `recover-render-${process.pid}.txt`)
    writeFileSync(file, PHRASE, { mode: 0o600 })
    const out: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stdout.write
    try {
      await main(['--phrase-file', file])
    } finally {
      process.stdout.write = realOut
      rmSync(file, { force: true })
    }
    // byte-for-byte the same renderer — one answer, never two.
    expect(out.join('')).toContain(renderSets([both.v1, both.v2]))
  })

  // A CHECKPOINT, not the accounting. It covers only what has run so far; the
  // afterEach/afterAll above are what cover the whole suite.
  test('the derivation path so far has attempted no network at all', () => {
    expect(networkAttempts).toEqual([])
  })

  test('an invalid phrase throws and derives nothing — no fallback wallet', async () => {
    await expect(addressesFromPhrase('not a real phrase at all', 'v2')).rejects.toThrow()
  })
})

// ===== VAULT FILES: authenticate, or derive nothing =====

const KDF_TEST = { t: 1, m: 256, p: 1 } as const

describe('vault files — a failure derives nothing', () => {
  test('a passphrase vault opens and its marker picks the branch', async () => {
    const blob = await sealVault(PHRASE, 'correct horse', { derivation: 'v2', kdf: KDF_TEST })
    const opened = await phraseFromVault(blob, 'correct horse')
    expect(opened.derivation).toBe('v2')
    const set = await addressesFromPhrase(opened.phrase, opened.derivation)
    expect(addrMap(set.addresses)).toEqual({ ...V2 })
  })

  test('a vault sealed WITHOUT a marker is v1 — undefined must never mean v2', async () => {
    const blob = await sealVault(PHRASE, 'correct horse', { kdf: KDF_TEST })
    const opened = await phraseFromVault(blob, 'correct horse')
    expect(opened.derivation).toBe('v1')
    const set = await addressesFromPhrase(opened.phrase, opened.derivation)
    expect(addrMap(set.addresses)).toEqual({ ...V1 })
  })

  test('a keychain-wrapped vault is refused BEFORE any passphrase work, and names the 24 words', async () => {
    const blob = await sealVault(PHRASE, 'a-keystore-secret', {
      wrap: 'keychain',
      derivation: 'v2',
      kdf: KDF_TEST,
    })
    // even with the RIGHT secret: this copy is not openable on another machine,
    // and pretending otherwise is how a holder concludes their money is gone.
    await expect(phraseFromVault(blob, 'a-keystore-secret')).rejects.toThrow(/24 words/i)
  })

  test('a wrong passphrase throws, derives nothing, and echoes no secret', async () => {
    const blob = await sealVault(PHRASE, 'correct horse', { derivation: 'v2', kdf: KDF_TEST })
    let message = ''
    let derived: unknown = 'NOT-THROWN'
    try {
      derived = await phraseFromVault(blob, 'wrong horse')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(derived).toBe('NOT-THROWN')
    expect(message).toBeTruthy()
    expect(message).not.toContain('abandon')
    expect(message).not.toContain('horse')
  })

  test('a corrupt blob throws rather than generating a stranger wallet', async () => {
    const blob = await sealVault(PHRASE, 'correct horse', { derivation: 'v2', kdf: KDF_TEST })
    const tampered = { ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' } as VaultBlob
    await expect(phraseFromVault(tampered, 'correct horse')).rejects.toThrow()
  })
})

// ===== BALANCES: only an RPC the holder names, carrying only public bytes =====

describe('balances', () => {
  test('there is no default endpoint — an empty rpc is refused', async () => {
    await expect(
      fetchBalance({ rpc: '', chain: 'sui', address: V2.sui, fetchImpl: globalThis.fetch }),
    ).rejects.toThrow()
  })

  test('an rpc pointing at a ONE server is refused — no ONE server in the path', () => {
    expect(() => assertNotOneServer('https://one.ie/api/x')).toThrow()
    expect(() => assertNotOneServer('https://api.one.ie/rpc')).toThrow()
    expect(() => assertNotOneServer('https://fullnode.mainnet.sui.io')).not.toThrow()
  })

  test('the request carries the public address and nothing else', async () => {
    const wallet = await addressesFromPhrase(PHRASE, 'v2')
    const req = balanceRequest('https://fullnode.mainnet.sui.io', 'sui', V2.sui)
    const body = typeof req.body === 'string' ? req.body : ''
    expect(body).toContain(V2.sui)
    expect(body).not.toContain('abandon')
    expect(wallet.addresses.every((a) => !JSON.stringify(a).includes('privateKey'))).toBe(true)
  })

  test('an INJECTED fetch answers — the real one would have thrown', async () => {
    let seen = ''
    const injected = (async (url: unknown, init: unknown) => {
      seen = String(url)
      const body = (init as { body?: string } | undefined)?.body ?? ''
      expect(body).not.toContain('abandon')
      return new Response(JSON.stringify({ result: { totalBalance: '12345' } }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const out = await fetchBalance({
      rpc: 'https://fullnode.mainnet.sui.io',
      chain: 'sui',
      address: V2.sui,
      fetchImpl: injected,
    })
    expect(seen).toBe('https://fullnode.mainnet.sui.io')
    expect(out.balance).toBe('12345')
    expect(networkAttempts).toEqual([])
  })
})

// ===== THE CLI's BALANCE LEG — the one line in the tool that can reach a wire =====
//
// Everything above hands `fetchBalance` an injected fetch. `main()` does not: it
// passes the GLOBAL. That line is the only place this tool can touch a network,
// and a grep cannot see it (it is `fetch`, not a URL), so it is tested here by
// swapping the global underneath it — once with a fetch that throws, once with
// one that answers.

describe('the CLI balance leg', () => {
  const phraseFile = join(tmpdir(), `recover-accept-${process.pid}.txt`)

  const runCli = async (argv: string[], stub: typeof globalThis.fetch) => {
    writeFileSync(phraseFile, PHRASE, { mode: 0o600 })
    const out: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    const realGlobal = throwingFetch
    process.stdout.write = ((s: unknown) => (out.push(String(s)), true)) as typeof process.stdout.write
    process.stderr.write = ((s: unknown) => (out.push(String(s)), true)) as typeof process.stderr.write
    globalThis.fetch = stub
    try {
      const code = await main(['--phrase-file', phraseFile, '--derivation', 'v2', ...argv])
      return { code, out: out.join('') }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
      globalThis.fetch = realGlobal
      rmSync(phraseFile, { force: true })
    }
  }

  test('it really uses the global fetch — and a failed read is NOT a zero', async () => {
    let reached = ''
    const throwing = ((url: unknown) => {
      reached = String(url)
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { code, out } = await runCli(['--rpc', 'sui=https://example.invalid/rpc'], throwing)
    expect(reached).toBe('https://example.invalid/rpc') // the leg is executed, not skipped
    expect(out).toContain(V2.sui) // addresses still printed — recovery does not need a network
    expect(out).toContain('unread —') // "0" would be a lie
    expect(out).not.toContain('abandon') // no secret on any stream
    expect(code).toBe(1)
  })

  test('an answering endpoint prints the balance, and a ONE server is refused', async () => {
    const answering = (async () =>
      new Response(JSON.stringify({ result: { totalBalance: '777' } }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const ok = await runCli(['--rpc', 'sui=https://fullnode.mainnet.sui.io'], answering)
    expect(ok.out).toContain('777')
    expect(ok.code).toBe(0)

    let reached = false
    const watcher = (async () => {
      reached = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const refused = await runCli(['--rpc', 'sui=https://api.one.ie/rpc'], watcher)
    expect(reached).toBe(false) // refused BEFORE the request, not after
    expect(refused.out).toContain('unread —')
    expect(refused.code).toBe(1)
  })

  test('a secret on argv is refused with exit 2 and nothing derived', async () => {
    const out: string[] = []
    const realErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((s: unknown) => (out.push(String(s)), true)) as typeof process.stderr.write
    let code: number
    try {
      code = await main(['--phrase', PHRASE])
    } finally {
      process.stderr.write = realErr
    }
    expect(code).toBe(2)
    expect(out.join('')).toMatch(/history|ps/)
    expect(out.join('')).not.toContain(V1.sui)
  })

  test('the CLI balance leg used the LOCAL stub, so the preload counter is still clean', () => {
    // the swapped-in stubs above are the test's own; a hit on the PRELOAD's
    // counter here would mean something reached past them.
    expect(networkAttempts).toEqual([])
  })
})

// ===== A FAILURE MESSAGE MUST NOT QUOTE THE FILE IT FAILED ON =====
//
// THE PREMISE, MEASURED — because it is not quite what it was reported to be.
// The objection was that `JSON.parse` puts a fragment of its INPUT in the
// message it throws, so printing a caught error on the vault path can put vault
// bytes on a terminal. Measured on this box, neither runtime quotes the bytes:
//   bun  -> "JSON Parse error: Expected '}'"
//   node -> "Expected ',' or '}' after property value in JSON at position 33"
// node leaks a POSITION, bun leaks nothing. So the specific leak does not
// reproduce here, and saying it did would be the same overclaim this pass is
// fixing elsewhere.
//
// The rule is kept anyway, because it is the rule and not the instance: the CLI
// prints NO caught message on any path that has touched vault or phrase input.
// That is structural — it does not depend on which parser, SDK version or fs
// error is in play next, and every one of those is free to quote its input.
// The canary below is a belt that today's parser cannot trip; the fixed-sentence
// assertion beside it is what actually bites (proven: restoring the raw
// JSON.parse + verbatim print made this suite exit 1).

describe('a vault failure never echoes the vault', () => {
  const CANARY = 'CANARY-VAULT-BYTES-must-never-be-printed'

  const runVault = async (contents: string) => {
    const file = join(tmpdir(), `recover-vault-${process.pid}.json`)
    writeFileSync(file, contents, { mode: 0o600 })
    const pass = join(tmpdir(), `recover-pass-${process.pid}.txt`)
    writeFileSync(pass, 'whatever', { mode: 0o600 })
    const out: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stdout.write
    process.stderr.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stderr.write
    try {
      const code = await main(['--vault', file, '--passphrase-file', pass])
      return { code, out: out.join('') }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
      rmSync(file, { force: true })
      rmSync(pass, { force: true })
    }
  }

  test('a malformed vault: fixed sentence, no file bytes, nothing derived', async () => {
    const { code, out } = await runVault(`{"v":1,"ct":"${CANARY}" this is not json`)
    expect(out).not.toContain(CANARY) // the whole objection, in one line
    expect(out).toContain(SAFE_MESSAGE['vault-malformed'])
    expect(out).not.toContain(V1.sui) // no fallback wallet on a failed read
    expect(out).not.toContain(V2.sui)
    expect(code).toBe(1)
  })

  test('a well-formed JSON that is not a vault is refused the same way', async () => {
    const { code, out } = await runVault(`{"notAVault":"${CANARY}"}`)
    expect(out).not.toContain(CANARY)
    expect(out).toContain(SAFE_MESSAGE['vault-malformed'])
    expect(code).toBe(1)
  })

  test('parseVaultBlob throws a TYPED failure, and its message is a constant', () => {
    try {
      parseVaultBlob(`{"ct":"${CANARY}"`)
      throw new Error('parseVaultBlob accepted a malformed vault')
    } catch (e) {
      expect(e).toBeInstanceOf(RecoverError)
      expect((e as RecoverError).kind).toBe('vault-malformed')
      expect((e as RecoverError).message).toBe(SAFE_MESSAGE['vault-malformed'])
      expect((e as RecoverError).message).not.toContain(CANARY)
    }
  })

  test('cli.ts prints no caught message anywhere — the rule, read off the source', () => {
    // The behavioural tests above cover the paths they exercise. This one covers
    // the paths nobody thought to exercise, which is where the next leak will be.
    const cli = readFileSync(join(SRC, 'cli.ts'), 'utf8')
    const offenders: string[] = []
    cli.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
      // a caught error reaching a stream, in any of its usual shapes
      if (/(process\.(stdout|stderr)\.write|console\.(log|error|warn))[^\n]*\b(e|err|error)\b[^\n]*\.message/.test(line)) {
        offenders.push(`cli.ts:${i + 1} ${line.trim()}`)
      }
    })
    expect(offenders).toEqual([])
  })

  test('every sentence this tool can print about a failure is a constant', () => {
    // If a kind is ever built by interpolation, this catches it: no SAFE_MESSAGE
    // value may carry a template hole or a quoted fragment.
    for (const [kind, sentence] of Object.entries(SAFE_MESSAGE)) {
      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence).not.toMatch(/\$\{|undefined|\[object/)
      expect(new RecoverError(kind as keyof typeof SAFE_MESSAGE).message).toBe(sentence)
    }
  })
})


// ===== argv IS NEVER ECHOED, BECAUSE AN UNKNOWN TOKEN MAY BE THE PHRASE =====

describe('a refusal never repeats what it refused', () => {
  const runArgs = async (argv: string[]) => {
    const out: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stdout.write
    process.stderr.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stderr.write
    try {
      return { code: await main(argv), out: out.join('') }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  // the exact shapes a holder gets wrong at 2am with their paper backup in hand
  const SECRET_SHAPES: [string, string[]][] = [
    ['--phrase=<the whole phrase>', [`--phrase=${PHRASE}`]],
    ['a bare pasted mnemonic', [PHRASE]],
    ['a bare mnemonic as 24 separate arguments', PHRASE.split(' ')],
    ['--mnemonic with the value after it', ['--mnemonic', PHRASE]],
    ['a phrase typed where a filename belongs', ['--phrase-file', PHRASE]],
    ['a phrase typed where a derivation belongs', ['--derivation', PHRASE]],
  ]

  for (const [what, argv] of SECRET_SHAPES) {
    test(`${what}: refused, non-zero, and ZERO occurrences of the phrase on any stream`, async () => {
      const { code, out } = await runArgs(argv)
      // the whole phrase, any single word of it, and the first word alone
      expect(out).not.toContain(PHRASE)
      expect(out).not.toContain('abandon')
      expect(out).not.toContain(' art')
      expect(out).not.toContain(V1.sui) // and nothing was derived
      expect(out).not.toContain(V2.sui)
      expect(code).toBeGreaterThan(0)
    })
  }

  test('the SUCCESS path echoes no value either — the rule has no exception', async () => {
    // Every error path was fixed first, and the success path was still printing
    // the destination verbatim. A rule with one exception is a habit.
    const dir = mkdtempSync(join(tmpdir(), 'recover-success-'))
    const phraseFile = join(dir, 'words.txt')
    writeFileSync(phraseFile, PHRASE, { mode: 0o600 })
    // a destination whose NAME is the secret — the stretch case, and the one
    // that decides whether the rule holds everywhere or only where it is easy
    const dest = join(dir, `${PHRASE.split(' ').slice(0, 6).join('-')}.json`)
    const { code, out } = await runArgs(['--phrase-file', phraseFile, '--derivation', 'v2', '--export-signer', dest])
    expect(code).toBe(0)
    expect(out).not.toContain(dest)
    expect(out).not.toContain('abandon')
    expect(out).toMatch(/--export-signer/) // the FLAG is named; the path is not
    expect(readFileSync(dest, 'utf8')).toContain((await signerBundle(PHRASE, 'v2')).keys[0].privateKeyHex)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a known flag used wrongly may still be NAMED — that name is our literal', async () => {
    const { code, out } = await runArgs(['--vault'])
    expect(out).toContain('--vault')
    expect(code).toBe(2)
  })

  test('the argv refusal still explains WHY, or it just looks broken', async () => {
    const { out } = await runArgs(['--phrase', 'x'])
    expect(out).toMatch(/history/)
    expect(out).toMatch(/ps/)
  })
})

// ===== THE SIGNER GOES TO A PROTECTED REGULAR FILE, OR NOWHERE =====
//
// `mode: 0o600` applies only on CREATION and the write FOLLOWS a symlink, so a
// destination that is a link, a fifo or /dev/stdout turned "write the keys to a
// file" into "print the keys" — the one output this tool must never produce.

describe('the signer export refuses to publish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-signer-'))
  const phraseFile = join(dir, 'words.txt')

  const runExport = async (dest: string, extra: string[] = []) => {
    writeFileSync(phraseFile, PHRASE, { mode: 0o600 })
    const out: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stdout.write
    process.stderr.write = ((x: unknown) => (out.push(String(x)), true)) as typeof process.stderr.write
    try {
      const code = await main(['--phrase-file', phraseFile, '--derivation', 'v2', '--export-signer', dest, ...extra])
      return { code, out: out.join('') }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  // the v2 sui private key — the exact bytes that must never reach a stream
  const keyBytes = async () => (await signerBundle(PHRASE, 'v2')).keys[0].privateKeyHex

  test('a symlink destination is REFUSED, and the link target is untouched', async () => {
    const real = join(dir, 'real-target.txt')
    writeFileSync(real, 'original contents\n', { mode: 0o600 })
    const link = join(dir, 'a-link')
    symlinkSync(real, link)

    const key = await keyBytes()
    const { code, out } = await runExport(link, ['--force'])
    expect(out).not.toContain(key) // no key bytes on stdout or stderr
    expect(readFileSync(real, 'utf8')).toBe('original contents\n') // not written through
    expect(out).toMatch(/symlink/)
    expect(code).toBe(1)
  })

  test('a character device (/dev/stdout) is REFUSED — that is the print-the-keys case', async () => {
    const key = await keyBytes()
    const { code, out } = await runExport('/dev/stdout', ['--force'])
    expect(out).not.toContain(key)
    // On macOS /dev/stdout is ITSELF a symlink (-> /dev/fd/1), so the symlink
    // guard fires first. Either refusal is correct; what matters is that the
    // keys do not reach the stream. Both branches are asserted by name so this
    // stays true on a platform where it is a character device instead.
    expect(out).toMatch(/symlink|not a regular file/)
    expect(code).toBe(1)
  })

  test('a fifo is REFUSED', async () => {
    const fifo = join(dir, 'a-fifo')
    // mkfifo via the shell; skip the case rather than fake it if that fails
    const made = Bun.spawnSync(['mkfifo', fifo]).exitCode === 0
    if (!made) return
    const key = await keyBytes()
    const { code, out } = await runExport(fifo, ['--force'])
    expect(out).not.toContain(key)
    expect(code).toBe(1)
  })

  test('a regular file gets the keys at mode 0600 — and an existing 0666 file does NOT keep 0666', async () => {
    const dest = join(dir, 'signer.json')
    writeFileSync(dest, '{}')
    chmodSync(dest, 0o666) // umask trims the mode on create — set it explicitly
    expect(statSync(dest).mode & 0o777).toBe(0o666)

    const key = await keyBytes()
    const { code, out } = await runExport(dest, ['--force'])
    expect(code).toBe(0)
    expect(out).not.toContain(key) // the PATH is announced; the KEYS are not
    expect(readFileSync(dest, 'utf8')).toContain(key) // they are in the file
    expect(statSync(dest).mode & 0o777).toBe(0o600) // the mode we set, not the one inherited
  })

  test('an existing regular file is not overwritten without --force', async () => {
    const dest = join(dir, 'keep-me.json')
    writeFileSync(dest, 'do not clobber', { mode: 0o600 })
    const { code, out } = await runExport(dest)
    expect(readFileSync(dest, 'utf8')).toBe('do not clobber')
    expect(out).toMatch(/--force/)
    expect(code).toBe(1)
  })

  test('no temp file is left behind on a refusal', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

// ===== SECRETS: exported only on demand, never printed =====

describe('secrets', () => {
  test('the address view carries no private material at all', async () => {
    const set = await addressesFromPhrase(PHRASE, 'v2')
    expect(JSON.stringify(set)).not.toMatch(/privateKey|secret|mnemonic|abandon/i)
  })

  test('the signer bundle is a separate, explicit call and it DOES carry keys', async () => {
    const bundle = await signerBundle(PHRASE, 'v2')
    expect(bundle.derivation).toBe('v2')
    expect(bundle.keys.length).toBe(4)
    for (const k of bundle.keys) expect(k.privateKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(addrMap(bundle.keys)).toEqual({ ...V2 })
  })
})

// ===== THE INVARIANTS A GREP CAN STILL CATCH =====

const SRC = join(import.meta.dir, '..', 'src')

describe('independence, checked over the source', () => {
  test('no ONE server URL in src — the brand link the licence obliges excepted', () => {
    const offenders: string[] = []
    for (const f of readdirSync(SRC)) {
      const text = readFileSync(join(SRC, f), 'utf8')
      for (const url of text.matchAll(/https?:\/\/[^\s"'`<>)]*one\.ie[^\s"'`<>)]*/g)) {
        // The Free ONE License obliges the mark and the link. A bare link is
        // the one permitted occurrence; an endpoint path under it is not.
        if (url[0] === 'https://one.ie' || url[0] === 'https://one.ie/') continue
        offenders.push(`${f}: ${url[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('src reimplements NO derivation — the SDK is the only derivation code', () => {
    const banned = /\b(hkdf|HDKey|bip32|bech32|base58|mnemonicToSeed|blake2b|keccak_256|secp256k1|ed25519)\b/
    const offenders: string[] = []
    for (const f of readdirSync(SRC)) {
      if (!f.endsWith('.ts')) continue
      const text = readFileSync(join(SRC, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (banned.test(line)) offenders.push(`${f}:${i + 1} ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  // NAMED FOR WHAT IT ACTUALLY DOES. It reads the COMMITTED TEMPLATE under src/
  // and nothing else — it cannot tell you the page works offline, because src/
  // is not what a holder opens. The page a holder opens is dist/page.html, and
  // the check that it RUNS — executing the committed bundle against these same
  // pinned vectors with every network door shut — is C7b's test/page-bundle.test.ts.
  // This one stays as the cheap belt on the template it guards.
  test('the committed page.html carries no remote URL — and nothing more than that', () => {
    const html = join(SRC, 'page.html')
    expect(existsSync(html)).toBe(true)
    const text = readFileSync(html, 'utf8')
    const remote = [...text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])
    for (const url of remote) {
      // a plain link the holder may click is not a load; a fetched asset is.
      const isLink = new RegExp(`href\\s*=\\s*["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(text)
      if (isLink && url === 'https://one.ie') continue
      expect(url).not.toMatch(/^(https?:)?\/\//)
    }
    expect(text).not.toMatch(/cdn\.|unpkg|jsdelivr|googleapis|analytics|gtag/i)
  })

  // THE TODO THAT WAS HERE IS DISCHARGED, not deleted quietly. C7 recorded that
  // nothing proved the page renders four addresses from file:// with the network
  // off, because the bundle was generated and uncommitted. C7b commits ONE
  // self-contained dist/page.html and executes it: test/page-bundle.test.ts runs
  // the committed bundle under a DOM shim whose fetch, XMLHttpRequest, WebSocket,
  // sendBeacon, Image and storages all record-and-throw, and asserts the same
  // eight literals this file pins. The line below keeps the two files tied
  // together so neither can be deleted without the other going red.
  test('the offline page accept exists and pins the SAME eight addresses this file does', () => {
    const page = readFileSync(join(import.meta.dir, 'page-bundle.test.ts'), 'utf8')
    for (const a of [...Object.values(V1), ...Object.values(V2)]) expect(page).toContain(a)
    expect(page).toContain(PHRASE)
  })
})
