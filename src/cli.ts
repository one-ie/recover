#!/usr/bin/env bun
/**
 * cli.ts — the offline recovery tool, on a terminal.
 *
 *   bun src/cli.ts                        # 24 words, typed hidden, both derivations
 *   bun src/cli.ts --phrase-file words.txt
 *   bun src/cli.ts --vault vault.json     # passphrase typed hidden
 *   bun src/cli.ts --rpc sui=https://fullnode.mainnet.sui.io --rpc evm=https://…
 *   bun src/cli.ts --export-signer ./signer.json
 *
 * THE PHRASE NEVER COMES FROM argv. `--phrase "<words>"` is refused with a
 * sentence saying why: argv is in the shell history file and in `ps` output for
 * every other user on the box, so a secret passed that way is disclosed before
 * the program starts. Words arrive on stdin (hidden when the terminal is
 * interactive) or in a file the holder names.
 *
 * NOTHING SECRET IS EVER PRINTED. Addresses are public and go to stdout. A
 * signer leaves this process only through --export-signer, into a file written
 * 0600 that will not silently replace an existing one.
 *
 * NO NETWORK unless the holder names an RPC. There is no default endpoint, and
 * a ONE server is refused outright (see assertNotOneServer) — the whole point
 * of this tool is that it works when one.ie does not.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  addressesFromPhrase,
  fetchBalance,
  parseVaultBlob,
  RecoverError,
  labelFor,
  phraseFromVault,
  recoverBoth,
  renderSets,
  signerBundle,
  type AddressSet,
  type Chain,
  type Derivation,
} from './recover.ts'

const CHAINS: Chain[] = ['sui', 'evm', 'sol', 'btc']

const HELP = `one-recover — recover a ONE key with no ONE server in the path

  --phrase-file <path>     read the 24 words from a file (else: hidden prompt / stdin)
  --vault <path>           read a sealed vault file instead of words
  --passphrase-file <path> read the vault passphrase from a file (else: hidden prompt)
  --derivation v1|v2|both  which address set to print (default: both)
  --rpc <chain>=<url>      read a balance from an endpoint YOU name (repeatable)
  --export-signer <path>   write the private keys to a file, mode 0600
  --force                  allow --export-signer to overwrite an existing file
  --json                   machine-readable addresses on stdout
  --help

The phrase is never taken from the command line: argv is visible in your shell
history and in \`ps\` to every user on this machine.

Free ONE License — keep the ONE mark and the link https://one.ie in what you ship,
and the ONE coin on Sui. Independence is a property of your key, not a promise from us.`

/**
 * An argument refusal, in OUR words. Separate from a caught runtime error on
 * purpose: these sentences are written here as constants (plus, at most, a flag
 * TOKEN the holder typed — never a flag VALUE), so they are safe to print in
 * full, and the `--phrase` refusal has to keep explaining WHY or it just looks
 * like a broken tool.
 */
class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

interface Args {
  phraseFile?: string
  vault?: string
  passphraseFile?: string
  derivation: 'v1' | 'v2' | 'both'
  rpc: Map<Chain, string>
  exportSigner?: string
  force: boolean
  json: boolean
  help: boolean
}

/**
 * WHY NOTHING FROM argv IS EVER ECHOED.
 *
 * An unknown token may BE the secret. `--phrase=<the 24 words>` and a bare
 * pasted mnemonic both arrive here as ordinary argv strings, and a refusal that
 * quotes what it refused writes them to stderr — which is the very exposure the
 * whole design exists to prevent (argv is already in shell history and in `ps`;
 * echoing it adds the terminal, the scrollback and any log capturing stderr).
 *
 * So: a KNOWN flag may be named, because the name printed is our own literal
 * from the table below and not the token the holder typed. An unknown token is
 * never named, and a flag VALUE is never named — not a path, not a URL, not a
 * destination. `--phrase=x` is split so the known-flag refusal still fires with
 * its explanation intact.
 */
const KNOWN_FLAGS = new Set([
  '--phrase',
  '--passphrase',
  '--mnemonic',
  '--phrase-file',
  '--vault',
  '--passphrase-file',
  '--derivation',
  '--rpc',
  '--export-signer',
  '--force',
  '--json',
  '--help',
  '-h',
])

const REFUSE_ARGV_SECRET =
  'A secret on the command line is refused on purpose: it is written to your shell history and is ' +
  'visible in `ps` to every user on this machine. Pipe it on stdin, or use --phrase-file / --passphrase-file.'

const REFUSE_UNKNOWN =
  'Unrecognised argument. It is not repeated here on purpose — an unknown argument may BE your ' +
  'recovery phrase, and printing it would put it on your screen and in your scrollback. Run --help.'

