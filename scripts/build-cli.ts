#!/usr/bin/env bun
/**
 * build-cli.ts — produce `dist/cli.js` and `dist/recover.js`, the files npm ships.
 *
 * The package's `bin` and `exports` used to point at `src/*.ts` with a bun
 * shebang: nothing under `files` shipped them, and Node cannot run a `.ts` bin
 * through npx. So the tool is bundled for Node, SDK included — the derivation
 * code is the SDK's (never a copy), carried inside the file so a stranger's
 * install resolves nothing at run time. `prepack` runs this, so `npm pack` and
 * `npm publish` can never ship a stale or missing bin.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG = join(import.meta.dir, '..')

for (const [entry, out, bin] of [
  ['bin.ts', 'cli.js', true],
  ['recover.ts', 'recover.js', false],
] as const) {
  const built = await Bun.build({ entrypoints: [join(PKG, 'src', entry)], target: 'node', format: 'esm' })
  if (!built.success) throw new AggregateError(built.logs, `build-cli: ${entry} failed`)
  const code = (await built.outputs[0].text()).replace(/^#!.*\n/, '').replace(/^\/\/ @bun\n/, '')
  const path = join(PKG, 'dist', out)
  writeFileSync(path, (bin ? '#!/usr/bin/env node\n' : '') + code)
  if (bin) chmodSync(path, 0o755)
  process.stdout.write(`build-cli: dist/${out} ${readFileSync(path).length} bytes\n`)
}
