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

  // A page's layout set by hand is used and remembered.
  const firstPage = await reader.$eval('#flow .page-marker', (m) => Number((m as HTMLElement).dataset.page))
  const marker = `#flow .page-marker[data-page="${firstPage}"]`
  check(/^Auto: /.test(await reader.$eval(`${marker} .page-layout option[value="auto"]`, (o) => o.textContent ?? '')), 'each page shows the layout it was read with')
  await reader.selectOption(`${marker} .page-layout`, 'one')
  await reader.waitForFunction((m) => (document.querySelector(`${m} .page-layout`) as HTMLSelectElement | null)?.value === 'one', marker)
  const stored = await reader.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).find(([k]) => k.startsWith('pdfPages:'))?.[1]) as { layouts?: Record<string, string> } | undefined
  check(stored?.layouts?.[firstPage] === 'one', 'a page layout set by hand is saved')
  await reader.selectOption(`${marker} .page-layout`, 'auto')

  // Marking an area to leave out takes its text out of the reflowed copy; removing the area brings it back.
  const pageText = () => reader.$eval(`#flow .page-text[data-page="${firstPage}"]`, (d) => d.textContent ?? '').catch(() => '')
  const before = await pageText()
  await reader.click('#mark-area')
  await reader.$eval(`#pages .page[data-page="${firstPage}"]`, (p) => p.scrollIntoView({ block: 'start' }))
  const pageBox = (await (await reader.$(`#pages .page[data-page="${firstPage}"]`))!.boundingBox())!
  await reader.mouse.move(pageBox.x + 2, pageBox.y + 2)
  await reader.mouse.down()
  await reader.mouse.move(pageBox.x + pageBox.width - 2, pageBox.y + pageBox.height * 0.3, { steps: 4 })
  await reader.mouse.up()
  await reader.click('.region-menu button:has-text("Leave out")')
  await reader.waitForSelector(`#pages .page[data-page="${firstPage}"] .region-skip`)
  const after = await pageText()
  check(after.length < before.length, 'an area marked “Leave out” is left out of the text')
  if (shots) await reader.screenshot({ path: join(resolve(shots), 'reader-regions.png') })
  await reader.click(`#pages .page[data-page="${firstPage}"] .region-skip .region-label button`)
  await reader.waitForFunction(() => !document.querySelector('#pages .region'))
  check((await pageText()) === before, 'removing the area brings its text back')
  await reader.click('#mark-area')

  // Editing a page's text keeps the edit: after reading the PDF again, and in what is clipped.
  await reader.click(`${marker} .page-tools button:has-text("Edit text")`)
  await reader.evaluate((n) => {
    const p = document.querySelector(`#flow .page-text[data-page="${n}"] p, #flow .page-text[data-page="${n}"] h1, #flow .page-text[data-page="${n}"] h2`)!
    const range = document.createRange()
    range.setStart(p.firstChild ?? p, 0)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    document.execCommand('insertText', false, 'Edited by hand: ')
  }, firstPage)
  if (shots) await reader.screenshot({ path: join(resolve(shots), 'reader-editing.png') })
  await reader.keyboard.press('Control+Enter')
  await reader.waitForSelector(`${marker} .edited`)
  await reader.reload()
  await reader.waitForFunction(() => !/Reading|Opening/.test(document.getElementById('status')?.textContent ?? '') && document.querySelector('#flow [data-boxes]'), null, { timeout: 120_000 })
  check((await pageText()).includes('Edited by hand: '), 'an edited page keeps its edit when the PDF is opened again')
  await reader.evaluate(() => getSelection()?.removeAllRanges())
  await reader.evaluate(() => document.getElementById('text')!.scrollTo({ top: 0 }))
  const readerTabAgain = await reader.evaluate(async () => (await chrome.tabs.getCurrent())?.id)
  const edited = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'lk-reader-capture', tabId, request: { kind: 'article' } }), readerTabAgain) as { capture?: { html: string } }
  check(edited.capture?.html.includes('Edited by hand: ') && !/page-text|page-tools/.test(edited.capture.html), 'a clip takes the edited text')
  await reader.click(`${marker} .page-tools button:has-text("Undo edit")`)
  await reader.waitForFunction((m) => !document.querySelector(`${m} .edited`), marker)
  check(!(await pageText()).includes('Edited by hand: '), 'undoing an edit brings back the reflowed text')

  // Scan mode can be turned on and off from the Headings panel.
  await reader.click('#toggle-styles')
  await reader.click('#styles .scan-mode input')
  await reader.waitForFunction(() => /scan mode/.test(document.getElementById('status')?.textContent ?? ''))
  check(true, 'scan mode can be turned on')
  await reader.click('#styles .scan-mode input')
  await reader.click('#toggle-styles')

  // Paging, the contents, and the Layout panel with the dividers drawn on the pages.
  await reader.fill('#page-input', '3')
  await reader.press('#page-input', 'Enter')
  await reader.waitForTimeout(300)
  check(await reader.$eval('#page-input', (i) => (i as HTMLInputElement).value) === '3', 'going to a page by its number')
  await reader.click('#next-page')
  check(await reader.$eval('#page-input', (i) => (i as HTMLInputElement).value) === '4', 'the next-page button')
  await reader.click('#toggle-contents')
  const toc = await reader.$$eval('#contents .toc button', (bs) => bs.length)
  check(toc === stats.headings + (await reader.$$eval('#flow h4', (h) => h.length)), 'Contents lists every heading')
  await reader.click('#toggle-layout')
  check(await reader.$('#layout select'), 'the Layout panel opens')
  const dividers = await reader.$$eval('#pages .page', (pages) => pages.map((p) => p.querySelectorAll('.divider').length))
  console.log(`  dividers per page: ${dividers.join(', ')}`)
  check(dividers.some((n) => n > 0), 'column dividers are drawn on the pages')
  if (shots) await reader.screenshot({ path: join(resolve(shots), 'reader-layout.png') })
  await reader.click('#toggle-layout')

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
