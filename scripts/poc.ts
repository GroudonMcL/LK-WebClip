/**
 * Phase 1 proof of concept: exercises every LegendKeeper operation the web clipper depends on,
 * against a real project, and writes what happened to docs/phase1-poc-output.md.
 *
 *   npm run poc
 *
 * Everything it creates goes under the sandbox page (LK_SANDBOX_NAME, default "LK Web Clipper
 * Sandbox"), in a fresh "Phase 1 run <time>" page. Nothing is deleted, so each run can be inspected
 * in the app afterwards.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { LegendKeeper, ValidationError } from '@legendkeeper/sdk'
import {
  bold, code, collection, h, italic, li, link, mention, mono, ol, p, plainText, quote, strike, table, td, th, tr, ul, underline,
  walk, type Block, type DocumentBlocks,
} from '@legendkeeper/sdk/blocks'
import {
  MatchTier, NotAppendableError, ProjectIndex, appendToDocument, appendedClip, configuredKeys, createPage, describeError,
  ensureAssetFolder, findOrCreateSource, findSources, importImage, newPageClip, resolveAppendTarget, searchResources, siteName,
  type DocumentRef, type IndexedResource, type SourceConfig,
} from '../src/index.js'

const SANDBOX_NAME = process.env.LK_SANDBOX_NAME?.trim() || 'LK Web Clipper Sandbox'
const ASSET_FOLDER = 'LK Web Clipper'
const CLIP_URL = 'https://en.wikipedia.org/wiki/Flag_of_Wales'
const IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Flag_of_Wales.svg/330px-Flag_of_Wales.svg.png'
const NOT_AN_IMAGE_URL = 'https://en.wikipedia.org/wiki/Red_dragon'

// ---------------------------------------------------------------- reporting

interface StepResult {
  title: string
  ok: boolean
  lines: string[]
}
const results: StepResult[] = []
let current: StepResult | undefined

function log(line = ''): void {
  console.log(`  ${line}`)
  current?.lines.push(line)
}

async function step<T>(title: string, run: () => Promise<T>): Promise<T | undefined> {
  current = { title, ok: true, lines: [] }
  results.push(current)
  console.log(`\n▶ ${title}`)
  try {
    return await run()
  } catch (error) {
    current.ok = false
    log(`FAILED: ${describeError(error)}`)
    if (process.env.DEBUG) console.error(error)
    return undefined
  } finally {
    console.log(current.ok ? '  ✔ passed' : '  ✘ failed')
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`)
  log(`✓ ${message}`)
}

// ---------------------------------------------------------------- client with request accounting

const requests = { reads: 0, writes: 0 }
const keys = configuredKeys(process.env)
if (keys.length === 0) {
  console.error('Set LEGENDKEEPER_API_KEY (see .env.example).')
  process.exit(1)
}
const lk = new LegendKeeper({
  apiKey: keys[0]!,
  maxRetries: 3,
  fetch: async (url, init) => {
    if ((init.method ?? 'GET') === 'GET') requests.reads++
    else requests.writes++
    return fetch(url, init)
  },
})

function mentionsIn(doc: DocumentBlocks | Block[]): { resourceId: string; name?: string }[] {
  const found: { resourceId: string; name?: string }[] = []
  walk(doc, (block) => {
    for (const run of 'content' in block && Array.isArray(block.content) ? block.content : []) {
      if ('mention' in run && run.mention) found.push({ resourceId: run.mention.resourceId, name: run.mention.name ?? undefined })
    }
  })
  return found
}

function kinds(blocks: Block[]): string {
  return blocks.map((block) => block.kind).join(', ')
}

const childrenCollection = () =>
  collection({ filter: { type: 'filter', filterType: 'field', id: 'children', field: 'parentId', operator: 'equals', value: '$self' }, isTitleHidden: true })

// ---------------------------------------------------------------- the run

const startedAt = new Date()
const stamp = startedAt.toISOString().slice(0, 16).replace('T', ' ')
console.log(`LegendKeeper web clipper — Phase 1 proof of concept (${stamp} UTC)`)

// 1. Project details ----------------------------------------------------------
const project = await step('1. Load project details', async () => {
  log(`${keys.length} API key(s) configured → ${keys.length === 1 ? 'the project picker can be skipped' : 'the UI must offer a project picker'}`)
  const details = await lk.project()
  log(`Project: "${details.name}" (${details.id}), public: ${details.isPublic}, created ${details.createdAt}`)
  try {
    const tags = await lk.tags.list()
    log(`tags.list (an ADMIN-only operation) succeeded → the key acts as ADMIN. ${tags.data.length} distinct tags.`)
  } catch (error) {
    log(`tags.list refused → the key acts as MEMBER: ${describeError(error)}`)
  }
  return details
})
if (!project) process.exit(1)

// 2. Resource hierarchy ------------------------------------------------------
const index = (await step('2. Retrieve the resource hierarchy', async () => {
  const started = Date.now()
  const loaded = await ProjectIndex.load(lk)
  log(`${loaded.size} resources in ${loaded.pagesFetched} page(s) of resources.list, ${Date.now() - started} ms, tree depth ${loaded.maxDepth()}`)
  const types = new Map<string, number>()
  for (const resource of loaded.byId.values()) for (const doc of resource.documents) types.set(doc.type, (types.get(doc.type) ?? 0) + 1)
  log(`Document types: ${[...types].map(([type, count]) => `${type} ${count}`).join(', ')}`)
  const multiTab = [...loaded.byId.values()].filter((r) => r.documents.filter((d) => d.type === 'page').length > 1)
  log(`${multiTab.length} resources have more than one page tab (e.g. ${multiTab.slice(0, 3).map((r) => `"${r.name}": ${r.documents.filter((d) => d.type === 'page').map((d) => d.name).join('/')}`).join('; ')})`)
  log(`Top level: ${loaded.children(null).map((r) => r.name).join(', ')}`)
  const sample = loaded.findByName('Adult Red Dragon')[0] ?? [...loaded.byId.values()].find((r) => loaded.ancestors(r.id).length >= 2)
  if (sample) log(`Example path: ${loaded.path(sample.id)}`)
  check(loaded.size > 0, 'the index holds the project tree')
  return loaded
}))!
if (!index) process.exit(1)

// 3. Search --------------------------------------------------------------------
await step('3. Search for a resource by name', async () => {
  for (const query of ['Dragon', 'Greyhawk', 'Witch Queen']) {
    const started = Date.now()
    const hits = await searchResources(lk, index, query, 8)
    log(`"${query}" → ${hits.length} hits in ${Date.now() - started} ms:`)
    for (const hit of hits) log(`    [${MatchTier[hit.tier]}] ${hit.path}${hit.matched ? `  (${hit.matched.slice(0, 60)})` : ''}`)
  }
  const dragon = await searchResources(lk, index, 'Dragon', 3)
  check(dragon[0]?.tier === MatchTier.ExactName, 'an exact name match ranks first')
  const alias = await searchResources(lk, index, 'Witch Queen', 3)
  check(alias.some((hit) => hit.tier === MatchTier.Alias), 'aliases are searchable')
})

// Sandbox, run page and sources root -----------------------------------------------
const setup = await step('Sandbox setup', async () => {
  let sandbox = index.children(null).find((r) => r.name === SANDBOX_NAME)
  if (!sandbox) {
    sandbox = (await createPage(lk, index, { name: SANDBOX_NAME, blocks: [p('Test content made by the LK Web Clipper proof of concept.'), childrenCollection()] })).resource
    log(`Created the sandbox page "${SANDBOX_NAME}"`)
  } else log(`Using the existing sandbox page "${SANDBOX_NAME}" (${sandbox.id})`)

  let sourcesRoot = index.children(sandbox.id).find((r) => r.name === 'Sources')
  if (!sourcesRoot) {
    sourcesRoot = (await createPage(lk, index, { parentId: sandbox.id, name: 'Sources', blocks: [p('Where clipped content came from.'), childrenCollection()] })).resource
    log('Created the sandbox Sources page (kept between runs, so later runs reuse its Sources)')
  } else log(`Using the existing sandbox Sources page (${sourcesRoot.id})`)

  const run = await createPage(lk, index, {
    parentId: sandbox.id,
    name: `Phase 1 run ${stamp}`,
    blocks: [p(`Pages created by the Phase 1 proof of concept on ${stamp} UTC. See docs/phase1-poc-output.md in the repository.`), childrenCollection()],
  })
  log(`Created the run page "${run.resource.name}" (${run.resource.id})`)
  return { sandbox, sourcesRoot, run: run.resource }
})
if (!setup) process.exit(1)
const sourceConfig: SourceConfig = { sourcesRootId: setup.sourcesRoot.id, sourceTag: 'Source' }

// 8. Source with backlinks ------------------------------------------------------------
const source = await step('8. Create a Source resource with a dynamic backlinks collection', async () => {
  const name = siteName({ url: CLIP_URL, ogSiteName: 'Wikipedia' })
  log(`Site name for ${CLIP_URL} with og:site_name "Wikipedia" → "${name}"`)
  log(`Site name for https://www.dndbeyond.com/monsters/16990-adult-red-dragon without metadata → "${siteName({ url: 'https://www.dndbeyond.com/monsters/16990-adult-red-dragon' })}"`)

  const choice = await findOrCreateSource(lk, index, name, sourceConfig)
  log(choice.created ? `Created Source "${choice.source.name}" under ${index.path(setup.sourcesRoot.id)}` : `"${name}" already exists in Sources → reused ${index.path(choice.source.id)} (the extension will prompt here)`)

  const doc = await lk.documents.getBlocks({ resourceId: choice.source.id, documentId: choice.source.documents[0]!.id })
  const backlinks = doc.blocks.find((b) => b.kind === 'resourceCollection')
  check(backlinks?.kind === 'resourceCollection' && backlinks.filter?.type === 'filter' && 'scope' in backlinks.filter && backlinks.filter.scope === 'edges', 'the Source page holds a backlinks (edges) collection')

  const realSources = index.children(null).find((r) => r.name === 'Sources')
  if (realSources) {
    const dndb = findSources(index, 'D&D Beyond', { sourcesRootId: realSources.id })
    log(`Duplicate detection against the project's own Sources page: "D&D Beyond" → ${dndb.length ? dndb.map((r) => index.path(r.id)).join(', ') : 'none'}`)
  }
  return choice.source
})

// Resources to mention ---------------------------------------------------------------
const dragon = index.findByName('Dragon')[0]
const greyhawk = (await searchResources(lk, index, 'Greyhawk', 1))[0]?.resource

// 9. Image upload ---------------------------------------------------------------------
const images = await step('9. Upload an image and create an image block', async () => {
  const folderId = await ensureAssetFolder(lk, ASSET_FOLDER)
  log(`Asset folder "${ASSET_FOLDER}": ${folderId}`)
  const good = await importImage(lk, IMAGE_URL, { name: 'Flag of Wales (clipped)', alt: 'The red dragon of the Flag of Wales', folderId, referer: CLIP_URL })
  if (!good.ok) throw new Error(`the image import failed: ${good.reason}`)
  log(`Uploaded ${IMAGE_URL} → asset ${good.assetId}`)
  log(`Asset url: ${good.url}`)
  const bad = await importImage(lk, NOT_AN_IMAGE_URL, { name: 'Not an image', folderId })
  check(!bad.ok, `a non-image URL falls back to a link instead of failing the clip ("${bad.ok ? '' : bad.reason}")`)
  return { good, bad }
})

// 5 + 6 + 7. New page with formatted blocks, a mention and the image ----------------
function sampleClip(): Block[] {
  const blocks: Block[] = [
    h(2, 'Y Ddraig Goch'),
    p(
      'The flag of Wales shows a ', bold('red dragon'), ' passant on a ', italic('green and white'), ' field. ',
      'It was ', underline('officially recognised'), ' in 1959; ', strike('earlier designs'), ' differ. Code point: ', mono('U+1F3F4'), '. ',
      'More: ', link(CLIP_URL, 'Flag of Wales on Wikipedia'), '.',
    ),
  ]
  if (dragon || greyhawk) {
    blocks.push(p(
      'Related pages already in the project: ',
      ...(dragon ? [mention({ resourceId: dragon.id })] : []),
      ...(dragon && greyhawk ? [' and '] : []),
      ...(greyhawk ? [mention({ resourceId: greyhawk.id, text: 'Greyhawk' })] : []),
      '.',
    ))
  }
  blocks.push(
    h(3, 'Heraldry'),
    ul('Tinctures: gules, vert and argent', li('Charges', ul('A dragon passant', 'A per fess field')), 'Proportions: 3:5'),
    ol(['Adopted as a royal badge', 'Flown at Caernarfon in 1959', 'Made the national flag'], { start: 1 }),
    quote(p('Y Ddraig Goch ddyry cychwyn — the red dragon will show the way.')),
    table(
      tr(th(['Element']), th(['Tincture']), th(['Meaning'])),
      tr(td(['Dragon']), td(['Gules (red)']), td(['Cadwaladr’s standard'])),
      tr(td(['Upper field']), td(['Argent (white)']), td(['The Tudor livery'])),
      tr(td(['Lower field']), td(['Vert (green)']), td(['The Tudor livery'])),
    ),
    code('<img src="Flag_of_Wales.svg" alt="Flag of Wales">', 'html'),
  )
  if (images) blocks.push(images.good.block, images.bad.block)
  return blocks
}

const newPage = await step('5–7. Create a new page under a chosen parent, with formatted blocks and genuine mentions', async () => {
  if (!source) throw new Error('needs the Source from step 8')
  const created = await createPage(lk, index, { parentId: setup.run.id, name: 'Red Dragon of Wales (new page clip)', blocks: newPageClip(source.id, sampleClip()) })
  log(`Created ${index.path(created.resource.id)}`)
  const doc = await lk.documents.getBlocks(created.document)
  log(`Top-level blocks: ${kinds(doc.blocks)}`)
  const first = doc.blocks[0]
  check(first?.kind === 'heading' && first.level === 1 && plainText(first) === `From ${source.name}`, `the page opens with Heading 1 "From ${source.name}"`)
  const mentions = mentionsIn(doc)
  log(`Mentions as stored (the server fills in each name): ${mentions.map((m) => `${m.name ?? '?'} → ${m.resourceId}`).join(', ')}`)
  check(mentions.some((m) => m.resourceId === source.id), 'the Source name in the heading is a mention of the Source page')
  if (dragon) check(mentions.some((m) => m.resourceId === dragon.id && m.name === dragon.name), `the body mentions the existing "${dragon.name}" page and the server resolves it`)
  const all: string[] = []
  const marks = new Set<string>()
  walk(doc, (block) => {
    all.push(block.kind === 'tableCell' && block.header ? 'tableCell (header)' : block.kind)
    for (const run of 'content' in block && Array.isArray(block.content) ? block.content : []) {
      for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'link']) if (mark in run) marks.add(mark)
    }
  })
  for (const kind of ['heading', 'bulletList', 'listItem', 'orderedList', 'quote', 'table', 'tableCell (header)', 'code', 'image']) {
    if (kind === 'image' && !images) continue
    check(all.includes(kind), `${kind} survived the round trip`)
  }
  check(all.filter((k) => k === 'bulletList').length >= 2, 'the nested list survived the round trip')
  check(marks.size === 6, `inline marks survived the round trip: ${[...marks].join(', ')}`)
  return created
})

// 6. Append to an existing page ---------------------------------------------------------
async function makeExistingPage(name: string): Promise<{ resource: IndexedResource; ref: DocumentRef; before: DocumentBlocks }> {
  const made = await createPage(lk, index, {
    parentId: setup!.run.id,
    name,
    blocks: [
      h(1, 'Dragon research'),
      p('Notes written by hand before any clipping. ', bold('These must survive every append unchanged.')),
      ul('Chromatic dragons', 'Metallic dragons'),
    ],
  })
  return { resource: made.resource, ref: made.document, before: await lk.documents.getBlocks(made.document) }
}

await step('6. Append formatted content to an existing page (atomic write, with a simulated concurrent edit)', async () => {
  if (!source) throw new Error('needs the Source from step 8')
  const target = await makeExistingPage('Dragon research (append target, atomic)')
  log(`Existing page ${index.path(target.resource.id)} holds: ${kinds(target.before.blocks)}`)

  const ref = resolveAppendTarget(index.get(target.resource.id)!)
  const concurrentText = 'A line typed in the app by someone else while the clip was being saved.'
  const result = await appendToDocument(lk, ref, appendedClip(source.id, [p('Clip appended in one atomic write: ', italic('a red dragon passant'), '.')]), {
    strategy: 'replace',
    beforeWrite: async (attempt, read) => {
      if (attempt !== 1) return
      await lk.blocks.insert(ref, { block: p(concurrentText), ifMatch: read.version })
      log('Simulated a concurrent edit between the clipper’s read and its write')
    },
  })
  log(`Strategy ${result.strategy}, ${result.attempts} attempt(s). Page now: ${kinds(result.document.blocks)}`)
  check(result.attempts === 2, 'the stale write was refused with 412 and retried on a fresh read')
  const n = target.before.blocks.length
  check(JSON.stringify(result.document.blocks.slice(0, n)) === JSON.stringify(target.before.blocks), 'the original blocks are unchanged, ids included')
  check(plainText(result.document.blocks[n]!) === concurrentText, 'the concurrent edit was kept, not overwritten')
  const tail = result.document.blocks.slice(n + 1)
  check(tail[0]?.kind === 'rule' && tail[1]?.kind === 'heading' && plainText(tail[1]!) === `From ${source.name}`, 'the clip starts with a divider and the "From <Source>" heading')

  const second = await appendToDocument(lk, ref, appendedClip(source.id, [p('A second clip, appended block by block with blocks.insert.')]), { strategy: 'insert' })
  check(second.document.blocks.filter((b) => b.kind === 'rule').length === 2, 'a second clip (insert strategy) adds its own divider and heading below the first')
})

await step('Append targets: blank documents, maps and multi-tab resources', async () => {
  if (!source) throw new Error('needs the Source from step 8')
  const blank = await lk.resources.create({ name: 'Blank folder page (append target)', parentId: setup.run.id })
  index.upsert(ProjectIndex.fromListItem(blank))
  log(`New resource with no content: document type "${blank.documents[0]?.type}"`)
  const appended = await appendToDocument(lk, resolveAppendTarget(index.get(blank.id)!), appendedClip(source.id, [p('Appended to a blank document, which becomes a page.')]))
  check(appended.document.blocks[0]?.kind === 'rule', 'appending to a blank document works and converts it to a page')

  const map = await lk.resources.create({ name: 'Map page (not appendable)', parentId: setup.run.id, documents: [{ name: 'Map', type: 'map' }] })
  index.upsert(ProjectIndex.fromListItem(map))
  try {
    resolveAppendTarget(index.get(map.id)!)
    check(false, 'a map is refused as an append target')
  } catch (error) {
    check(error instanceof NotAppendableError, `a map is refused before any write: "${(error as Error).message}"`)
  }

  const tabs = await lk.resources.create({
    name: 'Two-tab page (choose a tab)',
    parentId: setup.run.id,
    documents: [{ name: 'Main', type: 'page', blocks: [p('Player-facing notes.')] }, { name: 'DM', type: 'page', blocks: [p('DM-only notes.')] }],
  })
  index.upsert(ProjectIndex.fromListItem(tabs))
  try {
    resolveAppendTarget(index.get(tabs.id)!)
    check(false, 'a resource with two page tabs asks which one')
  } catch (error) {
    check(!(error instanceof NotAppendableError), `two page tabs need a choice: "${(error as Error).message}"`)
  }
  const dmTab = tabs.documents.find((d) => d.name === 'DM')!
  const toDm = await appendToDocument(lk, resolveAppendTarget(index.get(tabs.id)!, dmTab.id), appendedClip(source.id, [p('Clipped into the DM tab.')]))
  check(plainText(toDm.document).includes('Clipped into the DM tab.'), 'appending to the chosen tab works')
})

await step('Errors are reported in words the user can act on', async () => {
  try {
    await lk.resources.create({ name: '' })
  } catch (error) {
    check(error instanceof ValidationError, `an invalid request reads: "${describeError(error)}"`)
  }
})

await step('Index stays current without a full reload', async () => {
  const before = index.size
  const reloaded = await ProjectIndex.load(lk)
  check(reloaded.size === before, `the incrementally updated index (${before}) matches a full reload (${reloaded.size})`)
})

// ---------------------------------------------------------------- summary

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} steps passed. ${requests.reads} reads and ${requests.writes} writes.`)
if (newPage) console.log(`Open "${setup.run.name}" under "${SANDBOX_NAME}" in LegendKeeper to inspect the pages.`)

const md = [
  `# Phase 1 proof of concept — output of the latest run`,
  '',
  `Run ${stamp} UTC against project "${project.name}" with \`npm run poc\`. ${passed}/${results.length} steps passed, using ${requests.reads} read and ${requests.writes} write requests.`,
  '',
  `Everything it made is under **${SANDBOX_NAME} / ${setup.run.name}** in LegendKeeper (Sources under **${SANDBOX_NAME} / Sources**).`,
  '',
  ...results.flatMap((r) => [`## ${r.ok ? '✅' : '❌'} ${r.title}`, '', '```', ...r.lines, '```', '']),
]
await mkdir(new URL('../docs/', import.meta.url), { recursive: true })
await writeFile(new URL('../docs/phase1-poc-output.md', import.meta.url), md.join('\n'))
process.exit(passed === results.length ? 0 : 1)
