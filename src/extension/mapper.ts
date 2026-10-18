/**
 * The mapper tab: fix how a clip is placed into a template by moving cards from the clip into a
 * wireframe of the template. The side panel hands over the cards, slots and mapping through
 * chrome.storage.session (see mapperState.ts); every change here goes back the same way, and the
 * panel does the import.
 *
 * Cards move by dragging (Chrome's own drag and drop), by clicking a card and then a slot, or with
 * the keyboard (Tab to a card, Enter, Tab to a slot, Enter). Selecting part of a card's text and
 * dragging the selection makes a card of just that part.
 */
import type { Block } from '@legendkeeper/sdk/blocks'
import { blocksToHtml } from '../clip/preview.js'
import { appendedTemplate, applyComposition, compose } from '../fill/compose.js'
import {
  accepts, applyMapping, canRemember, cardIndex, clearSlot, cut, FILLABLE, initialMapping, isImage, place, placements, setRemember, summarize, typeValue, unplace, useGhost,
  type BaseSlot, type Card, type MappedSlot, type Mapping, type MapResult,
} from '../fill/mapping.js'
import type { SlotOrigin } from '../fill/plan.js'
import { SIDEBAR, type AnyBlock, type Slot } from '../fill/template.js'
import { clear, el } from './dom.js'
import { IMPORT_KEY, MAPPING_KEY, readSession, SESSION_KEY, STATUS_KEY, writeSession, type ImportStatus, type MapperSession, type MappingMessage } from './mapperState.js'

const BADGES: Record<SlotOrigin, string> = {
  rule: 'Saved rule', label: 'Label · Exact', synonym: 'Label · Synonym', similar: 'Label · Loose', ai: 'AI', 'ai-written': 'AI · not in the clip', 'ai-wrote': 'AI · written',
  derived: 'Worked out', manual: 'Manual', typed: 'Typed', title: 'Page name',
}
const BLOCK_NAMES: Record<string, string> = { table: 'Table', bulletList: 'List', orderedList: 'List', taskList: 'List', quote: 'Quote', heading: 'Heading', code: 'Code', callout: 'Callout' }

const clipBox = document.getElementById('m-clip')!
const wireBox = document.getElementById('m-wire')!
const previewBox = document.getElementById('m-preview')!
const trayBox = document.getElementById('m-tray')!
const statusBox = document.getElementById('m-status')!
const countsBox = document.getElementById('m-counts')!
const importButton = document.getElementById('m-import') as HTMLButtonElement
const undoButton = document.getElementById('m-undo') as HTMLButtonElement
const resetButton = document.getElementById('m-reset') as HTMLButtonElement
const cutButton = document.getElementById('m-cut') as HTMLButtonElement
const toastBox = document.getElementById('m-toast')!

let session: MapperSession | undefined
let mapping: Mapping
let history: Mapping[] = []
/** The card chosen by clicking it (or Enter), waiting for a slot. */
let selected: string | undefined
let dragging: { card: Card; cut?: { from: number; to: number } } | undefined
/** The template tab shown. */
let tab = 0
/** The slot whose "Type a value" box is open. */
let editing: string | undefined
/** Cards shown in full rather than cut to three lines. */
const expanded = new Set<string>()
/** The card whose text can be selected, to split part of it off (✂, or a double-click on its text). */
let splitting: string | undefined
let pendingRequest: string | undefined
let status: ImportStatus | undefined

// ------------------------------------------------------------------------------------- start

void start()

async function start(): Promise<void> {
  session = await readSession<MapperSession>(SESSION_KEY)
  if (session) {
    const saved = await readSession<MappingMessage>(MAPPING_KEY)
    mapping = saved?.key === session.key ? saved.mapping : session.mapping
    const last = await readSession<ImportStatus>(STATUS_KEY)
    status = last?.key === session.key ? last : undefined
  }
  chrome.storage.session.onChanged.addListener((changes) => {
    const next = changes[SESSION_KEY]?.newValue as MapperSession | undefined
    if (next) {
      const fresh = !session || next.key !== session.key
      // The panel made the cards again (the AI answered, the page list changed): take its mapping, which keeps your changes.
      if (fresh || next.rev !== session!.rev) {
        mapping = next.mapping
        if (fresh) {
          history = []
          selected = undefined
          editing = undefined
          tab = 0
          status = undefined
        }
      }
      session = next
      render()
    }
    const message = changes[MAPPING_KEY]?.newValue as MappingMessage | undefined
    if (message && session && message.key === session.key && JSON.stringify(message.mapping) !== JSON.stringify(mapping)) {
      mapping = message.mapping
      render()
    }
    const update = changes[STATUS_KEY]?.newValue as ImportStatus | undefined
    if (update && session && update.key === session.key) {
      status = update
      if (update.requestId === pendingRequest) pendingRequest = undefined
      renderStatus()
    }
  })
  render()
}

/** Makes a change: kept for Undo, shown, and sent to the panel. */
function commit(next: Mapping): boolean {
  if (!session || next === mapping) return false
  history.push(mapping)
  if (history.length > 100) history.shift()
  mapping = next
  void writeSession(MAPPING_KEY, { key: session.key, mapping } satisfies MappingMessage).catch((error) => toast(String(error)))
  render()
  return true
}

