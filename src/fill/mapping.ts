import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { leftoverEntries, overlaps, splitRuns, type Candidate } from './candidates.js'
import { cleanLabel, compareLabels, Synonyms } from './labels.js'
import { valueFor, type FillPlan, type SavedRule, type SlotOrigin, type SlotState } from './plan.js'
import { blockText, blocksToRuns, mentionsIn, runsText, withNames, type AnyBlock, type Slot, type SlotFill } from './template.js'

/**
 * The mapper: the clip as cards, and which cards go in which slot of the template.
 *
 * Label matching (with saved rules, and later the AI) makes a fill plan as before. The mapper turns
 * that plan into a base (cards and slots, plain data that can go through chrome.storage) and a
 * mapping (slot id → card ids, also plain data). Every change the user makes is a new mapping.
 *
 * A slot the user never touches keeps exactly what the plan put there, so with nothing moved the
 * page is the same as without the mapper. A slot the user changed is built from its cards.
 */

/**
 * - pair: a label and its value ("Armor Class 15")
 * - section: a heading or label line; it carries the cards under it, and its own heading isn't written
 * - block: one block of the clip (a paragraph, list, table…)
 * - image: an image
 * - virtual: a value the plan made that is not one card of the clip (an AI answer, a worked-out value)
 * - typed: a value typed into a slot
 * - piece: part of a card's text, split off by selecting it
 */
export type CardKind = 'pair' | 'section' | 'block' | 'image' | 'virtual' | 'typed' | 'piece'

export interface Card {
  id: string
  kind: CardKind
  /** The clip's label for it ("Armor Class", "Traits"); empty for prose, which can't become a rule. */
  label: string
  key: string
  /** Plain text, for showing. */
  text: string
  /** The text a selection is measured against, for cards that can be split. */
  cutText?: string
  /** A pair's value, or a paragraph's content. */
  runs?: Run[]
  /** What the card writes. */
  blocks: Block[]
  /** The parts of the clip it uses (see Candidate.units). */
  units: string[]
  /** Its position in the clip, for ordering. */
  order: number
  /** How deep it sits under sections and tables, for indenting. */
  depth: number
  /** Shown in the clip column (a section's heading block is shown as the section's card instead). */
  listed: boolean
  /** A section's cards. */
  body?: string[]
  /** A section heading's level, so its sub-headings keep their depth under the template's heading. */
  level?: number
  /** A block card's kind ("paragraph", "table"…). */
  blockKind?: string
  /** The pages it links to. */
  mentions: string[]
  /** The plan's candidate, for pairs and virtual cards, so they write exactly what the plan would. */
  candidate?: Candidate
  /** A piece: the card it was cut from, and its span of that card's text. */
  of?: string
  from?: number
  to?: number
  /** A piece's runs before trimming, so neighbouring pieces join back exactly. */
  raw?: Run[]
}

/** A slot and what the plan found for it. */
export interface BaseSlot {
  slot: Slot
  status: SlotState['status']
  origin?: SlotOrigin
  text: string
  warning?: string
  note?: string
  /** The plan's value, used while the slot is untouched. */
  fill?: SlotFill
  /** The parts of the clip the plan's value uses. */
  units: string[]
  /** The plan's value as cards. */
  cards: string[]
  /** For a tie: the competing cards. */
  contenders: string[]
  /** An AI answer left unticked (made up, or at odds with the clip), offered to use anyway. */
  ghost?: string
}

/** Everything the mapper works from: plain data, so it can be handed to the mapper tab. */
export interface MapBase {
  /** Which clip, template and destination this is for. */
  key: string
  clip: Block[]
  cards: Card[]
  slots: BaseSlot[]
  split: [number, { runs: Run[]; segments: { from: number; to: number; unit: string }[] }][]
  captions: [number, number][]
  titleBlocks: number[]
  /** The plan's unused content, used while nothing is touched. */
  leftovers: Block[]
  subject?: { placeholder: string; name: string }
  /** Page names for mentions. */
  names: Record<string, string>
  synonyms: string[][]
}

/** The user's mapping. Plain data: an AI step can produce one too. */
export interface Mapping {
  /** Slot id → card ids, in order. */
  slots: Record<string, string[]>
  /** Where each placed card came from, by card id: the badge it shows. */
  origins: Record<string, SlotOrigin>
  /** Typed values, by card id ("typed:<slot id>"). */
  typed: Record<string, string>
  /** Where cards were cut by selecting part of their text: card id → offsets in its text. */
  cuts: Record<string, number[]>
  /** Slots whose manual choice should be saved as a rule for the site. */
  remember: Record<string, boolean>
  /** Slots the user changed; the others keep the plan's value. */
  touched: string[]
}

