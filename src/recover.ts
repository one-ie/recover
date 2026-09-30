/**
 * recover.ts — the one code path the CLI and the static page both run.
 *
 * WHAT THIS IS. The offline recovery tool's engine: words or a vault file in,
 * four addresses out, per derivation, labelled. It is REQUIRED rather than
 * recommended, because independence has to be a property of the key and not a
 * promise from ONE — if one.ie is gone, the words still open the money.
 *
 * WHAT IT MUST NEVER DO, and each of these is a check in test/recover.test.ts:
 *   • Reimplement derivation. `@oneie/sdk/wallet` is the only derivation code
 *     in the system; a second implementation here would be a second answer to
 *     "where is my money", and one of the two would be wrong forever.
 *   • Reach a ONE server. No fetch, no import, no telemetry, no default RPC —
 *     balances come only from an endpoint the holder names, and an endpoint
 *     under one.ie is refused outright.
 *   • Fall back. A vault that will not open derives NOTHING. A recovery tool
 *     that mints a fresh wallet when recovery fails shows a stranger's empty
 *     addresses, and the holder concludes the money is gone.
 *   • Print a secret. Addresses are public and printed freely; a mnemonic, a
 *     seed or a private key leaves this process only into a file the holder
 *     asked for by name.
 *
 * Subpath imports throughout — never the bare `@oneie/sdk` barrel.
 */

import { isKeychainWrapped, openVault, type VaultBlob } from '@oneie/sdk/vault-file'
import { readDerivation, recoverWallet, type Derivation, type WalletChain } from '@oneie/sdk/wallet'

export type { Derivation, VaultBlob }
export type Chain = WalletChain

/** A public address and the chain it belongs to. Carries no private material. */
export interface AddressRow {
  chain: Chain
  address: string
}

/** The four addresses of ONE derivation. The derivation is part of the answer:
 *  an address without its version is an instruction to lose money. */
export interface AddressSet {
  derivation: Derivation
  addresses: AddressRow[]
}

/** A signer — private keys. Produced only by an explicit call, never by the
 *  address path, and never written to stdout by the CLI. */
export interface SignerKey {
  chain: Chain
  address: string
  privateKeyHex: string
  publicKeyHex: string
}

export interface SignerBundle {
  derivation: Derivation
  keys: SignerKey[]
}

/**
 * WHY A TYPED FAILURE AND NOT A MESSAGE.
 *
 * `JSON.parse` puts a fragment of its INPUT in the message it throws. On the
 * vault path that input is the vault file, so a caller that prints the caught
 * error verbatim can put ciphertext — or, with a differently-shaped file, key
 * material a holder pasted into the wrong place — onto a terminal and into a
 * scrollback. The kind is what a caller branches on; the sentence it prints is
 * FIXED and lives here, never assembled from anything the holder supplied.
 */
export type RecoverFailure =
  | 'vault-malformed'
  | 'vault-keychain'
  | 'vault-unopenable'
  | 'vault-unknown-derivation'
  | 'invalid-phrase'
  | 'rpc-refused'
  | 'rpc-missing'

export class RecoverError extends Error {
  constructor(readonly kind: RecoverFailure) {
    super(SAFE_MESSAGE[kind])
    this.name = 'RecoverError'
  }
}

/** The complete set of sentences this tool is allowed to print about a failure.
 *  Every one is a constant. Nothing here interpolates caught text. */
export const SAFE_MESSAGE: Record<RecoverFailure, string> = {
  'vault-malformed':
    'That vault file is not a readable ONE vault. Nothing was derived. Recover from your 24 words instead — they derive the same addresses.',
  'vault-keychain':
    'This vault copy is sealed to a device keystore (biometric unlock) and cannot be opened on another machine. Nothing was derived. Recover from your 24 words instead — they derive the same addresses.',
  'vault-unopenable':
    'Could not open that vault — wrong passphrase, or the file has been altered. Nothing was derived. Recover from your 24 words instead — they derive the same addresses.',
  'vault-unknown-derivation':
    'That vault records a derivation this tool does not implement, so the addresses it owns cannot be named. Nothing was derived, because a guess would produce a third set nobody can find again.',
  'invalid-phrase':
    'That is not a valid 24-word BIP-39 recovery phrase. Nothing was derived — no wallet is generated when recovery fails.',
  'rpc-refused':
    'Refusing to read balances from a ONE server. This tool works without ONE by construction — name a public node instead.',
  'rpc-missing': 'No RPC endpoint. There is no default — name one with --rpc.',
}