export function parseArgs(argv: string[]): Args {
  const a: Args = { derivation: 'both', rpc: new Map(), force: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    // `--flag=value` is split so a known flag is still recognised. The VALUE is
    // dropped on the floor unless the flag is one that takes one.
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const name = eq > 0 ? token.slice(0, eq) : token
    const inline = eq > 0 ? token.slice(eq + 1) : undefined
    if (!KNOWN_FLAGS.has(name)) throw new ArgError(REFUSE_UNKNOWN)

    const next = (): string => {
      if (inline !== undefined) return inline
      const v = argv[++i]
      // `name` is byte-equal to a literal in KNOWN_FLAGS — safe to print.
      if (v === undefined) throw new ArgError(`${name} needs a value`)
      return v
    }

    switch (name) {
      case '--phrase':
      case '--passphrase':
      case '--mnemonic':
        // The value, if any, is never touched and never printed.
        throw new ArgError(REFUSE_ARGV_SECRET)
      case '--phrase-file':
        a.phraseFile = next()
        break
      case '--vault':
        a.vault = next()
        break
      case '--passphrase-file':
        a.passphraseFile = next()
        break
      case '--derivation': {
        const v = next()
        // the value is NOT echoed — a holder who typed their phrase here would
        // otherwise see it back.
        if (v !== 'v1' && v !== 'v2' && v !== 'both') throw new ArgError('--derivation must be v1, v2 or both')
        a.derivation = v
        break
      }
      case '--rpc': {
        const [chain, ...rest] = next().split('=')
        const url = rest.join('=')
        if (!CHAINS.includes(chain as Chain) || !url) throw new ArgError('--rpc takes <sui|evm|sol|btc>=<url>')
        a.rpc.set(chain as Chain, url)
        break
      }
      case '--export-signer':
        a.exportSigner = next()
        break
      case '--force':
        a.force = true
        break
      case '--json':
        a.json = true
        break
      case '--help':
      case '-h':
        a.help = true
        break
    }
  }
  return a
}

/** Read a secret from a file the holder named, warning — on stderr, never
 *  stdout — when the file is readable by anyone but its owner. */
function readSecretFile(path: string, flag: string): string {
  // `flag` is our own literal; `path` is a VALUE from argv and is never printed
  // — a holder who typed their 24 words where a filename belongs would
  // otherwise read them back off their own terminal.
  if (!existsSync(path)) throw new ArgError(`the file given to ${flag} does not exist`)
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    process.stderr.write(
      `warning: the file given to ${flag} is readable by other users (mode ${mode.toString(8)}). chmod 600 it.\n`,
    )
  }
  return readFileSync(path, 'utf8').trim()
}

/** Hidden interactive input, or piped stdin. Never echoed, never logged. */
async function readSecretStdin(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  const typed = await new Promise<string>((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          process.stderr.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          process.stderr.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    stdin.on('data', onData)
  })
  return typed.trim()
}

/**
 * WRITE THE SIGNER, OR REFUSE — never write it somewhere that publishes it.
 *
 * `writeFileSync(path, …, { mode })` is not enough, and the gap is the worst
 * one this tool could have. `mode` applies only when the file is CREATED, so an
 * existing destination keeps whatever permissions it already had; and the write
 * FOLLOWS a symlink, so `--export-signer link-to-something` writes through it.
 * A destination that is a fifo, a socket or a character device — `/dev/stdout`
 * most obviously — turns "write the private keys to a file" into "print the
 * private keys", which is the one output this tool must never produce.
 *
 * So: lstat (NOT stat — do not follow the link), require a REGULAR file or
 * nothing at all, and write through a fresh temp file in the destination's own
 * directory, created 0600, fsynced, then renamed into place. rename(2) replaces
 * the name atomically and carries the mode we set, so the result cannot inherit
 * a permissive mode and cannot be redirected by a link planted mid-write.
 * `--force` may replace an existing REGULAR file; it can never make a
 * non-regular destination writable.
 */
function writeSignerFile(path: string, body: string, force: boolean): void {
  let existing: Stats | undefined
  try {
    existing = lstatSync(path) // lstat: a symlink is reported as a symlink
  } catch {
    existing = undefined // nothing there — the normal case
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new ArgError(
        'refusing to write the signer to a symlink — it would put private keys wherever the link points. ' +
          'Name a real file.',
      )
    }
    if (!existing.isFile()) {
      throw new ArgError(
        'refusing to write the signer to something that is not a regular file (a device, fifo, socket or ' +
          'directory). /dev/stdout and friends would print your private keys. Name a real file.',
      )
    }
    if (!force) {
      throw new ArgError(
        'refusing to overwrite the existing file given to --export-signer — pass --force if that is what you mean',
      )
    }
  }

  // A fresh file in the SAME directory, so the rename is atomic and stays on
  // one filesystem. `wx` refuses to reuse anything already at the temp name.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, body)
    fsyncSync(fd) // on disk before it is given its real name
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * THE ONE PLACE A FAILURE BECOMES WORDS — and it never uses the caught message.
 *
 * `JSON.parse` quotes its input in what it throws, and on the vault path that
 * input is the vault file: printing `e.message` there can put vault bytes on a
 * terminal and into a scrollback. So this CLI has exactly one rule about
 * errors, and it is structural rather than careful — **no caught `e.message`
 * is ever written to any stream.** A RecoverError carries a KIND whose sentence
 * is a constant in recover.ts; anything else prints its class name only, which
 * is a fact about our code and never about the holder's input.
 */
