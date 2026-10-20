import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { cleanLabel } from './labels.js'
import { blockText, runText, runsText, type AnyBlock } from './template.js'

/**
 * Finds label-and-value pairs in a converted clip. This runs on LegendKeeper blocks after
 * conversion and linking, so values keep their formatting and page links.
 *
 * Patterns:
 *   - A heading, or a short label on its own line: a section (everything up to the next one).
 *   - A short label on its own line followed by a short line: a pair ("STR" / "8 (-1)").
 *   - A paragraph starting with bold text: one pair per bold label ("**AC** 15 **Initiative** +2").
 *   - A paragraph starting with a label the template uses: one pair per such label
 *     ("Armor Class 15 (leather armor)"), which is how D&D Beyond writes stat blocks.
 *   - "Label: value".
 *   - Table rows whose first cell is a label; a table of one header row and one data row (STR DEX CON…).
 *   - Images.
 *
 * Every candidate names the parts of the clip it uses ("units"), so a value used in the template is
 * not repeated in the unused content, and two candidates that overlap are never both used.
 */

export type CandidateKind = 'pair' | 'section' | 'image'

export interface Candidate {
  id: string
  /** The label as it appears in the clip. */
  label: string
  key: string
  kind: CandidateKind
  /** For pairs: the value as one line of runs. */
  runs?: Run[]
  /** The value as blocks (a pair's value is one paragraph). */
  blocks: Block[]
  /** Plain text of the value, for the review screen and the AI check. */
  text: string
  /**
   * A named entry rather than a field label: "**Multiattack.** The assassin makes…" (the label
   * ends with a full stop). Entries are what a section holds, so they don't tie a block to a field.
   */
  entry?: boolean
  /** For a value the AI copied: the top-level blocks it appears in. */
  found?: number[]
  /** For a heading's section: the heading's level, so its sub-headings keep their depth under the template's heading. */
  level?: number
  /**
   * The parts of the clip this uses: "b3" is top-level block 3, "b3.r1" a table row, "b3.c2" a
   * table column, "b3.s0" a paragraph segment. For a section, units[0] is its heading or label line
   * and units[k + 1] is blocks[k].
   */
  units: string[]
}

export interface Extraction {
  candidates: Candidate[]
  /** Paragraphs split into labelled segments, so unused segments can be kept. */
  split: Map<number, { runs: Run[]; segments: { from: number; to: number; unit: string }[] }>
  /** A table's caption ("Core Bard Traits", a bold line just before it), by the caption's block index: the table's index. */
  captions: Map<number, number>
}

export interface ExtractOptions {
  /** Cleaned labels (with their synonyms) used by the template, which may start a line without bold or a colon. */
  knownLabels: Iterable<string>
  /**
   * Other labels worth recognising though the template has no field for them (every label in the
   * synonym list, such as "Saving Throws"), so their values aren't mistaken for unlabelled text.
   * Only labels of two or more words are used, and only at the start of a short line.
   */
  vocabulary?: Iterable<string>
}

/** Lines longer than this are prose, where a vocabulary label is more likely the start of a sentence. */
const VOCABULARY_LINE_CHARS = 160

const MAX_LABEL_WORDS = 6
const MAX_LABEL_CHARS = 48
const SHORT_VALUE_CHARS = 80