export const FILLABLE = new Set(['text', 'rich', 'image', 'links'])
/** The longest value a one-line slot takes. */
export const SHORT_CHARS = 300

// ------------------------------------------------------------------------------------- base

export function buildMapBase(plan: FillPlan, clip: Block[], context: { key: string; names?: Record<string, string>; synonyms: string[][]; title?: string }): MapBase {
  const names = context.names ?? {}
  return withNames((id) => names[id], () => {
    const cards: Card[] = []
    const byId = new Map<string, Card>()
    const add = (card: Card) => {
      cards.push(card)
      byId.set(card.id, card)
      return card
    }
    const title = new Set(plan.titleBlocks)
    const isTitle = (units: string[]) => units.some((u) => title.has(blockOf(u) ?? -1))

    // 1. Labelled values and images. Overlapping candidates ("STR" as a pair and as a section) give one card.
    //    A bold page name starting a paragraph ("**Aurelion** is the god of…") is prose, not a label.
    const titleKey = cleanLabel(context.title ?? '')
    const pairs: Candidate[] = []
    for (const c of plan.extraction.candidates) {
      if (c.kind === 'section' || c.entry || isTitle(c.units) || (titleKey && c.kind === 'pair' && c.key === titleKey)) continue
      // An image inside a table has no part of its own; it is still a card.
      if (c.units.length === 0 && c.kind !== 'image') continue
      if (pairs.some((p) => overlaps(p.units, c.units))) continue
      pairs.push(c)
    }
    for (const c of pairs) {
      add({
        id: c.id, kind: c.kind === 'image' ? 'image' : 'pair', label: c.kind === 'image' ? '' : c.label, key: c.kind === 'image' ? '' : c.key,
        text: c.kind === 'image' ? imageText(c.blocks[0]) : c.text, ...(c.runs ? { runs: c.runs, cutText: runsText(c.runs) } : {}),
        blocks: c.blocks, units: c.units, order: orderOf(c.units[0]!), depth: 0, listed: true, mentions: mentionsIn(c.runs ?? c.blocks), candidate: c,
      })
    }

    // 2. Every top-level block. One covered by a labelled value, or split into labelled parts, is
    //    shown as those cards; a table is shown whole, with its labelled rows under it.
    clip.forEach((block, i) => {
      const unit = `b${i}`
      const covering = pairs.filter((p) => overlaps(p.units, [unit]))
      const hidden = title.has(i) || covering.some((p) => p.units.includes(unit)) || (block.kind !== 'table' && covering.length > 0)
      const runs = block.kind === 'paragraph' ? block.content : undefined
      add({
        id: unit, kind: block.kind === 'image' ? 'image' : 'block', label: '', key: '', text: block.kind === 'image' ? imageText(block) : blockText(block as AnyBlock),
        ...(runs ? { runs, cutText: runsText(runs) } : {}), blocks: [block], units: [unit], order: i * 1000, depth: 0, listed: !hidden, blockKind: block.kind, mentions: mentionsIn([block]),
      })
    })

    /** The cards for the parts of the clip a section holds. */
    const cardsFor = (units: string[]): string[] => {
      const out: string[] = []
      for (const unit of units) {
        const atom = /^b\d+$/.test(unit) ? byId.get(unit) : undefined
        const parts = pairs.filter((p) => overlaps(p.units, [unit]))
        const ids = atom && (atom.listed || atom.blockKind === 'heading' || parts.length === 0) ? [atom.id] : parts.map((p) => p.id)
        for (const id of ids) if (!out.includes(id) && !title.has(blockOf(id) ?? -1)) out.push(id)
      }
      return out
    }

    // 3. Sections: a heading or label line with the cards under it. Its heading block is shown as this card.
    const sections: { card: Card; held: string[] }[] = []
    for (const c of plan.extraction.candidates) {
      if (c.kind !== 'section' || c.entry || c.units.length !== c.blocks.length + 1) continue
      const head = c.units[0]!
      if (isTitle([head]) || pairs.some((p) => overlaps(p.units, [head])) || sections.some((s) => s.card.units[0] === head)) continue
      const card = add({
        id: `sec:${c.id}`, kind: 'section', label: c.label, key: c.key, text: c.text, blocks: [], units: [head], order: orderOf(head), depth: 0, listed: true,
        body: cardsFor(c.units.slice(1)), ...(c.level !== undefined ? { level: c.level } : {}), mentions: mentionsIn(c.blocks), candidate: c,
      })
      const atom = byId.get(head)
      if (atom) atom.listed = false
      sections.push({ card, held: c.units.slice(1) })
    }
    for (const card of cards) {
      const inSections = sections.filter((s) => s.card !== card && card.units.length > 0 && overlaps(s.held, card.units)).length
      const inTable = /^b\d+\.[rc]\d+$/.test(card.units[0] ?? '') ? 1 : 0
      card.depth = Math.min(3, inSections + inTable)
    }

    // 4. Slots, with the plan's value as cards when it is exactly those cards, or as one virtual card.
    const sameBlocks = (ids: string[], blocks: Block[]) => JSON.stringify(ids.flatMap((id) => byId.get(id)?.blocks ?? [])) === JSON.stringify(blocks)
    const asCards = (c: Candidate, slotId: string, suffix = ''): string[] => {
      if (byId.get(c.id)?.candidate === c) return [c.id]
      if (c.kind === 'section' && c.units.length === c.blocks.length + 1) {
        const section = sections.find((s) => s.card.units[0] === c.units[0])
        const body = cardsFor(c.units.slice(1))
        if (section && sameBlocks(body, c.blocks)) return [section.card.id, ...body]
      }
      if (c.units.length > 0 && c.units.every((u) => /^b\d+$/.test(u) && byId.has(u)) && sameBlocks(c.units, c.blocks)) return [...c.units]
      const id = `v:${slotId}${suffix}`
      add({
        id, kind: 'virtual', label: c.label, key: c.label === 'AI' ? '' : c.key, text: c.kind === 'image' ? imageText(c.blocks[0]) : c.text,
        ...(c.runs ? { runs: c.runs } : {}), blocks: c.blocks, units: c.units, order: c.units[0] ? orderOf(c.units[0]) : Infinity, depth: 0, listed: false, mentions: mentionsIn(c.runs ?? c.blocks), candidate: c,
      })
      return [id]
    }
    const slots: BaseSlot[] = plan.slots.map((state) => {
      const id = state.slot.id
      const fill = plan.fills.get(id)
      const base: BaseSlot = {
        slot: state.slot, status: state.status, text: state.text, units: state.units ?? [], cards: [], contenders: [],
        ...(state.origin ? { origin: state.origin } : {}), ...(state.warning ? { warning: state.warning } : {}), ...(state.note ? { note: state.note } : {}), ...(fill ? { fill } : {}),
      }
      if (!FILLABLE.has(state.slot.kind)) return base
      if (state.status === 'filled' && state.candidate) base.cards = asCards(state.candidate, id)
      if (state.status === 'off' && state.candidate) base.ghost = asCards(state.candidate, id, ':ghost')[0]
      if (state.status === 'ambiguous') {
        base.contenders = state.contenders.map((c, k) => {
          const section = c.kind === 'section' ? sections.find((s) => s.card.units[0] === c.units[0]) : undefined
          return section ? section.card.id : byId.get(c.id)?.candidate === c ? c.id : asCards(c, id, `:tie${k}`)[0]!
        })
      }
      return base
    })

    return {
      key: context.key, clip, cards, slots, split: [...plan.extraction.split], captions: [...plan.extraction.captions], titleBlocks: plan.titleBlocks,
      leftovers: plan.leftovers, ...(plan.subject ? { subject: plan.subject } : {}), names, synonyms: context.synonyms,
    }
  })
}