function say(e: unknown, fallback: string): string {
  if (e instanceof RecoverError) return e.message // a constant from SAFE_MESSAGE
  if (e instanceof ArgError) return e.message // our own words, no holder input
  const kind = e instanceof Error ? e.name : 'Error'
  return `${fallback} (${kind})`
}

export async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (e) {
    // parseArgs' own sentences. They quote a flag TOKEN at most — never a flag
    // VALUE, so a mistyped `--phrasefile <words>` reports the flag and drops
    // the words.
    process.stderr.write(`${say(e, 'Could not read the arguments')}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  // ---- the secret, and the derivation it was kept with -------------------
  let phrase: string
  let vaultDerivation: Derivation | undefined
  try {
    if (args.vault) {
      const blob = parseVaultBlob(readFileSync(args.vault, 'utf8'))
      const passphrase = args.passphraseFile
        ? readSecretFile(args.passphraseFile, '--passphrase-file')
        : await readSecretStdin('Vault passphrase (not shown): ')
      const opened = await phraseFromVault(blob, passphrase)
      phrase = opened.phrase
      vaultDerivation = opened.derivation
    } else if (args.phraseFile) {
      phrase = readSecretFile(args.phraseFile, '--phrase-file')
    } else {
      phrase = await readSecretStdin('Recovery phrase, 24 words (not shown): ')
    }
  } catch (e) {
    // This is the path that has touched the vault file and the phrase. Nothing
    // derived, and nothing echoed: a fixed sentence by kind, never the caught
    // message. No fallback wallet, ever.
    process.stderr.write(`${say(e, 'Could not read that input. Nothing was derived')}\n`)
    return 1
  }
  if (!phrase) {
    process.stderr.write('no recovery phrase given\n')
    return 1
  }

  // ---- the addresses ------------------------------------------------------
  let sets: AddressSet[]
  try {
    if (vaultDerivation) {
      // The vault RECORDS which derivation its key was born under. Printing the
      // other set beside it would invite a send to addresses this key does not own.
      sets = [await addressesFromPhrase(phrase, vaultDerivation)]
    } else if (args.derivation === 'both') {
      const both = await recoverBoth(phrase)
      sets = [both.v1, both.v2]
    } else {
      sets = [await addressesFromPhrase(phrase, args.derivation)]
    }
  } catch (e) {
    process.stderr.write(`${say(e, 'Could not derive addresses. Nothing was derived')}\n`)
    return 1
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(sets.map((s) => ({ derivation: s.derivation, label: labelFor(s.derivation), addresses: s.addresses })), null, 2)}\n`,
    )
  } else {
    process.stdout.write(`${renderSets(sets)}\n`)
  }

  // ---- balances, only from endpoints the holder named ---------------------
  let exitCode = 0
  if (args.rpc.size > 0) {
    process.stdout.write('\nbalances (smallest unit, from the endpoints you named)\n')
    for (const set of sets) {
      for (const row of set.addresses) {
        const rpc = args.rpc.get(row.chain)
        if (!rpc) continue
        try {
          const out = await fetchBalance({ rpc, chain: row.chain, address: row.address, fetchImpl: fetch })
          process.stdout.write(`  ${set.derivation} ${row.chain.padEnd(4)} ${out.balance}\n`)
        } catch (e) {
          // A failed read is NOT a zero. Say which, and leave non-zero. The
          // node's own message is dropped with the rest: this leg has the
          // holder's address and endpoint in scope, so it gets the same rule.
          process.stdout.write(`  ${set.derivation} ${row.chain.padEnd(4)} unread — ${say(e, 'the endpoint did not answer')}\n`)
          exitCode = 1
        }
      }
    }
  }

  // ---- the signer, only when asked for by name ----------------------------
  if (args.exportSigner) {
    try {
      const bundles = await Promise.all(sets.map((s) => signerBundle(phrase, s.derivation)))
      writeSignerFile(args.exportSigner, `${JSON.stringify(bundles, null, 2)}\n`, args.force)
      // A CONSTANT sentence: not the keys, and not the path either. The path is
      // a VALUE from argv, and the rule this file keeps is that no argv value
      // reaches a stream — a rule with one exception on the success path is not
      // a rule, it is a habit. The holder named the destination; they know it.
      process.stderr.write(
        'signer written to the path you gave --export-signer (mode 0600) — it holds private keys; treat it as cash.\n',
      )
    } catch (e) {
      // The path is argv and safe to name; the caught message is not printed.
      // the destination is a VALUE from argv — named by its flag, never printed
      process.stderr.write(`${say(e, 'Could not write the signer to the path given to --export-signer')}\n`)
      return 1
    }
  }

  return exitCode
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
