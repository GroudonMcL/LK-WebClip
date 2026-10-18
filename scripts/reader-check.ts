/**
 * Smoke test of the PDF reader in the built extension, with no LegendKeeper project needed.
 *
 *   npm run build && npm run reader:check -- <file.pdf> [screenshot-dir]
 *
 * Serves the PDF locally, opens it in reader.html, waits for every page to be read, then checks
 * that text, a stat block and images came out, that page renders appear, and that clipping (the
 * path a "Send to LegendKeeper" click takes) returns the clip with its images as data URLs. It
 * also checks that a local file without file-URL access shows the drop zone. Screenshots of the
 * reader go to the screenshot directory when one is given.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const [file, shots] = process.argv.slice(2)
if (!file) throw new Error('Usage: npm run reader:check -- <file.pdf> [screenshot-dir]')
const pdf = await readFile(file)

const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf))
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const src = `http://127.0.0.1:${(server.address() as { port: number }).port}/book.pdf`

const extension = new URL('../dist/extension', import.meta.url).pathname
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'lk-reader-')), {
  executablePath: CHROMIUM,
  headless: true,
  viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
let failures = 0
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? '✔' : '✖'} ${what}`)
  if (!ok) failures++
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const reader = await context.newPage()
  reader.on('pageerror', (e) => console.log(`page error: ${e.message}`))
  reader.on('console', (m) => m.type() === 'error' && console.log(`reader: ${m.text().slice(0, 400)}`))
  await reader.goto(`chrome-extension://${id}/reader.html?src=${encodeURIComponent(src)}`)
  const started = Date.now()
  await reader.waitForFunction(() => !/Reading|Opening/.test(document.getElementById('status')?.textContent ?? '') && document.querySelector('#flow [data-boxes]'), null, { timeout: 120_000 })
  console.log(`Read ${file} in ${((Date.now() - started) / 1000).toFixed(1)} s`)

  const stats = await reader.evaluate(() => ({
    title: document.getElementById('book-title')?.textContent,
    blocks: document.querySelectorAll('#flow [data-boxes]').length,
    headings: document.querySelectorAll('#flow h1, #flow h2, #flow h3').length,
    tables: document.querySelectorAll('#flow table').length,
    statblocks: document.querySelectorAll('#flow .statblock').length,
    images: document.querySelectorAll('#flow img[data-pdf-image]').length,
  }))
  console.log(stats)
  check(stats.blocks > 10, 'reflowed text is shown')
  check(stats.headings > 0, 'headings are found')

  // Images load as they come into view.
  await reader.evaluate(() => document.querySelector('#flow img[data-pdf-image]')?.scrollIntoView())
  if (stats.images) {
    await reader.waitForFunction(() => document.querySelector<HTMLImageElement>('#flow img[data-pdf-image][src^="blob:"]')?.complete, null, { timeout: 30_000 }).catch(() => {})
    check(await reader.$('#flow img[src^="blob:"]'), 'an image is decoded and shown')
  }
  // The page beside the text is rendered.
  await reader.waitForFunction(() => document.querySelectorAll('#pages canvas').length > 0, null, { timeout: 30_000 }).catch(() => {})
  check(await reader.$('#pages canvas'), 'original pages are rendered')

  // Clip: the side panel's capture path, asked of the reader tab by message.
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  const readerTab = await reader.evaluate(async () => (await chrome.tabs.getCurrent())?.id)
  if (stats.statblocks) {
    await reader.evaluate(() => {
      const block = document.querySelector('#flow .statblock')!
      block.scrollIntoView()
      const range = document.createRange()
      range.selectNodeContents(block)
      range.setStartAfter(block.querySelector('.clip-statblock')!)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    const reply = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'lk-reader-capture', tabId, request: { kind: 'selection' } }), readerTab) as { capture?: { html: string; suggestedTitle: string; meta: { ogSiteName?: string } }; error?: string }
    check(reply.capture && /Armor Class/i.test(reply.capture.html) && !/data-boxes|clip-statblock/.test(reply.capture.html), 'a stat block clips cleanly')
    console.log(`  suggested title: ${reply.capture?.suggestedTitle}; Source: ${reply.capture?.meta.ogSiteName}`)
    if (shots) await reader.screenshot({ path: join(resolve(shots), 'reader-statblock.png') })
  }
  if (stats.images) {
    await reader.evaluate(() => {
      const figure = document.querySelector('#flow figure')!
      figure.scrollIntoView()
      const range = document.createRange()
      range.selectNode(figure)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    const reply = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'lk-reader-capture', tabId, request: { kind: 'selection' } }), readerTab) as { capture?: { html: string } }
    check(/src="data:image\/webp;base64,/.test(reply.capture?.html ?? ''), 'a clipped image travels as a WebP data URL')
  }
  // The whole page in view.
  await reader.evaluate(() => getSelection()?.removeAllRanges())
  const article = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'lk-reader-capture', tabId, request: { kind: 'article' } }), readerTab) as { capture?: { kind: string; html: string } }
  check(article.capture?.kind === 'article' && article.capture.html.length > 100, 'the page in view clips as an article')

  // Corrections to text styles re-show the text.
  await reader.click('#toggle-styles')
  check(await reader.$('#styles .style select'), 'the text styles panel lists styles')
  if (shots) {
    await reader.evaluate(() => document.querySelector('#flow')?.parentElement?.scrollTo({ top: 0 }))
    await reader.screenshot({ path: join(resolve(shots), 'reader-styles.png') })
    await reader.click('#toggle-styles')
  }

  // A local file opens when the extension may read files, and otherwise explains how to allow it.
  const allowed = await reader.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())
  const local = await context.newPage()
  await local.goto(`chrome-extension://${id}/reader.html?src=${encodeURIComponent(pathToFileURL(resolve(file)).href)}`)
  if (allowed) {
    await local.waitForSelector('#flow [data-boxes]', { timeout: 60_000 }).catch(() => {})
    check(await local.$('#flow [data-boxes]'), 'a local file opens (file access is allowed)')
  } else {
    await local.waitForSelector('#drop:not([hidden])')
    check(/Allow access to file URLs/.test(await local.textContent('#drop') ?? ''), 'a local file without file access shows how to allow it')
  }
} finally {
  await context.close()
  server.close()
}
if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All reader checks passed')
