/**
 * package.test.ts — the tool has to be HANDED OUT, not just built
 * (task:01a0d250d09836d023469ecf).
 *
 * The failure this names, measured 2026-09-26: package.json said
 * `"private": true`, `bin` pointed at `./src/cli.ts` under a bun shebang, and the
 * LICENSE it referenced did not exist. So `npm publish` refused, and had it not,
 * `npx @oneie/recover` would have installed a bin Node cannot run under a
 * license that pointed at nothing. Free-and-independent was a sentence.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PKG = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

describe('@oneie/recover is publishable and runs under plain Node', () => {
  test('not private, and carries the ONE License it names', () => {
    expect(pkg.private).toBeUndefined()
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE')
    expect(readFileSync(join(PKG, 'LICENSE'), 'utf8')).toBe(readFileSync(join(PKG, '..', '..', 'LICENSE.md'), 'utf8'))
  })

  test('every bin and export is a built .js file that `files` ships', () => {
    const targets = [...Object.values(pkg.bin), ...Object.values(pkg.exports)] as string[]
    for (const t of targets) {
      expect(t.endsWith('.js')).toBe(true)
      expect(pkg.files).toContain(t.replace(/^\.\//, ''))
    }
    expect(pkg.files).toContain('dist/page.html')
    expect(pkg.files).toContain('LICENSE')
    expect(pkg.scripts.prepack).toBe('bun run build:cli')
  })

  test('nothing is installed at run time — the SDK is bundled, never a runtime dependency', () => {
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  test('the built bin answers --help under node, with a node shebang', () => {
    const build = Bun.spawnSync(['bun', 'scripts/build-cli.ts'], { cwd: PKG })
    expect(build.exitCode).toBe(0)
    const bin = join(PKG, 'dist', 'cli.js')
    expect(existsSync(bin)).toBe(true)
    expect(readFileSync(bin, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
    const run = Bun.spawnSync(['node', bin, '--help'], { cwd: PKG })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toContain('no ONE server in the path')
  })
})
