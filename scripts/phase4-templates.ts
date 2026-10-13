/**
 * Phase 4 integration check: fills real templates of the project from real clips, through the same
 * pipeline the extension uses, and reads the pages back to check the values landed.
 *
 *   npm run phase4:templates
 *
 * Needs a template named "Statblock Template" and one named "God Template" in the project (the AI
 * Test Project has both). With OPENROUTER_API_KEY set, the "Labels then AI" runs use a free
 * OpenRouter model; without it they are skipped. Only adds pages, under
 * "LK Web Clipper Sandbox / Phase 4 templates <time>".
 */
import { readFile } from 'node:fs/promises'
import { LegendKeeper } from '@legendkeeper/sdk'
import { p, plainText, type Block } from '@legendkeeper/sdk/blocks'
import { Readability } from '@mozilla/readability'
import { DOMParser, parseHTML } from 'linkedom'
import { importClip, prepareClip, type Capture } from '../src/clip/importClip.js'
import { DEFAULT_LINK_OPTIONS } from '../src/clip/links.js'
import { slotsForAi } from '../src/fill/ai.js'
import { appendTree } from '../src/fill/compose.js'
import { listFreeModels, OpenRouterEngine, suggest } from '../src/fill/engines.js'
import { DEFAULT_SYNONYMS, Synonyms } from '../src/fill/labels.js'
import { planFill, type AiSuggestion, type FillMode } from '../src/fill/plan.js'
import { blockText, type AnyBlock } from '../src/fill/template.js'
import { ProjectIndex, configuredKeys, createPage, describeError, findOrCreateSource, siteName, type SourceConfig } from '../src/index.js'
import { listTemplates, readTemplate } from '../src/lk/templates.js'

const SANDBOX_NAME = process.env.LK_SANDBOX_NAME?.trim() || 'LK Web Clipper Sandbox'
const WIKI_URL = 'https://en.wikipedia.org/wiki/Tiamat_(Dungeons_%26_Dragons)'
const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()

const lk = new LegendKeeper({ apiKey: configuredKeys(process.env)[0]!, maxRetries: 3 })
const index = await ProjectIndex.load(lk)
const sandbox = index.children(null).find((r) => r.name === SANDBOX_NAME)
const sourcesRoot = sandbox && index.children(sandbox.id).find((r) => r.name === 'Sources')
if (!sandbox || !sourcesRoot) throw new Error('Run npm run poc first: it creates the sandbox and its Sources page.')
const sourceConfig: SourceConfig = { sourcesRootId: sourcesRoot.id, sourceTag: 'Source' }
const templates = listTemplates(index)
const nameOf = (id: string) => index.get(id)?.name
const templateNamed = (name: string) => {
  const found = templates.find((t) => t.resource.name === name)
  if (!found) throw new Error(`The project has no template named "${name}".`)
  return found.resource
}
console.log(`Templates in the project: ${templates.map((t) => t.path).join(', ')}`)
console.log(`Templates are kept out of the page list: ${templates.every((t) => !index.pages().includes(t.resource)) ? 'yes' : 'NO'}\n`)

const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
const run = await createPage(lk, index, {
  parentId: sandbox.id,
  name: `Phase 4 templates ${stamp}`,
  blocks: [p(`Clips filled into the project's templates by the Phase 4 pipeline on ${stamp} UTC (scripts/phase4-templates.ts).`)],
})
console.log(`Writing under ${index.path(run.resource.id)}\n`)

