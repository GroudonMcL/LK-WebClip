/**
 * End-to-end test of the built extension in Chromium, against the real LegendKeeper project.
 *
 *   npm run build && npm run e2e
 *
 * Loads dist/extension, opens the side panel page, connects the API key through the Settings
 * screen, then clips from a local test page three ways (a selection to a new page, a right-clicked
 * image appended to that page, and the whole article to a new page), and finally fills the
 * project's Statblock Template from a D&D Beyond stat block, as a new page and appended to a page. Chrome's context menu cannot
 * be clicked by automation, so the test calls the same function the menu click calls.
 *
 * Pages go under "LK Web Clipper Sandbox / Phase 2 E2E <time>" and are not deleted. Screenshots of
 * the side panel are saved to docs/screenshots.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LegendKeeper } from '@legendkeeper/sdk'
import { p, walk, type Block } from '@legendkeeper/sdk/blocks'
import { chromium, type Page, type Worker } from 'playwright'
import { blockText, type AnyBlock } from '../src/fill/template.js'
import { ProjectIndex, configuredKeys, createPage } from '../src/index.js'

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const SANDBOX_NAME = process.env.LK_SANDBOX_NAME?.trim() || 'LK Web Clipper Sandbox'
const root = new URL('../', import.meta.url)
const shots = new URL('docs/screenshots/', root).pathname

const apiKey = configuredKeys(process.env)[0]
if (!apiKey) throw new Error('Set LEGENDKEEPER_API_KEY (see .env.example).')
const lk = new LegendKeeper({ apiKey, maxRetries: 3 })

// ------------------------------------------------------------------------ sandbox run page
const index = await ProjectIndex.load(lk)
const sandbox = index.children(null).find((r) => r.name === SANDBOX_NAME)
const sandboxSources = sandbox && index.children(sandbox.id).find((r) => r.name === 'Sources')
if (!sandbox || !sandboxSources) throw new Error('Run npm run poc first: it creates the sandbox and its Sources page.')
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
const runName = `Extension E2E ${stamp}`
const run = await createPage(lk, index, { parentId: sandbox.id, name: runName, blocks: [p(`Clips made through the Chrome extension by the automated end-to-end test on ${stamp} UTC (scripts/e2e.ts).`)] })
console.log(`Run page: ${index.path(run.resource.id)}`)

// ------------------------------------------------------------------------ local test site
const fixture = await readFile(new URL('test/fixtures/statblock.html', root), 'utf8')
const goblinBlock = await readFile(new URL('test/fixtures/dndbeyond-goblin.html', root), 'utf8')
const dragonPng = await readFile(new URL('src/extension/static/icons/icon-128.png', root))
const server = createServer((req, res) => {
  if (req.url === '/dragon.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(dragonPng)
  if (req.url === '/monsters/goblin') {
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><html><head><title>Goblin - Monsters - D&amp;D Beyond</title><meta property="og:site_name" content="D&amp;D Beyond"></head><body><main id="content">${goblinBlock}</main></body></html>`)
  }
  const html = fixture.replace('</body>', '<p><img id="art" src="/dragon.png" alt="Red dragon sigil"></p></body>')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const site = `http://127.0.0.1:${port}`

// ------------------------------------------------------------------------ browser
const extension = new URL('dist/extension', root).pathname
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'lk-e2e-')), {
  executablePath: CHROMIUM,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
  viewport: { width: 420, height: 900 },
})
let failures = 0
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? '✓' : '✘'} ${message}`)
  if (!ok) failures++
}

try {
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  console.log(`Extension loaded: ${extensionId}`)

  const site1 = await context.newPage()
  await site1.goto(`${site}/monsters/adult-red-dragon`)
  const panel = await context.newPage()
  panel.on('pageerror', (error) => console.log(`  [panel error] ${error.message}`))
  panel.on('console', (msg) => msg.type() === 'error' && console.log(`  [panel console] ${msg.text()}`))
  await panel.setViewportSize({ width: 400, height: 1100 })
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)

  // 1. Settings: connect the key and choose the sandbox's Sources page.
  console.log('\n▶ Settings')
  await panel.getByPlaceholder('lk_…').fill(apiKey)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await panel.getByText('AI Test Project', { exact: false }).first().waitFor()
  await panel.getByText(/pages, updated/).waitFor({ timeout: 30_000 })
  check(true, 'the key connected and the page list loaded')
  await panel.locator('.picker-chosen button.link').click().catch(() => {}) // A top-level "Sources" page may have been chosen automatically.
  await panel.getByPlaceholder('Search for your Sources page…').fill('Sources')
  await panel.locator('.picker-results li', { has: panel.locator('.path', { hasText: new RegExp(`^${SANDBOX_NAME}$`) }) }).first().click()
  await panel.screenshot({ path: `${shots}settings.png`, fullPage: true })
  await panel.getByRole('button', { name: 'Done' }).click()
  check(await panel.getByText('Select something on a web page').isVisible(), 'the panel waits for a clip')

  // 2. A selection, clipped to a new page.
  console.log('\n▶ Selection → new page')
  const selectionText = await site1.evaluate(() => {
    const start = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Actions')!
    const end = document.querySelector('pre')!
    const range = document.createRange()
    range.setStartBefore(start)
    range.setEndAfter(end)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    return getSelection()!.toString()
  })
  const tabId = await tabIdFor(worker, `${site}/monsters/adult-red-dragon`)
  await worker.evaluate(async ([text, id]) => (globalThis as any).__lkTest.captureFromMenu({ selectionText: text, frameId: 0 }, id), [selectionText, tabId] as const)
  await panel.getByText('Selection', { exact: true }).waitFor()
  const title = `Adult Red Dragon actions (E2E selection)`
  await panel.getByPlaceholder('Name of the new page').fill(title)
  await pick(panel, 'Search for the parent page…', runName)
  await panel.locator('#website-notice').getByText('already exists in your Sources').waitFor()
  check(true, 'the website Source "Example Compendium" was recognised as an existing Source')
  const summary = await panel.locator('.summary').innerText()
  console.log(`  summary: ${summary.replace(/\n+/g, ' | ')}`)
  // Links: choose a page for the ambiguous name, and switch one proposed link off.
  const links = panel.locator('.links')
  await links.getByText('Natasha the Dark').waitFor()
  const natasha = index.findByName('Natasha').find((r) => r.name === 'Natasha')!
  const initiative = index.findByName('Initiative')[0]
  await links.locator('li.ambiguous', { hasText: 'Natasha the Dark' }).locator('select').selectOption(natasha.id)
  check(await links.locator('li.ambiguous').count() === 0, 'choosing Natasha for "Natasha the Dark" resolves the ambiguity')
  if (initiative) await links.locator('li', { hasText: 'Initiative' }).locator('input[type=checkbox]').uncheck()
  // Reloading the page list must not reset the form.
  await panel.locator('#refresh').click()
  await panel.getByText(/loading pages/).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
  await panel.getByText(/pages, updated just now/).waitFor({ timeout: 30_000 })
  const kept = (await panel.getByPlaceholder('Name of the new page').inputValue()) === title && (await panel.locator('.picker-chosen', { hasText: runName }).isVisible())
  const keptChoice = (await links.locator('li', { hasText: 'Natasha the Dark' }).locator('select').inputValue()) === natasha.id
  check(kept && keptChoice, 'reloading the page list kept the page name, parent and link choices')
  const linksText = await links.innerText()
  console.log(`  links: ${linksText.replace(/\n+/g, ' | ')}`)
  await panel.screenshot({ path: `${shots}new-page-form.png`, fullPage: true })
  await panel.getByRole('button', { name: 'Create page' }).click()
  await panel.getByText('Page created').waitFor({ timeout: 60_000 })
  await panel.screenshot({ path: `${shots}done.png`, fullPage: true })
  const newPageId = resourceIdFrom(await panel.getByRole('link', { name: 'Open in LegendKeeper' }).getAttribute('href'))
  const page1 = await readPage(newPageId)
  check(page1.parentId === run.resource.id, `created "${page1.name}" under the run page`)
  check(firstHeading(page1.blocks) === 'From Example Compendium', 'it opens with "From Example Compendium"')
  check(kinds(page1.blocks).includes('bulletList') && kinds(page1.blocks).includes('table') && kinds(page1.blocks).includes('code'), `lists, tables and code arrived: ${[...new Set(kinds(page1.blocks))].join(', ')}`)
  const mentioned = mentions(page1.blocks.slice(1)) // After the "From <Source>" heading.
  check(mentioned.some((m) => m.resourceId === natasha.id && m.text === 'Natasha the Dark'), '"Natasha the Dark" links to the chosen page, Natasha')
  if (initiative) check(!mentioned.some((m) => m.resourceId === initiative.id), 'the link switched off (Initiative) was left as plain text')
  const fromText = mentioned.filter((m) => m.resourceId !== natasha.id)
  check(fromText.length >= 2, `page names in the text became links: ${fromText.map((m) => m.text ?? index.get(m.resourceId)?.name).join(', ')}`)

  // 3. A right-clicked image, appended to that page with an existing Source.
  console.log('\n▶ Image → append to the new page')
  await site1.evaluate(() => getSelection()!.removeAllRanges())
  await worker.evaluate(async ([src, id]) => (globalThis as any).__lkTest.captureFromMenu({ mediaType: 'image', srcUrl: src, frameId: 0 }, id), [`${site}/dragon.png`, tabId] as const)
  await panel.getByText('Image', { exact: true }).waitFor()
  await panel.getByRole('radio', { name: 'Add to a page' }).click()
  // Searched with a typo: fuzzy search still finds it.
  await pick(panel, 'Search for the page to add to…', title, runName, 'Adult Red Dragn actions')
  check(true, 'the page was found by searching "Adult Red Dragn actions" (a typo)')
  await panel.getByRole('radio', { name: 'A Source' }).click()
  await panel.locator('.picker-chosen button.link').last().click().catch(() => {})
  await panel.getByPlaceholder('Search your Sources…').fill('Wikipedia')
  await panel.locator('.picker-results li').first().click()
  await panel.screenshot({ path: `${shots}append-form.png`, fullPage: true })
  await panel.getByRole('button', { name: 'Add to page' }).click()
  await panel.getByText('Added to the page').waitFor({ timeout: 60_000 })
  const page1b = await readPage(newPageId)
  const tail = page1b.blocks.slice(page1.blocks.length)
  check(tail[0]?.kind === 'rule' && headingText(tail[1]) === 'From Wikipedia', 'the append starts with a divider and "From Wikipedia"')
  const img = tail.find((b) => b.kind === 'image')
  check(img?.kind === 'image' && img.url.startsWith('https://assets.legendkeeper.com/'), 'the image was uploaded to the project')

  // 4. No selection: the whole article, to a new page.
  console.log('\n▶ Article → new page')
  await panel.getByRole('button', { name: 'Back to this clip' }).click()
  await worker.evaluate(async ([id]) => (globalThis as any).__lkTest.captureFromMenu({ frameId: 0 }, id), [tabId] as const)
  await panel.getByText('Article', { exact: true }).waitFor()
  await panel.getByRole('radio', { name: 'New page' }).click()
  const articleTitle = await panel.getByPlaceholder('Name of the new page').inputValue()
  check(articleTitle === 'Adult Red Dragon', `the page name defaults to the article title ("${articleTitle}")`)
  await panel.getByPlaceholder('Name of the new page').fill('Adult Red Dragon (E2E article)')
  await panel.getByRole('button', { name: 'Create page' }).click()
  await panel.getByText('Page created').waitFor({ timeout: 60_000 })
  const page2 = await readPage(resourceIdFrom(await panel.getByRole('link', { name: 'Open in LegendKeeper' }).getAttribute('href')))
  check(page2.parentId === run.resource.id, 'the article page went under the remembered parent')
  check(kinds(page2.blocks).filter((k) => k === 'heading').length >= 3, `the article kept its headings (${page2.blocks.length} top-level blocks)`)

  // 5. Templates: the goblin stat block into the Statblock Template, labels then (on-device) AI.
  console.log('\n▶ Templates: stat block → Statblock Template, then appended to a page')
  // Chromium here has no built-in model, so the panel gets a stand-in with the Prompt API's shape.
  // It answers like the model would: the block holding the creature type goes in that field. It
  // also makes the kind of slip a small model makes, copying the proficiency bonus "+2" into
  // Immunities, which the panel must flag and leave unticked.
  // (A string, because the test runner rewrites functions it sends to the page.)
  await panel.evaluate(`globalThis.LanguageModel = {
    availability: async () => 'available',
    params: async () => ({ defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 }),
    create: async () => ({
      contextWindow: 4096,
      destroy() {},
      async prompt(input) {
        const block = /\\[(\\d+)\\] \\(paragraph\\) Small Humanoid/.exec(input)?.[1]
        const keys = [...input.matchAll(/^(s\\d+): "([^"]+)"/gm)]
        return JSON.stringify(Object.fromEntries(keys.map(([, key, label]) => [key, { blocks: label.startsWith('Size') && block ? [Number(block)] : [], value: label === 'Immunities' ? '+2' : '' }])))
      },
    }),
  }`)
  await panel.locator('#open-settings').click()
  await panel.getByText('Enable template filling').click()
  await panel.getByRole('combobox').filter({ has: panel.locator('option', { hasText: 'On-device' }) }).selectOption('on-device')
  await panel.getByText('Ready. It runs on this computer').waitFor()
  check(true, 'Settings show the on-device model as ready')
  await panel.screenshot({ path: `${shots}template-settings.png`, fullPage: true })
  await panel.getByRole('button', { name: 'Done' }).click()

  const site2 = await context.newPage()
  await site2.goto(`${site}/monsters/goblin`)
  await site2.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('.mon-stat-block')!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  const goblinTab = await tabIdFor(worker, `${site}/monsters/goblin`)
  await worker.evaluate(async ([id]) => (globalThis as any).__lkTest.captureFromMenu({ selectionText: 'Goblin', frameId: 0 }, id), [goblinTab] as const)
  await panel.getByText('Selection', { exact: true }).waitFor()
  await panel.getByRole('radio', { name: 'New page' }).click()
  await panel.getByPlaceholder('Name of the new page').fill('Goblin')
  await pick(panel, 'Search for the parent page…', runName)
  const statblockTemplate = [...index.byId.values()].find((r) => r.name === 'Statblock Template' && index.isTemplate(r.id))!
  await panel.locator('.field', { hasText: 'Template' }).locator('select').first().selectOption(statblockTemplate.id)
  await panel.getByRole('radio', { name: 'Labels then AI' }).click()
  await panel.getByText('Keep unfilled template fields').click()
  const fields = panel.locator('.template-fields')
  await panel.locator('.template-ai').getByText(/suggested 2 of/).waitFor({ timeout: 30_000 })
  check(true, `the on-device AI was asked: ${(await panel.locator('.template-ai').innerText()).split('\n')[0]}`)
  const sizeRow = fields.locator('li[data-slot^="Size, Creature Type"]')
  check((await sizeRow.locator('.origin').innerText()) === 'AI' && (await sizeRow.innerText()).includes('Small Humanoid'), 'the creature type line came from the AI')
  check((await fields.locator('li[data-slot="Armour Class"] .origin').innerText()) === 'Synonym', '"Armor Class" filled Armour Class through a synonym')
  const immunities = fields.locator('li[data-slot="Immunities"]')
  check(!(await immunities.locator('input[type="checkbox"]').isChecked()) && (await immunities.locator('.slot-warning').innerText()).includes('The clip labels this'), 'the AI’s slip (“+2” in Immunities) is shown unticked, with the reason')
  const initiativeRow = fields.locator('li[data-slot="Initiative"]')
  check((await initiativeRow.locator('.origin').innerText()) === 'Worked out' && (await initiativeRow.innerText()).includes('+2'), 'Initiative was worked out from Dexterity (+2)')
  // A manual choice, remembered as a rule for this site.
  const legendary = fields.locator('li[data-slot="Legendary Actions"]')
  await fields.locator('summary.empty-slots').click()
  const shortbow = await legendary.locator('option', { hasText: '“Shortbow”' }).getAttribute('value')
  await legendary.locator('select').selectOption(shortbow!)
  await fields.locator('li[data-slot="Legendary Actions"]').getByText(/Remember for 127\.0\.0\.1/).click()
  const summaryLine = await fields.locator('summary').first().innerText()
  console.log(`  ${summaryLine}`)
  await panel.screenshot({ path: `${shots}template-review.png`, fullPage: true })
  await panel.getByRole('button', { name: 'Create page' }).click()
  await panel.getByText('Page created').waitFor({ timeout: 90_000 })
  const goblinId = resourceIdFrom(await panel.getByRole('link', { name: 'Open in LegendKeeper' }).getAttribute('href'))
  const goblinRes = await lk.resources.get({ resourceId: goblinId })
  const goblinPage = await readPage(goblinId)
  const goblinJson = JSON.stringify(goblinPage.blocks)
  // Page names in the values are links now, so read the text with their names.
  const goblinText = goblinPage.blocks.map((b) => blockText(b as AnyBlock)).join('\n')
  check((goblinRes.tags ?? []).includes('Statblock') && goblinRes.parentId === run.resource.id, 'the page was made from the Statblock Template under the run page')
  check(goblinText.includes('Armour Class: 15 (leather armor, shield)') && goblinText.includes('Small Humanoid (Goblinoid), Neutral Evil'), 'the infobox holds the AC and the AI’s creature type')
  check(!goblinJson.includes('Bonus Actions') && !goblinText.includes('[Description text]'), 'unfilled fields were removed')
  check(!goblinText.includes('Immunities: +2') && goblinText.includes('Initiative: +2'), 'the flagged slip stayed out of the page; the worked-out Initiative went in')
  const field = (title: string) => goblinPage.blocks.find((b) => b.kind === 'textField' && b.title === title)
  check(blockText(field('Legendary Actions') as AnyBlock).startsWith('Shortbow.'), 'the manual choice went into Legendary Actions, with its name')
  check(blockText(field('Actions') as AnyBlock).startsWith('Scimitar.') && !blockText(field('Actions') as AnyBlock).includes('Shortbow'), 'Actions kept the rest of its section')

  // The same clip appended to an existing page, with the credit heading switched off.
  await panel.getByRole('button', { name: 'Back to this clip' }).click()
  await panel.getByRole('radio', { name: 'Add to a page' }).click()
  await pick(panel, 'Search for the page to add to…', title, runName)
  await panel.getByText('Add a “From <Source>” heading').click()
  const before = (await readPage(newPageId)).blocks.length
  await panel.getByRole('button', { name: 'Add to page' }).click()
  await panel.getByText('Added to the page').waitFor({ timeout: 60_000 })
  const appendedTail = (await readPage(newPageId)).blocks.slice(before)
  check(appendedTail[0]?.kind === 'rule' && appendedTail[1]?.kind === 'infobox', 'the template went below the existing content, after a divider')
  check(!appendedTail.some((b) => headingText(b).startsWith('From ')), 'no “From” heading when the credit is off')

  await panel.locator('#open-settings').click()
  check(await panel.getByText('“Shortbow” → “Legendary Actions”').isVisible(), 'the remembered choice is listed under Saved rules')
} catch (error) {
  failures++
  console.log(`  ✘ ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  for (const page of context.pages()) await page.screenshot({ path: join(tmpdir(), `lk-e2e-failure-${context.pages().indexOf(page)}.png`), fullPage: true }).catch(() => {})
  console.log(`  screenshots of each tab: ${join(tmpdir(), 'lk-e2e-failure-<n>.png')}`)
} finally {
  await context.close()
  server.close()
}

console.log(failures === 0 ? '\nEnd-to-end test passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

// ------------------------------------------------------------------------ helpers
async function tabIdFor(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url)
}

async function pick(panel: Page, placeholder: string, name: string, underPath?: string, query = name): Promise<void> {
  const chosen = panel.locator('.picker', { has: panel.getByPlaceholder(placeholder) }).locator('.picker-chosen button.link')
  if (await chosen.isVisible()) await chosen.click()
  await panel.getByPlaceholder(placeholder).fill(query)
  let row = panel.locator('.picker-results li', { has: panel.locator('.name', { hasText: name }) })
  // Earlier runs left pages with the same name; pick the one under this run's page.
  if (underPath) row = row.filter({ has: panel.locator('.path', { hasText: underPath }) })
  await row.first().click()
}

function resourceIdFrom(href: string | null): string {
  const id = href?.split('/').filter(Boolean).at(-1)
  if (!id) throw new Error(`no page link: ${href}`)
  return id
}

async function readPage(resourceId: string): Promise<{ name: string; parentId: string | null; blocks: Block[] }> {
  const resource = await lk.resources.get({ resourceId })
  const doc = await lk.documents.getBlocks({ resourceId, documentId: resource.documents[0]!.id })
  return { name: resource.name, parentId: resource.parentId ?? null, blocks: doc.blocks }
}

function kinds(blocks: Block[]): string[] {
  const out: string[] = []
  walk(blocks, (b) => out.push(b.kind))
  return out
}

function headingText(block: Block | undefined): string {
  if (block?.kind !== 'heading') return ''
  return block.content.map((r) => ('text' in r ? r.text : 'mention' in r ? (r.mention.text ?? r.mention.name ?? '') : '')).join('')
}

function firstHeading(blocks: Block[]): string {
  return headingText(blocks[0])
}

function mentions(blocks: Block[]): { resourceId: string; text?: string }[] {
  const out: { resourceId: string; text?: string }[] = []
  walk(blocks, (b) => {
    for (const r of 'content' in b && Array.isArray(b.content) ? b.content : []) {
      if ('mention' in r && r.mention) out.push({ resourceId: r.mention.resourceId, text: r.mention.text ?? undefined })
    }
  })
  return out
}