export function initialMapping(base: MapBase): Mapping {
  const mapping: Mapping = { slots: {}, origins: {}, typed: {}, cuts: {}, remember: {}, touched: [] }
  for (const b of base.slots) {
    if (!FILLABLE.has(b.slot.kind)) continue
    mapping.slots[b.slot.id] = b.status === 'filled' ? [...b.cards] : []
    if (b.status === 'filled' && b.origin) for (const id of b.cards) mapping.origins[id] = b.origin
  }
  return mapping
}

// ------------------------------------------------------------------------------------ cards

/** Every card: the base's, typed values, and the pieces of cut cards (which replace the card cut). */
export function cardIndex(base: MapBase, mapping: Mapping): Map<string, Card> {
  return withNames((id) => base.names[id], () => {
    const out = new Map(base.cards.map((c) => [c.id, c]))
    for (const [id, text] of Object.entries(mapping.typed)) {
      out.set(id, { id, kind: 'typed', label: '', key: '', text, runs: [{ text }], blocks: paragraphs(text), units: [], order: Infinity, depth: 0, listed: false, mentions: [] })
    }
    for (const [id, offsets] of Object.entries(mapping.cuts)) {
      const card = out.get(id)
      if (!card?.runs) continue
      out.set(id, { ...card, listed: false })
      for (const piece of piecesOf(card, offsets)) out.set(piece.id, piece)
    }
    return out
  })
}

