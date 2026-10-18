import type { Box, PageContent, PdfImage, PdfText } from './types.js'

/**
 * Turns positioned PDF text into reading-order blocks: headings, paragraphs, lists, tables,
 * images and stat blocks.
 *
 * Works on what `extractPage` reads, with no pdf.js or DOM, so it runs (and is tested) in Node.
 * The rules, in order:
 *   1. Text runs on the same baseline join into lines; a wide gap splits a line into segments
 *      (separate columns, or table cells).
 *   2. Each page's gutter is found from where text never sits across the whole document. A line
 *      that crosses it spans the page (a title, a wide table); the lines between two spanning lines
 *      are read left column first, then right.
 *   3. Text styles (font + size) are ranked: the most used one is body text, larger distinct styles
 *      become heading levels. `ReflowOptions.styles` corrects any that come out wrong.
 *   4. Lines join into paragraphs unless something says a new one starts: a gap, an indent, a short
 *      line ending a sentence, a bold lead-in ("Armor Class:"), a bullet or a change of font.
 *   5. Rows of aligned segments become tables; a heading followed by "Armor Class" starts a stat block.
 */

export type Role = 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'ignore'

export interface TextStyle {
  /** "Font@size", e.g. "GreyhawkGothic@36". */
  key: string
  font: string
  size: number
  /** Characters set in this style across the document. */
  chars: number
  example: string
  role: Role
  /** False when the role came from `ReflowOptions.styles`. */
  auto: boolean
}

export interface ReflowOptions {
  /** Corrections to the detected roles, by style key. */
  styles?: Record<string, Role>
}

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
}

/** Where a block's lines sit on the original pages, for highlighting. */
export interface PageBox extends Box {
  page: number
}

export type ReflowBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string; page: number; boxes: PageBox[] }
  | { type: 'paragraph'; runs: Run[]; list?: boolean; boxed?: boolean; page: number; boxes: PageBox[] }
  | { type: 'table'; rows: Run[][][]; header: boolean; page: number; boxes: PageBox[] }
  | { type: 'image'; id: string; width: number; height: number; page: number; boxes: PageBox[] }
  | { type: 'statblock'; name: string; blocks: ReflowBlock[]; page: number; boxes: PageBox[] }

export interface ReflowResult {
  blocks: ReflowBlock[]
  styles: TextStyle[]
}

interface Segment extends Box {
  page: number
  items: PdfText[]
  baseline: number
  size: number
  style: string
  /** A contents line ("Credits . . . . 3"). */
  leader?: boolean
  /** Starts with a joined drop cap, so its font differs from the lines after it. */
  dropCap?: boolean
}

type Line =
  | (Box & { kind: 'text'; page: number; segs: Segment[]; col: Column; size: number; baseline: number })
  | (Box & { kind: 'image'; page: number; image: PdfImage; col: Column })

type Column = 'left' | 'right' | 'span'

