import type { Block, PropertyBlock, Run } from '@legendkeeper/sdk/blocks'
import { cleanLabel, isPlaceholderText, isWeakLabel, placeholderLabels } from './labels.js'

/**
 * A template's slots: every place in it that can take a value, with the label that names it.
 *
 * Slots are found the same way in the template and in a page just made from it, and each slot's id
 * comes from its labels and position among same-labelled slots (never from block ids). So a slot
 * matched against the template can be filled in the copy, and a saved rule keeps working after
 * the template is edited, unless that label is renamed.
 */

/** Blocks and properties are handled generically here: by kind and by their children or rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlock = { kind: string; [field: string]: any }

export interface TemplateDoc {
  name: string
  blocks: Block[]
}

/** The parts of a template (or of a page made from one) that slots are read from. */
export interface TemplateTree {
  /** The page tabs, in order. Other tabs (maps, boards) have no slots. */
  docs: TemplateDoc[]
  /** Sidebar properties. */
  properties: PropertyBlock[]
}

/**
 * - text: a key-value row; takes a line of text.
 * - rich: a text field, a heading's section or placeholder paragraphs; takes blocks.
 * - image: an image block or property; takes one image.
 * - name: a heading such as "[Spell] Name"; takes the page name.
 * - source: a "From [Source]" heading; takes the Source link.
 * - links: a links block or a hand-picked collection; takes the pages the clip links to.
 */
export type SlotKind = 'text' | 'rich' | 'image' | 'name' | 'source' | 'links'

export type SlotTarget =
  | { type: 'row'; at: number[]; row: number }
  | { type: 'field'; at: number[] }
  | { type: 'section'; at: number[]; length: number; level: number }
  | { type: 'placeholder'; at: number[]; length: number }
  | { type: 'image'; at: number[] }
  | { type: 'name'; at: number[] }
  | { type: 'source'; at: number[]; length: number }
  | { type: 'links'; at: number[] }

export interface Slot {
  id: string
  /** What the template calls it, e.g. "Armour Class". */
  label: string
  /** The cleaned label used for matching; empty for weak labels such as "TEXT". */
  key: string
  /** Where it is, for telling same-named slots apart: "Infobox › Armour Class". */
  path: string
  kind: SlotKind
  /** The template's current value as plain text: kept when the slot is left unfilled. */
  placeholder: string
  /** -1 for the sidebar, otherwise the index of the page tab. */
  doc: number
  /** The sidebar property's id, for slots in the sidebar. */
  propertyId?: string
  /** The row's id, for key-value rows (needed to update a sidebar row). */
  rowId?: string
  target: SlotTarget
  /**
   * A template heading, or a text field with its own title ("Legendary Actions"): it names a part
   * of a page, so only content under a heading like it belongs there.
   */
  titled?: boolean
  /** For a slot holding a table (a class's level table): the table's column headings. */
  table?: string[]
}

export const SIDEBAR = -1

/** The children of a block: an infobox's rows (which are properties), or its child blocks. */
export function childrenOf(block: AnyBlock): AnyBlock[] | undefined {
  if (block.kind === 'infobox') return block.rows as AnyBlock[]
  return Array.isArray(block.children) ? (block.children as AnyBlock[]) : undefined
}

/**
 * A mention made by the linker stores only the page id (its text is the page's name, which the
 * API fills in on read). Matching needs the words, so callers pass the page list's names here.
 */
let nameOf: ((resourceId: string) => string | undefined) | undefined

export function withNames<T>(resolve: ((resourceId: string) => string | undefined) | undefined, fn: () => T): T {
  const previous = nameOf
  nameOf = resolve ?? previous
  try {
    return fn()
  } finally {
    nameOf = previous
  }
}

export function runText(run: Run): string {
  if ('text' in run) return run.text
  if ('mention' in run) return run.mention.text ?? run.mention.name ?? nameOf?.(run.mention.resourceId) ?? ''
  return '\n'
}

export function runsText(runs: Run[] | undefined): string {
  return (runs ?? []).map(runText).join('')
}