export function extractCandidates(blocks: Block[], options: ExtractOptions): Extraction {
  const known = [...new Set([...options.knownLabels].filter(Boolean))].sort((a, b) => b.length - a.length)
  const knownSet = new Set(known)
  const withVocabulary = [...new Set([...known, ...[...(options.vocabulary ?? [])].filter((l) => l.includes(' '))])].sort((a, b) => b.length - a.length)
  const candidates: Candidate[] = []
  const split: Extraction['split'] = new Map()
  const captions: Extraction['captions'] = new Map()
  const add = (c: Omit<Candidate, 'id' | 'key'>) => {
    const key = cleanLabel(c.label)
    if (key) candidates.push({ ...c, id: `c${candidates.length}`, key })
  }
  const list = blocks as AnyBlock[]

  /** A line that is only a label: a known label, or short bold text. */
  const loneLabel = (block: AnyBlock | undefined): string | undefined => {
    if (!block || block.kind !== 'paragraph') return undefined
    const text = runsText(block.content).trim()
    if (!text || text.length > MAX_LABEL_CHARS) return undefined
    if (knownSet.has(cleanLabel(text))) return text
    const runs = (block.content as Run[]).filter((r) => !('text' in r) || r.text.trim() !== '')
    // A link to a page inside a bold line ("Core [[Bard]] Traits") doesn't make it less of a label.
    const allBold = runs.some((r) => 'text' in r && r.bold) && runs.every((r) => ('text' in r && r.bold) || 'mention' in r)
    return allBold && text.split(/\s+/).length <= MAX_LABEL_WORDS && !/[.!?]$/.test(text) ? text : undefined
  }

  /** Dividers that end a section of label lines: the end of a stat block. */
  const statBlockEnds = new Set<number>()

  for (let i = 0; i < list.length; i++) {
    const block = list[i]!
    if (block.kind === 'heading') {
      const level = block.level as number
      let end = i + 1
      while (end < list.length && !(list[end]!.kind === 'heading' && (list[end]!.level as number) <= level)) end++
      const body = list.slice(i + 1, end) as Block[]
      if (body.length > 0) add({ label: runsText(block.content).trim(), kind: 'section', blocks: body, text: body.map((b) => blockText(b as AnyBlock)).join('\n'), units: range(i, end), level })
      continue
    }
    if (block.kind === 'image') {
      add({ label: 'Image', kind: 'image', blocks: [block as Block], text: String(block.alt ?? block.url ?? ''), units: [`b${i}`] })
      continue
    }
    if (block.kind === 'table') {
      tableCandidates(block, i, add)
      nestedImages(block, add)
      continue
    }
    if (block.kind !== 'paragraph') nestedImages(block, add)
    if (block.kind !== 'paragraph') continue

    const lone = loneLabel(block)
    if (lone && list[i + 1]?.kind === 'table' && lone.length <= 60) captions.set(i, i + 1)
    if (lone) {
      const next = list[i + 1]
      // "STR" then "8 (-1)": a pair, when the next line is short and not itself a label.
      if (next?.kind === 'paragraph' && !loneLabel(next)) {
        const text = runsText(next.content).trim()
        if (text && text.length <= SHORT_VALUE_CHARS) add({ label: lone, kind: 'pair', runs: next.content as Run[], blocks: [next as Block], text, units: [`b${i}`, `b${i + 1}`] })
      }
      // "Traits" then its entries, up to the next heading, label line or divider.
      let end = i + 1
      while (end < list.length && list[end]!.kind !== 'heading' && list[end]!.kind !== 'rule' && !loneLabel(list[end])) end++
      const body = list.slice(i + 1, end) as Block[]
      if (body.length > 0) add({ label: lone, kind: 'section', blocks: body, text: body.map((b) => blockText(b as AnyBlock)).join('\n'), units: range(i, end) })
      if (list[end]?.kind === 'rule') statBlockEnds.add(end)
      continue
    }

    const runs = block.content as Run[]
    const short = runsText(runs).trim().length <= VOCABULARY_LINE_CHARS
    const segments = boldSegments(runs) ?? knownSegments(runs, short ? withVocabulary : known) ?? colonSegment(runs)
    if (!segments) continue
    const pieces = splitRuns(runs, segments.flatMap((s) => [s.labelEnd, s.end]))
    const out: { from: number; to: number; unit: string }[] = []
    segments.forEach((segment, n) => {
      const unit = `b${i}.s${n}`
      const labelRuns = sliceText(pieces.runs, pieces.offsets, segment.start, segment.labelEnd)
      const valueRuns = trimRuns(sliceText(pieces.runs, pieces.offsets, segment.labelEnd, segment.end))
      const rawLabel = runsText(labelRuns).trim()
      const label = rawLabel.replace(/[:.]$/, '').trim()
      const text = runsText(valueRuns).trim().replace(/^[:–—-]\s*/, '')
      if (!label || !text) return
      // "**Tiamat** is a supremely strong…": a bold subject starting a sentence, not a label.
      if (!/[:.]$/.test(rawLabel) && !/^[:–—-]/.test(runsText(valueRuns).trim()) && text.length > 120 && /^\p{Ll}/u.test(text)) return
      // In a row the value alone; in a text field the whole entry, so "**Shortbow.** Ranged…" keeps its name.
      const whole = trimRuns(sliceText(pieces.runs, pieces.offsets, segment.start, segment.end))
      add({ label, kind: 'pair', runs: stripLeadingColon(valueRuns), blocks: [{ kind: 'paragraph', content: whole }], text, units: [unit], ...(/\.$/.test(rawLabel) ? { entry: true } : {}) })
      out.push({ from: indexAt(pieces.offsets, segment.start), to: indexAt(pieces.offsets, segment.end), unit })
    })
    if (out.length > 0) split.set(i, { runs: pieces.runs, segments: out })
  }
  // A stat block's creature description follows it with no heading of its own (D&D Beyond's lore,
  // tables and images under the stat block): everything after the divider is the "Description".
  // When the site gives it a heading or label, that labels it instead.
  for (const i of statBlockEnds) {
    const next = list[i + 1]
    if (!next || next.kind === 'heading' || loneLabel(next)) continue
    const body = list.slice(i + 1) as Block[]
    add({ label: 'Description', kind: 'section', blocks: body, text: body.map((b) => blockText(b as AnyBlock)).join('\n'), units: range(i, list.length) })
  }
  return { candidates, split, captions }
}