const STAT_INTERNAL = /^(actions|reactions|bonus actions|legendary actions|lair actions|mythic actions|traits|villain actions)\b/i
const BULLET = /^[•●▪◦■‣∙·]\s*/
const SMALL_CAPS = /SC\d*$|SmallCaps|-SC-/i
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])
const TERMINAL = /[.!?:”"’)\]]$/

export function reflow(pages: PageContent[], options: ReflowOptions = {}): ReflowResult {
  const segsByPage = pages.map((p) => toSegments(p))
  const bodySize = mostUsed(segsByPage.flat().flatMap((s) => s.items.map((i) => [round(i.size), i.str.length] as const))) ?? 10
  for (const segs of segsByPage) joinDropCaps(segs, bodySize)
  const styles = detectStyles(segsByPage.flat(), bodySize, options.styles ?? {})
  const roles = new Map(styles.map((s) => [s.key, s.role]))
  const gutter = findGutter(pages, segsByPage)
  const keepImages = new Set(pickImages(pages).map((i) => `${i.page}:${i.id}`))

  const lines: Line[] = []
  const columnEdges = new Map<string, { left: number; right: number }>()
  const pageLines = pages.map((page, i) => {
    const images = page.images.filter((img) => keepImages.has(`${page.number}:${img.id}`))
    return orderPage(page, segsByPage[i] ?? [], images, gutter, roles)
  })
  // Columns start at the same place on every page (or every other page, when margins mirror),
  // whatever their first line is (a bullet, an indented paragraph), so a paragraph carrying on in
  // the next column can be lined up.
  const pageMin = (ls: Line[], col: Column) => {
    const text = ls.filter((l) => l.kind === 'text' && l.col === col)
    return [Math.round(Math.min(...text.map((l) => l.x0))), text.length] as const
  }
  const columnStart = (parity: number, col: Column) =>
    mostUsed(pageLines.filter((_, i) => (pages[i]?.number ?? 0) % 2 === parity).map((ls) => pageMin(ls, col)).filter(([x]) => Number.isFinite(x)))
  pages.forEach((page, i) => {
    for (const col of ['left', 'right', 'span'] as const) {
      const text = (pageLines[i] ?? []).filter((l): l is Extract<Line, { kind: 'text' }> => l.kind === 'text' && l.col === col)
      if (!text.length) continue
      const min = Math.min(...text.map((l) => l.x0))
      const start = col === 'span' ? undefined : columnStart(page.number % 2, col)
      columnEdges.set(`${page.number}:${col}`, { left: start === undefined ? min : Math.min(min, start), right: Math.max(...text.map((l) => l.x1)) })
    }
    lines.push(...(pageLines[i] ?? []))
  })

  const words = wordSet(segsByPage.flat())
  const blocks = buildBlocks(lines, roles, columnEdges, words, pages)
  return { blocks: groupStatBlocks(blocks), styles }
}

/** The images worth showing: not page backgrounds, not decorations repeated on many pages, not specks. */
export function pickImages(pages: PageContent[]): (PdfImage & { page: number })[] {
  const seen = new Map<string, number>()
  for (const p of pages) for (const id of new Set(p.images.map((i) => `${i.width}x${i.height}:${i.id}`))) seen.set(id, (seen.get(id) ?? 0) + 1)
  const repeated = (img: PdfImage) => pages.length >= 3 && (seen.get(`${img.width}x${img.height}:${img.id}`) ?? 0) >= Math.max(3, pages.length / 2)
  const out: (PdfImage & { page: number })[] = []
  for (const p of pages) {
    const pageArea = p.width * p.height
    for (const img of p.images) {
      const w = Math.min(img.x1, p.width) - Math.max(img.x0, 0)
      const h = Math.min(img.y1, p.height) - Math.max(img.y0, 0)
      if (w < 36 || h < 36 || img.width < 48 || img.height < 48) continue
      if (w * h > pageArea * 0.8) continue
      if (repeated(img)) continue
      // Text printed on top makes it a background: a panel behind a table, a border round a page.
      if (p.text.filter((t) => t.x > img.x0 && t.x < img.x1 && t.y > img.y0 && t.y < img.y1).length >= 8) continue
      if (out.some((o) => o.page === p.number && o.id === img.id)) continue
      // Layout programs often draw an image twice in one place (a knockout layer under the art):
      // the last one drawn is what shows.
      const under = out.findIndex((o) => o.page === p.number && Math.abs(o.x0 - img.x0) < 1 && Math.abs(o.y0 - img.y0) < 1 && Math.abs(o.x1 - img.x1) < 1 && Math.abs(o.y1 - img.y1) < 1)
      if (under >= 0) out.splice(under, 1)
      out.push({ ...img, page: p.number })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// 1. Lines and segments

function toSegments(page: PageContent): Segment[] {
  // Text drawn twice in the same place (outlines, shadows) is read once.
  const seen = new Set<string>()
  const items = page.text
    .filter((t) => {
      const key = `${t.str}|${Math.round(t.x)}|${Math.round(t.y)}`
      if (t.str.trim() === '' || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: PdfText[][] = []
  for (const item of items) {
    const row = rows.at(-1)
    const ref = row?.[0]
    if (row && ref && Math.abs(item.y - ref.y) <= 0.35 * Math.min(item.size, ref.size)) row.push(item)
    else rows.push([item])
  }
  const segs: Segment[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    let current: PdfText[] = []
    const flush = () => {
      if (current.length) segs.push(makeSegment(page.number, current))
      current = []
    }
    const start = segs.length
    for (const item of row) {
      const prev = current.at(-1)
      if (prev && item.x - (prev.x + prev.w) > 0.9 * Math.max(prev.size, item.size)) flush()
      current.push(item)
    }
    flush()
    // A contents line's dot leaders split it into pieces: put it back together.
    const pieces = segs.splice(start)
    if (pieces.length > 1 && pieces.some((s) => /^[.\s·…]+$|(\.\s*){4,}/.test(s.items.map((i) => i.str).join('')))) segs.push({ ...makeSegment(page.number, pieces.flatMap((s) => s.items)), leader: true })
    else segs.push(...pieces)
  }
  // Page numbers and running footers are not part of the text.
  return segs.filter((s) => !(/^\d{1,4}$/.test(segText(s)) && (s.y0 > page.height * 0.92 || s.y1 < page.height * 0.06)))
}

function makeSegment(page: number, items: PdfText[]): Segment {
  const biggest = items.reduce((a, b) => (b.size > a.size ? b : a))
  const baseline = biggest.y
  return {
    page,
    items,
    baseline,
    size: biggest.size,
    style: `${biggest.font}@${round(biggest.size)}`,
    x0: Math.min(...items.map((i) => i.x)),
    x1: Math.max(...items.map((i) => i.x + i.w)),
    y0: Math.min(...items.map((i) => i.y - i.size * 0.8)),
    y1: Math.max(...items.map((i) => i.y + i.size * 0.2)),
  }
}

function segText(s: Segment): string {
  return segRuns(s).map((r) => r.text).join('')
}

function segRuns(s: Segment): Run[] {
  const runs: Run[] = []
  let prev: PdfText | undefined
  let sofar = ''
  const allSmallCaps = s.items.every((i) => SMALL_CAPS.test(i.font))
  for (const item of s.items) {
    let text = s.leader ? item.str.replace(/(\s*\.){3,}\s*/g, ' … ') : item.str
    if (prev) {
      const gap = item.x - (prev.x + prev.w)
      if (gap > 0.15 * Math.min(prev.size, item.size) && !/\s$/.test(prev.str) && !/^\s/.test(text)) text = ' ' + text
    }
    if (!allSmallCaps && SMALL_CAPS.test(item.font)) text = titleCase(text, sofar)
    sofar += text
    pushRun(runs, { text, bold: item.bold || undefined, italic: item.italic || undefined })
    prev = item
  }
  if (allSmallCaps) {
    let before = ''
    for (const r of runs) { r.text = titleCase(r.text, before); before += r.text }
  }
  return runs
}

/**
 * Small caps fonts set everything as capitals but store a mix of cases ("hired By the seekers"),
 * so their text is put in title case.
 */
function titleCase(text: string, before: string): string {
  let out = ''
  for (const word of text.toLowerCase().split(/(\s+)/)) {
    const context = before + out
    const start = context.trim() === '' || /[:.!?]\s*$/.test(context)
    out += /^\s+$/.test(word) || (!start && SMALL_WORDS.has(word)) || !/[\s(“"'-]$|^$/.test(context) ? word : word.replace(/\p{L}/u, (c) => c.toUpperCase())
  }
  return out
}

function pushRun(runs: Run[], run: Run) {
  const last = runs.at(-1)
  if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic) last.text += run.text
  else if (run.text) runs.push({ ...run })
}

/** Decorative initials ("W" + "elcome") are joined to the line they start. */
function joinDropCaps(segs: Segment[], bodySize: number) {
  for (const cap of [...segs]) {
    const text = segText(cap).trim()
    if (!/^\p{L}$/u.test(text) || cap.size < bodySize * 2.5) continue
    const target = segs
      .filter((s) => s !== cap && s.y0 >= cap.y0 - cap.size * 0.3 && s.y0 <= cap.y1 && s.x0 >= cap.x1 - 4 && s.x0 <= cap.x1 + bodySize * 4)
      .sort((a, b) => a.y0 - b.y0)[0]
    if (!target) continue
    const first = target.items[0]
    if (first) target.items[0] = { ...first, str: text + first.str.replace(/^\s+/, '') }
    target.dropCap = true
    segs.splice(segs.indexOf(cap), 1)
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Columns and reading order

interface Gutter { left: number; right: number }

/** The vertical strip near the middle that text (almost) never crosses, across the whole document. */
function findGutter(pages: PageContent[], segsByPage: Segment[][]): Gutter | null {
  const width = Math.round(Math.max(...pages.map((p) => p.width), 0))
  if (!width) return null
  const cover = new Array<number>(width + 1).fill(0)
  for (const s of segsByPage.flat()) for (let x = Math.max(0, Math.floor(s.x0)); x <= Math.min(width, Math.ceil(s.x1)); x++) cover[x]!++
  const lo = Math.round(width * 0.3)
  const hi = Math.round(width * 0.7)
  const typical = [...cover.slice(lo, hi)].sort((a, b) => a - b)[Math.floor((hi - lo) * 0.75)] ?? 0
  let best: Gutter | null = null
  let bestScore = Infinity
  for (let x = lo; x < hi; x++) {
    let end = x
    while (end + 1 < hi && cover[end + 1]! <= cover[x]! + 1) end++
    if (end - x >= 6 && cover[x]! < bestScore) {
      bestScore = cover[x]!
      best = { left: x, right: end }
    }
  }
  return best && bestScore <= typical * 0.2 ? best : null
}

function orderPage(page: PageContent, segs: Segment[], images: PdfImage[], gutter: Gutter | null, roles: Map<string, Role>): Line[] {
  const isHeading = (l: Line) => l.kind === 'text' && l.segs.length === 1 && !['body', 'ignore'].includes(roles.get(l.segs[0]!.style) ?? 'body')
  const crosses = (b: Box) => !!gutter && b.x0 < gutter.left - 2 && b.x1 > gutter.right + 2
  const twoColumns = !!gutter && segs.filter((s) => s.x1 <= gutter.left + 2).length >= 4 && segs.filter((s) => s.x0 >= gutter.right - 2).length >= 4

  // Rows of segments on the same baseline.
  const rows: Segment[][] = []
  for (const s of [...segs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = rows.at(-1)
    const ref = row?.[0]
    if (row && ref && Math.abs(s.baseline - ref.baseline) <= 0.4 * Math.min(s.size, ref.size)) row.push(s)
    else rows.push([s])
  }

  const textLine = (group: Segment[], col: Column): Line => ({
    kind: 'text', page: page.number, segs: group.sort((a, b) => a.x0 - b.x0), col,
    size: Math.max(...group.map((s) => s.size)), baseline: group[0]!.baseline,
    x0: Math.min(...group.map((s) => s.x0)), x1: Math.max(...group.map((s) => s.x1)),
    y0: Math.min(...group.map((s) => s.y0)), y1: Math.max(...group.map((s) => s.y1)),
  })
  const imageLine = (image: PdfImage, col: Column): Line => ({ kind: 'image', page: page.number, image, col, x0: image.x0, x1: image.x1, y0: image.y0, y1: image.y1 })

  if (!twoColumns || !gutter) {
    const lines = [...rows.map((r) => textLine(r, 'span')), ...images.map((i) => imageLine(i, 'span'))]
    return lines.sort((a, b) => a.y0 - b.y0)
  }

  const spanning: Line[] = []
  const left: Line[] = []
  const right: Line[] = []
  const mid = (gutter.left + gutter.right) / 2
  // A row with cells on both sides of the gutter, next to a wide table row, belongs to that table.
  const wide = rows.map((row) => row.some(crosses))
  const tableRow = (i: number) => wide[i] && (rows[i]?.length ?? 0) >= 2
  // Rows with a wide gap across the gutter, one under another, are one table (or a contents list
  // whose dot leaders are drawn as lines): "Credits ........ 3".
  const gapped = rows.map((row) => row.some((l) => l.x1 < gutter.left - page.width * 0.1) && row.some((r) => r.x0 > gutter.right + page.width * 0.1) && row.every((s) => s.x1 < gutter.left || s.x0 > gutter.right))
  gapped.forEach((g, i) => {
    const near = (j: number) => gapped[j] && Math.abs(rows[j]![0]!.baseline - rows[i]![0]!.baseline) < 3 * rows[i]![0]!.size
    if (g && (near(i - 1) || near(i + 1))) wide[i] = true
  })
  rows.forEach((row, i) => {
    if (wide[i] || row.length < 2 || !row.some((s) => s.x1 < mid) || !row.some((s) => s.x0 > mid)) return
    const near = (j: number) => tableRow(j) && Math.abs(rows[j]![0]!.baseline - row[0]!.baseline) < 2.5 * row[0]!.size
    if (near(i - 1) || near(i + 1)) wide[i] = true
  })
  for (const [i, row] of rows.entries()) {
    if (wide[i]) spanning.push(textLine(row, 'span'))
    else {
      const l = row.filter((s) => (s.x0 + s.x1) / 2 < mid)
      const r = row.filter((s) => (s.x0 + s.x1) / 2 >= mid)
      if (l.length) left.push(textLine(l, 'left'))
      if (r.length) right.push(textLine(r, 'right'))
    }
  }
  for (const img of images) {
    if (crosses(img)) spanning.push(imageLine(img, 'span'))
    else ((img.x0 + img.x1) / 2 < mid ? left : right).push(imageLine(img, (img.x0 + img.x1) / 2 < mid ? 'left' : 'right'))
  }
  spanning.sort((a, b) => a.y0 - b.y0)

  const out: Line[] = []
  let from = -Infinity
  for (let i = 0; i <= spanning.length; i++) {
    const sep = spanning[i]
    const to = sep ? sep.y0 + 0.5 : Infinity
    const inBand = (l: Line) => l.y0 >= from && l.y0 < to
    let bandLeft = left.filter(inBand).sort((a, b) => a.y0 - b.y0)
    const bandRight = right.filter(inBand).sort((a, b) => a.y0 - b.y0)
    // A heading that sits below both columns, just above a spanning line, introduces that line.
    let tail: Line[] = []
    if (sep && bandRight.length) {
      const rightBottom = Math.max(...bandRight.map((l) => l.y1))
      const below = bandLeft.filter((l) => l.y0 > rightBottom + 2)
      if (below[0] && isHeading(below[0])) {
        tail = below
        bandLeft = bandLeft.filter((l) => !tail.includes(l))
      }
    }
    out.push(...bandLeft, ...bandRight, ...tail)
    if (sep) out.push(sep)
    from = to
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// 3. Text styles

function detectStyles(segs: Segment[], bodySize: number, overrides: Record<string, Role>): TextStyle[] {
  const stats = new Map<string, { font: string; size: number; chars: number; segs: number; example: string; pages: Set<number> }>()
  const familyChars = new Map<string, number>()
  for (const s of segs) {
    const biggest = s.items.reduce((a, b) => (b.size > a.size ? b : a))
    const text = segText(s)
    const st = stats.get(s.style) ?? { font: biggest.font, size: round(biggest.size), chars: 0, segs: 0, example: text.slice(0, 60), pages: new Set() }
    // Contents lines ("Credits . . . . 3") are long text, whatever their pieces look like.
    st.chars += s.leader ? 100 : text.length
    st.segs++
    st.pages.add(s.page)
    stats.set(s.style, st)
    for (const i of s.items) familyChars.set(family(i.font), (familyChars.get(family(i.font)) ?? 0) + i.str.length)
  }
  const bodyFamily = [...familyChars].sort((a, b) => b[1] - a[1])[0]?.[0]

  const candidate = (st: { font: string; size: number; chars: number; segs: number }) =>
    st.size >= bodySize * 1.15 &&
    st.chars / st.segs <= 40 &&
    !/italic|oblique/i.test(st.font) &&
    (family(st.font) !== bodyFamily || /bold|black|heavy|semibold/i.test(st.font))
  const ranked = [...new Set([...stats.values()].filter((st) => candidate(st) && st.segs >= 2).map((st) => st.size))].sort((a, b) => b - a)
  const levelFor = (size: number): Role => {
    let rank = ranked.findIndex((r) => r <= size)
    if (rank < 0) rank = ranked.length
    if (ranked[rank] !== size && rank > 0 && !ranked.includes(size)) rank = Math.max(0, rank - 1)
    return (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(rank, 3)]!
  }

  return [...stats].map(([key, st]) => {
    const auto: Role = candidate(st) ? levelFor(st.size) : 'body'
    return { key, font: st.font, size: st.size, chars: st.chars, example: st.example, role: overrides[key] ?? auto, auto: !(key in overrides) }
  }).sort((a, b) => b.size - a.size || b.chars - a.chars)
}

function family(font: string): string {
  return font.split(/[-,]/)[0] ?? font
}

// ---------------------------------------------------------------------------------------------
// 4. Blocks

type Open =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string; page: number; boxes: PageBox[]; last: Line }
  | {
      type: 'paragraph'; runs: Run[]; list?: boolean; family: string; size: number; page: number; boxes: PageBox[]; last: Line
      /** Where the next line should start, measured from its column's left edge (a list item's text, or the last line). */
      offset: number
      lines: number
      dropCap?: boolean
    }
  | { type: 'table'; lines: Segment[][]; page: number; boxes: PageBox[]; last: Line; size: number }

function buildBlocks(
  lines: Line[],
  roles: Map<string, Role>,
  edges: Map<string, { left: number; right: number }>,
  words: Set<string>,
  pages: PageContent[],
): ReflowBlock[] {
  const blocks: ReflowBlock[] = []
  let open: Open | null = null
  const pageOf = new Map(pages.map((p) => [p.number, p]))

  const flush = () => {
    if (!open) return
    if (open.type === 'heading') blocks.push({ type: 'heading', level: open.level, text: open.text.trim(), page: open.page, boxes: open.boxes })
    else if (open.type === 'paragraph') {
      const runs = tidy(open.runs)
      if (runs.length) {
        const boxed = isBoxed(open.boxes, pageOf)
        blocks.push({ type: 'paragraph', runs, ...(open.list ? { list: true } : {}), ...(boxed ? { boxed } : {}), page: open.page, boxes: open.boxes })
      }
    } else blocks.push(...finishTable(open))
    open = null
  }

  for (const line of lines) {
    const box: PageBox = { page: line.page, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 }
    if (line.kind === 'image') {
      flush()
      blocks.push({ type: 'image', id: line.image.id, width: line.image.width, height: line.image.height, page: line.page, boxes: [box] })
      continue
    }
    const segs = line.segs
    if (segs.length >= 2) {
      const last = open?.last
      if (open?.type === 'table' && last && last.page === line.page && line.y0 - last.y1 < 2.5 * line.size) {
        open.lines.push(segs)
        open.boxes.push(box)
        open.last = line
      } else {
        flush()
        open = { type: 'table', lines: [segs], page: line.page, boxes: [box], last: line, size: line.size }
      }
      continue
    }

    const seg = segs[0]!
    const role = roles.get(seg.style) ?? 'body'
    if (role === 'ignore') continue
    const text = segText(seg)

    if (role !== 'body') {
      const level = Number(role.slice(1)) as 1 | 2 | 3 | 4
      if (open?.type === 'heading' && open.level === level && open.last.page === line.page && line.y0 - open.last.y1 < line.size * 0.8) {
        // "Hired" + "By the Seekers": a small word carried to the next line was capitalised as a line start.
        const more = text.trim().replace(/^\p{L}+/u, (w) => (SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w))
        open.text += (open.text.endsWith('-') ? '' : ' ') + more
        open.boxes.push(box)
        open.last = line
      } else {
        flush()
        open = { type: 'heading', level, text, page: line.page, boxes: [box], last: line }
      }
      continue
    }

    // A wrapped table cell: a short line just under the table, inside its width.
    if (open?.type === 'table') {
      const last: Line = open.last
      const row = open.lines.at(-1)!
      if (last.page === line.page && line.y0 - last.y1 < 0.8 * line.size && Math.abs(line.size - open.size) < 1.5 && line.x0 >= open.boxes[0]!.x0 - 2 && line.x1 <= Math.max(...open.boxes.map((b) => b.x1)) + 2) {
        const cell = row.reduce((best, s) => (overlap(s, seg) > overlap(best, seg) ? s : best))
        cell.items.push(...seg.items.map((i, n) => (n === 0 ? { ...i, str: ' ' + i.str.trimStart() } : i)))
        open.boxes.push(box)
        open.last = line
        continue
      }
    }

    const runs = segRuns(seg)
    const fam = mainFamily(seg)
    const colLeft: number = edges.get(`${line.page}:${line.col}`)?.left ?? line.x0
    if (BULLET.test(text)) {
      flush()
      const first = runs[0]
      if (first) first.text = first.text.replace(BULLET, '')
      const textItem = seg.items.find((i) => !BULLET.test(i.str) || i.str.replace(BULLET, '').trim())
      const textX = textItem && BULLET.test(textItem.str) ? seg.x0 + seg.size : textItem?.x ?? seg.x0
      open = { type: 'paragraph', runs, list: true, offset: textX - colLeft, lines: 1, family: fam, size: seg.size, page: line.page, boxes: [box], last: line }
      continue
    }

    if (open?.type === 'paragraph' && continues(open, line, seg, runs, edges)) {
      if (open.dropCap && open.lines === 1) open.family = fam
      appendLine(open.runs, runs, words)
      open.boxes.push(box)
      open.last = line
      if (!open.list || open.lines > 1) open.offset = line.x0 - colLeft
      open.lines++
      continue
    }
    flush()
    open = { type: 'paragraph', runs, offset: line.x0 - colLeft, lines: 1, dropCap: seg.dropCap, family: fam, size: seg.size, page: line.page, boxes: [box], last: line }
  }
  flush()
  return blocks
}

function continues(open: Extract<Open, { type: 'paragraph' }>, line: Extract<Line, { kind: 'text' }>, seg: Segment, runs: Run[], edges: Map<string, { left: number; right: number }>): boolean {
  const prev = open.last
  if (prev.kind !== 'text') return false
  if (seg.leader || prev.segs.some((s) => s.leader)) return false
  // The line after a drop cap's first line changes font (small caps, then the body face).
  const afterDropCap = open.dropCap && open.lines === 1
  if (!afterDropCap && (!seg.items.some((i) => family(i.font) === open.family) || Math.abs(seg.size - open.size) > 1.5)) return false
  const text = open.runs.map((r) => r.text).join('').trimEnd()
  const ended = TERMINAL.test(text)
  const lead = runs[0]?.bold && /^[^a-z].{0,60}[.:]\s*$/.test(runs[0].text)
  // "Handaxe." or "Armor Class:" in bold after a finished sentence starts a new entry.
  if (ended && lead) return false
  const startsBold = !!runs[0]?.bold && /^[^a-z]/.test(runs[0].text) && runs[0].text.trim().length > 1
  const edge = edges.get(`${line.page}:${line.col}`)
  const offset = line.x0 - (edge?.left ?? line.x0)

  if (prev.page !== line.page || prev.col !== line.col) {
    // Carrying on in the next column or page: only mid-sentence, starting where the paragraph's lines start.
    if (ended || startsBold) return false
    return open.lines > 1 || open.list ? Math.abs(offset - open.offset) <= 3 : offset <= open.offset + 3
  }

  if (line.y0 - prev.y1 > 0.9 * seg.size) return false
  if (open.list) return Math.abs(offset - open.offset) <= 3 || (afterDropCap ?? false)
  const prevEdge = edges.get(`${prev.page}:${prev.col}`)
  const centered = (l: Box) => !!prevEdge && Math.abs((l.x0 + l.x1) / 2 - (prevEdge.left + prevEdge.right) / 2) < 4 && l.x0 - prevEdge.left > seg.size
  if (line.x0 - prev.x0 > 0.6 * seg.size && !(centered(line) && centered(prev))) return false
  const short = !!prevEdge && prev.x1 < prevEdge.right - 3 * seg.size
  if (short && (ended || startsBold)) return false
  return true
}

/** The font family most of a segment's text is set in. */
function mainFamily(seg: Segment): string {
  const chars = new Map<string, number>()
  for (const i of seg.items) chars.set(family(i.font), (chars.get(family(i.font)) ?? 0) + i.str.length)
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function appendLine(runs: Run[], next: Run[], words: Set<string>) {
  const last = runs.at(-1)
  const first = next[0]
  if (last && first) {
    const hyphen = /(\p{L}+)-$/u.exec(last.text)
    const after = /^(\p{Ll}+)/u.exec(first.text)
    if (hyphen && after) {
      // A word broken across lines loses its hyphen when the book also prints it whole.
      if (words.has((hyphen[1]! + after[1]!).toLowerCase())) last.text = last.text.slice(0, -1)
    } else if (!/\s$/.test(last.text) && !/^\s/.test(first.text)) {
      last.text += ' '
    }
  }
  for (const r of next) pushRun(runs, { ...r })
}

function tidy(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    pushRun(out, { ...r, text: r.text.replace(/\s+/g, ' ') })
  }
  // Spaces between runs belong to the plain one: "in** bold** text" reads "in **bold** text".
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!
    const b = out[i]!
    const plain = (r: Run) => !r.bold && !r.italic
    if (a.text.endsWith(' ') && !plain(a) && plain(b)) { a.text = a.text.slice(0, -1); if (!b.text.startsWith(' ')) b.text = ' ' + b.text }
    if (b.text.startsWith(' ') && !plain(b) && plain(a)) { b.text = b.text.slice(1); if (!a.text.endsWith(' ')) a.text += ' ' }
  }
  const first = out[0]
  const last = out.at(-1)
  if (first) first.text = first.text.trimStart()
  if (last) last.text = last.text.trimEnd()
  return out.filter((r) => r.text !== '')
}

function finishTable(t: Extract<Open, { type: 'table' }>): ReflowBlock[] {
  if (t.lines.length < 2) {
    // One row of spaced-out text is not a table.
    const runs: Run[] = []
    for (const s of t.lines[0] ?? []) {
      if (runs.length) pushRun(runs, { text: ' ' })
      for (const r of segRuns(s)) pushRun(runs, r)
    }
    return [{ type: 'paragraph', runs: tidy(runs), page: t.page, boxes: t.boxes }]
  }
  // Columns come from the row with the most cells; other rows' cells go to the nearest column.
  const template = t.lines.reduce((a, b) => (b.length > a.length ? b : a))
  t.lines = t.lines.map((segs) => splitToFit(segs, template.length))
  const centers = template.map((s) => (s.x0 + s.x1) / 2)
  const rows: Run[][][] = t.lines.map((segs) => {
    const cells: Run[][] = centers.map(() => [])
    for (const s of segs) {
      let best = 0
      let bestScore = -Infinity
      template.forEach((col, i) => {
        const score = overlap(col, s) - Math.abs((s.x0 + s.x1) / 2 - centers[i]!) * 0.01
        if (score > bestScore) { bestScore = score; best = i }
      })
      const cell = cells[best]!
      if (cell.length) pushRun(cell, { text: ' ' })
      for (const r of segRuns(s)) pushRun(cell, r)
    }
    return cells.map(tidy)
  })
  const header = !!rows[0]?.every((cell) => cell.length === 0 || cell.every((r) => r.bold))
  return [{ type: 'table', rows, header, page: t.page, boxes: t.boxes }]
}

/** Cells set closer than usual ("16 (+3) 12 (+1)") are split at their widest gaps to match the table. */
function splitToFit(segs: Segment[], count: number): Segment[] {
  const out = [...segs]
  while (out.length < count) {
    let best: { seg: number; at: number; gap: number } | null = null
    out.forEach((s, si) => s.items.forEach((item, ii) => {
      const prev = s.items[ii - 1]
      if (!prev) return
      const gap = item.x - (prev.x + prev.w)
      if (gap > 0.4 * item.size && (!best || gap > best.gap)) best = { seg: si, at: ii, gap }
    }))
    if (!best) break
    const { seg, at } = best as { seg: number; at: number }
    const s = out[seg]!
    out.splice(seg, 1, makeSegment(s.page, s.items.slice(0, at)), makeSegment(s.page, s.items.slice(at)))
  }
  return out
}

function overlap(a: Box, b: Box): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
}

/** Boxed text: the paragraph sits on a coloured panel that is not a table stripe or the page. */
function isBoxed(boxes: PageBox[], pages: Map<number, PageContent>): boolean {
  const first = boxes[0]
  const page = first && pages.get(first.page)
  if (!first || !page) return false
  const cx = (first.x0 + first.x1) / 2
  const cy = (first.y0 + first.y1) / 2
  return page.shapes.some((s) =>
    s.fill !== '#ffffff' && s.fill !== '#000000' &&
    (s.x1 - s.x0) * (s.y1 - s.y0) < page.width * page.height * 0.4 &&
    s.y1 - s.y0 > (first.y1 - first.y0) * 2 &&
    cx > s.x0 && cx < s.x1 && cy > s.y0 && cy < s.y1)
}

// ---------------------------------------------------------------------------------------------
// 5. Stat blocks

function groupStatBlocks(blocks: ReflowBlock[]): ReflowBlock[] {
  const out: ReflowBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const head = blocks[i]!
    const acAt = head.type === 'heading' ? blocks.slice(i + 1, i + 4).findIndex((b) => b.type === 'paragraph' && /^(armor class|armour class|ac)\b/i.test(plain(b))) : -1
    if (head.type !== 'heading' || acAt < 0) {
      out.push(head)
      continue
    }
    const ac = blocks[i + 1 + acAt] as Extract<ReflowBlock, { type: 'paragraph' }>
    const inner: ReflowBlock[] = []
    const images: ReflowBlock[] = []
    let j = i + 1
    for (; j < blocks.length; j++) {
      const b = blocks[j]!
      if (b.type === 'image') { images.push(b); continue }
      if (b.type === 'statblock') break
      if (b.type === 'heading' && !STAT_INTERNAL.test(b.text) && b.level <= head.level) break
      if (b.type === 'heading' && b.level < head.level) break
      if (b.type === 'paragraph' && b !== ac && b.boxes[0] && ac.boxes[0] && !sameFace(b, ac)) break
      inner.push(b)
    }
    out.push({ type: 'statblock', name: head.text, blocks: [head, ...inner], page: head.page, boxes: [head, ...inner].flatMap((b) => b.boxes) })
    out.push(...images)
    i = j - 1
  }
  return out
}

/** Paragraphs set in the same typeface family, judged by their size: stat blocks use their own. */
function sameFace(a: Extract<ReflowBlock, { type: 'paragraph' }>, b: Extract<ReflowBlock, { type: 'paragraph' }>): boolean {
  const h = (p: typeof a) => (p.boxes[0]!.y1 - p.boxes[0]!.y0)
  return Math.abs(h(a) - h(b)) < 2.5
}

function plain(b: ReflowBlock): string {
  return b.type === 'paragraph' ? b.runs.map((r) => r.text).join('') : b.type === 'heading' ? b.text : ''
}

// ---------------------------------------------------------------------------------------------
// Helpers

function wordSet(segs: Segment[]): Set<string> {
  const words = new Set<string>()
  for (const s of segs) for (const w of segText(s).toLowerCase().split(/\s+/)) {
    const clean = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    if (clean) words.add(clean)
  }
  return words
}

function mostUsed(pairs: Iterable<readonly [number, number]>): number | undefined {
  const totals = new Map<number, number>()
  for (const [k, n] of pairs) totals.set(k, (totals.get(k) ?? 0) + n)
  return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function round(n: number): number {
  return Math.round(n * 2) / 2
}