undoButton.addEventListener('click', undo)
resetButton.addEventListener('click', () => {
  if (!session) return
  if (commit(initialMapping(session.base))) toast('Back to what label matching found.')
})
importButton.addEventListener('click', () => void requestImport())

function undo(): void {
  const previous = history.pop()
  if (!previous || !session) return
  mapping = previous
  void writeSession(MAPPING_KEY, { key: session.key, mapping } satisfies MappingMessage)
  render()
}

/** Asks the side panel to import. If no panel answers, it is closed: say how to open it. */
async function requestImport(): Promise<void> {
  if (!session) return
  const requestId = crypto.randomUUID()
  pendingRequest = requestId
  status = { key: session.key, requestId, state: 'importing', message: 'Asking the side panel to import…' }
  renderStatus()
  await writeSession(IMPORT_KEY, { key: session.key, requestId })
  setTimeout(() => {
    if (pendingRequest !== requestId || !session) return
    pendingRequest = undefined
    status = {
      key: session.key, requestId, state: 'failed',
      message: 'The side panel didn’t answer, so it is probably closed. Click the LegendKeeper Clipper icon in Chrome’s toolbar to open it (your changes here are kept), then click Import again, here or in the panel.',
    }
    renderStatus()
  }, 3000)
}

// ------------------------------------------------------------------------------------ render

function render(): void {
  if (!session) {
    document.title = 'LK Mapper'
    clear(clipBox, el('div', { class: 'empty-page' },
      el('h2', {}, 'Nothing to map yet'),
      el('p', {}, 'Clip something with “Send to LegendKeeper”, choose a template in the side panel, then click ', el('strong', {}, 'Open mapper'), '.')))
    for (const box of [wireBox, previewBox, trayBox]) clear(box)
    importButton.disabled = true
    return
  }
  const { base, context } = session
  const result = applyMapping(base, mapping)
  const cards = cardIndex(base, mapping)
  const where = placements(base, mapping, result)
  const bySlot = new Map(result.slots.map((s) => [s.slot.id, s]))
  const focus = focusKey()

  document.title = `Mapper: ${context.title || 'clip'} → ${context.templateName}`
  document.getElementById('m-title')!.textContent = `${context.title || 'Untitled'} → ${context.templateName}`
  document.getElementById('m-sub')!.textContent = [context.site, context.projectName, context.mode === 'append' ? 'adds the template’s main tab to the page' : 'new page'].filter(Boolean).join(' · ')
  const counts = summarize(result)
  clear(countsBox,
    el('span', { class: 'count filled' }, el('strong', {}, String(counts.filled)), ' filled'),
    el('span', { class: 'count empty' }, el('strong', {}, String(counts.empty + counts.toChoose)), ' empty'),
    el('span', { class: 'count unused' }, el('strong', {}, String(counts.unused)), ' unused'))
  importButton.textContent = context.importLabel
  undoButton.disabled = history.length === 0
  resetButton.disabled = mapping.touched.length === 0 && Object.keys(mapping.cuts).length === 0

  renderClip(cards, where.slotOf, bySlot)
  renderWire(cards, bySlot)
  renderTray(cards, where.unused)
  renderPreview(result)
  renderStatus()
  restoreFocus(focus)
  markChoosing()
}

function renderStatus(): void {
  if (!session) return clear(statusBox)
  const problems = session.context.problems
  importButton.disabled = problems.length > 0 || status?.state === 'importing' || status?.state === 'done'
  const parts: (Node | null)[] = []
  if (status) {
    const link = status.url ? el('a', { href: status.url, target: '_blank', rel: 'noopener' }, 'Open the page in LegendKeeper') : null
    if (status.state === 'done') parts.push(el('p', { class: 'done-line' }, `✔ ${status.message} `, link))
    else if (status.state === 'importing') parts.push(el('p', { class: 'muted' }, status.message))
    else if (status.state === 'fill-failed') parts.push(el('p', { class: 'warning' }, el('strong', {}, 'Page created, but filling failed. '), status.message, ' ', link))
    else parts.push(el('p', { class: status.state === 'blocked' ? 'warning' : 'problem' }, status.message))
  }
  if (problems.length && status?.state !== 'done') parts.push(el('p', { class: 'warning' }, `Before importing, in the side panel: ${problems.join(' ')}`))
  clear(statusBox, ...parts)
}

// The clip column: every card, in the clip's order.
function renderClip(cards: Map<string, Card>, slotOf: Map<string, string>, bySlot: Map<string, MappedSlot>): void {
  const listed = [...cards.values()].filter((c) => c.listed).sort((a, b) => a.order - b.order)
  clear(clipBox,
    el('h2', {}, 'Clip'),
    el('p', { class: 'hint' }, 'Drag a card into a field of the template, or click it and then click the field. To move only part of a card’s text, click its ✂ (or double-click the text), select the part and drag it.'),
    ...listed.map((card) => {
      const slotId = slotOf.get(card.id)
      return cardEl(card, { in: 'clip', where: slotId ? bySlot.get(slotId)?.slot.label : undefined })
    }),
    el('p', { class: 'keys' }, 'Keyboard: ', el('kbd', {}, 'Tab'), ' to a card, ', el('kbd', {}, 'Enter'), ' to pick it up, ', el('kbd', {}, 'Tab'), ' to a field, ', el('kbd', {}, 'Enter'), ' to put it there. In a field: ',
      el('kbd', {}, 'Delete'), ' sends a card back, ', el('kbd', {}, 'Alt'), '+', el('kbd', {}, '↑'), '/', el('kbd', {}, '↓'), ' moves it. ', el('kbd', {}, 'Esc'), ' cancels, ', el('kbd', {}, 'Ctrl'), '+', el('kbd', {}, 'Z'), ' undoes. ✂ on a card lets you select part of its text.'))
}