/** Parse a vault file WITHOUT letting the parser's message escape. */
export function parseVaultBlob(text: string): VaultBlob {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The caught message quotes the input. It is dropped here, deliberately.
    throw new RecoverError('vault-malformed')
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as VaultBlob).v !== 1) {
    throw new RecoverError('vault-malformed')
  }
  return parsed as VaultBlob
}

/**
 * The human name of a derivation. Kimi's line 7 is the row's real risk and this
 * is the whole mitigation: a holder who sends to the wrong set loses the money,
 * so the label travels with the addresses everywhere they are rendered.
 */
export function labelFor(derivation: Derivation): string {
  return derivation === 'v2'
    ? 'v2 — standard paths (BIP-44 / SLIP-0010). Any BIP-39 wallet recovers these.'
    : 'v1 — original ONE derivation (HKDF labels). Only this tool and one.ie derive these.'
}

/**
 * The four addresses for one derivation. `undefined` is v1 — an absent marker
 * has always meant v1 and must never come to mean v2 (see readDerivation).
 */
export async function addressesFromPhrase(phrase: string, derivation?: Derivation): Promise<AddressSet> {
  const version = readDerivation(derivation)
  const wallet = await recoverWallet(phrase, version).catch(() => {
    throw new RecoverError('invalid-phrase')
  })
  return {
    derivation: version,
    addresses: wallet.keys.map((k) => ({ chain: k.chain, address: k.address })),
  }
}

/** Both sets, for a holder who does not know which one their key was born
 *  under — the common case for anyone reading a paper backup years later. */
export async function recoverBoth(phrase: string): Promise<{ v1: AddressSet; v2: AddressSet }> {
  return {
    v1: await addressesFromPhrase(phrase, 'v1'),
    v2: await addressesFromPhrase(phrase, 'v2'),
  }
}

/**
 * The signer. Separate call, separate type, and the CLI writes it to a file the
 * holder named with 0600 — it is never a return value that can drift onto a
 * terminal by accident.
 */
export async function signerBundle(phrase: string, derivation?: Derivation): Promise<SignerBundle> {
  const version = readDerivation(derivation)
  const wallet = await recoverWallet(phrase, version).catch(() => {
    throw new RecoverError('invalid-phrase')
  })
  return {
    derivation: version,
    keys: wallet.keys.map((k) => ({
      chain: k.chain,
      address: k.address,
      privateKeyHex: k.privateKeyHex,
      publicKeyHex: k.publicKeyHex,
    })),
  }
}

/**
 * Open a vault copy offline.
 *
 * THE KEYCHAIN CASE IS CHECKED FIRST, before any passphrase work. A keychain
 * copy's passphrase is a random secret held by the OS keystore of ONE machine;
 * it cannot be opened on another, and that is the point of the wrapping rather
 * than a defect. Prompting for a passphrase that was never set would tell the
 * holder their file is corrupt, which is false and frightening.
 *
 * Every failure — keychain wrap, wrong passphrase, tampered blob, unknown
 * derivation marker — throws. There is no fallback path that derives anything.
 */
export async function phraseFromVault(
  blob: VaultBlob,
  passphrase: string,
): Promise<{ phrase: string; derivation: Derivation }> {
  if (isKeychainWrapped(blob)) throw new RecoverError('vault-keychain')
  // Read the marker BEFORE decrypting: an unknown marker means we cannot name
  // the addresses this key has, and guessing produces a third set nobody finds.
  let derivation: Derivation
  try {
    derivation = readDerivation(blob.derivation)
  } catch {
    throw new RecoverError('vault-unknown-derivation')
  }
  // The SDK's own refusal text is safe, but it is DROPPED rather than relayed:
  // the rule this file keeps is that no caught message reaches a caller, so a
  // future SDK message that quotes its input cannot leak through this seam.
  const phrase = await openVault(blob, passphrase).catch(() => {
    throw new RecoverError('vault-unopenable')
  })
  return { phrase, derivation }
}