function piecesOf(card: Card, offsets: number[]): Card[] {
  const length = runsText(card.runs!).length
  const points = [0, ...offsets.filter((o) => o > 0 && o < length).sort((a, b) => a - b), length].filter((o, i, all) => all.indexOf(o) === i)
  const out: Card[] = []
  for (let k = 0; k + 1 < points.length; k++) {
    const from = points[k]!
    const to = points[k + 1]!
    const raw = sliceRuns(card.runs!, from, to)
    const runs = trimRuns(raw)
    out.push({
      id: `${card.id}~${from}`, kind: 'piece', label: '', key: '', text: runsText(runs), runs, cutText: runsText(sliceRuns(card.runs!, from, to)),
      blocks: [{ kind: 'paragraph', content: runs }], units: [], order: card.order + (k + 1) / 100, depth: card.depth, listed: card.listed && runsText(runs).trim() !== '',
      mentions: mentionsIn(runs), of: card.id, from, to, raw,
    })
  }
  return out
}

/** Whether a slot can take a card: images in image slots, short values in one-line slots, anything in a section. */
export function accepts(slot: Slot, card: Card): boolean {
  const image = isImage(card)
  switch (slot.kind) {
    case 'image':
      return image
    case 'links':
      return !image && card.mentions.length > 0
    case 'text':
      if (image) return false
      // A short section, like label matching allows: a few short paragraphs.
      if (card.kind === 'section') return !!card.candidate && card.candidate.text.length <= 200 && card.candidate.blocks.length <= 3 && card.candidate.blocks.every((b) => b.kind === 'paragraph')
      if (card.kind === 'block') return ['paragraph', 'heading', 'quote'].includes(card.blockKind ?? '') && card.text.length <= SHORT_CHARS
      return card.text.length <= SHORT_CHARS || card.kind === 'typed' || card.kind === 'virtual'
    case 'rich':
      return true
    default:
      return false
  }
}

export function isImage(card: Card): boolean {
  return card.kind === 'image' || (card.kind === 'virtual' && card.candidate?.kind === 'image')
}

// ------------------------------------------------------------------------------- operations

/** The slot's current cards: the user's list, or the plan's while untouched. */
export function listOf(mapping: Mapping, slotId: string): string[] {
  return mapping.slots[slotId] ?? []
}

/** Puts a card in a slot (before `before`, or at the end). A section brings the cards under it that are free. */
export function place(base: MapBase, mapping: Mapping, cardId: string, slotId: string, before?: string): Mapping {
  const cards = cardIndex(base, mapping)
  const card = cards.get(cardId)
  const target = base.slots.find((s) => s.slot.id === slotId)
  if (!card || !target || !FILLABLE.has(target.slot.kind) || !accepts(target.slot, card)) return mapping
  const m = copy(mapping)
  const moving = [cardId]
  if (card.kind === 'section') {
    const from = holder(m, cardId)
    const usage = slotUsage(base, m, cards)
    for (const id of card.body ?? []) {
      const at = holder(m, id)
      const body = cards.get(id)
      const elsewhere = [...usage.values()].some((units) => body && body.units.length > 0 && overlaps(units, body.units))
      if ((from && at === from) || (!at && !elsewhere)) moving.push(id)
    }
  }
  for (const id of moving) release(base, m, cards, id)
  const single = target.slot.kind === 'text' || target.slot.kind === 'image'
  if (single) {
    for (const id of listOf(m, slotId)) delete m.origins[id]
    m.slots[slotId] = moving.filter((id) => accepts(target.slot, cards.get(id)!))
  } else {
    const list = listOf(m, slotId).filter((id) => !moving.includes(id))
    const at = before && list.includes(before) ? list.indexOf(before) : list.length
    list.splice(at, 0, ...moving)
    m.slots[slotId] = list
  }
  for (const id of moving) m.origins[id] = 'manual'
  delete m.remember[slotId]
  touch(m, slotId)
  return m
}

/** Takes a card out of its slot, back to the unused content. A section takes the cards under it along. */
export function unplace(base: MapBase, mapping: Mapping, cardId: string): Mapping {
  const cards = cardIndex(base, mapping)
  const card = cards.get(cardId)
  if (!card) return mapping
  const m = copy(mapping)
  const from = holder(m, cardId)
  const ids = [cardId, ...(card.kind === 'section' && from ? (card.body ?? []).filter((id) => holder(m, id) === from) : [])]
  for (const id of ids) {
    release(base, m, cards, id)
    delete m.origins[id]
  }
  return m
}

/** Empties a slot: its cards go back to the unused content. */
export function clearSlot(mapping: Mapping, slotId: string): Mapping {
  const m = copy(mapping)
  for (const id of listOf(m, slotId)) delete m.origins[id]
  delete m.typed[`typed:${slotId}`]
  delete m.remember[slotId]
  m.slots[slotId] = []
  touch(m, slotId)
  return m
}