export function blockText(block: AnyBlock): string {
  if (block.kind === 'code') return String(block.text ?? '')
  if (Array.isArray(block.content)) return runsText(block.content as Run[])
  if (block.kind === 'keyValue') return (block.rows as { key: string; text?: string; content?: Run[] }[]).map((r) => `${r.key}: ${r.text ?? runsText(r.content)}`).join('\n')
  const children = childrenOf(block)
  if (!children) return ''
  const sep = block.kind === 'tableRow' ? ' | ' : '\n'
  return children.map(blockText).filter((t) => t !== '').join(sep)
}

/**
 * Whether a bracketed heading stands for the page's name: "[Spell] Name", "[Magic Item] Name" or
 * "[Name]", but not "Level [?]: [Feature Name]", which names something else.
 */
export function namesPage(text: string): boolean {
  if (/\bname\b/i.test(text.replace(/\[[^\]]*\]/g, ' '))) return true
  return [...text.matchAll(/\[([^\]]*)\]/g)].some((m) => /^\s*(?:page\s+)?name\s*$/i.test(m[1]!))
}

const SOURCE_HEADING = /^from\s*\[\s*source\s*\]\s*$/i
/** A section's body stops at the next heading or at any of these. */
const SECTION_STOP = new Set(['heading', 'rule', 'infobox', 'layout', 'layoutColumn', 'secret', 'textField', 'keyValue', 'resourceCollection', 'resourceLink', 'map', 'unsupported', 'expand'])
/** Containers whose children can hold slots; they add nothing to the path. */
const TRANSPARENT = new Set(['layout', 'layoutColumn', 'secret', 'callout', 'expand'])

export function buildSlots(tree: TemplateTree): Slot[] {
  const slots: Slot[] = []
  const multiTab = tree.docs.length > 1
  tree.docs.forEach((doc, docIndex) => {
    walkSiblings(doc.blocks as AnyBlock[], [], multiTab ? [doc.name || 'Main'] : [], docIndex, slots)
  })
  tree.properties.forEach((property, i) => {
    const prop = property as AnyBlock
    const added = slotsForProperty(prop, [i], ['Sidebar'], SIDEBAR)
    for (const slot of added) slots.push({ ...slot, id: '', propertyId: prop.id as string | undefined })
  })
  // Ids: the path, numbered when the same path appears more than once.
  const seen = new Map<string, number>()
  for (const slot of slots) {
    const base = `${slot.doc === SIDEBAR ? 'sidebar' : `tab${slot.doc}`}:${slot.kind}:${cleanLabel(slot.path)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    slot.id = n === 1 ? base : `${base}#${n}`
  }
  return slots
}

type NewSlot = Omit<Slot, 'id'>

