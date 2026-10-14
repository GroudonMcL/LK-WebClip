import { rule, type Block, type Run } from '@legendkeeper/sdk/blocks'
import type { FillPlan } from './plan.js'
import { buildSlots, fillTree, forCopy, SIDEBAR, type AnyBlock, type FilledTree, type Slot, type SlotFill, type TemplateTree } from './template.js'

/**
 * Turns a fill plan into what is written: the values, unfilled slots kept or removed, the
 * "From <Source>" credit, and the clip's unused content.
 *
 * A template with its own "From [Source]" heading (as in a God template) gets the credit there, and
 * the unused content under it when only placeholder text sits under it. Otherwise the credit goes
 * at the top of the main tab (or of the added content, on an append), and the unused content at
 * the end, after a divider.
 */

export interface ComposeOptions {
  /** The "From <Source>" heading, or undefined when the credit is switched off. */
  sourceHeading?: Block
  /** Keep the template's placeholder in slots nothing was found for; otherwise remove those slots. */
  keepUnfilled: boolean
}

export interface Composition {
  fills: Map<string, SlotFill>
  /** Blocks to add at the start of the main tab: the credit, when the template has no place for it. */
  head: Block[]
  /** Blocks to add at the end of the main tab. */
  tail: Block[]
  /** The tab that gets the tail: the one named Main, else the first. */
  mainDoc: number
  /** "[Class]" in the template's headings, written as the page's name. */
  subject?: { placeholder: string; name: string }
}

export function mainDocIndex(tree: TemplateTree): number {
  const main = tree.docs.findIndex((d) => d.name.trim().toLowerCase() === 'main')
  return main >= 0 ? main : 0
}

export function compose(tree: TemplateTree, plan: FillPlan, options: ComposeOptions): Composition {
  const fills = new Map(plan.fills)
  for (const state of plan.slots) {
    if (state.status === 'filled' || state.slot.kind === 'source') continue
    if (!options.keepUnfilled) fills.set(state.slot.id, { remove: true })
  }

  const mainDoc = mainDocIndex(tree)
  const leftovers = plan.leftovers
  const sourceSlots = plan.slots.map((s) => s.slot).filter((s) => s.kind === 'source')
  // The template's own credit line takes the unused content if only placeholders sit under it.
  const home = sourceSlots.find((s) => s.doc === mainDoc && s.target.type === 'source' && s.target.length > 0) ?? sourceSlots.find((s) => s.doc === mainDoc)
  let placed = false
  for (const slot of sourceSlots) {
    const takesContent = slot === home && slot.target.type === 'source' && slot.target.length > 0 && leftovers.length > 0
    const content = takesContent ? leftovers : []
    if (takesContent) placed = true
    if (options.sourceHeading) {
      fills.set(slot.id, { blocks: [options.sourceHeading, ...content] })
      continue
    }
    // No credit: the heading stays as a placeholder or goes, like any unfilled slot.
    const original = originalBlock(tree, slot)
    if (takesContent) fills.set(slot.id, { blocks: [...(options.keepUnfilled && original ? [original] : []), ...content] })
    else if (!options.keepUnfilled) fills.set(slot.id, { remove: true })
  }

  const head = options.sourceHeading && sourceSlots.length === 0 ? [options.sourceHeading] : []
  const rest = placed ? [] : leftovers
  const tail = rest.length > 0 ? [rule(), ...rest] : []
  return { fills, head, tail, mainDoc, ...(plan.subject ? { subject: plan.subject } : {}) }
}

function originalBlock(tree: TemplateTree, slot: Slot): Block | undefined {
  if (slot.doc === SIDEBAR) return undefined
  let list = tree.docs[slot.doc]!.blocks as AnyBlock[]
  let block: AnyBlock | undefined
  for (const i of slot.target.at) {
    block = list[i]
    list = (block?.children ?? block?.rows ?? []) as AnyBlock[]
  }
  return block as Block | undefined
}

/** Fills a tree (the template, or a page made from it) and adds the head and tail to its main tab. */
export function applyComposition(tree: TemplateTree, composition: Composition): FilledTree & { missing: string[] } {
  const slots = buildSlots(tree)
  const ids = new Set(slots.map((s) => s.id))
  const missing = [...composition.fills.keys()].filter((id) => !ids.has(id))
  const filled = fillTree(tree, slots, composition.fills)
  filled.docs[composition.mainDoc] = [...composition.head, ...(filled.docs[composition.mainDoc] ?? []), ...composition.tail]
  filled.docs = filled.docs.map(tidyRules)
  if (composition.subject) filled.docs = filled.docs.map((blocks) => namedHeadings(blocks, composition.subject!))
  return { ...filled, missing }
}

/**
 * Writes the page's name for the template's subject in brackets in its headings: in a Class
 * Template, "Core [Class] Traits" becomes "Core Bard Traits" and "[Class] Class Features" "Bard
 * Class Features". Paragraphs keep their brackets: they are placeholders or notes to the reader.
 */