function renderTray(cards: Map<string, Card>, unused: string[]): void {
  const titles = session!.base.titleBlocks.map((i) => cards.get(`b${i}`)?.text).filter(Boolean)
  clear(trayBox,
    el('h2', {}, `Unused (${unused.length})`),
    el('p', { class: 'hint' }, unused.length
      ? 'These go at the end of the page, after a divider and the “From <Source>” heading. Drag a card here to take it out of a field.'
      : 'Everything in the clip is in a field. Drag a card here to take it out of its field.'),
    el('div', { class: 'tray-cards' }, ...unused.map((id) => cardEl(cards.get(id)!, { in: 'tray' }))),
    titles.length ? el('p', { class: 'hint' }, `Left out: “${titles.join('”, “')}” only repeats the page’s name.`) : null)
}

function renderPreview(result: MapResult): void {
  const { context, base } = session!
  const tree = context.tree
  const composition = compose(tree, result, { sourceHeading: context.sourceHeading, keepUnfilled: context.keepUnfilled })
  let blocks: Block[]
  let note = ''
  if (context.mode === 'append') {
    blocks = appendedTemplate(tree, composition)
    note = 'What is added to the end of the page.'
  } else {
    const filled = applyComposition(tree, composition)
    const doc = Math.min(tab, filled.docs.length - 1)
    blocks = filled.docs[doc] ?? []
    const sidebar = filled.properties.filter((op) => op.op === 'updateRow' || op.op === 'update').length
    note = `${tree.docs.length > 1 ? `The ${tree.docs[doc]?.name || 'Main'} tab. ` : ''}${sidebar ? `${sidebar} sidebar field${sidebar === 1 ? '' : 's'} are filled too (see the template).` : ''}`
  }
  const box = el('div', { class: 'preview' })
  box.innerHTML = blocksToHtml(blocks, { nameOf: (id) => base.names[id] })
  clear(previewBox, el('h2', {}, 'Preview'), note ? el('p', { class: 'preview-note' }, note) : null, box)
}

// The wireframe: the template laid out like LegendKeeper, every slot a drop zone.
function renderWire(cards: Map<string, Card>, bySlot: Map<string, MappedSlot>): void {
  const { base, context } = session!
  const tree = context.tree
  const at = new Map<string, BaseSlot[]>()
  for (const b of base.slots) {
    const key = `${b.slot.doc}:${b.slot.target.at.join('.')}`
    at.set(key, [...(at.get(key) ?? []), b])
  }
  tab = Math.min(tab, Math.max(0, tree.docs.length - 1))
  const ctx: WireContext = { at, cards, bySlot }
  const tabs = tree.docs.length > 1
    ? el('div', { class: 'wf-tabs', role: 'tablist' }, ...tree.docs.map((doc, i) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(i === tab), class: i === tab ? 'on' : '', 'data-action': 'tab', 'data-tab': String(i) }, doc.name || 'Main')))
    : null
  const page = el('div', { class: 'wf-page' }, ...renderBlocks((tree.docs[tab]?.blocks ?? []) as AnyBlock[], [], tab, ctx))
  const sidebar = tree.properties.length ? el('div', { class: 'wf-sidebar' }, el('h3', {}, 'Sidebar'), ...renderBlocks(tree.properties as unknown as AnyBlock[], [], SIDEBAR, ctx)) : null
  clear(wireBox, el('h2', {}, 'Template'), tabs, el('div', { class: `wf-layout${sidebar ? '' : ' no-sidebar'}` }, page, sidebar))
}

interface WireContext {
  at: Map<string, BaseSlot[]>
  cards: Map<string, Card>
  bySlot: Map<string, MappedSlot>
}

