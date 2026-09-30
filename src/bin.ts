/**
 * bin.ts — the `one-recover` entry for Node (what `npx @oneie/recover` runs).
 *
 * WHY A SEPARATE ENTRY. cli.ts guards itself with `import.meta.main`, which Bun
 * understands and Node's ESM loader did not until recently; bundled for node it
 * compiles to a `__require.main` check that throws on load. This file IS the
 * main module by construction, so it needs no guard. `scripts/build-cli.ts`
 * bundles it — with @oneie/sdk inside — into dist/cli.js, one file that runs on
 * any Node 20+ with nothing else installed and no ONE server in the path.
 */
import { main } from './cli.ts'

process.exitCode = await main(process.argv.slice(2))
