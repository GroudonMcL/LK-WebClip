/**
 * Phase 2 integration check: converts real web HTML with the clipper's converter and imports it
 * into the sandbox through the same pipeline the extension uses. It proves that what the
 * converter produces is accepted by the live API, not only by the unit tests.
 *
 *   npm run phase2:import
 *
 * Like the Phase 1 script it only adds pages, under "LK Web Clipper Sandbox / Phase 2 import <time>".
 */
import { readFile } from 'node:fs/promises'
import { LegendKeeper } from '@legendkeeper/sdk'
import { p, plainText, walk } from '@legendkeeper/sdk/blocks'
import { Readability } from '@mozilla/readability'
import { DOMParser, parseHTML } from 'linkedom'
import { importClip, prepareClip, type Capture } from '../src/clip/importClip.js'
import { DEFAULT_LINK_OPTIONS } from '../src/clip/links.js'
import { ProjectIndex, configuredKeys, createPage, describeError, findOrCreateSource, siteName, type SourceConfig } from '../src/index.js'

const SANDBOX_NAME = process.env.LK_SANDBOX_NAME?.trim() || 'LK Web Clipper Sandbox'
const WIKI_URL = 'https://en.wikipedia.org/wiki/Tiamat_(Dungeons_%26_Dragons)'
const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }

const lk = new LegendKeeper({ apiKey: configuredKeys(process.env)[0]!, maxRetries: 3 })
const index = await ProjectIndex.load(lk)
const sandbox = index.children(null).find((r) => r.name === SANDBOX_NAME)
const sourcesRoot = sandbox && index.children(sandbox.id).find((r) => r.name === 'Sources')
if (!sandbox || !sourcesRoot) throw new Error('Run npm run poc first: it creates the sandbox and its Sources page.')
const sourceConfig: SourceConfig = { sourcesRootId: sourcesRoot.id, sourceTag: 'Source' }

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
const run = await createPage(lk, index, {
  parentId: sandbox.id,
  name: `Phase 2 import ${stamp}`,
  blocks: [p(`Real web content converted by the Phase 2 clipper pipeline on ${stamp} UTC (scripts/phase2-import.ts).`)],
})
console.log(`Writing under ${index.path(run.resource.id)}\n`)

let failures = 0
async function clip(title: string, capture: Capture, destination: 'new' | { appendTo: string }): Promise<void> {
  console.log(`▶ ${title}`)
  try {
    const plan = prepareClip(capture, index, { links: DEFAULT_LINK_OPTIONS, images: true, parser })
    const kinds = new Map<string, number>()
    walk(plan.blocks, (block) => kinds.set(block.kind, (kinds.get(block.kind) ?? 0) + 1))
    console.log(`  converted: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`)
    const linked = plan.terms.filter((t) => t.linkedTo)
    console.log(`  links → pages: ${linked.map((t) => `${t.pass === 'text' ? '' : '[link] '}${t.text} → ${index.path(t.linkedTo!)}${t.found > 1 ? ` (${t.linked} of ${t.found})` : ''}`).join('; ') || 'none'}`)
    const ambiguous = plan.terms.filter((t) => t.status === 'ambiguous')
    if (ambiguous.length) console.log(`  ambiguous, left unlinked: ${ambiguous.map((t) => `${t.text} (${t.candidates.map((c) => c.name).join(' / ')})`).join('; ')}`)
    for (const warning of plan.warnings) console.log(`  warning: ${warning}`)

    const name = siteName({ url: capture.url, ...capture.meta })
    const source = await findOrCreateSource(lk, index, name, sourceConfig)
    const result = await importClip(lk, index, plan, {
      destination: destination === 'new'
        ? { mode: 'new', parentId: run.resource.id, title: capture.suggestedTitle }
        : { mode: 'append', target: { resourceId: destination.appendTo, documentId: index.get(destination.appendTo)!.documents[0]!.id } },
      source: { kind: 'existing', resourceId: source.source.id },
      sourceConfig,
      onProgress: (message) => console.log(`  … ${message}`),
    })
    const written = await lk.documents.getBlocks({ resourceId: result.resourceId, documentId: result.documentId })
    console.log(`  ✔ ${index.path(result.resourceId)} — ${written.blocks.length} top-level blocks, source "${result.source.name}"${source.created ? ' (new)' : ''}, ${result.imagesUploaded} image(s) uploaded`)
    for (const failed of result.imagesFailed) console.log(`  image fallback: ${failed.src.slice(0, 80)} — ${failed.reason}`)
    console.log(`  ${result.url}\n`)
  } catch (error) {
    failures++
    console.log(`  ✘ ${describeError(error)}\n`)
    if (process.env.DEBUG) console.error(error)
  }
}

function capture(kind: Capture['kind'], html: string, url: string, document: Document, suggestedTitle: string): Capture {
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content') ?? undefined
  return {
    kind,
    html,
    text: '',
    url,
    title: document.title,
    suggestedTitle,
    meta: { ogSiteName: meta('meta[property="og:site_name"]'), applicationName: meta('meta[name="application-name"]'), ogTitle: meta('meta[property="og:title"]') },
    capturedAt: new Date().toISOString(),
  }
}

// 1. A stat block with awkward markup, as a new page.
const fixture = await readFile(new URL('../test/fixtures/statblock.html', import.meta.url), 'utf8')
const { document: statDoc } = parseHTML(fixture)
await clip('Stat block selection (fixture) → new page', capture('selection', statDoc.getElementById('clip')!.outerHTML, 'https://compendium.example.com/monsters/adult-red-dragon', statDoc, 'Adult Red Dragon (clip test)'), 'new')

// 2. A full Wikipedia article through Readability, as a new page.
const wikiHtml = await (await fetch(WIKI_URL, { headers: { 'User-Agent': 'LK-WebClip/0.2 (https://github.com/GroudonMcL/LK-WebClip)' } })).text()
const { document: wikiDoc } = parseHTML(wikiHtml)
const article = new Readability(parseHTML(wikiHtml).document as unknown as Document).parse()
if (!article?.content) throw new Error('Readability found no article')
await clip('Wikipedia article (Readability) → new page', capture('article', article.content, WIKI_URL, wikiDoc as unknown as Document, `${article.title ?? 'Tiamat'} (article clip)`), 'new')

// 3. One section of the same article, appended to an existing page.
const target = await createPage(lk, index, { parentId: run.resource.id, name: 'Tiamat notes (append target)', blocks: [p('Notes written before clipping.')] })
// Wikipedia wraps each section in <section>; take the "Campaign settings" one, as if it had been selected.
const heading = Array.from(wikiDoc.querySelectorAll('h2')).find((h) => /Campaign settings/i.test(h.textContent ?? ''))
const sectionEl = heading?.closest('section')
if (!sectionEl) throw new Error('the Campaign settings section was not found')
const section = [sectionEl.outerHTML]
await clip('Wikipedia section selection → append to existing page', capture('selection', section.join(''), WIKI_URL, wikiDoc as unknown as Document, 'Tiamat'), { appendTo: target.resource.id })

const appended = await lk.documents.getBlocks(target.document)
console.log(`Append target now reads: ${plainText(appended).split('\n').slice(0, 3).join(' / ')} …`)
console.log(failures === 0 ? '\nAll imports succeeded.' : `\n${failures} import(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