function renderBlocks(blocks: AnyBlock[], at: number[], doc: number, ctx: WireContext): Node[] {
  const out: Node[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const here = [...at, i]
    const slots = ctx.at.get(`${doc}:${here.join('.')}`) ?? []
    const first = slots[0]
    if (first && (first.slot.target.type === 'section' || first.slot.target.type === 'source' || first.slot.target.type === 'placeholder')) {
      out.push(zoneEl(first, ctx))
      i += first.slot.target.type === 'placeholder' ? first.slot.target.length - 1 : first.slot.target.length
      continue
    }
    if (first?.slot.kind === 'name') {
      out.push(zoneEl(first, ctx))
      continue
    }
    switch (block.kind) {
      case 'infobox':
        out.push(el('div', { class: 'wf-infobox' }, el('div', { class: 'wf-caption' }, 'Infobox'), ...renderBlocks(block.rows as AnyBlock[], here, doc, ctx)))
        break
      case 'keyValue': {
        const rows = block.rows as { key: string; text?: string }[]
        out.push(el('div', { class: 'wf-kv' },
          titleOf(block),
          ...rows.map((row, r) => {
            const slot = slots.find((s) => s.slot.target.type === 'row' && s.slot.target.row === r)
            return el('div', { class: 'kv-row' }, el('div', { class: 'kv-key' }, row.key), slot ? zoneEl(slot, ctx, true) : el('div', { class: 'wf-static' }, row.text ?? ''))
          })))
        break
      }
      case 'textField':
      case 'image':
      case 'resourceLink':
      case 'resourceCollection':
        if (first) out.push(el('div', {}, titleOf(block), zoneEl(first, ctx)))
        else out.push(el('div', { class: 'wf-static' }, block.kind === 'resourceCollection' ? `[${String(block.title ?? 'Collection')}: fills itself]` : blockSummary(block)))
        break
      case 'layout':
        out.push(el('div', { class: 'wf-columns' }, ...renderBlocks(block.children as AnyBlock[], here, doc, ctx)))
        break
      case 'layoutColumn':
        out.push(el('div', {}, ...renderBlocks(block.children as AnyBlock[], here, doc, ctx)))
        break
      case 'secret':
      case 'callout':
      case 'expand':
        out.push(el('div', { class: 'wf-box' }, ...renderBlocks((block.children ?? []) as AnyBlock[], here, doc, ctx)))
        break
      case 'rule':
        out.push(el('div', { class: 'wf-static' }, el('hr')))
        break
      case 'heading':
        out.push(el('div', { class: 'wf-static heading' }, blockSummary(block)))
        break
      case 'unsupported':
        out.push(el('div', { class: 'wf-static' }, `[${String(block.title ?? 'LegendKeeper field')}: kept as it is]`))
        break
      default:
        out.push(el('div', { class: 'wf-static' }, blockSummary(block)))
    }
  }
  return out
}

function titleOf(block: AnyBlock): HTMLElement | null {
  const title = typeof block.title === 'string' ? block.title : ''
  return title && !/^(text|stats|properties|image|links|collection)$/i.test(title.trim()) ? el('div', { class: 'wf-field-title' }, title) : null
}

function blockSummary(block: AnyBlock): string {
  const text = Array.isArray(block.content) ? block.content.map((r: { text?: string; mention?: { text?: string; name?: string } }) => r.text ?? r.mention?.text ?? r.mention?.name ?? '').join('') : ''
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text
  return `[${BLOCK_NAMES[block.kind] ?? block.kind}]`
}

function kindName(slot: Slot): string {
  if (slot.kind === 'text') return 'short text'
  if (slot.kind === 'image') return 'image'
  if (slot.kind === 'links') return 'links'
  return slot.target.type === 'section' ? 'section' : 'text'
}