function walkSiblings(blocks: AnyBlock[], at: number[], path: string[], doc: number, out: Slot[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const here = [...at, i]
    if (block.kind === 'heading') {
      const text = runsText(block.content).trim()
      if (SOURCE_HEADING.test(text)) {
        const length = countWhile(blocks, i + 1, (b) => b.kind === 'paragraph' && (isPlaceholderText(blockText(b)) || blockText(b).trim() === ''))
        out.push(slot({ label: 'Source', key: '', path: [...path, 'From [Source]'], kind: 'source', placeholder: text, doc, target: { type: 'source', at: here, length } }))
        i += length
        continue
      }
      if (text.includes('[') && namesPage(text)) {
        out.push(slot({ label: 'Name', key: '', path: [...path, text], kind: 'name', placeholder: text, doc, target: { type: 'name', at: here } }))
        continue
      }
      // "[Class] Class Features" names a part of the page, with the page's subject in brackets; other
      // brackets ("Level [?]: [Feature Name]") make the heading a sample to copy, not a field.
      if (text.includes('[') && [...text.matchAll(/\[([^\]]*)\]?/g)].some((m) => !/^\s*\p{L}+\s*$/u.test(m[1]!))) continue
      const length = countWhile(blocks, i + 1, (b) => !SECTION_STOP.has(b.kind))
      const next = blocks[i + 1]
      // A heading over sub-headings ("Becoming a [Class]" over "As a Level 1 Character") only titles
      // them, and a bracketed heading with nothing under it is only a title.
      if (length === 0 && (text.includes('[') || (next?.kind === 'heading' && (next.level as number) > (block.level as number)))) continue
      const body = blocks.slice(i + 1, i + 1 + length)
      out.push(slot({ label: text, key: cleanLabel(text), path: [...path, text], kind: 'rich', placeholder: body.map(blockText).join('\n').trim(), doc, target: { type: 'section', at: here, length, level: block.level as number }, titled: true, ...tableOf(body) }))
      i += length
      continue
    }
    if ((block.kind === 'paragraph' || block.kind === 'quote') && isPlaceholderText(blockText(block))) {
      // "[Overview text]" or a quote "[Manifesto, Dogma, or Quote]": each is its own slot.
      const text = blockText(block)
      const label = placeholderLabels(text).join(', ').replace(/\s+text$/i, '')
      out.push(slot({ label, key: cleanLabel(label), path: [...path, label], kind: 'rich', placeholder: text, doc, target: { type: 'placeholder', at: here, length: 1 } }))
      continue
    }
    if (block.kind === 'infobox') {
      ;(block.rows as AnyBlock[]).forEach((row, r) => out.push(...slotsForProperty(row, [...here, r], [...path, 'Infobox'], doc).map(withId)))
      continue
    }
    if (block.kind === 'keyValue' || block.kind === 'textField' || block.kind === 'image' || block.kind === 'resourceLink' || block.kind === 'resourceCollection') {
      out.push(...slotsForProperty(block, here, path, doc).map(withId))
      continue
    }
    if (TRANSPARENT.has(block.kind) && Array.isArray(block.children)) walkSiblings(block.children as AnyBlock[], here, path, doc, out)
  }
}

/** Slots in a property-capable block: in the page, in an infobox, or in the sidebar. */
function slotsForProperty(block: AnyBlock, at: number[], path: string[], doc: number): NewSlot[] {
  const title = typeof block.title === 'string' ? block.title : ''
  const named = title && !isWeakLabel(title) ? [...path, title] : path
  if (block.kind === 'keyValue') {
    return (block.rows as { key: string; text?: string; content?: Run[]; id?: string }[]).map((row, r) => {
      const label = row.key.trim().replace(/:$/, '')
      return { label, key: cleanLabel(label), path: [...named, label].join(' › '), kind: 'text' as const, placeholder: row.text ?? runsText(row.content), doc, rowId: row.id, target: { type: 'row' as const, at, row: r } }
    })
  }
  if (block.kind === 'textField') {
    const children = (block.children ?? []) as AnyBlock[]
    // A field holding only a heading is a caption ("Core [Class] Traits"), unless it names the page.
    if (children.length > 0 && children.every((c) => c.kind === 'heading')) {
      const text = children.map(blockText).join(' ')
      return text.includes('[') && namesPage(text)
        ? [{ label: 'Name', key: '', path: [...path, text].join(' › '), kind: 'name' as const, placeholder: text, doc, target: { type: 'name' as const, at: [...at, 0] } }]
        : []
    }
    const placeholder = children.map(blockText).join('\n').trim()
    // "(For the above Tag Index tag the [Class] name…, then remove this text box)": a note to whoever
    // fills the page, not a field. A placeholder is mostly brackets.
    if (isWeakLabel(title) && placeholder.includes('[') && !isPlaceholderText(placeholder) && placeholder.replace(/\[[^\]]*\]?/g, ' ').trim().split(/\s+/).length >= 5) return []
    let label = title
    if (isWeakLabel(title)) {
      // "[Size, e.g. Small] [Creature Type…]" or "Description text": the placeholder names it.
      const fromBrackets = placeholderLabels(placeholder).join(', ')
      label = fromBrackets || (placeholder.length <= 40 ? placeholder.replace(/\s+text$/i, '') : '') || title || 'Text'
    }
    return [{ label, key: isWeakLabel(title) && !label ? '' : cleanLabel(label), path: [...path, label].join(' › '), kind: 'rich' as const, placeholder, doc, target: { type: 'field' as const, at }, ...(isWeakLabel(title) ? {} : { titled: true }), ...tableOf(children) }]
  }
  if (block.kind === 'image') {
    const label = title && !isWeakLabel(title) ? title : 'Image'
    return [{ label, key: cleanLabel(label), path: [...path, label].join(' › '), kind: 'image' as const, placeholder: String(block.url ?? ''), doc, target: { type: 'image' as const, at } }]
  }
  // A collection that picks pages by a filter (a Source's Backlinks) fills itself: only one whose
  // pages are picked by hand takes the clip's links.
  if (block.kind === 'resourceLink' || (block.kind === 'resourceCollection' && !block.filter)) {
    const fallback = block.kind === 'resourceLink' ? 'Links' : 'Collection'
    const label = title && !isWeakLabel(title) ? title : fallback
    const items = (block.items ?? []) as unknown[]
    return [{ label, key: title && !isWeakLabel(title) ? cleanLabel(title) : '', path: [...path, label].join(' › '), kind: 'links' as const, placeholder: items.length ? `${items.length} linked page${items.length === 1 ? '' : 's'}` : '', doc, target: { type: 'links' as const, at } }]
  }
  return []
}