// ===== BALANCES — only from an endpoint the holder names =====

/**
 * Refuse an RPC that is a ONE server. The invariant on the row is "no ONE
 * server in the path"; a balance read is the only place a URL enters this tool,
 * so it is the only place that invariant can be broken — and the only place it
 * can be checked.
 */
export function assertNotOneServer(rpc: string): void {
  let host: string
  try {
    host = new URL(rpc).hostname.toLowerCase()
  } catch {
    throw new RecoverError('rpc-missing')
  }
  if (host === 'one.ie' || host.endsWith('.one.ie')) throw new RecoverError('rpc-refused')
}

/**
 * The request a balance read would make. Returned rather than sent, so a test
 * can assert what crosses the wire without a wire existing: only the public
 * address, never a phrase, a seed or a key.
 */
export function balanceRequest(rpc: string, chain: Chain, address: string): {
  url: string
  method: 'GET' | 'POST'
  body: string
  headers: Record<string, string>
} {
  if (!rpc) throw new RecoverError('rpc-missing')
  assertNotOneServer(rpc)
  const json = (method: string, params: unknown[]) => ({
    url: rpc,
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  switch (chain) {
    case 'sui':
      return json('suix_getBalance', [address])
    case 'evm':
      return json('eth_getBalance', [address, 'latest'])
    case 'sol':
      return json('getBalance', [address])
    case 'btc':
      // Esplora REST (mempool.space / blockstream.info shape) — Bitcoin has no
      // address-balance JSON-RPC on a stock node.
      return {
        url: `${rpc.replace(/\/$/, '')}/address/${address}`,
        method: 'GET',
        headers: {},
        body: '',
      }
  }
}

/** The smallest-unit balance as a decimal string, or a thrown error. Never a
 *  zero standing in for a failed read — "0" and "I could not ask" are different
 *  answers and only one of them means the money is gone. */
export function readBalance(chain: Chain, payload: unknown): string {
  const p = payload as Record<string, unknown>
  if (p && typeof p === 'object' && 'error' in p && p.error) {
    throw new Error(`recover: the node refused the request: ${JSON.stringify(p.error)}`)
  }
  switch (chain) {
    case 'sui':
      return String((p?.result as { totalBalance?: string } | undefined)?.totalBalance ?? '')
    case 'evm': {
      const hex = p?.result
      if (typeof hex !== 'string') throw new Error('recover: no balance in the response')
      return BigInt(hex).toString(10)
    }
    case 'sol':
      return String((p?.result as { value?: number } | undefined)?.value ?? '')
    case 'btc': {
      const stats = (p as { chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } })?.chain_stats
      if (!stats) throw new Error('recover: no chain_stats in the response')
      return String(BigInt(stats.funded_txo_sum ?? 0) - BigInt(stats.spent_txo_sum ?? 0))
    }
  }
}

/**
 * Read one balance through a fetch the CALLER supplies. There is no captured
 * global here on purpose: the accept test runs with a fetch that throws, so a
 * default would turn the no-network invariant into a promise instead of a check.
 */
export async function fetchBalance(q: {
  rpc: string
  chain: Chain
  address: string
  fetchImpl: typeof fetch
}): Promise<{ chain: Chain; address: string; balance: string }> {
  const req = balanceRequest(q.rpc, q.chain, q.address)
  const res = await q.fetchImpl(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.method === 'POST' ? { body: req.body } : {}),
  })
  const payload = await res.json()
  return { chain: q.chain, address: q.address, balance: readBalance(q.chain, payload) }
}

/** The whole address view as text — the same rendering the CLI prints and the
 *  page shows, so there is one answer and not two. */
export function renderSets(sets: AddressSet[]): string {
  return sets
    .map((s) => [labelFor(s.derivation), ...s.addresses.map((a) => `  ${a.chain.padEnd(4)} ${a.address}`)].join('\n'))
    .join('\n\n')
}
