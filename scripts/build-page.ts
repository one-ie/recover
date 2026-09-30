#!/usr/bin/env bun
/**
 * build-page.ts — produce `dist/page.html`: the whole recovery tool as ONE file.
 *
 *   bun run build:page                 → writes the committed artifact
 *   bun scripts/build-page.ts --out X  → writes a throwaway copy at X
 *
 * WHY ONE FILE AND NOT TWO. C7 shipped `page.html` next to a generated
 * `page.js`. A holder keeps this on a USB stick for years; two files is one file
 * to lose and a 404 to misread as "my money is gone". There is a second, harder
 * reason: a browser refuses to load an EXTERNAL module script over `file://`
 * (opaque origin, CORS), so `<script type="module" src="./page.js">` is dead on
 * arrival in exactly the situation this tool exists for. An inline classic
 * script has neither problem.
 *
 * WHY --out EXISTS. The staleness check rebuilds and compares against the
 * committed bytes. A check that rebuilds ON TOP of the file it is checking has
 * already destroyed the evidence, so the rebuild goes somewhere else and the
 * committed file is never touched by its own test.
 *
 * DETERMINISM IS THE POINT. Same source + same bun ⇒ same bytes, so a difference
 * means the artifact is stale, not that the bundler is moody. Measured
 * 2026-09-21 under bun 1.3.14: two fresh builds byte-identical.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PKG = join(import.meta.dir, '..')
const argv = Bun.argv.slice(2)
const flag = argv.indexOf('--out')
const OUT = flag >= 0 ? argv[flag + 1] : join(PKG, 'dist', 'page.html')
if (flag >= 0 && !OUT) throw new Error('build-page: --out needs a path')

const built = await Bun.build({
  entrypoints: [join(PKG, 'src', 'page-entry.ts')],
  target: 'browser',
  format: 'iife',
  minify: true,
})
if (!built.success) throw new AggregateError(built.logs, 'build-page: the bundle did not build')
if (built.outputs.length !== 1) throw new Error(`build-page: expected 1 chunk, got ${built.outputs.length}`)

// `</script` anywhere in the bundle would END the script element early and leave
// the rest of the tool as text on the page. `<\/script` is the identical string
// inside a JS string literal and an identical escape inside a regex literal, so
// the replacement is safe in both places and needs no undoing to run.
const js = (await built.outputs[0].text()).replaceAll('</script', '<\\/script')

// The bundle must PARSE before it is sealed into a page nobody will run again
// until the day they need it. A build that emits unparseable JS fails here.
new Function(js)

// DENY BY DEFAULT, and the script runs only because its bytes hash to this.
// Not "there is no http:// in the source" — a policy the browser enforces on
// constructed URLs, beacons, images, forms and websockets too. `connect-src`
// is the single opening, because the holder may name an endpoint to read a
// balance from; `ws:`/`wss:` are NOT matched by the http/https scheme sources,
// so a socket cannot be opened either. `style-src 'unsafe-inline'` covers the
// one inline <style>: with img-src and font-src at 'none' a stylesheet has no
// door to send anything through.
//
// The hash is taken over the EXACT text that lands between the tags, newlines
// included — that is what a browser hashes (the element's text content), and
// hashing the bare bundle while writing `\n${js}\n` produces a policy that
// refuses its own script. Measured: the page's own check caught it here.
const body = `\n${js}\n`
const hash = new Bun.CryptoHasher('sha256').update(body, 'utf8').digest('base64')
const CSP = [
  "default-src 'none'",
  `script-src 'sha256-${hash}'`,
  "style-src 'unsafe-inline'",
  'connect-src https: http:',
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const template = readFileSync(join(PKG, 'src', 'page.html'), 'utf8')
// A STRING replacement, not a regex, and through a FUNCTION: a `$&` or `$'` in
// 130KB of minified JS would otherwise be expanded by String.replace and the
// bundle would be silently corrupted.
const html = template.replace('__CSP__', () => CSP).replace('<!-- __BUNDLE__ -->', () => `<script>${body}</script>`)
for (const marker of ['__CSP__', '<!-- __BUNDLE__ -->']) {
  if (html.includes(marker)) throw new Error(`build-page: template marker ${marker} was not replaced`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`build-page: ${OUT} — ${html.length} bytes (${js.length} of bundle), sha256-${hash.slice(0, 12)}…`)