/** Puts a typed value in a slot. */
export function typeValue(mapping: Mapping, slotId: string, text: string): Mapping {
  if (!text.trim()) return clearSlot(mapping, slotId)
  const m = clearSlot(mapping, slotId)
  const id = `typed:${slotId}`
  m.typed[id] = text.trim()
  m.slots[slotId] = [id]
  m.origins[id] = 'typed'
  return m
}

/**
 * Splits the text `from`–`to` of a card off as a card of its own. The rest of the card stays as
 * pieces where the card was, so nothing is lost. Returns the new card's id, or undefined when the
 * card can't be split (it isn't text, or it sits inside another slot's value: move it out first).
 */
export function cut(base: MapBase, mapping: Mapping, cardId: string, from: number, to: number): { mapping: Mapping; piece?: string } {
  const cards = cardIndex(base, mapping)
  const card = cards.get(cardId)
  const originalId = card?.of ?? cardId
  const original = base.cards.find((c) => c.id === originalId)
  if (!card || !original?.runs || from >= to) return { mapping }
  const offset = card.from ?? 0
  const start = offset + Math.max(0, from)
  const end = offset + Math.min(to, card.cutText?.length ?? to)
  if (start >= end) return { mapping }
  if (!holder(mapping, cardId) && [...slotUsage(base, mapping, cards).values()].some((units) => original.units.length > 0 && overlaps(units, original.units))) return { mapping }
  const m = copy(mapping)
  m.cuts[originalId] = [...new Set([...(m.cuts[originalId] ?? []), start, end])].sort((a, b) => a - b)
  const after = cardIndex(base, m)
  // Where the card cut was placed, its pieces go instead.
  const replacement = [...after.values()].filter((c) => c.of === originalId && c.from! >= offset && c.to! <= (card.to ?? Infinity)).sort((a, b) => a.from! - b.from!).map((c) => c.id)
  for (const [slotId, list] of Object.entries(m.slots)) {
    const at = list.indexOf(cardId)
    if (at < 0) continue
    const origin = m.origins[cardId]
    m.slots[slotId] = [...list.slice(0, at), ...replacement, ...list.slice(at + 1)]
    for (const id of replacement) if (origin) m.origins[id] = origin
    touch(m, slotId)
  }
  delete m.origins[cardId]
  return { mapping: m, piece: `${originalId}~${start}` }
}

/** Uses an AI answer the plan left unticked. */
export function useGhost(base: MapBase, mapping: Mapping, slotId: string): Mapping {
  const b = base.slots.find((s) => s.slot.id === slotId)
  if (!b?.ghost) return mapping
  const m = place(base, mapping, b.ghost, slotId)
  if (m !== mapping && b.origin) m.origins[b.ghost] = b.origin
  return m
}

export function setRemember(mapping: Mapping, slotId: string, remember: boolean): Mapping {
  const m = copy(mapping)
  if (remember) m.remember[slotId] = true
  else delete m.remember[slotId]
  return m
}

/** Whether a slot's value can be saved as a rule: you put a labelled clip value there yourself. */
export function canRemember(base: MapBase, mapping: Mapping, slotId: string): boolean {
  const b = base.slots.find((s) => s.slot.id === slotId)
  const first = listOf(mapping, slotId)[0]
  if (!b?.slot.key || !first || !mapping.touched.includes(slotId) || mapping.origins[first] !== 'manual') return false
  const card = base.cards.find((c) => c.id === first)
  return !!card?.key && (card.kind === 'pair' || card.kind === 'section')
}

/** Rules to save: manual placements of labelled values that the user asked to remember. */
export function rulesFromMapping(base: MapBase, mapping: Mapping, context: { site: string; templateId: string; templateName: string }): SavedRule[] {
  const out: SavedRule[] = []
  for (const [slotId, on] of Object.entries(mapping.remember)) {
    if (!on || !context.site || !canRemember(base, mapping, slotId)) continue
    const slot = base.slots.find((s) => s.slot.id === slotId)!.slot
    const card = base.cards.find((c) => c.id === listOf(mapping, slotId)[0])!
    out.push({ ...context, slotKey: slot.key, slotLabel: slot.label, candidateKey: card.key, candidateLabel: card.label })
  }
  return out
}

/**
 * Keeps the user's changes when the plan is made again (the page list refreshed, the AI answered,
 * the page name changed): touched slots keep their cards, which the other slots give up.
 */