/** Replaces matches of `pattern` in runs, also where a match spans runs ("Core [" + italic "Class] "). */
function replaceInRuns(runs: Run[], pattern: RegExp, replacement: string): Run[] {
  const text = runs.map((r) => ('text' in r ? r.text : '\u0000')).join('')
  const matches = [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
  if (matches.length === 0) return runs
  const out: Run[] = []
  let offset = 0
  for (const run of runs) {
    const length = 'text' in run ? run.text.length : 1
    if (!('text' in run)) {
      out.push(run)
      offset += length
      continue
    }
    let piece = ''
    for (let k = 0; k < run.text.length; k++) {
      const at = offset + k
      const match = matches.find((m) => at >= m.start && at < m.end)
      if (!match) piece += run.text[k]
      else if (at === match.start) piece += replacement
    }
    if (piece) out.push({ ...run, text: piece })
    offset += length
  }
  return out
}

export function namedHeadings(blocks: Block[], subject: { placeholder: string; name: string }): Block[] {
  const pattern = new RegExp(`\\[\\s*${subject.placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'gi')
  const walk = (list: AnyBlock[]): AnyBlock[] =>
    list.map((block) => {
      let out = block
      if (block.kind === 'heading' && Array.isArray(block.content)) out = { ...block, content: replaceInRuns(block.content as Run[], pattern, subject.name) }
      if (Array.isArray(out.children)) out = { ...out, children: walk(out.children as AnyBlock[]) }
      if (out.kind === 'infobox' && Array.isArray(out.rows)) out = { ...out, rows: walk(out.rows as AnyBlock[]) }
      return out
    })
  return walk(blocks as AnyBlock[]) as Block[]
}

/** Removing an unfilled section can leave two dividers together, or one at the end: keep one. */
export function tidyRules(blocks: Block[]): Block[] {
  const isBlank = (b: Block | undefined) => b?.kind === 'paragraph' && b.content.length === 0
  return blocks.filter((block, i) => {
    if (block.kind !== 'rule') return true
    let next = i + 1
    while (isBlank(blocks[next])) next++
    return next < blocks.length && blocks[next]!.kind !== 'rule'
  })
}

/**
 * What adding a template to an existing page appends: a divider, the credit, the template's main tab
 * filled in, then the unused content. Sidebar properties are not touched on an existing page.
 */
export function appendedTemplate(tree: TemplateTree, composition: Composition): Block[] {
  const main: TemplateTree = { docs: [tree.docs[composition.mainDoc]!], properties: [] }
  const filled = applyComposition(main, { ...composition, mainDoc: 0 })
  return [rule(), ...forCopy(filled.docs[0]!)]
}

/** The tree an append fills: only the main tab, no sidebar. Plans for an append are made on this. */
export function appendTree(tree: TemplateTree): TemplateTree {
  return { docs: [tree.docs[mainDocIndex(tree)]!], properties: [] }
}

/**
 * Swaps clip images for their uploaded copies in fills and the tail. `replace` returns the block to
 * use: an image block with the asset URL, or (for an image that couldn't be copied) a paragraph
 * linking to the original.
 */
export function mapImages(composition: Composition, replace: (url: string) => Block | undefined): Composition {
  const swap = (blocks: Block[]): Block[] =>
    blocks.map((block) => {
      const b = block as AnyBlock
      if (b.kind === 'image') {
        const next = replace(String(b.url)) as AnyBlock | undefined
        if (!next) return block
        return (next.kind === 'image' ? { ...b, url: next.url, ...(next.alt && !b.alt ? { alt: next.alt } : {}) } : next) as Block
      }
      if (Array.isArray(b.children)) return { ...b, children: swap(b.children as Block[]) } as Block
      return block
    })
  const fills = new Map<string, SlotFill>()
  for (const [id, fill] of composition.fills) {
    if ('image' in fill) {
      const next = replace(fill.image.url) as AnyBlock | undefined
      // Only project assets can go in an image slot; an image that couldn't be copied leaves it as it was.
      if (next?.kind === 'image') fills.set(id, { image: { url: String(next.url), alt: fill.image.alt ?? (next.alt as string | undefined) } })
    } else if ('blocks' in fill) fills.set(id, { blocks: swap(fill.blocks) })
    else fills.set(id, fill)
  }
  return { ...composition, fills, head: swap(composition.head), tail: swap(composition.tail) }
}

/** Every image URL the composition would write. */
export function imageUrls(composition: Composition): Set<string> {
  const out = new Set<string>()
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      const b = block as AnyBlock
      if (b.kind === 'image') out.add(String(b.url))
      if (Array.isArray(b.children)) walk(b.children as Block[])
    }
  }
  for (const fill of composition.fills.values()) {
    if ('image' in fill) out.add(fill.image.url)
    if ('blocks' in fill) walk(fill.blocks)
  }
  walk(composition.head)
  walk(composition.tail)
  return out
}