/** The pages mentioned in blocks or runs, in order, each once: what a links slot takes. */
export function mentionsIn(value: Block[] | Run[]): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const mention = (node as { mention?: { resourceId?: string } }).mention
    if (mention?.resourceId) {
      if (!out.includes(mention.resourceId)) out.push(mention.resourceId)
      return
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child)
  }
  walk(value)
  return out
}

/** The column headings of the first table in a slot's placeholder, as { table } to spread into the slot. */
function tableOf(blocks: AnyBlock[]): { table?: string[] } {
  const table = blocks.find((b) => b.kind === 'table')
  const first = (table?.children as AnyBlock[] | undefined)?.[0]
  const headers = ((first?.children ?? []) as AnyBlock[]).map((cell) => blockText(cell).trim()).filter(Boolean)
  return headers.length >= 2 ? { table: headers } : {}
}

function slot(fields: Omit<NewSlot, 'path'> & { path: string[] }): Slot {
  return { ...fields, id: '', path: fields.path.join(' › ') }
}

function withId(fields: NewSlot): Slot {
  return { ...fields, id: '' }
}

function countWhile(blocks: AnyBlock[], from: number, test: (block: AnyBlock) => boolean): number {
  let n = 0
  while (from + n < blocks.length && test(blocks[from + n]!)) n++
  return n
}

// ------------------------------------------------------------------------------------ filling

/** What goes into a slot. `remove` deletes the slot (and its row, field or section) from the page. */
export type SlotFill =
  /** A row's value; `extraRows` are added at the end of the row's list (rows the template lacks). */
  | { runs: Run[]; extraRows?: { key: string; content: Run[] }[] }
  | { blocks: Block[] }
  | { image: { url: string; alt?: string } }
  /** The pages a links block or collection lists. */
  | { links: string[] }
  | { remove: true }

/** Operations on sidebar properties, which are written with their own API calls. */
export type PropertyOp =
  | { op: 'updateRow'; propertyId: string; rowId: string; content: Run[] }
  | { op: 'deleteRow'; propertyId: string; rowId: string }
  | { op: 'update'; propertyId: string; patch: Record<string, unknown> }
  | { op: 'delete'; propertyId: string }

export interface FilledTree {
  /** Each page tab's new blocks, in the order of tree.docs. */
  docs: Block[][]
  properties: PropertyOp[]
}

type Edit =
  | { type: 'rows'; rows: Map<number, Run[] | 'remove'>; extra?: { key: string; content: Run[] }[] }
  | { type: 'children'; children: Block[] }
  | { type: 'remove' }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'content'; content: Run[] }
  | { type: 'links'; items: { resourceId: string }[] }
  /** Replace this block and the `length` siblings after it with `blocks`. */
  | { type: 'span'; length: number; blocks: Block[] }

/**
 * Writes values into a tree. `fills` is keyed by slot id; slots not in it are left as they are.
 * The tree is not changed; new block arrays are returned.
 */
