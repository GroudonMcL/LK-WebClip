/**
 * Checks the mapper tab in the built extension, with no LegendKeeper project needed.
 *
 *   npm run build && npm run mapper:check [-- screenshot-dir]
 *
 * It makes the cards, slots and mapping from saved clips (the D&D Beyond Goblin into the Statblock
 * Template, a wiki page with an infobox into the God Template, a plain article into a location
 * template), hands them to mapper.html through chrome.storage.session as the side panel does, and
 * then drags, clicks and types like a person. A stand-in for the side panel answers the Import
 * button, so the round trip is checked too. Screenshots go to the directory when one is given.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMParser } from 'linkedom'
import { chromium, type Page } from 'playwright'
import { htmlStringToBlocks } from '../src/clip/htmlToBlocks.js'
import { DEFAULT_SYNONYMS, Synonyms } from '../src/fill/labels.js'
import { buildMapBase, initialMapping, type Mapping } from '../src/fill/mapping.js'
import { planFill } from '../src/fill/plan.js'
import type { TemplateTree } from '../src/fill/template.js'
import type { MapperSession } from '../src/extension/mapperState.js'
import { inRankOrder } from '../src/lk/pages.js'
import type { Block } from '@legendkeeper/sdk/blocks'

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const shots = process.argv[2]
const root = new URL('../', import.meta.url)
const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }

async function sessionFor(fixture: string, templateName: string, title: string, key: string, site = 'dndbeyond.com'): Promise<MapperSession> {
  const t = JSON.parse(await readFile(new URL(`test/fixtures/templates/${templateName.replace(/ /g, '_')}.json`, root), 'utf8'))
  const tree: TemplateTree = { docs: t.docs.filter((d: { type: string }) => d.type === 'page').map((d: { name: string; blocks: Block[] }) => ({ ...d, blocks: inRankOrder(d.blocks) })), properties: t.properties }
  const clip = htmlStringToBlocks(await readFile(new URL(`test/fixtures/${fixture}`, root), 'utf8'), parser, { baseUrl: `https://${site}/` }).blocks
  const plan = planFill({ tree, templateId: t.id, templateName, clip, title, site, synonyms: new Synonyms(DEFAULT_SYNONYMS), rules: [], mode: 'labels', overrides: {} })
  const base = buildMapBase(plan, clip, { key, synonyms: DEFAULT_SYNONYMS, title })
  return {
    key, rev: 1, base, mapping: initialMapping(base),
    context: {
      title, site, templateName, mode: 'new', tree, keepUnfilled: true, importLabel: 'Create page', problems: [], projectName: 'AI Test Project', clipUrl: `https://${site}/`,
      sourceHeading: { kind: 'heading', level: 1, content: [{ text: 'From ' }, { mention: { resourceId: '_source', text: 'D&D Beyond' } }] },
    },
  }
}

const extension = new URL('../dist/extension', import.meta.url).pathname
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'lk-mapper-')), {
  executablePath: CHROMIUM,
  headless: true,
  viewport: { width: 1500, height: 950 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
let failures = 0
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? '✔' : '✖'} ${what}`)
  if (!ok) failures++
}
const zone = (page: Page, label: string) => page.locator(`.zone[data-slot-id]`).filter({ has: page.locator(`:scope > .zone-head .zone-label`, { hasText: new RegExp(`^${label.replace(/[()[\]]/g, '\\$&')}$`) }) }).first()
const clipCard = (page: Page, text: string) => page.locator('#m-clip .card').filter({ hasText: text }).first()
const stored = (page: Page) => page.evaluate(async () => ((await chrome.storage.session.get('mapper:mapping'))['mapper:mapping'] as { mapping: Mapping }).mapping)

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The saved clips' images point at made-up addresses, so they fail to load; anything else is an error.
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()))
  await page.goto(`chrome-extension://${id}/mapper.html`)
  check(await page.getByText('Nothing to map yet').isVisible(), 'with no clip, the mapper says how to start')

  // 1. The D&D Beyond Goblin into the Statblock Template.
  const goblin = await sessionFor('dndbeyond-goblin.html', 'Statblock Template', 'Goblin', 'goblin')
  await page.evaluate((s) => chrome.storage.session.set({ 'mapper:session': s }), goblin)
  await page.locator('#m-clip .card').first().waitFor()
  check((await page.locator('#m-title').textContent()) === 'Goblin → Statblock Template', 'shows the clip and template')
  check((await page.locator('#m-counts').textContent())?.includes('16 filled'), 'label matching filled 16 fields')
  check(await zone(page, 'Armour Class').locator('.card').filter({ hasText: '15 (leather armor, shield)' }).isVisible(), 'Armour Class holds “15 (leather armor, shield)”')
  check(await zone(page, 'Armour Class').locator('.origin').filter({ hasText: 'Label · Synonym' }).isVisible(), '…with a Label · Synonym badge')
  check(await page.locator('.wf-infobox').count() > 0, 'the wireframe has the infobox')
  check(await zone(page, 'Bonus Actions').locator('.zone-empty').isVisible(), 'an empty field is marked')
  check((await page.locator('#m-preview .preview').textContent())?.includes('Scimitar'), 'the preview shows the page')
  if (shots) await page.screenshot({ path: join(shots, 'mapper.png') })

  // Dragging an entry out of Actions into Legendary Actions.
  await clipCard(page, 'Shortbow').dragTo(zone(page, 'Legendary Actions'))
  check(await zone(page, 'Legendary Actions').locator('.card').filter({ hasText: 'Shortbow' }).isVisible(), 'drag: Shortbow moved into Legendary Actions')
  check(!(await zone(page, 'Actions').locator('.card').filter({ hasText: 'Shortbow' }).count()), '…and out of Actions')
  check(await zone(page, 'Legendary Actions').locator('.origin').filter({ hasText: 'Manual' }).isVisible(), '…with a Manual badge')
  check(!(await zone(page, 'Legendary Actions').locator('.remember').count()), '…and no “Remember” for prose')
  check((await stored(page)).slots['tab0:rich:legendary actions']?.length === 1, 'the mapping is sent to the panel')
  const preview = (await page.locator('#m-preview .preview').innerHTML())
  check(preview.indexOf('Legendary Actions') < preview.indexOf('Shortbow'), 'the preview follows')

  // Reordering inside Actions by dragging onto the first card.
  await clipCard(page, 'Shortbow').dragTo(zone(page, 'Actions').locator('.card').filter({ hasText: 'Scimitar' }), { targetPosition: { x: 20, y: 3 } })
  const actions = await zone(page, 'Actions').locator('.zone-cards').textContent()
  check(actions && actions.indexOf('Shortbow') >= 0 && actions.indexOf('Shortbow') < actions.indexOf('Scimitar'), `drag within a section: Shortbow now comes before Scimitar${process.env.DEBUG ? ` (${actions})` : ''}`)

  // Click to choose a card: slots that can't take it are greyed out.
  await clipCard(page, '§ Actions').click()
  check(await page.evaluate(() => document.body.classList.contains('choosing')), 'click a card: it is chosen')
  check(await zone(page, 'Speed').evaluate((e) => e.classList.contains('refuse')), '…a one-line field can’t take a section, and is greyed out')
  check(await zone(page, 'Description').evaluate((e) => e.classList.contains('accept')), '…a section field can')
  await page.keyboard.press('Escape')
  check(!(await page.evaluate(() => document.body.classList.contains('choosing'))), 'Esc cancels')

  // Click-to-place a labelled value, and remember it.
  await clipCard(page, 'Common, Goblin').click()
  await zone(page, 'Description').locator('.zone-head').click()
  check(await zone(page, 'Description').locator('.card').filter({ hasText: 'Common, Goblin' }).isVisible(), 'click a card, then a field: it goes there')
  const remember = zone(page, 'Description').locator('.remember input')
  check(await remember.isVisible(), '“Remember this for dndbeyond.com?” is offered for a labelled value')
  await remember.check()
  check((await stored(page)).remember['tab0:rich:description'] === true, '…and ticking it is saved in the mapping')

  // The keyboard: Enter on a card, then Enter on a field.
  await clipCard(page, 'Challenge').focus()
  await page.keyboard.press('Enter')
  await zone(page, 'Initiative').focus()
  await page.keyboard.press('Enter')
  check(await zone(page, 'Initiative').locator('.card').filter({ hasText: '1/4 (50 XP)' }).isVisible(), 'keyboard: Enter on a card, then on a field, places it')
  await page.keyboard.press('Control+z')
  check(!(await zone(page, 'Initiative').locator('.card').count()), 'Ctrl+Z undoes it')

  // Typing a value, and clearing a field.
  await zone(page, 'Initiative').locator('[data-action="type"]').click()
  await page.locator('[data-type-input="tab0:text:infobox › initiative"]').fill('+2 (12)')
  await page.keyboard.press('Enter')
  check(await zone(page, 'Initiative').getByText('+2 (12)').isVisible(), 'type a value: it fills the field')
  check(await zone(page, 'Initiative').locator('.origin').filter({ hasText: 'Typed' }).isVisible(), '…with a Typed badge')
  await zone(page, 'Hit Points').locator('[data-action="clear"]').click()
  check(await zone(page, 'Hit Points').locator('.zone-empty').isVisible(), 'clear a field: it is marked empty')
  check(await page.locator('#m-tray .card').filter({ hasText: '7 (2d6)' }).isVisible(), '…and its value goes to Unused')

  // Selecting part of a card and making a card of it.
  const line = page.locator('#m-tray .card').filter({ hasText: 'Small Humanoid' })
  await line.locator('[data-action="split"]').click()
  check(await page.locator('#m-tray .card.splitting').isVisible(), '✂ makes a card’s text selectable')
  await page.evaluate(() => {
    const text = [...document.querySelectorAll('#m-tray .cut-text')].find((e) => e.textContent?.startsWith('Small Humanoid'))!
    const range = document.createRange()
    range.setStart(text.firstChild!, 0)
    range.setEnd(text.firstChild!, 'Small Humanoid (Goblinoid)'.length)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.locator('#m-cut').waitFor({ state: 'visible' })
  await page.locator('#m-cut').click()
  await zone(page, 'Size, Creature Type, Alignment').locator('.zone-head').click()
  check(await zone(page, 'Size, Creature Type, Alignment').getByText('Small Humanoid (Goblinoid)', { exact: true }).isVisible(), 'select part of a card’s text: just that part goes in a field')
  check(await page.locator('#m-tray .card').filter({ hasText: ', Neutral Evil' }).isVisible(), '…and the rest stays in Unused')

  // Dragging a card back to Unused.
  await zone(page, 'Legendary Actions').locator('.card').filter({ hasText: 'Shortbow' }).count()
  await zone(page, 'Actions').locator('.card').filter({ hasText: 'Shortbow' }).dragTo(page.locator('#m-tray'))
  check(await page.locator('#m-tray .card').filter({ hasText: 'Shortbow' }).isVisible(), 'drag a card to Unused: it goes to the end of the page')

  // Import: a stand-in panel answers.
  await worker.evaluate(() => {
    chrome.storage.session.onChanged.addListener((changes) => {
      const request = changes['mapper:import']?.newValue as { key: string; requestId: string } | undefined
      if (request) void chrome.storage.session.set({ 'mapper:status': { key: request.key, requestId: request.requestId, state: 'done', message: 'Created “Goblin”.', url: 'https://www.legendkeeper.com/app/p/r/' } })
    })
  })
  await page.locator('#m-import').click()
  await page.locator('.done-line').waitFor()
  check((await page.locator('.done-line').textContent())?.includes('Created “Goblin”.'), 'Import: the panel imports and the mapper shows the result, with a link')
  if (shots) await page.screenshot({ path: join(shots, 'mapper-edited.png') })

  // 2. A tie.
  const tie = await sessionFor('dndbeyond-goblin.html', 'Statblock Template', 'Goblin', 'tie')
  const tieClip = htmlStringToBlocks('<p>Speed: 30 ft.</p><p>Speed: 40 ft.</p>', parser, { baseUrl: 'https://dndbeyond.com/' }).blocks
  const tiePlan = planFill({ tree: tie.context.tree, templateId: 't', clip: tieClip, title: 'Goblin', site: 'dndbeyond.com', synonyms: new Synonyms(DEFAULT_SYNONYMS), rules: [], mode: 'labels', overrides: {} })
  tie.base = buildMapBase(tiePlan, tieClip, { key: 'tie', synonyms: DEFAULT_SYNONYMS, title: 'Goblin' })
  tie.mapping = initialMapping(tie.base)
  await page.evaluate((s) => chrome.storage.session.set({ 'mapper:session': s }), tie)
  await zone(page, 'Speed').locator('.tie').waitFor()
  check(await zone(page, 'Speed').locator('.tie button').count() === 2, 'a tie shows the competing values')
  await zone(page, 'Speed').locator('.tie button').filter({ hasText: '40 ft.' }).click()
  check(await zone(page, 'Speed').locator('.card').filter({ hasText: '40 ft.' }).isVisible(), '…and the one picked goes in')

  // 3. A wiki page with an infobox.
  const wiki = await sessionFor('wiki-infobox.html', 'God Template', 'Aurelion', 'wiki', 'example.org')
  await page.evaluate((s) => chrome.storage.session.set({ 'mapper:session': s }), wiki)
  await page.locator('#m-title', { hasText: 'Aurelion' }).waitFor()
  check(await zone(page, 'Alignment').getByText('Neutral good').isVisible(), 'wiki: infobox rows fill by label')
  check(await page.locator('.wf-sidebar .zone').count() > 0, 'wiki: the sidebar fields are shown down the side')
  await clipCard(page, '§ Dogma').dragTo(zone(page, 'Manifesto, Dogma, or Quote'))
  check(await zone(page, 'Manifesto, Dogma, or Quote').getByText('Every dawn is a second chance', { exact: false }).isVisible(), 'wiki: a section dragged in brings its text')
  if (shots) await page.screenshot({ path: join(shots, 'mapper-wiki.png') })

  // Resizing panes and hiding the sidebar.
  const width = async (selector: string) => (await page.locator(selector).boundingBox())!.width
  const drag = async (gutter: string, dx: number, dy = 0) => {
    const box = (await page.locator(`[data-gutter="${gutter}"]`).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 })
    await page.mouse.up()
  }
  const clipBefore = await width('#m-clip')
  await drag('clip', 120)
  check(Math.abs(await width('#m-clip') - clipBefore - 120) < 4, 'drag the divider: the clip gets wider')
  const previewBefore = await width('#m-preview')
  await drag('preview', 80)
  check(Math.abs(previewBefore - await width('#m-preview') - 80) < 4, 'drag the divider: the preview gets narrower')
  const trayBefore = (await page.locator('#m-tray').boundingBox())!.height
  await drag('tray', 0, -60)
  check(Math.abs((await page.locator('#m-tray').boundingBox())!.height - trayBefore - 60) < 4, 'drag the divider: the unused tray gets taller')
  const sidebarBefore = await width('.wf-sidebar')
  await drag('sidebar', -50)
  check(Math.abs(await width('.wf-sidebar') - sidebarBefore - 50) < 4, 'drag the divider: the sidebar gets wider')
  await page.locator('[data-gutter="clip"]').dblclick()
  check(await page.locator('#m-app').evaluate((grid) => grid.style.getPropertyValue('--clip-w') === ''), 'double-click the divider: the clip goes back to its default size')
  await page.locator('.wf-sidebar [data-action="sidebar"]').click()
  check(await page.locator('.wf-sidebar .zone').count() === 0 && await page.locator('.wf-sidebar.collapsed').isVisible(), 'hide the sidebar')
  const pageWider = await width('.wf-page')
  await page.reload()
  await page.locator('#m-title', { hasText: 'Aurelion' }).waitFor()
  check(await page.locator('.wf-sidebar.collapsed').isVisible() && Math.abs(await width('#m-preview') - (previewBefore - 80)) < 4, 'sizes and the hidden sidebar are remembered')
  if (shots) await page.screenshot({ path: join(shots, 'mapper-resized.png') })
  await page.locator('.wf-sidebar.collapsed [data-action="sidebar"]').click()
  check(await page.locator('.wf-sidebar .zone').count() > 0 && await width('.wf-page') < pageWider, 'show the sidebar again')

  // 4. A plain article with no labels.
  const article = await sessionFor('plain-article.html', 'Other Location Template', 'Saltmere', 'article', 'example.org')
  await page.evaluate((s) => chrome.storage.session.set({ 'mapper:session': s }), article)
  await page.locator('#m-title', { hasText: 'Saltmere' }).waitFor()
  check((await page.locator('#m-counts').textContent())?.includes('0 filled'), 'article: nothing has a label, so nothing is filled')
  const trayCount = await page.locator('#m-tray .card').count()
  check(trayCount === 4, `article: every part is in Unused (${trayCount}: ${(await page.locator('#m-tray .card').allTextContents()).join(' || ')})`)
  await clipCard(page, 'The harbour town').dragTo(zone(page, 'Overview'))
  check(await zone(page, 'Overview').locator('.card').filter({ hasText: 'The harbour town' }).isVisible(), 'article: a paragraph dragged into Overview')
  check(!(await zone(page, 'Overview').locator('.remember').count()), 'article: no “Remember” for prose')

  // 5. No panel to answer: the mapper says how to open it.
  await worker.evaluate(() => chrome.runtime.reload)
  const lone = await context.newPage()
  await lone.goto(`chrome-extension://${id}/mapper.html`)
  await lone.locator('#m-title', { hasText: 'Saltmere' }).waitFor()
  check(await lone.locator('#m-clip .card').count() > 0, 'a new mapper tab picks up the same clip and changes')
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await context.close()
}
if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All mapper checks passed')