/** A slot as a drop zone: its cards, or what happens if it stays empty, and its tools. */
function zoneEl(b: BaseSlot, ctx: WireContext, compact = false): HTMLElement {
  const slot = b.slot
  const { base, context } = session!
  if (slot.kind === 'name') return el('div', { class: 'zone static' }, el('span', { class: 'zone-kind' }, 'Page name '), el('strong', {}, context.title || slot.placeholder))
  if (slot.kind === 'source') return el('div', { class: 'zone static' }, el('span', { class: 'zone-kind' }, 'Credit '), context.sourceHeading ? 'The “From <Source>” heading, with the unused content under it' : 'No credit (switched off in the panel)')
  const r = ctx.bySlot.get(slot.id)!
  const ids = r.cards.filter((id) => ctx.cards.has(id))
  const untouched = !r.touched
  const tie = untouched && b.status === 'ambiguous'
  const ghost = untouched && b.status === 'off' && b.ghost ? ctx.cards.get(b.ghost) : undefined
  const empty = r.status !== 'filled'
  const classes = ['zone', `kind-${slot.kind}`, `target-${slot.target.type}`, empty ? 'is-empty' : '', tie ? 'is-tie' : ''].filter(Boolean).join(' ')
  const tools = el('span', { class: 'zone-tools' },
    el('button', { type: 'button', class: 'mini', 'data-action': 'type', 'data-slot': slot.id, title: `Type a value for ${slot.label}`, 'aria-label': `Type a value for ${slot.label}` }, '✎'),
    ids.length ? el('button', { type: 'button', class: 'mini', 'data-action': 'clear', 'data-slot': slot.id, title: `Clear ${slot.label}`, 'aria-label': `Clear ${slot.label}` }, '⌫') : null)
  const typing = editing === slot.id
  const typed = r.status === 'filled' ? r.text : ''
  const input = slot.kind === 'text'
    ? el('input', { type: 'text', value: typed, placeholder: slot.placeholder || 'Value', 'aria-label': `Value for ${slot.label}`, 'data-type-input': slot.id })
    : el('textarea', { placeholder: slot.placeholder || 'Text', 'aria-label': `Text for ${slot.label}`, 'data-type-input': slot.id })
  if (input instanceof HTMLTextAreaElement) input.value = typed
  const remember = canRemember(base, mapping, slot.id) && context.site
    ? el('label', { class: 'check remember' },
        el('input', { type: 'checkbox', checked: !!mapping.remember[slot.id], 'data-action': 'remember', 'data-slot': slot.id }),
        `Remember this for ${context.site}: “${ctx.cards.get(ids[0]!)?.label}” goes in “${slot.label}”`)
    : null
  return el('div', {
    class: classes, 'data-zone': `slot:${slot.id}`, 'data-slot-id': slot.id, tabindex: 0, role: 'group',
    'aria-label': `${slot.label} (${kindName(slot)})${empty ? ', empty' : ''}`, title: `${slot.path}: takes ${kindName(slot)}`,
  },
    el('div', { class: 'zone-head' }, el('span', { class: 'zone-label' }, slot.label), el('span', { class: 'zone-kind' }, kindName(slot)), tools),
    el('div', { class: 'zone-cards' }, ...ids.map((id) => cardEl(ctx.cards.get(id)!, { in: 'slot', slotId: slot.id, multi: slot.kind === 'rich' || slot.kind === 'links' }))),
    empty && !tie && !typing ? el('div', { class: 'zone-empty' }, context.keepUnfilled ? (slot.placeholder ? `Empty: keeps “${short(slot.placeholder, 80)}”` : 'Empty') : 'Empty: removed from the page') : null,
    tie ? el('div', { class: 'tie' }, el('span', {}, 'Several clip values fit. Pick one:'),
      ...b.contenders.map((id) => {
        const card = ctx.cards.get(id)
        return card ? el('button', { type: 'button', 'data-action': 'pick', 'data-slot': slot.id, 'data-card': id, draggable: false }, `“${card.label || 'Clip'}”: ${short(card.text, 70)}`) : null
      })) : null,
    ghost ? el('div', { class: 'ghost' }, el('span', {}, `The AI suggested “${short(ghost.text, 90)}”, but it isn’t used: ${b.warning ?? 'it isn’t in the clip.'}`),
      el('button', { type: 'button', 'data-action': 'ghost', 'data-slot': slot.id }, 'Use it anyway')) : null,
    untouched && b.warning && !ghost ? el('div', { class: 'slot-warning' }, b.warning) : null,
    untouched && b.note && !compact ? el('div', { class: 'zone-note' }, b.note) : null,
    untouched && b.fill && 'runs' in b.fill && b.fill.extraRows?.length
      ? el('div', { class: 'zone-note' }, `Also adds the clip’s ${b.fill.extraRows.map((row) => `“${row.key}”`).join(', ')} row${b.fill.extraRows.length === 1 ? '' : 's'} to this list (the template has no row for ${b.fill.extraRows.length === 1 ? 'it' : 'them'}). Change this field to leave ${b.fill.extraRows.length === 1 ? 'it' : 'them'} out.`)
      : null,
    typing ? el('div', { class: 'type-box' }, input, el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', 'data-action': 'save-type', 'data-slot': slot.id }, 'Use this'),
      el('button', { type: 'button', 'data-action': 'cancel-type' }, 'Cancel'))) : null,
    remember)
}