export function fillTree(tree: TemplateTree, slots: Slot[], fills: Map<string, SlotFill>): FilledTree {
  const edits: Map<string, Edit>[] = tree.docs.map(() => new Map())
  const properties: PropertyOp[] = []
  for (const slot of slots) {
    const fill = fills.get(slot.id)
    if (!fill) continue
    if (slot.doc === SIDEBAR) {
      const op = propertyOp(slot, fill)
      if (op) properties.push(op)
      continue
    }
    const docEdits = edits[slot.doc]!
    const key = slot.target.at.join('.')
    const t = slot.target
    const doc = tree.docs[slot.doc]!.blocks as AnyBlock[]
    if (t.type === 'row') {
      const edit: Extract<Edit, { type: 'rows' }> = (docEdits.get(key) as Extract<Edit, { type: 'rows' }> | undefined) ?? { type: 'rows', rows: new Map() }
      edit.rows.set(t.row, 'remove' in fill ? 'remove' : 'runs' in fill ? fill.runs : 'blocks' in fill ? blocksToRuns(fill.blocks) : [])
      if ('runs' in fill && fill.extraRows?.length) edit.extra = [...(edit.extra ?? []), ...fill.extraRows]
      docEdits.set(key, edit)
    } else if (t.type === 'field') {
      docEdits.set(key, 'remove' in fill ? { type: 'remove' } : { type: 'children', children: fillBlocks(fill) })
    } else if (t.type === 'image') {
      if ('remove' in fill) docEdits.set(key, { type: 'remove' })
      else if ('image' in fill) docEdits.set(key, { type: 'image', ...fill.image })
    } else if (t.type === 'name') {
      if ('remove' in fill) docEdits.set(key, { type: 'remove' })
      else docEdits.set(key, { type: 'content', content: 'runs' in fill ? fill.runs : blocksToRuns(fillBlocks(fill)) })
    } else if (t.type === 'section') {
      const heading = at(doc, t.at)
      if ('remove' in fill) docEdits.set(key, { type: 'span', length: t.length, blocks: [] })
      else docEdits.set(key, { type: 'span', length: t.length, blocks: [heading as Block, ...belowLevel(fillBlocks(fill), t.level)] })
    } else if (t.type === 'placeholder') {
      const original = at(doc, t.at)
      const blocks = 'remove' in fill ? [] : fillBlocks(fill)
      // A quote placeholder stays a quote.
      const value = original.kind === 'quote' && blocks.length > 0 ? [{ ...original, children: blocks } as Block] : blocks
      docEdits.set(key, { type: 'span', length: t.length - 1, blocks: value })
    } else if (t.type === 'links') {
      if ('remove' in fill) docEdits.set(key, { type: 'remove' })
      else if ('links' in fill) docEdits.set(key, { type: 'links', items: fill.links.map((resourceId) => ({ resourceId })) })
    } else if (t.type === 'source') {
      // A source fill is the heading followed by any blocks to put under it.
      docEdits.set(key, { type: 'span', length: t.length, blocks: 'remove' in fill ? [] : fillBlocks(fill) })
    }
  }
  return { docs: tree.docs.map((doc, i) => rebuild(doc.blocks as AnyBlock[], '', edits[i]!) as Block[]), properties }
}

function propertyOp(slot: Slot, fill: SlotFill): PropertyOp | undefined {
  const propertyId = slot.propertyId
  if (!propertyId) return undefined
  if (slot.target.type === 'row') {
    if (!slot.rowId) return undefined
    if ('remove' in fill) return { op: 'deleteRow', propertyId, rowId: slot.rowId }
    return { op: 'updateRow', propertyId, rowId: slot.rowId, content: 'runs' in fill ? fill.runs : 'blocks' in fill ? blocksToRuns(fill.blocks) : [] }
  }
  if ('remove' in fill) return { op: 'delete', propertyId }
  if (slot.target.type === 'field') return { op: 'update', propertyId, patch: { children: fillBlocks(fill) } }
  if (slot.target.type === 'image' && 'image' in fill) return { op: 'update', propertyId, patch: { url: fill.image.url, ...(fill.image.alt ? { alt: fill.image.alt } : {}) } }
  if (slot.target.type === 'links' && 'links' in fill) return { op: 'update', propertyId, patch: { items: fill.links.map((resourceId) => ({ resourceId })) } }
  return undefined
}