let failures = 0
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? '✔' : '✘'} ${message}`)
  if (!ok) failures++
}

interface Case {
  title: string
  capture: Capture
  template: string
  mode: FillMode
  keepUnfilled: boolean
  destination: 'new' | { appendTo: string }
  credit?: boolean
  verify: (page: { blocks: Block[]; text: string; tags: string[] }) => void
}

async function run_(c: Case): Promise<void> {
  console.log(`▶ ${c.title}`)
  if (c.mode !== 'labels' && !openRouterKey) {
    console.log('  skipped: set OPENROUTER_API_KEY to run the AI cases\n')
    return
  }
  try {
    const plan = prepareClip(c.capture, index, { links: DEFAULT_LINK_OPTIONS, images: true, parser })
    const content = await readTemplate(lk, templateNamed(c.template).id)
    const tree = c.destination === 'new' ? content.tree : appendTree(content.tree)
    const base = { tree, templateId: content.id, clip: plan.blocks, title: c.capture.suggestedTitle, site: new URL(c.capture.url).hostname, synonyms: new Synonyms(DEFAULT_SYNONYMS), rules: [], overrides: {}, nameOf }
    let fill = planFill({ ...base, mode: c.mode })
    let ai: Map<string, AiSuggestion> | undefined
    if (c.mode !== 'labels') {
      const models = await listFreeModels()
      const engine = new OpenRouterEngine({ apiKey: openRouterKey!, model: process.env.OPENROUTER_MODEL ?? models[0]!.id, fallbacks: models })
      const started = Date.now()
      try {
        const result = await suggest(engine, { slots: slotsForAi(fill, c.mode, {}), clip: plan.blocks, blockIndexes: c.mode === 'ai' ? plan.blocks.map((_, i) => i) : fill.unusedBlockIndexes, title: c.capture.suggestedTitle, nameOf })
        ai = result.suggestions
        console.log(`  AI (${process.env.OPENROUTER_MODEL ?? models[0]!.id}) answered in ${((Date.now() - started) / 1000).toFixed(1)} s with ${ai.size} suggestion(s)`)
      } catch (error) {
        console.log(`  AI failed, labels only: ${describeError(error)}`)
      }
      fill = planFill({ ...base, mode: c.mode, ai })
    }
    for (const s of fill.slots.filter((x) => ['text', 'rich', 'image'].includes(x.slot.kind))) {
      console.log(`    ${s.status.padEnd(9)} ${(s.origin ?? '').padEnd(10)} ${s.slot.label.slice(0, 32).padEnd(32)} ${s.text.replace(/\s+/g, ' ').slice(0, 60)}`)
    }
    console.log(`  unused clip parts: ${fill.leftovers.length}`)

    const source = c.credit === false ? undefined : (await findOrCreateSource(lk, index, siteName({ url: c.capture.url, ...c.capture.meta }), sourceConfig)).source
    const result = await importClip(lk, index, plan, {
      destination: c.destination === 'new'
        ? { mode: 'new', parentId: run.resource.id, title: c.capture.suggestedTitle }
        : { mode: 'append', target: { resourceId: c.destination.appendTo, documentId: index.get(c.destination.appendTo)!.documents[0]!.id } },
      source: source ? { kind: 'existing', resourceId: source.id } : undefined,
      template: { content, plan: fill, keepUnfilled: c.keepUnfilled },
      sourceConfig,
      onProgress: (message) => console.log(`  … ${message}`),
    })
    check(result.templateMissing.length === 0, `every slot was found in the written page${result.templateMissing.length ? `; missing: ${result.templateMissing.join(', ')}` : ''}`)
    const resource = await lk.resources.get({ resourceId: result.resourceId })
    const written = await lk.documents.getBlocks({ resourceId: result.resourceId, documentId: result.documentId })
    // plainText skips infoboxes; blockText reads their rows too.
    c.verify({ blocks: written.blocks, text: written.blocks.map((b) => blockText(b as AnyBlock)).join('\n'), tags: resource.tags ?? [] })
    console.log(`  ${result.url}\n`)
  } catch (error) {
    failures++
    console.log(`  ✘ ${describeError(error)}\n`)
    if (process.env.DEBUG) console.error(error)
  }
}

function capture(kind: Capture['kind'], html: string, url: string, suggestedTitle: string, meta: Capture['meta'] = {}): Capture {
  return { kind, html, text: '', url, title: suggestedTitle, suggestedTitle, meta, capturedAt: new Date().toISOString() }
}

const json = (blocks: Block[]) => JSON.stringify(blocks)
const goblinHtml = await readFile(new URL('../test/fixtures/dndbeyond-goblin.html', import.meta.url), 'utf8')
const goblin = (title: string) => capture('selection', goblinHtml, 'https://www.dndbeyond.com/monsters/16907-goblin', title, { ogSiteName: 'D&D Beyond' })

await run_({
  title: 'D&D Beyond goblin → Statblock Template, new page, labels only, unfilled fields removed',
  capture: goblin('Goblin (labels)'),
  template: 'Statblock Template',
  mode: 'labels',
  keepUnfilled: false,
  destination: 'new',
  verify: ({ blocks, text, tags }) => {
    check(tags.includes('Statblock'), `the template's tags were copied (${tags.join(', ')})`)
    check(text.includes('15 (leather armor, shield)') && text.includes('8 (-1)') && text.includes('1/4 (50 XP)'), 'infobox rows hold AC, ability scores and CR')
    check(text.includes('Nimble Escape') && text.includes('Scimitar'), 'Traits and Actions hold the clip’s entries')
    check(!text.includes('[Example') && !text.includes('[Description text]'), 'unfilled placeholders were removed')
    check(!json(blocks).includes('"Bonus Actions"'), 'the empty Bonus Actions field was removed')
    check(json(blocks).includes('"mention"') && text.includes('Proficiency Bonus +2'), 'the From heading and unused content are at the end')
  },
})