/** A card: in the clip column, in the unused tray, or placed in a slot. */
function cardEl(card: Card, where: { in: 'clip' | 'tray' | 'slot'; slotId?: string; where?: string; multi?: boolean }): HTMLElement {
  const origin = where.in === 'slot' ? mapping.origins[card.id] ?? session!.base.slots.find((s) => s.slot.id === where.slotId)?.origin : undefined
  const kindLabel = card.kind === 'block' && card.blockKind && card.blockKind !== 'paragraph' ? BLOCK_NAMES[card.blockKind] ?? card.blockKind : card.kind === 'typed' ? 'Typed' : card.kind === 'piece' ? 'Part' : ''
  const label = card.kind === 'section' ? `§ ${card.label}` : card.kind === 'virtual' && card.label === 'AI' ? '' : card.label
  const long = card.kind !== 'section' && (card.text.length > 180 || card.text.split('\n').length > 3)
  const canSplit = card.cutText !== undefined && card.kind !== 'virtual' && card.cutText.trim().length > 1
  const isSplitting = splitting === card.id && canSplit
  let content: Node
  if (isImage(card)) {
    const url = String((card.blocks[0] as AnyBlock | undefined)?.url ?? '')
    content = el('span', { class: 'card-content' }, url ? el('img', { src: url, alt: card.text, loading: 'lazy', draggable: false }) : null, el('span', { class: 'card-text' }, card.text))
  } else if (card.kind === 'section') {
    const parts = card.body?.length ?? 0
    content = el('span', { class: 'card-content muted', title: where.in === 'slot' ? 'The clip’s heading isn’t written: the template has its own' : '' }, where.in === 'slot' ? ' (its heading)' : `${parts} part${parts === 1 ? '' : 's'} under it`)
  } else if (canSplit) {
    content = el('span', { class: 'card-content' }, el('span', { class: 'cut-text', 'data-cut': card.id }, card.cutText))
  } else {
    content = el('span', { class: 'card-content' }, el('span', { class: 'card-text' }, short(card.text, 600)))
  }
  const body = el('div', { class: `card-body${long && !expanded.has(card.id) && !isSplitting ? ' clamped' : ''}` },
    kindLabel ? el('span', { class: 'card-kind' }, kindLabel) : null,
    label ? el('span', { class: 'card-label' }, label) : null,
    content,
    long && !isSplitting ? el('button', { type: 'button', class: 'more', 'data-action': 'more', 'data-card': card.id }, expanded.has(card.id) ? 'less' : 'more') : null,
    where.where ? el('span', { class: 'where' }, `in ${where.where}`) : null,
    isSplitting ? el('div', { class: 'split-hint' }, 'Select part of the text, then drag the selection to a field, or click “Make a card from the selection”. ', el('button', { type: 'button', class: 'more', 'data-action': 'split', 'data-card': card.id }, 'Done')) : null)
  const split = canSplit ? el('button', { type: 'button', class: 'mini', 'data-action': 'split', 'data-card': card.id, title: 'Split part of this text off as a card of its own', 'aria-label': 'Split part of this text off', 'aria-pressed': String(isSplitting) }, '✂') : null
  const tools = where.in === 'slot'
    ? el('span', { class: 'tools' },
        origin ? el('span', { class: `origin ${origin}`, title: 'Where this came from' }, BADGES[origin]) : null,
        where.multi ? el('button', { type: 'button', class: 'mini', 'data-action': 'up', 'data-card': card.id, 'data-slot': where.slotId, title: 'Move up', 'aria-label': 'Move up' }, '↑') : null,
        where.multi ? el('button', { type: 'button', class: 'mini', 'data-action': 'down', 'data-card': card.id, 'data-slot': where.slotId, title: 'Move down', 'aria-label': 'Move down' }, '↓') : null,
        split,
        el('button', { type: 'button', class: 'mini', 'data-action': 'unplace', 'data-card': card.id, title: 'Back to the unused content', 'aria-label': 'Back to the unused content' }, '×'))
    : split ? el('span', { class: 'tools' }, split) : null
  return el('div', {
    class: `card kind-${card.kind} depth-${where.in === 'clip' ? card.depth : 0}${where.where ? ' placed' : ''}${selected === card.id ? ' selected' : ''}${isSplitting ? ' splitting' : ''}`,
    'data-card': card.id, 'data-in': where.in === 'slot' ? `slot:${where.slotId}` : where.in, draggable: !isSplitting, tabindex: 0, role: 'button',
    'aria-pressed': String(selected === card.id), 'aria-label': `${label || kindLabel || 'Text'}: ${short(card.text, 120)}${where.where ? `, in ${where.where}` : ''}`,
  }, el('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'), body, tools)
}

// ------------------------------------------------------------------------------------ moving

/** Puts a card (or the selected part of one) in a slot, or back in the unused content. */
function drop(zone: string, cardId: string, options: { before?: string; cut?: { from: number; to: number } } = {}): void {
  if (!session) return
  const { base } = session
  let next = mapping
  let id = cardId
  if (options.cut) {
    const split = cut(base, next, cardId, options.cut.from, options.cut.to)
    if (!split.piece) return toast('That card sits inside another field’s value. Move it out of that field first, then select part of it.')
    next = split.mapping
    id = split.piece
    splitting = undefined
  }
  if (zone === 'unused') next = unplace(base, next, id)
  else {
    const slotId = zone.slice('slot:'.length)
    const placed = place(base, next, id, slotId, options.before)
    if (placed === next) {
      const slot = base.slots.find((s) => s.slot.id === slotId)?.slot
      return toast(`“${slot?.label}” takes ${slot ? kindName(slot) : 'something else'}, so that card can’t go there.`)
    }
    next = placed
  }
  selected = undefined
  commit(next)
}

/** The card being moved: dragged, or chosen by clicking. */
function movingCard(): Card | undefined {
  if (!session) return undefined
  if (dragging) return dragging.cut ? pieceOf(dragging.card, dragging.cut.from, dragging.cut.to) : dragging.card
  return selected ? cardIndex(session.base, mapping).get(selected) : undefined
}

/** While a card is being moved, greys out the slots that can't take it. */
function markChoosing(): void {
  const card = movingCard()
  document.body.classList.toggle('choosing', !!card)
  for (const zone of document.querySelectorAll<HTMLElement>('[data-zone]')) {
    zone.classList.remove('accept', 'refuse', 'over')
    if (!card) continue
    zone.classList.add(canDrop(zone.dataset.zone!, card) ? 'accept' : 'refuse')
  }
}

function canDrop(zone: string, card: Card): boolean {
  if (zone === 'unused') return true
  const slot = session?.base.slots.find((s) => s.slot.id === zone.slice('slot:'.length))?.slot
  return !!slot && FILLABLE.has(slot.kind) && accepts(slot, card)
}

/** A stand-in for a part of a card that is being dragged, to check where it can go. */
function pieceOf(card: Card, from: number, to: number): Card {
  const text = (card.cutText ?? card.text).slice(from, to)
  return { ...card, id: `${card.id}~drag`, kind: 'piece', label: '', key: '', text, mentions: [], units: [], listed: false }
}