function fillBlocks(fill: SlotFill): Block[] {
  if ('blocks' in fill) return fill.blocks
  if ('runs' in fill) return [{ kind: 'paragraph', content: fill.runs }]
  return []
}

/** Joins paragraphs into one line of runs, with line breaks between them, for a key-value row. */
export function blocksToRuns(blocks: Block[]): Run[] {
  const out: Run[] = []
  const add = (block: AnyBlock) => {
    if (Array.isArray(block.content)) {
      if (out.length) out.push({ break: true })
      out.push(...(block.content as Run[]))
    } else for (const child of childrenOf(block) ?? []) add(child)
  }
  for (const block of blocks) add(block as AnyBlock)
  return out
}

/** Moves headings in a section's new content below the section's own heading. */
function belowLevel(blocks: Block[], level: number): Block[] {
  let min = 7
  for (const block of blocks) if (block.kind === 'heading') min = Math.min(min, block.level)
  if (min > level) return blocks
  const delta = level + 1 - min
  return blocks.map((block) => (block.kind === 'heading' ? { ...block, level: Math.min(6, block.level + delta) as typeof block.level } : block))
}

function at(blocks: AnyBlock[], pointer: number[]): AnyBlock {
  let list = blocks
  let block: AnyBlock | undefined
  for (const i of pointer) {
    block = list[i]
    if (!block) throw new Error(`No block at ${pointer.join('.')}`)
    list = childrenOf(block) ?? []
  }
  return block!
}

function rebuild(blocks: AnyBlock[], prefix: string, edits: Map<string, Edit>): AnyBlock[] {
  const out: AnyBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const key = prefix ? `${prefix}.${i}` : String(i)
    const edit = edits.get(key)
    if (edit?.type === 'span') {
      out.push(...(edit.blocks as AnyBlock[]))
      i += edit.length
      continue
    }
    if (edit?.type === 'remove') continue
    let block = blocks[i]!
    if (edit?.type === 'rows') {
      const rows = (block.rows as AnyBlock[]).flatMap((row, r) => {
        const value = edit.rows.get(r)
        if (value === undefined) return [row]
        if (value === 'remove') return []
        const { text: _text, ...rest } = row
        return [{ ...rest, content: value }]
      })
      rows.push(...(edit.extra ?? []).map((row) => ({ key: row.key, content: row.content }) as unknown as AnyBlock))
      if (rows.length === 0) continue
      block = { ...block, rows }
    } else if (edit?.type === 'children') block = { ...block, children: edit.children }
    else if (edit?.type === 'image') block = { ...block, url: edit.url, ...(edit.alt ? { alt: edit.alt } : {}) }
    else if (edit?.type === 'content') block = { ...block, content: edit.content }
    else if (edit?.type === 'links') block = { ...block, items: edit.items }

    if (block.kind === 'infobox') {
      const rows = rebuild(block.rows as AnyBlock[], key, edits)
      if (rows.length === 0) continue
      block = { ...block, rows }
    } else if (Array.isArray(block.children) && edit?.type !== 'children') {
      let children = rebuild(block.children as AnyBlock[], key, edits)
      // Some containers must keep a child: a column, a secret, a quote.
      if (children.length === 0 && (block.children as AnyBlock[]).length > 0) {
        if (block.kind === 'textField') continue
        children = [{ kind: 'paragraph', content: [] }]
      }
      block = { ...block, children }
    }
    out.push(block)
  }
  return out
}

/**
 * Makes template blocks fit to add to another page: no ids or ranks (the page gives new ones), and
 * no blocks the API can't create (an unsupported block can only be kept, never copied).
 */
export function forCopy(blocks: Block[]): Block[] {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !(item && typeof item === 'object' && (item as AnyBlock).kind === 'unsupported')).map(strip)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id' && k !== 'rank' && k !== 'version').map(([k, v]) => [k, strip(v)]))
    }
    return value
  }
  const copied = strip(blocks) as AnyBlock[]
  // An infobox left with no rows (all were unsupported) would be an empty box.
  return copied.filter((block) => !(block.kind === 'infobox' && (block.rows as AnyBlock[]).length === 0)) as Block[]
}