/**
 * An image inside a table or list (a wiki infobox's portrait) can fill an image slot. It uses no
 * part of the clip, so the table keeps its copy.
 */
function nestedImages(block: AnyBlock, add: (c: Omit<Candidate, 'id' | 'key'>) => void): void {
  for (const child of (block.children ?? []) as AnyBlock[]) {
    if (child.kind === 'image') add({ label: 'Image', kind: 'image', blocks: [child as Block], text: String(child.alt ?? child.url ?? ''), units: [] })
    else nestedImages(child, add)
  }
}

function range(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, k) => `b${from + k}`)
}

function tableCandidates(table: AnyBlock, i: number, add: (c: Omit<Candidate, 'id' | 'key'>) => void): void {
  const rows = (table.children ?? []) as AnyBlock[]
  const cells = (row: AnyBlock) => (row.children ?? []) as AnyBlock[]
  const cellRuns = (cell: AnyBlock): Run[] => {
    const out: Run[] = []
    for (const child of (cell.children ?? []) as AnyBlock[]) {
      if (!Array.isArray(child.content)) continue
      if (out.length) out.push({ break: true })
      out.push(...(child.content as Run[]))
    }
    return out
  }
  // A header row over one data row: each column is a pair (STR / 18 (+4)).
  const abilityRow = (row: AnyBlock) => {
    const [first, ...rest] = cells(row)
    return !!first && abilityValue(blockText(first).trim(), rest.map((cell) => blockText(cell).trim())) !== undefined
  }
  if (rows.length === 2 && cells(rows[0]!).length >= 2 && cells(rows[0]!).length === cells(rows[1]!).length && cells(rows[0]!).every((c) => c.header) && !abilityRow(rows[1]!)) {
    cells(rows[0]!).forEach((header, c) => {
      const value = cellRuns(cells(rows[1]!)[c]!)
      const text = runsText(value).trim()
      if (text) add({ label: blockText(header).trim(), kind: 'pair', runs: value, blocks: [{ kind: 'paragraph', content: value }], text, units: [`b${i}.c${c}`] })
    })
    return
  }
  rows.forEach((row, r) => {
    const [first, ...rest] = cells(row)
    if (!first || rest.length === 0) return
    const label = blockText(first).trim()
    if (!label || label.length > MAX_LABEL_CHARS || /^[\d\s.,+\-–()/%]+$/.test(label)) return
    const ability = abilityValue(label, rest.map((cell) => blockText(cell).trim()))
    if (ability) {
      add({ label, kind: 'pair', runs: [{ text: ability }], blocks: [{ kind: 'paragraph', content: [{ text: ability }] }], text: ability, units: [`b${i}.r${r}`] })
      return
    }
    const value: Run[] = []
    for (const cell of rest) {
      const runs = cellRuns(cell)
      if (runs.length === 0) continue
      if (value.length) value.push({ text: ' ' })
      value.push(...runs)
    }
    const text = runsText(value).trim()
    if (text) add({ label, kind: 'pair', runs: value, blocks: [{ kind: 'paragraph', content: value }], text, units: [`b${i}.r${r}`] })
  })
}

const ABILITY = /^(?:str|dex|con|int|wis|cha|strength|dexterity|constitution|intelligence|wisdom|charisma)$/i
const SIGNED = /^[+\-−–]?\d+$/

/**
 * A row of a 2024 stat block's ability table, "STR | 30 | +10 | +10" under "MOD" and "SAVE", as the
 * value an ability field takes: "30 (+10)", with the saving throw added only when it differs from
 * the modifier: "11 (+0, Save +8)".
 */
export function abilityValue(label: string, cells: string[]): string | undefined {
  if (!ABILITY.test(label)) return undefined
  const [score, mod, save, ...more] = cells.filter((c) => c !== '')
  if (!score || !mod || more.length > 0 || !/^\d+$/.test(score) || !SIGNED.test(mod) || (save !== undefined && !SIGNED.test(save))) return undefined
  const norm = (n: string) => Number(n.replace(/[−–]/g, '-'))
  return save === undefined || norm(save) === norm(mod) ? `${score} (${mod})` : `${score} (${mod}, Save ${save})`
}