export function carryOver(previous: Mapping, base: MapBase): Mapping {
  let m = initialMapping(base)
  const known = new Set(base.cards.map((c) => c.id))
  m.typed = Object.fromEntries(Object.entries(previous.typed).filter(([id]) => base.slots.some((s) => `typed:${s.slot.id}` === id)))
  m.cuts = Object.fromEntries(Object.entries(previous.cuts).filter(([id]) => base.cards.find((c) => c.id === id)?.runs))
  let cards = cardIndex(base, m)
  // A cut card placed by the plan is replaced by its pieces.
  for (const [slotId, list] of Object.entries(m.slots)) {
    if (!list.some((id) => m.cuts[id])) continue
    m.slots[slotId] = list.flatMap((id) => (m.cuts[id] ? [...cards.values()].filter((c) => c.of === id).map((c) => c.id) : [id]))
    touch(m, slotId)
  }
  for (const slotId of previous.touched) {
    const b = base.slots.find((s) => s.slot.id === slotId)
    if (!b || !FILLABLE.has(b.slot.kind)) continue
    const list = listOf(previous, slotId).filter((id) => cards.has(id) && (known.has(id) || id.startsWith('typed:') || id.includes('~')))
    for (const id of list) release(base, m, cards, id)
    m.slots[slotId] = list
    for (const id of list) m.origins[id] = previous.origins[id] ?? 'manual'
    if (previous.remember[slotId]) m.remember[slotId] = true
    touch(m, slotId)
    cards = cardIndex(base, m)
  }
  return m
}

// ---------------------------------------------------------------------------------- result

export interface MappedSlot {
  slot: Slot
  status: SlotState['status']
  origin?: SlotOrigin
  text: string
  touched: boolean
  /** The cards shown in the slot. */
  cards: string[]
}

export interface MapResult {
  slots: MappedSlot[]
  fills: Map<string, SlotFill>
  leftovers: Block[]
  subject?: { placeholder: string; name: string }
  /** The parts of the clip each filled slot uses. */
  usage: Map<string, string[]>
}

/** What the mapping writes: each slot's value and the unused content, ready for compose(). */
export function applyMapping(base: MapBase, mapping: Mapping): MapResult {
  return withNames((id) => base.names[id], () => {
    const cards = cardIndex(base, mapping)
    const touched = new Set(mapping.touched)
    const synonyms = new Synonyms(base.synonyms)
    const fills = new Map<string, SlotFill>()
    const usage = slotUsage(base, mapping, cards)
    const slots = base.slots.map((b): MappedSlot => {
      const id = b.slot.id
      if (!touched.has(id) || !FILLABLE.has(b.slot.kind)) {
        if (b.fill && b.status === 'filled') fills.set(id, b.fill)
        return { slot: b.slot, status: b.status, ...(b.origin ? { origin: b.origin } : {}), text: b.text, touched: false, cards: b.cards }
      }
      const ids = listOf(mapping, id).filter((c) => cards.has(c))
      const value = valueOf(b.slot, ids.map((c) => cards.get(c)!), synonyms, base.names)
      if (!value) return { slot: b.slot, status: 'empty', text: '', touched: true, cards: ids }
      fills.set(id, value.fill)
      const origin = mapping.origins[ids.find((c) => cards.get(c)!.kind !== 'section') ?? ids[0]!] ?? 'manual'
      return { slot: b.slot, status: 'filled', origin, text: value.text, touched: true, cards: ids }
    })
    const changed = touched.size > 0 || Object.keys(mapping.cuts).length > 0
    return { slots, fills, leftovers: changed ? leftovers(base, mapping, cards, usage) : base.leftovers, usage, ...(base.subject ? { subject: base.subject } : {}) }
  })
}

/** The fill plan with the mapping applied: what the import and the preview use. */
export function mappedPlan(plan: FillPlan, base: MapBase, mapping: Mapping, result = applyMapping(base, mapping)): FillPlan {
  const touched = new Set(mapping.touched)
  if (touched.size === 0 && Object.keys(mapping.cuts).length === 0) return plan
  const slots = plan.slots.map((s, i): SlotState => {
    const r = result.slots[i]!
    if (!r.touched) return s
    return { slot: s.slot, status: r.status, ...(r.origin ? { origin: r.origin } : {}), text: r.text, options: s.options, contenders: [], units: result.usage.get(s.slot.id) ?? [] }
  })
  return { ...plan, slots, fills: result.fills, leftovers: result.leftovers, extraRows: plan.extraRows.filter((row) => !touched.has(row.slotId)) }
}

/** Where each card is: its slot (by id, or because the slot uses its part of the clip), and the unused cards. */
export function placements(base: MapBase, mapping: Mapping, result: MapResult): { slotOf: Map<string, string>; unused: string[] } {
  const cards = cardIndex(base, mapping)
  const slotOf = new Map<string, string>()
  for (const s of result.slots) for (const id of s.cards) slotOf.set(id, s.slot.id)
  for (const card of cards.values()) {
    if (slotOf.has(card.id) || card.units.length === 0) continue
    for (const [slotId, units] of result.usage) {
      if (overlaps(units, card.units)) {
        slotOf.set(card.id, slotId)
        break
      }
    }
  }
  const unused = [...cards.values()].filter((c) => c.listed && !slotOf.has(c.id)).sort((a, b) => a.order - b.order).map((c) => c.id)
  return { slotOf, unused }
}