/** Where a selection of a card's text starts and ends, in that text. */
function selectionInCard(): { cardId: string; from: number; to: number } | undefined {
  const selection = getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  const start = closestEl(range.startContainer, '[data-cut]')
  const end = closestEl(range.endContainer, '[data-cut]')
  if (!start || start !== end) return undefined
  const offset = (node: Node, at: number) => {
    const r = document.createRange()
    r.setStart(start, 0)
    r.setEnd(node, at)
    return r.toString().length
  }
  const from = offset(range.startContainer, range.startOffset)
  const to = offset(range.endContainer, range.endOffset)
  return to > from ? { cardId: start.dataset.cut!, from, to } : undefined
}

// ------------------------------------------------------------------------------------ events

// Dragging a card moves it. To select part of its text, its text is made selectable first: with ✂,
// or by double-clicking the text (which also selects the word).
document.addEventListener('dblclick', (e) => {
  const text = closestEl(e.target as Node, '.cut-text')
  const card = text ? closestEl(text, '[data-card]') : undefined
  if (!card || splitting === card.dataset.card) return
  for (const other of document.querySelectorAll<HTMLElement>('.card.splitting')) {
    other.classList.remove('splitting')
    other.draggable = true
  }
  splitting = card.dataset.card
  card.classList.add('splitting')
  card.draggable = false
})

document.addEventListener('dragstart', (e) => {
  if (!session || !e.dataTransfer) return
  const cards = cardIndex(session.base, mapping)
  // Dragging selected text in a card: just that part.
  const part = selectionInCard()
  if (part && closestEl(e.target as Node, '[data-cut]')) {
    const card = cards.get(part.cardId)!
    dragging = { card, cut: { from: part.from, to: part.to } }
    e.dataTransfer.setData('text/plain', (card.cutText ?? '').slice(part.from, part.to))
    e.dataTransfer.effectAllowed = 'copyMove'
    markChoosing()
    return
  }
  const element = closestEl(e.target as Node, '.card[data-card]')
  const card = element ? cards.get(element.dataset.card!) : undefined
  if (!element || !card) return
  dragging = { card }
  e.dataTransfer.setData('text/plain', card.text)
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setDragImage(element, 12, 12)
  markChoosing()
})

document.addEventListener('dragover', (e) => {
  if (!dragging) return
  const zone = closestEl(e.target as Node, '[data-zone]')
  for (const over of document.querySelectorAll('.over, .drop-before')) over.classList.remove('over', 'drop-before')
  if (!zone || !canDrop(zone.dataset.zone!, movingCard()!)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  zone.classList.add('over')
  beforeCard(zone, e.clientY)?.classList.add('drop-before')
})

document.addEventListener('drop', (e) => {
  if (!dragging) return
  const zone = closestEl(e.target as Node, '[data-zone]')
  const moving = dragging
  endDrag()
  if (!zone) return
  e.preventDefault()
  const before = beforeCard(zone, e.clientY)?.dataset.card
  drop(zone.dataset.zone!, moving.card.id, { ...(before && before !== moving.card.id ? { before } : {}), ...(moving.cut ? { cut: moving.cut } : {}) })
})

document.addEventListener('dragend', () => endDrag())

function endDrag(): void {
  dragging = undefined
  for (const over of document.querySelectorAll('.over, .drop-before')) over.classList.remove('over', 'drop-before')
  markChoosing()
}

/** In a section, the card the dropped one goes before (by the pointer's height). */
function beforeCard(zone: HTMLElement, y: number): HTMLElement | undefined {
  if (!zone.classList.contains('kind-rich') && !zone.classList.contains('kind-links')) return undefined
  const cards = [...zone.querySelectorAll<HTMLElement>(':scope > .zone-cards > .card')]
  return cards.find((card) => {
    const box = card.getBoundingClientRect()
    return y < box.top + box.height / 2
  })
}

document.addEventListener('click', (e) => {
  if (!session) return
  const target = e.target as HTMLElement
  const action = closestEl(target, '[data-action]')
  if (action) return onAction(action, e)
  if (closestEl(target, 'input, textarea, a, label')) return
  const card = closestEl(target, '.card[data-card]')
  // Clicks in a card being split select text; they don't choose the card.
  if (card && card.dataset.card === splitting) return
  if (card) {
    selected = selected === card.dataset.card ? undefined : card.dataset.card
    return render()
  }
  const zone = closestEl(target, '[data-zone]')
  if (zone && selected) drop(zone.dataset.zone!, selected)
})

document.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement
  if (target.dataset.action === 'remember' && target.dataset.slot) commit(setRemember(mapping, target.dataset.slot, target.checked))
})