interface Segment {
  /** Character offsets into the paragraph's text. */
  start: number
  labelEnd: number
  end: number
}

/** "**AC** 15 **Initiative** +2": a segment per bold run that starts the paragraph or follows a space. */
function boldSegments(runs: Run[]): Segment[] | undefined {
  const first = runs.find((r) => !('text' in r) || r.text.trim() !== '')
  if (!first || !('text' in first) || !first.bold) return undefined
  const starts: { start: number; labelEnd: number }[] = []
  let offset = 0
  let previous = ''
  for (const run of runs) {
    const text = runText(run)
    const isBold = 'text' in run && !!run.bold && text.trim() !== ''
    if (isBold && (starts.length === 0 || /\s$/.test(previous))) {
      const words = text.trim().split(/\s+/).length
      if (words <= MAX_LABEL_WORDS) {
        const lead = text.length - text.trimStart().length
        starts.push({ start: offset + lead, labelEnd: offset + text.trimEnd().length })
      }
    } else if (isBold && starts.length > 0 && starts.at(-1)!.labelEnd === offset) {
      starts.at(-1)!.labelEnd = offset + text.trimEnd().length
    }
    previous = text
    offset += text.length
  }
  if (starts.length === 0) return undefined
  return starts.map((s, n) => ({ ...s, end: n + 1 < starts.length ? starts[n + 1]!.start : offset }))
}

/**
 * "Armor Class 15 (leather armor, shield)": a paragraph that starts with a label the template
 * knows, split again at each later known label that starts with a capital letter and follows a
 * value ("Armor Class 15 Hit Points 7"), but not inside a list ("Saving Throws DEX +6, INT +4").
 */
function knownSegments(runs: Run[], known: string[]): Segment[] | undefined {
  if (known.length === 0) return undefined
  const text = runsText(runs)
  const lead = text.length - text.trimStart().length
  const found = labelAt(text, lead, known)
  if (found === undefined) return undefined
  const starts = [{ start: lead, labelEnd: lead + found }]
  for (let pos = lead + found; pos < text.length; pos++) {
    if (!/\s/.test(text[pos - 1]!) || !/\p{Lu}/u.test(text[pos]!)) continue
    const length = labelAt(text, pos, known)
    // "Saving Throws DEX +6, INT +4": a label straight after another, or after a comma, is part of a value.
    const before = text.slice(starts.at(-1)!.labelEnd, pos).trim()
    if (length !== undefined && before !== '' && !/[,;]$/.test(before)) {
      starts.push({ start: pos, labelEnd: pos + length })
      pos += length
    }
  }
  return starts.map((s, n) => ({ ...s, end: n + 1 < starts.length ? starts[n + 1]!.start : text.length }))
}

/** The length of a known label at `pos`, followed by a space or colon and more text. */
function labelAt(text: string, pos: number, known: string[]): number | undefined {
  const rest = text.slice(pos)
  const lower = rest.toLowerCase()
  for (const label of known) {
    if (!lower.startsWith(label)) continue
    const after = rest.slice(label.length)
    if (/^:?\s+\S/.test(after) || /^:\S/.test(after)) return label.length + (after.startsWith(':') ? 1 : 0)
  }
  return undefined
}

/** "Label: value", with a short label before the first colon. */
function colonSegment(runs: Run[]): Segment[] | undefined {
  const text = runsText(runs)
  const match = /^\s*([^:\n]{1,48}):\s+\S/.exec(text)
  if (!match || match[1]!.trim().split(/\s+/).length > MAX_LABEL_WORDS || /^https?$/i.test(match[1]!.trim())) return undefined
  const lead = text.length - text.trimStart().length
  return [{ start: lead, labelEnd: lead + match[1]!.trimStart().length + 1, end: text.length }]
}

/** Splits runs so each offset falls on a run boundary. Returns the runs and each run's start offset. */
export function splitRuns(runs: Run[], cuts: number[]): { runs: Run[]; offsets: number[] } {
  const wanted = new Set(cuts)
  const out: Run[] = []
  const offsets: number[] = []
  let offset = 0
  for (const run of runs) {
    if (!('text' in run)) {
      out.push(run)
      offsets.push(offset)
      offset += runText(run).length
      continue
    }
    let start = 0
    for (let k = 1; k < run.text.length; k++) {
      if (wanted.has(offset + k)) {
        out.push({ ...run, text: run.text.slice(start, k) })
        offsets.push(offset + start)
        start = k
      }
    }
    out.push({ ...run, text: run.text.slice(start) })
    offsets.push(offset + start)
    offset += run.text.length
  }
  return { runs: out, offsets }
}