/** Counts for the side panel. */
export function summarize(result: MapResult): { filled: number; empty: number; unused: number; toChoose: number } {
  const fields = result.slots.filter((s) => FILLABLE.has(s.slot.kind))
  return {
    filled: fields.filter((s) => s.status === 'filled').length,
    empty: fields.filter((s) => s.status === 'empty' || s.status === 'off').length,
    toChoose: fields.filter((s) => s.status === 'ambiguous').length,
    unused: result.leftovers.length,
  }
}

// ---------------------------------------------------------------------------------- helpers

function valueOf(slot: Slot, list: Card[], synonyms: Synonyms, names: Record<string, string>): { fill: SlotFill; text: string } | undefined {
  if (list.length === 0) return undefined
  if (slot.kind === 'image') {
    const card = list.find(isImage)
    if (!card) return undefined
    return { fill: valueFor(slot, card.candidate ?? asCandidate(card)), text: card.text }
  }
  if (slot.kind === 'links') {
    const ids = [...new Set(list.flatMap((c) => c.mentions))]
    return ids.length ? { fill: { links: ids }, text: ids.map((id) => names[id] ?? id).join(', ') } : undefined
  }
  // A virtual card alone writes exactly what the plan would have (an AI answer with its label taken off).
  if (list.length === 1 && list[0]!.kind === 'virtual' && list[0]!.candidate) {
    const c = list[0]!.candidate
    const fill = valueFor(slot, c)
    return { fill, text: slot.kind === 'rich' && 'blocks' in fill ? fill.blocks.map((b) => blockText(b as AnyBlock)).join('\n') : c.text }
  }
  // A section's heading is not written: the template has its own.
  const content = joinPieces(list.filter((c) => c.kind !== 'section'))
  if (slot.kind === 'text') {
    const runs = content.length === 1 && content[0]!.runs ? content[0]!.runs : blocksToRuns(content.flatMap((c) => (c.kind === 'pair' && c.runs ? [{ kind: 'paragraph', content: c.runs } as Block] : c.blocks)))
    return runs.length ? { fill: { runs }, text: runsText(runs) } : undefined
  }
  const blocks = content.flatMap((c) => {
    if (c.kind !== 'pair' || !c.runs) return c.blocks
    // A value with the slot's own label goes in without the label; any other keeps it ("Senses darkvision…").
    if (compareLabels(slot.key, c.key, synonyms) !== undefined) return c.blocks
    return [{ kind: 'paragraph', content: [{ text: c.label, bold: true }, { text: ' ' }, ...c.runs] } as Block]
  })
  if (blocks.length === 0) return undefined
  const level = list.find((c) => c.kind === 'section')?.level
  const fill = valueFor(slot, { ...asCandidate({ blocks } as Card), ...(level !== undefined ? { level } : {}) })
  return { fill, text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
}

/** Neighbouring pieces of one card, in order, are one value again. */
function joinPieces(list: Card[]): Card[] {
  const out: Card[] = []
  for (const card of list) {
    const prev = out.at(-1)
    if (prev?.kind === 'piece' && card.kind === 'piece' && prev.of === card.of && prev.to === card.from) {
      const raw = [...prev.raw!, ...card.raw!]
      const runs = trimRuns(raw)
      out[out.length - 1] = { ...prev, to: card.to, raw, runs, text: runsText(runs), blocks: [{ kind: 'paragraph', content: runs }], mentions: mentionsIn(runs) }
    } else out.push(card)
  }
  return out
}

function leftovers(base: MapBase, mapping: Mapping, cards: Map<string, Card>, usage: Map<string, string[]>): Block[] {
  const used = new Set<string>([...usage.values()].flat())
  for (const i of base.titleBlocks) used.add(`b${i}`)
  const cutCards = Object.keys(mapping.cuts).map((id) => base.cards.find((c) => c.id === id)).filter((c): c is Card => !!c?.runs)
  for (const card of cutCards) for (const unit of card.units) used.add(unit)
  const entries = leftoverEntries(base.clip, { split: new Map(base.split), captions: new Map(base.captions) }, used)
  // The unused pieces of a cut card go back where the card was, as one paragraph.
  const placed = new Set(Object.values(mapping.slots).flat())
  for (const card of cutCards) {
    const rest = [...cards.values()].filter((c) => c.of === card.id && !placed.has(c.id)).sort((a, b) => a.from! - b.from!)
    const runs = trimRuns(rest.flatMap((c) => sliceRuns(card.runs!, c.from!, c.to!)))
    if (!runsText(runs).trim()) continue
    const content = card.kind === 'pair' && card.label ? [{ text: card.label, bold: true }, { text: ' ' }, ...runs] : runs
    const index = blockOf(card.units[0] ?? '') ?? base.clip.length
    const at = entries.findIndex((e) => e.index > index)
    entries.splice(at < 0 ? entries.length : at, 0, { index, block: { kind: 'paragraph', content } as Block })
  }
  return entries.map((e) => e.block)
}

/** The parts of the clip each filled slot uses: the plan's for untouched slots, its cards' otherwise. */
function slotUsage(base: MapBase, mapping: Mapping, cards: Map<string, Card>): Map<string, string[]> {
  const touched = new Set(mapping.touched)
  const out = new Map<string, string[]>()
  for (const b of base.slots) {
    if (!FILLABLE.has(b.slot.kind)) continue
    if (!touched.has(b.slot.id)) {
      if (b.status === 'filled') out.set(b.slot.id, b.units)
      continue
    }
    const units = listOf(mapping, b.slot.id).flatMap((id) => cards.get(id)?.units ?? [])
    if (units.length) out.set(b.slot.id, units)
  }
  return out
}

/** Takes a card, and any card sharing part of the clip with it, out of every slot. */
function release(base: MapBase, m: Mapping, cards: Map<string, Card>, id: string): void {
  const card = cards.get(id)
  const touched = new Set(m.touched)
  for (const b of base.slots) {
    if (!FILLABLE.has(b.slot.kind)) continue
    const list = listOf(m, b.slot.id)
    const keep = list.filter((other) => other !== id && !(card && card.units.length > 0 && overlaps(cards.get(other)?.units ?? [], card.units)))
    // A part of the clip the plan's value uses without showing it as a card (a table's caption).
    const hidden = !touched.has(b.slot.id) && b.status === 'filled' && !!card && card.units.length > 0 && overlaps(b.units, card.units)
    if (keep.length !== list.length || hidden) {
      for (const gone of list.filter((other) => !keep.includes(other))) if (gone !== id) delete m.origins[gone]
      m.slots[b.slot.id] = keep
      touch(m, b.slot.id)
    }
  }
}

function holder(m: Mapping, id: string): string | undefined {
  return Object.entries(m.slots).find(([, list]) => list.includes(id))?.[0]
}

function touch(m: Mapping, slotId: string): void {
  if (!m.touched.includes(slotId)) m.touched.push(slotId)
}

function copy(m: Mapping): Mapping {
  return {
    slots: Object.fromEntries(Object.entries(m.slots).map(([k, v]) => [k, [...v]])),
    origins: { ...m.origins }, typed: { ...m.typed }, cuts: Object.fromEntries(Object.entries(m.cuts).map(([k, v]) => [k, [...v]])), remember: { ...m.remember }, touched: [...m.touched],
  }
}

function asCandidate(card: Pick<Card, 'blocks'> & Partial<Card>): Candidate {
  return { id: card.id ?? 'mapped', label: card.label ?? '', key: card.key ?? '', kind: card.blocks.some((b) => b.kind === 'image') && card.blocks.length === 1 ? 'image' : 'section', blocks: card.blocks, text: card.blocks.map((b) => blockText(b as AnyBlock)).join('\n'), units: card.units ?? [], ...(card.runs ? { runs: card.runs } : {}) }
}

function blockOf(unit: string): number | undefined {
  const match = /^b(\d+)(?:\.|$)/.exec(unit)
  return match ? Number(match[1]) : undefined
}

function orderOf(unit: string): number {
  const match = /^b(\d+)(?:\.[a-z](\d+))?/.exec(unit)
  return match ? Number(match[1]) * 1000 + (match[2] !== undefined ? Number(match[2]) + 1 : 0) : Infinity
}

function imageText(block: Block | undefined): string {
  const image = block as AnyBlock | undefined
  const alt = String(image?.alt ?? '').trim()
  return alt || String(image?.url ?? '').split(/[?#]/)[0]!.split('/').pop() || 'Image'
}

function paragraphs(text: string): Block[] {
  return text.split(/\n+/).map((line) => ({ kind: 'paragraph', content: [{ text: line }] }) as Block)
}

/** The runs covering offsets from–to of their text. */
function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const split = splitRuns(runs, [from, to])
  return split.runs.filter((_, i) => split.offsets[i]! >= from && split.offsets[i]! < to)
}

function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  const first = out[0]
  if (first && 'text' in first) first.text = first.text.trimStart()
  const last = out.at(-1)
  if (last && 'text' in last) last.text = last.text.trimEnd()
  return out.filter((r) => !('text' in r) || r.text !== '')
}