function onAction(element: HTMLElement, e: Event): void {
  if (!session) return
  const { base } = session
  const slotId = element.dataset.slot
  const cardId = element.dataset.card
  switch (element.dataset.action) {
    case 'tab':
      tab = Number(element.dataset.tab)
      return render()
    case 'split':
      splitting = splitting === cardId ? undefined : cardId
      getSelection()?.removeAllRanges()
      return render()
    case 'more':
      if (cardId) expanded.has(cardId) ? expanded.delete(cardId) : expanded.add(cardId)
      return render()
    case 'unplace':
      if (cardId) commit(unplace(base, mapping, cardId))
      return
    case 'clear':
      if (slotId) commit(clearSlot(mapping, slotId))
      return
    case 'type':
      editing = slotId
      render()
      document.querySelector<HTMLElement>(`[data-type-input="${CSS.escape(slotId ?? '')}"]`)?.focus()
      return
    case 'save-type': {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-type-input="${CSS.escape(slotId ?? '')}"]`)
      editing = undefined
      if (slotId && input) commit(typeValue(mapping, slotId, input.value))
      else render()
      return
    }
    case 'cancel-type':
      editing = undefined
      return render()
    case 'pick':
      if (slotId && cardId) drop(`slot:${slotId}`, cardId)
      return
    case 'ghost':
      if (slotId) commit(useGhost(base, mapping, slotId))
      return
    case 'up':
    case 'down':
      if (slotId && cardId) move(slotId, cardId, element.dataset.action === 'up' ? -1 : 1)
      return
    case 'remember':
      return
  }
  e.preventDefault()
}

/** Moves a card up or down in its section. */
function move(slotId: string, cardId: string, by: -1 | 1): void {
  if (!session) return
  const list = mapping.slots[slotId] ?? []
  const at = list.indexOf(cardId)
  if (at < 0) return
  const target = at + by
  if (target < 0 || target >= list.length) return
  const before = by < 0 ? list[target] : list[target + 1]
  commit(place(session.base, mapping, cardId, slotId, before))
}

document.addEventListener('keydown', (e) => {
  if (!session) return
  const target = e.target as HTMLElement
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !closestEl(target, 'input, textarea')) {
    e.preventDefault()
    return undo()
  }
  if (e.key === 'Escape') {
    if (editing) editing = undefined
    selected = undefined
    splitting = undefined
    return render()
  }
  const input = target.dataset.typeInput
  if (input && e.key === 'Enter' && (target instanceof HTMLInputElement || e.ctrlKey)) {
    e.preventDefault()
    editing = undefined
    return void commit(typeValue(mapping, input, (target as HTMLInputElement).value))
  }
  if (closestEl(target, 'input, textarea, button')) return
  const card = target.matches('.card[data-card]') ? target : undefined
  if (card) {
    const id = card.dataset.card!
    const inSlot = card.dataset.in?.startsWith('slot:') ? card.dataset.in.slice(5) : undefined
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      // With another card chosen, Enter on a card in a section puts the chosen one before it.
      if (selected && selected !== id && inSlot) return drop(`slot:${inSlot}`, selected, { before: id })
      selected = selected === id ? undefined : id
      return render()
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && inSlot) {
      e.preventDefault()
      return void commit(unplace(session.base, mapping, id))
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && inSlot) {
      e.preventDefault()
      return move(inSlot, id, e.key === 'ArrowUp' ? -1 : 1)
    }
    return
  }
  const zone = target.matches('[data-zone]') ? target : undefined
  if (zone && selected && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    drop(zone.dataset.zone!, selected)
  }
})

// Selecting part of a card's text offers a button to make a card of it (for clicking or the keyboard).
document.addEventListener('selectionchange', () => {
  const part = selectionInCard()
  if (!part) return void (cutButton.hidden = true)
  const box = getSelection()!.getRangeAt(0).getBoundingClientRect()
  cutButton.style.left = `${Math.max(8, Math.min(innerWidth - 260, box.left))}px`
  cutButton.style.top = `${Math.min(innerHeight - 40, box.bottom + 6)}px`
  cutButton.hidden = false
})
cutButton.addEventListener('mousedown', (e) => e.preventDefault())
cutButton.addEventListener('click', () => {
  const part = selectionInCard()
  cutButton.hidden = true
  if (!part || !session) return
  const split = cut(session.base, mapping, part.cardId, part.from, part.to)
  if (!split.piece) return toast('That card sits inside another field’s value. Move it out of that field first, then select part of it.')
  getSelection()?.removeAllRanges()
  selected = split.piece
  splitting = undefined
  commit(split.mapping)
  toast('Now click the field it goes in, or drag it there.')
})

// ----------------------------------------------------------------------------------- helpers

function closestEl(node: Node | null, selector: string): HTMLElement | undefined {
  const element = node instanceof Element ? node : node?.parentElement
  return (element?.closest(selector) as HTMLElement | null) ?? undefined
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Which element had the focus, so it gets it back after drawing again. */
function focusKey(): string | undefined {
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return undefined
  if (active.dataset.card && active.dataset.in) return `.card[data-card="${CSS.escape(active.dataset.card)}"][data-in="${CSS.escape(active.dataset.in)}"]`
  if (active.dataset.card && active.dataset.action) return `[data-action="${CSS.escape(active.dataset.action)}"][data-card="${CSS.escape(active.dataset.card)}"]`
  if (active.dataset.card) return `.card[data-card="${CSS.escape(active.dataset.card)}"]`
  if (active.dataset.slotId) return `[data-slot-id="${CSS.escape(active.dataset.slotId)}"]`
  return undefined
}

function restoreFocus(key: string | undefined): void {
  if (!key) return
  const element = document.querySelector<HTMLElement>(key) ?? (key.includes('[data-in') ? document.querySelector<HTMLElement>(key.replace(/\[data-in="[^"]*"\]/, '')) : null)
  element?.focus({ preventScroll: true })
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(message: string): void {
  toastBox.textContent = message
  toastBox.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastBox.hidden = true), 4500)
}