await run_({
  title: 'D&D Beyond goblin → Statblock Template, new page, labels then AI, placeholders kept',
  capture: goblin('Goblin (labels then AI)'),
  template: 'Statblock Template',
  mode: 'labels-ai',
  keepUnfilled: true,
  destination: 'new',
  verify: ({ text }) => {
    check(text.includes('Small Humanoid (Goblinoid), Neutral Evil'), 'the AI put the size, type and alignment line in the infobox text field')
    check(text.includes('[Description text]'), 'unfilled placeholders were kept')
  },
})

const target = await createPage(lk, index, { parentId: run.resource.id, name: 'Goblin notes (append target)', blocks: [p('Notes written before clipping.')] })
await run_({
  title: 'D&D Beyond goblin → Statblock Template appended to an existing page, no credit heading',
  capture: goblin('Goblin'),
  template: 'Statblock Template',
  mode: 'labels',
  keepUnfilled: false,
  destination: { appendTo: target.resource.id },
  credit: false,
  verify: ({ blocks, text }) => {
    check(blocks[0]?.kind === 'paragraph' && text.startsWith('Notes written before clipping.'), 'the existing content is untouched and first')
    check(blocks[1]?.kind === 'rule' && blocks[2]?.kind === 'infobox', 'then a divider and the filled template')
    check(text.includes('15 (leather armor, shield)'), 'the infobox is filled')
    check(!blocks.some((b) => b.kind === 'heading' && plainText([b]).startsWith('From ')), 'no From heading (credit switched off)')
  },
})

const wikiHtml = await (await fetch(WIKI_URL, { headers: { 'User-Agent': 'LK-WebClip/0.4 (https://github.com/GroudonMcL/LK-WebClip)' } })).text()
const readable = parseHTML(wikiHtml).document
for (const furniture of Array.from(readable.querySelectorAll('.mw-editsection'))) furniture.remove()
const article = new Readability(readable as unknown as Document).parse()
if (!article?.content) throw new Error('Readability found no article')
await run_({
  title: 'Wikipedia article → God Template, labels then AI; the clip goes under the template’s own “From [Source]” heading',
  capture: capture('article', article.content, WIKI_URL, 'Tiamat (God Template clip)', { ogSiteName: 'Wikipedia' }),
  template: 'God Template',
  mode: 'labels-ai',
  keepUnfilled: true,
  destination: 'new',
  verify: ({ blocks, text }) => {
    const fromIndex = blocks.findIndex((b) => b.kind === 'heading' && json([b]).includes('"mention"'))
    check(fromIndex >= 0, 'the template’s “From [Source]” heading now links the Source')
    check(!text.includes('[Source text]') && text.includes('Tiamat'), 'the article sits under it in place of the placeholder')
    check(blocks.filter((b) => b.kind === 'heading' && json([b]).includes('"mention"')).length === 1, 'there is only one credit heading')
  },
})

console.log(failures === 0 ? 'All template checks passed.' : `${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