function indexAt(offsets: number[], offset: number): number {
  const i = offsets.findIndex((o) => o >= offset)
  return i === -1 ? offsets.length : i
}

function sliceText(runs: Run[], offsets: number[], from: number, to: number): Run[] {
  return runs.slice(indexAt(offsets, from), indexAt(offsets, to))
}

function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  const first = out[0]
  if (first && 'text' in first) first.text = first.text.trimStart()
  const last = out.at(-1)
  if (last && 'text' in last) last.text = last.text.trimEnd()
  return out.filter((r) => !('text' in r) || r.text !== '')
}

function stripLeadingColon(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  const first = out[0]
  if (first && 'text' in first) first.text = first.text.replace(/^[:–—-]\s*/, '')
  return out.filter((r) => !('text' in r) || r.text !== '')
}

/**
 * The clip without the parts used in the template: whole blocks, table rows, and paragraph
 * segments. A table whose every column was used goes too.
 */
export function leftoverBlocks(blocks: Block[], extraction: Pick<Extraction, 'split' | 'captions'>, used: Iterable<string>): Block[] {
  return leftoverEntries(blocks, extraction, used).map((entry) => entry.block)
}

/** leftoverBlocks, with the top-level index each block comes from. */
export function leftoverEntries(blocks: Block[], extraction: Pick<Extraction, 'split' | 'captions'>, used: Iterable<string>): { index: number; block: Block }[] {
  const units = new Set(used)
  const gone = goneBlocks(blocks, extraction, units)
  const out: { index: number; block: Block }[] = []
  blocks.forEach((block, i) => {
    if (gone.has(i)) return
    const split = extraction.split.get(i)
    if (split && split.segments.some((s) => units.has(s.unit))) {
      const keep: Run[] = split.runs.slice(0, split.segments[0]!.from)
      for (const segment of split.segments) if (!units.has(segment.unit)) keep.push(...split.runs.slice(segment.from, segment.to))
      if (runsText(keep).trim()) out.push({ index: i, block: { ...block, content: keep } as Block })
      return
    }
    if (block.kind === 'table') {
      const rows = block.children.filter((_, r) => !units.has(`b${i}.r${r}`))
      if (rows.length < block.children.length) {
        out.push({ index: i, block: { ...block, children: rows as typeof block.children } })
        return
      }
    }
    out.push({ index: i, block })
  })
  return out
}

/**
 * Top-level blocks wholly used: used themselves, a table whose every row (or column) is used, a
 * caption whose table is gone, and a heading everything under which is gone ("Becoming a Bard…"
 * once both its lists are in fields).
 */
export function goneBlocks(blocks: Block[], extraction: Pick<Extraction, 'captions'>, units: Set<string>): Set<number> {
  const gone = new Set<number>()
  blocks.forEach((block, i) => {
    if (units.has(`b${i}`)) gone.add(i)
    else if (block.kind === 'table') {
      const rows = block.children.length
      const columns = (block.children[0] as AnyBlock | undefined)?.children?.length ?? 0
      // A header row ("MOD", "SAVE") goes with the rows under it.
      const headerRow = (r: number) => ((block.children[r] as AnyBlock).children as AnyBlock[]).every((cell) => cell.header || blockText(cell).trim() === '')
      const usedRows = Array.from({ length: rows }, (_, r) => units.has(`b${i}.r${r}`))
      const allRows = usedRows.some(Boolean) && usedRows.every((used, r) => used || headerRow(r))
      const allColumns = columns > 0 && Array.from({ length: columns }, (_, c) => units.has(`b${i}.c${c}`)).every(Boolean)
      if (allRows || allColumns) gone.add(i)
    }
  })
  for (const [caption, table] of extraction.captions) if (gone.has(table)) gone.add(caption)
  // Deepest headings first, so a heading over emptied sub-headings goes too.
  const headings = blocks.map((b, i) => (b.kind === 'heading' ? i : -1)).filter((i) => i >= 0).sort((a, b) => (blocks[b] as AnyBlock).level - (blocks[a] as AnyBlock).level)
  for (const i of headings) {
    if (gone.has(i)) continue
    const level = (blocks[i] as AnyBlock).level as number
    let end = i + 1
    while (end < blocks.length && !(blocks[end]!.kind === 'heading' && ((blocks[end] as AnyBlock).level as number) <= level)) end++
    if (end > i + 1 && Array.from({ length: end - i - 1 }, (_, k) => i + 1 + k).every((k) => gone.has(k))) gone.add(i)
  }
  return gone
}

/** True when two candidates share any part of the clip. */
export function overlaps(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(`${y}.`) || y.startsWith(`${x}.`)))
}
