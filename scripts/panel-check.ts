/**
 * Checks the side panel and the mapper together in the built extension, against a stand-in for
 * the LegendKeeper API (no project or API key needed).
 *
 *   npm run build && npm run panel:check [-- screenshot-dir]
 *
 * A local web server serves the saved D&D Beyond Goblin page; the API's answers come from memory,
 * starting with the Statblock Template saved from the AI Test Project. The check connects a key,
 * turns on template filling, clips the stat block, opens the mapper from the panel, moves cards,
 * imports from the mapper tab and reads back what was written. Then it turns template filling off
 * and checks that a clip works as it always has.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page, type Route } from 'playwright'
import type { Block } from '@legendkeeper/sdk/blocks'
import { blockText, type AnyBlock } from '../src/fill/template.js'

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const shots = process.argv[2]
const root = new URL('../', import.meta.url)

// ---------------------------------------------------------------- the stand-in LegendKeeper API
interface FakeDoc { id: string; name: string; type: string; blocks: Block[]; version: number }
interface FakeResource { id: string; name: string; parentId: string | null; rank: string; tags: string[]; aliases: string[]; updatedAt: string; properties: AnyBlock[]; docs: FakeDoc[] }
const resources = new Map<string, FakeResource>()
const writes: string[] = []
let nextId = 1
const add = (r: Omit<FakeResource, 'rank' | 'aliases' | 'updatedAt'> & Partial<FakeResource>) => resources.set(r.id, { rank: String(resources.size), aliases: [], updatedAt: '2026-10-01T00:00:00.000Z', ...r })
add({ id: 'sources', name: 'Sources', parentId: null, tags: [], properties: [], docs: [{ id: 'sources-main', name: 'Main', type: 'page', blocks: [], version: 1 }] })
const template = JSON.parse(await readFile(new URL('test/fixtures/templates/Statblock_Template.json', root), 'utf8'))
add({ id: template.id, name: template.name, parentId: 'templates', tags: template.tags ?? [], properties: template.properties, docs: template.docs.map((d: FakeDoc, i: number) => ({ ...d, id: d.id ?? `tpl-doc${i}`, version: 1 })) })
const project = { id: 'p1', name: 'Fake Project' }
const listItem = (r: FakeResource) => ({ id: r.id, name: r.name, parentId: r.parentId, rank: r.rank, tags: r.tags, aliases: r.aliases, isHidden: false, updatedAt: r.updatedAt, documents: r.docs.map((d) => ({ id: d.id, name: d.name, type: d.type })) })
const full = (r: FakeResource) => ({ ...listItem(r), properties: r.properties })

async function api(route: Route): Promise<void> {
  const request = route.request()
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'etag' }
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
  const path = new URL(request.url()).pathname.replace(/^\/api\/v3/, '').replace(/\/$/, '')
  const body = request.postData() ? JSON.parse(request.postData()!) : undefined
  const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, headers: { ...headers, ...extra }, contentType: 'application/json', body: JSON.stringify(json) })
  const method = request.method()
  let m: RegExpExecArray | null
  if (path === '/projects') return send({ data: [project], hasMore: false, nextCursor: null })
  if (path === '/projects/p1') return send(project)
  if (path === '/projects/p1/resources' && method === 'GET') return send({ data: [...resources.values()].map(listItem), hasMore: false, nextCursor: null })
  if (path === '/projects/p1/resources' && method === 'POST') {
    const id = `new${nextId++}`
    add({ id, name: body.name, parentId: body.parentId ?? null, tags: body.tags ?? [], properties: [], docs: (body.documents ?? []).map((d: FakeDoc, i: number) => ({ id: `${id}-doc${i}`, name: d.name, type: d.type, blocks: d.blocks ?? [], version: 1 })) })
    writes.push(`create ${body.name}`)
    return send(listItem(resources.get(id)!), 201)
  }
  if (path === '/projects/p1/resources/from-template' && method === 'POST') {
    const source = resources.get(body.templateId)!
    const id = `new${nextId++}`
    add({ id, name: body.name, parentId: body.parentId ?? null, tags: [...source.tags], properties: structuredClone(source.properties), docs: source.docs.map((d, i) => ({ ...structuredClone(d), id: `${id}-doc${i}`, version: 1 })) })
    writes.push(`createFromTemplate ${body.name}`)
    return send(listItem(resources.get(id)!), 201)
  }
  if ((m = /^\/projects\/p1\/resources\/([^/]+)$/.exec(path))) {
    const r = resources.get(m[1]!)
    if (!r) return send({ code: 'NOT_FOUND', message: 'No such resource' }, 404)
    if (method === 'PATCH') {
      Object.assign(r, body)
      writes.push(`update ${r.name} ${JSON.stringify(body)}`)
    }
    if (method === 'DELETE') {
      resources.delete(r.id)
      return send({})
    }
    return send(full(r))
  }
  if ((m = /^\/projects\/p1\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(path))) {
    const doc = resources.get(m[1]!)?.docs.find((d) => d.id === m![2])
    if (!doc) return send({ code: 'NOT_FOUND', message: 'No such document' }, 404)
    if (method === 'PUT') {
      if (request.headers()['if-match'] && request.headers()['if-match'] !== String(doc.version)) return send({ code: 'VERSION_MISMATCH', message: 'Changed' }, 412)
      doc.blocks = body.blocks
      doc.version++
      writes.push(`replaceBlocks ${m[1]}/${doc.name}`)
    }
    return send({ blocks: doc.blocks, version: String(doc.version) }, 200, { etag: `"${doc.version}"` })
  }
  if (/\/block-ids$/.test(path)) return send({})
  if ((m = /^\/projects\/p1\/resources\/([^/]+)\/properties\/([^/]+)(\/rows\/([^/]+))?$/.exec(path))) {
    const r = resources.get(m[1]!)!
    const property = r.properties.find((p) => p.id === m![2])
    if (property && !m[3] && method === 'PATCH') Object.assign(property, body)
    if (property && m[3] && method === 'PATCH') {
      const row = (property.rows as AnyBlock[]).find((x) => x.id === m![4])
      if (row) Object.assign(row, body)
    }
    writes.push(`${method} property ${m[2]}${m[3] ?? ''}`)
    return send(property ?? {})
  }
  if (/\/search$/.test(path)) return send({ data: [], hasMore: false, nextCursor: null })
  console.log(`  (stand-in API: no answer for ${method} ${path})`)
  return send({ code: 'NOT_FOUND', message: `Not faked: ${method} ${path}` }, 404)
}

// ----------------------------------------------------------------------------- the clipped site
const goblinHtml = await readFile(new URL('test/fixtures/dndbeyond-goblin.html', root), 'utf8')
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>Goblin - Monsters - D&D Beyond</title><meta property="og:site_name" content="D&D Beyond"></head><body><div class="mon-stat-block">${goblinHtml}</div></body></html>`))
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const extension = new URL('../dist/extension', import.meta.url).pathname
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'lk-panel-')), {
  executablePath: CHROMIUM,
  headless: true,
  viewport: { width: 1500, height: 950 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
await context.route('https://www.legendkeeper.com/api/v3/**', api)
let failures = 0
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? '✔' : '✖'} ${what}`)
  if (!ok) failures++
}
const zone = (page: Page, label: string) => page.locator(`.zone[data-slot-id]`).filter({ has: page.locator(`:scope > .zone-head .zone-label`, { hasText: new RegExp(`^${label}$`) }) }).first()
const textOf = (blocks: Block[]) => blocks.map((b) => blockText(b as AnyBlock)).join('\n')
const field = (blocks: AnyBlock[], title: string): AnyBlock | undefined => {
  for (const b of blocks) {
    if (b.kind === 'textField' && b.title === title) return b
    const inner = field([...((b.children ?? []) as AnyBlock[]), ...((b.rows ?? []) as AnyBlock[])], title)
    if (inner) return inner
  }
  return undefined
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const goblinSite = await context.newPage()
  await goblinSite.goto(`${site}/monsters/goblin`)
  const panel = await context.newPage()
  const errors: string[] = []
  panel.on('pageerror', (e) => errors.push(`panel: ${e.message}`))
  panel.on('console', (m) => m.type() === 'error' && console.log(`  [panel console] ${m.text()}`))
  await panel.setViewportSize({ width: 420, height: 1000 })
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)

  // Connect, and turn template filling on.
  await panel.getByPlaceholder('lk_…').fill('lk_fake_key')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await panel.getByText(/pages, updated/).waitFor({ timeout: 30_000 })
  await panel.getByText('Enable template filling').click()
  await panel.getByRole('button', { name: 'Done' }).click()
  check(await panel.getByText('Select something on a web page').isVisible(), 'connected to the stand-in project, with template filling on')

  // Clip the stat block.
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url })).find(Boolean)?.id, `${site}/monsters/goblin`)
  await goblinSite.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('.mon-stat-block')!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await worker.evaluate(async (tab) => (globalThis as unknown as { __lkTest: { captureFromMenu: (info: object, id: number) => Promise<void> } }).__lkTest.captureFromMenu({ selectionText: 'Goblin', frameId: 0 }, tab!), tabId)
  await panel.getByText('Selection', { exact: true }).waitFor()
  await panel.getByPlaceholder('Name of the new page').fill('Goblin')
  await panel.getByText('Import images').click()
  await panel.locator('.field', { hasText: 'Template' }).locator('select').first().selectOption(template.id)
  await panel.locator('.map-summary').waitFor()
  const summary = await panel.locator('.map-summary').innerText()
  check(/17\s*filled/.test(summary) && /1\s*unused/.test(summary), `the panel shows the counts, Initiative worked out from Dexterity (${summary.split('\n').slice(0, 3).join(' ')})`)
  check(!(await panel.locator('.template-fields li').count()), 'the dropdown review list is gone')
  if (shots) await panel.screenshot({ path: join(shots, 'panel-summary.png'), fullPage: true })

  // Open the mapper from the panel.
  const [mapper] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: 'Open mapper' }).click()])
  mapper.on('pageerror', (e) => errors.push(`mapper: ${e.message}`))
  await mapper.locator('#m-title', { hasText: 'Goblin → Statblock Template' }).waitFor()
  check(true, 'Open mapper opens the mapper in its own tab, with this clip')
  check(await zone(mapper, 'Initiative').locator('.origin').filter({ hasText: 'Worked out' }).isVisible() && await zone(mapper, 'Initiative').getByText('+2 (12)').isVisible(), 'Initiative shows “+2 (12)”, worked out')
  const [again] = await Promise.all([new Promise<Page | undefined>((done) => { context.once('page', done); setTimeout(() => done(undefined), 1500) }), panel.getByRole('button', { name: 'Open mapper' }).click()])
  check(!again, 'clicking it again goes back to that tab instead of opening another')

  await mapper.locator('#m-clip .card').filter({ hasText: 'Shortbow' }).dragTo(zone(mapper, 'Legendary Actions'))
  await mapper.locator('#m-clip .card').filter({ hasText: 'Proficiency Bonus' }).dragTo(zone(mapper, 'Resistances'))
  await zone(mapper, 'Resistances').locator('.remember input').check()
  await panel.getByText(/You changed \d fields? in the mapper/).waitFor()
  check(true, 'the panel hears the mapper’s changes')
  const preview = await panel.locator('.preview').innerText()
  check(preview.indexOf('LEGENDARY ACTIONS') < preview.indexOf('Shortbow') || preview.indexOf('Legendary Actions') < preview.indexOf('Shortbow'), 'the panel’s preview follows the mapper')

  // A change in the panel makes the cards again; the mapper keeps your changes.
  await panel.getByPlaceholder('Name of the new page').fill('Goblin Boss')
  await mapper.locator('#m-title', { hasText: 'Goblin Boss' }).waitFor()
  check(await zone(mapper, 'Legendary Actions').locator('.card').filter({ hasText: 'Shortbow' }).isVisible(), 'renaming the page in the panel keeps the mapper’s changes')

  // Import from the mapper tab.
  await mapper.getByRole('button', { name: 'Create page' }).click()
  await mapper.locator('.done-line').waitFor({ timeout: 30_000 })
  check((await mapper.locator('.done-line').innerText()).includes('Created “Goblin Boss”'), 'Import in the mapper: the panel imports, and the mapper says so with a link')
  await panel.getByText('Page created', { exact: true }).waitFor()
  check(true, 'the panel shows the page as created')
  check(writes.filter((w) => w.startsWith('createFromTemplate')).length === 1, 'exactly one page was made from the template')
  const page = [...resources.values()].find((r) => r.name === 'Goblin Boss')!
  const main = page.docs[0]!.blocks as AnyBlock[]
  check(textOf(main as Block[]).startsWith('From 127.0.0.1') || blockText(main[0]!).startsWith('From'), 'the page starts with the “From <Source>” credit')
  check(blockText(field(main, 'Legendary Actions')!).startsWith('Shortbow.'), 'Legendary Actions holds Shortbow')
  check(!blockText(field(main, 'Actions')!).includes('Shortbow') && blockText(field(main, 'Actions')!).startsWith('Scimitar.'), 'Actions kept Scimitar only')
  check(textOf(main as Block[]).includes('Resistances: +2'), 'Resistances holds the proficiency bonus')
  check(textOf(main as Block[]).includes('Small Humanoid (Goblinoid), Neutral Evil'), 'the unused line is at the end of the page')
  if (shots) await mapper.screenshot({ path: join(shots, 'mapper-imported.png') })

  // The remembered rule, in Settings.
  await panel.locator('#open-settings').click()
  const rule = panel.locator('.settings-list.rules li').first()
  await rule.waitFor()
  check((await rule.getByLabel('Label in the clip').inputValue()) === 'Proficiency Bonus' && (await rule.getByLabel('Website').inputValue()) === '127.0.0.1', 'the rule is saved: on 127.0.0.1, “Proficiency Bonus” goes in…')
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('.settings-list.rules select')?.options.length! > 2)
  check((await rule.getByLabel('Template field').inputValue()) === 'resistances', '…Resistances, and the template’s fields are offered to change it')
  await rule.getByLabel('Template field').selectOption({ label: 'Immunities' })
  const saved = await panel.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { projects: { rules: { slotLabel: string }[] }[] }).projects[0]!.rules[0]!.slotLabel)
  check(saved === 'Immunities', 'a rule can be edited')

  // Template filling off: the clip works as it always has.
  await panel.getByText('Enable template filling').click()
  await panel.getByRole('button', { name: 'Done' }).click()
  const formBefore = await panel.evaluate(async () => JSON.stringify((await chrome.storage.session.get('panel:form'))['panel:form'] ?? null))
  await worker.evaluate(async (tab) => (globalThis as unknown as { __lkTest: { captureFromMenu: (info: object, id: number) => Promise<void> } }).__lkTest.captureFromMenu({ selectionText: 'Goblin', frameId: 0 }, tab!), tabId)
  await panel.getByPlaceholder('Name of the new page').waitFor()
  check(!(await panel.locator('.field', { hasText: 'Template' }).count()) && !(await panel.locator('.map-summary').count()), 'with template filling off there is no Template choice and no mapper')
  await panel.getByPlaceholder('Name of the new page').fill('Goblin (plain)')
  await panel.getByRole('button', { name: 'Create page' }).click()
  await panel.getByText('Page created', { exact: true }).waitFor()
  const plain = [...resources.values()].find((r) => r.name === 'Goblin (plain)')!
  check(plain && !writes.includes('createFromTemplate Goblin (plain)') && blockText(plain.docs[0]!.blocks[0] as AnyBlock).startsWith('From'), 'a plain page is created as before, with the credit and the clip')
  const formAfter = await panel.evaluate(async () => JSON.stringify((await chrome.storage.session.get('panel:form'))['panel:form'] ?? null))
  check(formAfter === formBefore, 'and nothing new is stored for the mapper')
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} catch (error) {
  // Pictures of every tab, to see where it stopped.
  for (const [i, page] of context.pages().entries()) await page.screenshot({ path: join(tmpdir(), `lk-panel-failure-${i}.png`), fullPage: true }).catch(() => {})
  console.log(`Stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; screenshots in ${join(tmpdir(), 'lk-panel-failure-<n>.png')}`)
  failures++
} finally {
  await context.close()
  server.close()
}
if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All panel checks passed')
