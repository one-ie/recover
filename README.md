# @oneie/recover — the offline recovery tool

Words or a vault file in; four addresses, balances and a signer out. Any
machine. **No ONE server in the path.**

**Start here: https://one.ie/recover** — the three ways back in order, and the
SHA-256 of `dist/page.html` for each published version.

This tool is REQUIRED, not recommended. Independence is a property of the key,
not a promise from ONE: if one.ie is gone, the 24 words still open the money.

```bash
# 24 words, typed hidden, both address sets
bun src/cli.ts

# or from a file you protect yourself
bun src/cli.ts --phrase-file ./words.txt

# a sealed vault (passphrase typed hidden; a keychain-wrapped copy is refused
# with a plain sentence telling you to use your 24 words)
bun src/cli.ts --vault ./vault.json

# a balance, only from an endpoint YOU name — there is no default, and a ONE
# server is refused
bun src/cli.ts --rpc sui=https://fullnode.mainnet.sui.io

# the private keys, only when asked for by name: written 0600, never printed
bun src/cli.ts --export-signer ./signer.json
```

`--export-signer` refuses a symlink, a fifo, a device (`/dev/stdout`) or anything
else that is not a regular file, and writes via a fresh 0600 temp file renamed into
place — so the result never inherits a permissive mode and never writes through a
link. `--force` may replace an existing regular file; it can never make a
non-regular destination writable.

`--phrase <words>` is **refused on purpose**: argv lands in your shell history
and is visible in `ps` to every other user on the machine. A refusal never repeats
what it refused — an unknown argument may BE your recovery phrase, so it is never
echoed, and neither is any flag's value. That holds on the SUCCESS path too: the
signer confirmation names the flag, never the path.

## Install from npm — no ONE server, nothing else fetched

```bash
npx -y @oneie/recover --help     # the same tool, bundled for Node 20+
```

The package ships `dist/cli.js` (the bin, with the SDK's derivation bundled
inside — it installs no other package), `dist/recover.js` (the library),
`dist/page.html` (the offline page), `LICENSE` (the ONE License) and this
README. After the install it needs no network at all.

**Verify the page before you trust it.** Compare its SHA-256 with the one
published beside the release:

```bash
shasum -a 256 dist/page.html          # macOS / Linux
certutil -hashfile page.html SHA256   # Windows
```

A different hash means a different file: do not type your words into it.

## The page — ONE file, already built, already in the repo

`dist/page.html` **is** the tool. Copy that single file to a USB stick, a phone,
a laptop that has never heard of ONE — then take the machine off the network and
double-click it. Same four v1 and four v2 addresses the CLI prints, from the same
code, with nothing to install and nothing to fetch.

```bash
open dist/page.html     # from this folder — or drag it into any browser
```

It is **committed** (137KB), so there is nothing to build before you can use it
and nothing beside it to lose. `src/page.html` is the TEMPLATE, not the page: it
carries two markers that `bun run build:page` fills.

```bash
bun run build:page      # rebuild dist/page.html after changing src/ (offline, ~10ms)
```

Three properties, each one checked rather than promised
(`test/page-bundle.test.ts`):

- **No external anything.** The bundle is inlined, the styles are inline, there is
  no font, image, tracker or beacon. An external `<script src>` would not even
  load over `file://` — browsers refuse cross-origin module loads there — which is
  the second reason it is one file and not two.
- **Deny by default.** A `Content-Security-Policy` meta sets `default-src 'none'`
  and names the **sha256 of the inlined code**; `img-src`, `font-src`, `object-src`,
  `frame-src`, `form-action` and `base-uri` are all `'none'`. The only opening is
  `connect-src`, for the balance endpoint you type yourself. Change one byte of
  the page and the browser refuses to run it.
- **Your words stay in the tab.** They are read into a local variable, never
  logged, never stored, never put in a URL, and never sent to the balance endpoint
  — only the public address goes there, and only after you name the node.

## Two address sets — read this before you send anything

A key minted before the standard-paths ruling has **v1** addresses; a key minted
after has **v2**. Both are derivable from the same words, they are different
addresses, and money sent to a set your key does not own is not yours to move.
Every rendering here is labelled; a vault that records its derivation prints only
that set.

## What it will not do

Reimplement derivation (it calls `@oneie/sdk/wallet`, the only derivation code in
the system) · reach a ONE server · print a mnemonic, seed or private key ·
fall back to generating a wallet when recovery fails.

## Accept

```bash
bun test     # from this folder (packages/recover in the ONE monorepo)
```

63 tests, network disabled. The throwing `fetch` / `XMLHttpRequest` /
`WebSocket` stubs — plus `node:net`, `node:http`, `node:https`, `node:dgram`,
`net.Socket.prototype.connect` and `Bun.connect` — are armed in a **preload** (`bunfig.toml` → `test/no-network.ts`),
so they are in place before the first `import` of `src/` — a `beforeAll` runs too
late to see a module that fetches at import time. Proven to bite: an import-time
`fetch()`, a `node:https.request`, a `node:net.connect` or a `new Socket().connect()`
in `src/recover.ts` each make the suite exit 1 before any test runs, naming the host.
Every attempt is also accounted for after EVERY test and once at the end of the run,
not at a single point in the middle — a later attempt that the production code
catches and turns into a clean error message would otherwise be invisible.

Uncovered, and said plainly: a native addon or FFI call that opens a socket without
passing through any JS entry point. Nothing here uses FFI.

The page is checked by RUNNING it, not by reading it. `test/page-bundle.test.ts`
takes the bundle out of the **committed** `dist/page.html`, executes it against a
DOM shim whose `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `Image`,
`localStorage`, `sessionStorage` and `document.cookie` all record-and-throw, and
asserts the eight pinned addresses come out with every one of those recorders
empty. It then rebuilds into a temp directory and compares byte for byte, so an
artifact that drifts from `src/` goes red instead of shipping stale derivation
code. Proven to bite in two directions. The detectors, planted against and observed to
fire: a `fetch` carrying the phrase → 4 fail; `console.log` of the phrase → 1 fail;
`localStorage.setItem` of the phrase → 1 fail — each planted in `src/page-entry.ts`
and REBUILT first, so the red is the recorder and not the staleness check, and each
named the sink and the material in the failure output. The artifact, broken the way
it rots: delete it → 11 fail;
change `src/page-entry.ts` without rebuilding → 1 fail (the staleness check);
insert one space into the bundle → 2 fail (the CSP seal and the rebuild);
untrack it from git → 1 fail. Restoring each returns 63 pass / 0 fail.

## Reimplement it without us

`text/key-derivation-spec.md` — one page, enough to rebuild every address above
in any language, with public test vectors to check yourself against.

## Licence

Free ONE License — see `LICENSE` in this package (the same text as `LICENSE.md` at
the ONE repository root). One obligation:
*"Don't remove the ONE brand, logo, and link to https://one.ie/ from the deployed
product."* Keep the ONE mark, the link, and the ONE coin on Sui, so whoever
recovers a key with this can find the door it opens.
