/**
 * Builds the unpacked Chrome extension into dist/extension.
 *
 *   npm run build          → dist/extension (load it at chrome://extensions with "Load unpacked")
 *   npm run build -- --zip → also dist/lk-web-clipper-<version>.zip
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url)
const out = new URL('dist/extension/', root)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string }

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const common = { bundle: true, target: 'chrome116', sourcemap: true, legalComments: 'none', logLevel: 'warning' } as const
await build({ ...common, entryPoints: [new URL('src/extension/background.ts', root).pathname], outfile: new URL('background.js', out).pathname, format: 'esm' })
await build({ ...common, entryPoints: [new URL('src/extension/sidepanel.ts', root).pathname], outfile: new URL('sidepanel.js', out).pathname, format: 'esm' })
await build({ ...common, entryPoints: [new URL('src/extension/reader.ts', root).pathname], outfile: new URL('reader.js', out).pathname, format: 'esm' })
await build({ ...common, entryPoints: [new URL('src/extension/mapper.ts', root).pathname], outfile: new URL('mapper.js', out).pathname, format: 'esm' })
// pdf.js parses PDFs in a worker of its own.
await cp(new URL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', root), new URL('pdf.worker.mjs', out))
// Injected into web pages with chrome.scripting, so it must be a classic script.
await build({ ...common, entryPoints: [new URL('src/extension/capture.ts', root).pathname], outfile: new URL('capture.js', out).pathname, format: 'iife' })

await cp(new URL('src/extension/static/', root), out, { recursive: true, filter: (src) => !src.endsWith('.svg') })
const manifest = JSON.parse(await readFile(new URL('manifest.json', out), 'utf8')) as { version: string }
manifest.version = pkg.version
await writeFile(new URL('manifest.json', out), JSON.stringify(manifest, null, 2))

if (process.argv.includes('--zip')) {
  const zip = new URL(`dist/lk-web-clipper-${pkg.version}.zip`, root).pathname
  await rm(zip, { force: true })
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out.pathname })
  console.log(`Wrote ${zip}`)
}
console.log(`Built the extension (v${pkg.version}) into dist/extension`)
