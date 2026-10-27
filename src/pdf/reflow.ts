import type { Box, PageContent, PdfImage, PdfText } from './types.js'

/**
 * Turns positioned PDF text into reading-order blocks: headings, paragraphs, lists, tables,
 * images and stat blocks.
 *
 * Works on what `extractPage` reads, with no pdf.js or DOM, so it runs (and is tested) in Node.
 * The rules, in order:
 *   1. Text runs on the same baseline join into lines; a wide gap splits a line into segments
 *      (separate columns, or table cells).
 *   2. Each page's columns are found from where text never sits: across the pages on its side of
 *      the spine first (books mirror their margins), then the whole book, then the page itself when
 *      it is laid out differently (three columns, a sidebar). A line that crosses every gutter spans
 *      the page (a title, a wide table); the lines between two spanning lines are read column by
 *      column, left to right. A sidebar (a column much narrower than the others) is read after the
 *      rest of the page. `ReflowOptions.layout` sets the book's columns, divider and margins by
 *      hand, and `ReflowOptions.layouts` one page's layout.
 *   3. Text styles (font + size) are ranked: the most used one is body text, larger distinct styles
 *      become heading levels. `ReflowOptions.styles` corrects any that come out wrong.
 *   4. Lines join into paragraphs unless something says a new one starts: a gap, an indent, a short
 *      line ending a sentence, a bold lead-in ("Armor Class:"), a bullet or a change of font.
 *   5. Rows of aligned segments become tables; a heading followed by "Armor Class" starts a stat block.
 *
 * Areas marked by hand (`ReflowOptions.regions`) are taken out before all this: their text is left
 * out, read as one block, or read as a table, and put back where the area sits in the reading order.
 *
 * Scan mode (`ReflowOptions.scan`) is for scanned books with an OCR text layer, where every word has
 * the same font and its own slightly different size and baseline: lines are joined more loosely and
 * headings are found from their size alone.
 */

export type Role = 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'ignore'

/** A page's layout: found by itself, or set by hand. "sidebar" is two columns, the narrower read last. */
export type PageLayout = 'auto' | 'one' | 'two' | 'three' | 'sidebar'

/** What a hand-marked area holds: text to read as one block, text to leave out, or a table. */
export type RegionKind = 'block' | 'skip' | 'table'

/** An area marked on a page, in PDF points from the top left. */
export interface Region extends Box {
  page: number
  kind: RegionKind
}

/** How a page was read. */
export interface PageLayoutInfo {
  page: number
  columns: number
  sidebar: boolean
  /** "auto" unless the layout was set by hand. */
  layout: PageLayout
}

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
  /** The whole book's layout, where finding it automatically goes wrong. */
  layout?: Layout
  /** Layouts set by hand for single pages, by page number. They win over `layout`. */
  layouts?: Record<number, PageLayout>
  /** Areas marked by hand. Where they overlap, the one marked last wins. */
  regions?: Region[]
  /** Scan mode, for OCR text. Left out, it is on when the text looks like OCR (`looksScanned`). */
  scan?: boolean
}

/** Manual help with the whole book's layout. Every part is optional; what is left out is found automatically. */
export interface Layout {
  /** 'auto' finds the columns; 1 reads every page as one column; 2 always splits at the divider. */
  columns?: 'auto' | 1 | 2
  /**
   * Where the two columns divide, as a fraction of the page width, for odd and for even pages
   * (books mirror their margins, so the two sides differ). One value set applies to both.
   */
  divider?: { odd?: number; even?: number }
  /** Edges of every page to leave out, as fractions of its width and height: running heads, page numbers, chapter tabs. */
  margins?: { top?: number; bottom?: number; left?: number; right?: number }
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
  layouts: PageLayoutInfo[]
  /** Where each page's columns divide (the middle of each gutter, x in points), for pages read in columns. */
  dividers: Record<number, number[]>
  /** Whether scan mode was used. */
  scan: boolean
  /** Pages carrying invisible text: a scan with recognised text over it, whose layout is only approximate. */
  scanned: number[]
}

interface Segment extends Box {
  page: number
  items: PdfText[]
  baseline: number
  size: number
  style: string
  /** The style's font and size, as the text styles list shows them. */
  font: string
  styleSize: number
  /** A contents line ("Credits . . . . 3"). */
  leader?: boolean
  /** Starts with a joined drop cap, so its font differs from the lines after it. */
  dropCap?: boolean
  /** Printed on a picture: its name. Never part of a paragraph. */
  caption?: boolean
}

type Line =
  | (Box & { kind: 'text'; page: number; segs: Segment[]; col: Column; side?: boolean; size: number; baseline: number })
  | (Box & { kind: 'image'; page: number; image: PdfImage; col: Column; side?: boolean })
  | (Box & { kind: 'region'; page: number; region: RegionKind | 'panel'; segs: Segment[]; col: Column; side?: boolean })

/** A column's number on its page, counted from the left; SPAN for lines across every column. */
type Column = number
const SPAN = -1

/** How loosely text is put together: tighter for typeset PDFs, looser for OCR. */
interface Tolerance {
  scan: boolean
  /** Items this far from a row's baseline (times their size) are on that row. */
  row: number
  /** The same, for segments joining into a line. */
  line: number
  /** A line starting this much further in (times its size) than the one before starts a paragraph. */
  indent: number
  /** How far (in points) a line may start from where its paragraph's lines start. */
  align: (size: number) => number
  /** How far apart (in points) two sizes may be and still be the same text. */
  sameSize: (size: number) => number
}

function tolerance(scan: boolean): Tolerance {
  return scan
    ? { scan, row: 0.5, line: 0.6, indent: 1, align: (size) => Math.max(3, 0.8 * size), sameSize: (size) => Math.max(1.5, 0.15 * size) }
    : { scan, row: 0.35, line: 0.4, indent: 0.6, align: () => 3, sameSize: () => 1.5 }
}

const STAT_INTERNAL = /^(actions|reactions|bonus actions|legendary actions|lair actions|mythic actions|traits|villain actions)\b/i
const BULLET = /^[•●▪◦■‣∙·]\s*/
const SMALL_CAPS = /SC\d*$|SmallCaps|-SC-/i
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])
const TERMINAL = /[.!?:”"’)\]]$/
/** Fonts that draw rules, ornaments and symbols rather than words. */
const SYMBOL_FONT = /lines|ornament|dingbat|symbol|wingding|webding|zapf|\bpi\b|pi$/i

export function reflow(pages: PageContent[], options: ReflowOptions = {}): ReflowResult {
  const scan = options.scan ?? looksScanned(pages)
  const tol = tolerance(scan)
  const book = options.layout ?? {}
  pages = pages.map((p) => cropPage(p, book.margins))
  // Hand-marked areas come out first: skipped text goes, the rest is read on its own.
  const split = pages.map((p) => splitRegions(p, (options.regions ?? []).filter((r) => r.page === p.number)))
  const segsByPage = split.map((s) => toSegments(dropMarginalia(s.page, tol), tol))
  const regionSegs: { region: Omit<Region, 'kind'> & { kind: RegionKind | 'panel' }; segs: Segment[] }[][] =
    split.map((s) => s.regions.map(({ region, page }) => ({ region, segs: toSegments(page, tol, region.kind === 'table' ? 0.4 : 0.9) })))
  const allSegs = [...segsByPage.flat(), ...regionSegs.flat().flatMap((r) => r.segs)]
  const art = new Map<number, Box[]>()
  const bodySize = (scan
    ? mostUsed(allSegs.map((s) => [s.styleSize, segText(s).length] as const))
    : mostUsed(allSegs.flatMap((s) => s.items.map((i) => [round(i.size), i.str.length] as const)))) ?? 10
  for (const segs of segsByPage) joinDropCaps(segs, bodySize)
  // Coloured panels (boxed text, sidebars, stat blocks on a tint) are read as a unit, like a marked area.
  split.forEach((sp, i) => {
    const segs = segsByPage[i] ?? []
    const panels = findPanels(sp.page, segs, bodySize)
    if (!panels.length) return
    const held = panels.map((panel) => ({ region: { ...panel, page: sp.page.number, kind: 'panel' as const }, segs: segs.filter((s) => centreIn(s, panel)) }))
    segsByPage[i] = segs.filter((s) => !panels.some((panel) => centreIn(s, panel)))
    regionSegs[i] = [...(regionSegs[i] ?? []), ...held]
  })
  const styles = detectStyles(allSegs, bodySize, options.styles ?? {}, scan)
  const roles = new Map(styles.map((s) => [s.key, s.role]))
  // Over many pages, titles, wide tables and contents leaders all cross the gutter, so it only has
  // to be a clear dip there. Pages on one side of the spine share their gutters.
  const onSide = (parity: number) => segsByPage.filter((_, i) => (pages[i]?.number ?? 0) % 2 === parity).flat()
  const sideGutters = [findGutters(pages, onSide(0)), findGutters(pages, onSide(1))]
  const wholeGutters = findGutters(pages, segsByPage.flat())
  const kept = pickImages(split.map((s) => s.page))
  const keepImages = new Set(kept.map((i) => `${i.page}:${i.id}`))
  for (const img of kept) art.set(img.page, [...(art.get(img.page) ?? []), img])

  const lines: Line[] = []
  const columnEdges = new Map<string, { left: number; right: number }>()
  const layouts: PageLayoutInfo[] = []
  const dividers: Record<number, number[]> = {}
  const pageLayouts = pages.map((page, i) => {
    const chosen = options.layouts?.[page.number] ?? 'auto'
    const side = sideGutters[page.number % 2] ?? []
    const columns = pageLayout(page, segsByPage[i] ?? [], side.length ? side : wholeGutters, chosen, bodySize, book)
    layouts.push({ page: page.number, columns: columns.gutters.length + 1, sidebar: columns.sidebars.size > 0, layout: chosen })
    if (columns.gutters.length) dividers[page.number] = columns.gutters.map((g) => (g.left + g.right) / 2)
    return columns
  })
  const pageLines = split.map(({ page }, i) => {
    const images = page.images.filter((img) => keepImages.has(`${page.number}:${img.id}`))
    return orderPage(page, segsByPage[i] ?? [], images, regionSegs[i] ?? [], pageLayouts[i]!, roles, tol)
  })
  // Columns start at the same place on every page laid out alike (or every other page, when margins
  // mirror), whatever their first line is (a bullet, an indented paragraph), so a paragraph carrying
  // on in the next column can be lined up.
  const shape = (i: number) => `${(pages[i]?.number ?? 0) % 2}:${pageLayouts[i]?.gutters.length ?? 0}`
  const pageMin = (ls: Line[], col: Column) => {
    const text = ls.filter((l) => l.kind === 'text' && l.col === col)
    return [Math.round(Math.min(...text.map((l) => l.x0))), text.length] as const
  }
  const columnStart = (of: string, col: Column) =>
    mostUsed(pageLines.filter((_, i) => shape(i) === of).map((ls) => pageMin(ls, col)).filter(([x]) => Number.isFinite(x)))
  pages.forEach((page, i) => {
    const ls = pageLines[i] ?? []
    for (const col of new Set(ls.map((l) => l.col))) {
      const text = ls.filter((l): l is Extract<Line, { kind: 'text' }> => l.kind === 'text' && l.col === col)
      if (!text.length) continue
      const min = Math.min(...text.map((l) => l.x0))
      const start = col === SPAN ? undefined : columnStart(shape(i), col)
      columnEdges.set(`${page.number}:${col}`, { left: start === undefined ? min : Math.min(min, start), right: Math.max(...text.map((l) => l.x1)) })
    }
    lines.push(...ls)
  })

  const words = wordSet(allSegs)
  // In scan mode a line in capitals stands for a heading one level below the smallest found by size.
  const levels = styles.map((s) => Number(s.role.slice(1))).filter((n) => n > 0)
  const capsLevel = scan ? Math.min(4, Math.max(0, ...levels) + 1) as 1 | 2 | 3 | 4 : undefined
  const blocks = buildBlocks(lines, roles, columnEdges, words, pages, tol, { art, capsLevel })
  return { blocks: groupStatBlocks(blocks), styles, layouts, dividers, scan, scanned: pages.filter((p) => p.hiddenText).map((p) => p.number) }
}

/** Leaves out the text and images whose middle falls in the margins the layout says to ignore. */
function cropPage(page: PageContent, margins: Layout['margins']): PageContent {
  if (!margins || !Object.values(margins).some((m) => m)) return page
  const x0 = (margins.left ?? 0) * page.width
  const x1 = page.width - (margins.right ?? 0) * page.width
  const y0 = (margins.top ?? 0) * page.height
  const y1 = page.height - (margins.bottom ?? 0) * page.height
  const inside = (cx: number, cy: number) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
  return {
    ...page,
    text: page.text.filter((t) => inside(t.x + t.w / 2, t.y - t.size * 0.3)),
    images: page.images.filter((i) => inside((i.x0 + i.x1) / 2, (i.y0 + i.y1) / 2)),
  }
}

/**
 * Single letters outside the text area are decoration: a chapter name set down the page's edge one
 * letter at a time, which would otherwise end up as a cell beside every line of text, or joined
 * on to a heading set in a big face. The text area's edges are where the lines of text start and
 * end, so they are not thrown off by a letter that already sits next to a heading.
 */
function dropMarginalia(page: PageContent, tol: Tolerance): PageContent {
  const lines = toSegments(page, tol).filter((s) => segText(s).trim().length >= 30)
  if (lines.length < 3) return page
  const edge = (xs: number[], pick: (a: number, b: number) => number) => {
    const counts = new Map<number, number>()
    for (const x of xs) counts.set(Math.round(x), (counts.get(Math.round(x)) ?? 0) + 1)
    const shared = [...counts].filter(([, n]) => n >= 3).map(([x]) => x)
    return (shared.length ? shared : [...counts.keys()]).reduce((a, b) => pick(a, b))
  }
  const left = edge(lines.map((s) => s.x0), Math.min)
  const right = edge(lines.map((s) => s.x1), Math.max)
  const text = page.text.filter((t) => !(t.str.trim().length === 1 && (t.x + t.w / 2 < left - 2 || t.x + t.w / 2 > right + 2)))
  return text.length === page.text.length ? page : { ...page, text }
}

/**
 * Whether the text looks like an OCR layer on a scanned book: drawn invisibly over most pages, set
 * in an OCR program's font, or with neighbouring words on the same line at slightly different heights and sizes, which
 * typeset text never is.
 */
export function looksScanned(pages: PageContent[]): boolean {
  if (pages.length && pages.filter((p) => p.hiddenText).length >= pages.length / 2) return true
  let chars = 0
  let ocr = 0
  let pairs = 0
  let jitter = 0
  for (const p of pages) {
    let prev: PdfText | undefined
    for (const t of p.text) {
      chars += t.str.length
      if (/GlyphLess|Invisible|OCR|Tesseract/i.test(t.font)) ocr += t.str.length
      if (!t.str.trim()) continue
      if (prev) {
        const dy = Math.abs(t.y - prev.y)
        const gap = t.x - (prev.x + prev.w)
        if (dy <= 0.35 * prev.size && gap > -1 && gap < 2 * prev.size) {
          pairs++
          const ds = Math.abs(t.size - prev.size) / prev.size
          if (dy > 0.04 * prev.size || (ds > 0.03 && ds < 0.15)) jitter++
        }
      }
      prev = t
    }
  }
  return chars > 0 && (ocr / chars >= 0.5 || (pairs >= 20 && jitter / pairs > 0.3))
}

const centreIn = (s: Box, b: Box) => (s.x0 + s.x1) / 2 >= b.x0 && (s.x0 + s.x1) / 2 <= b.x1 && (s.y0 + s.y1) / 2 >= b.y0 && (s.y0 + s.y1) / 2 <= b.y1

/**
 * Coloured panels that hold text: boxed text, a sidebar on a tint, a stat block on a tan panel.
 * Only the outermost of nested panels counts, and only one that its text stays inside (a bar
 * behind a heading, or a table's stripes, have text running out of them or no room for any).
 */
function findPanels(page: PageContent, segs: Segment[], bodySize: number): Box[] {
  const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0)
  const contains = (o: Box, c: Box) => o.x0 <= c.x0 + 1 && o.x1 >= c.x1 - 1 && o.y0 <= c.y0 + 1 && o.y1 >= c.y1 - 1
  const candidates = page.shapes.filter((sh) => sh.fill !== '#ffffff' && sh.fill !== '#000000' &&
    sh.x1 - sh.x0 >= 80 && sh.y1 - sh.y0 >= 3 * bodySize && area(sh) < page.width * page.height * 0.4)
  const outer = candidates.filter((c, i) => !candidates.some((o, j) => o !== c && contains(o, c) && (area(o) > area(c) + 1 || j < i)))
  return outer.filter((panel) => {
    const inside = segs.filter((sg) => centreIn(sg, panel))
    if (inside.length < 2 || inside.length > 0.8 * segs.length) return false
    const pokesOut = (sg: Segment) => sg.x0 < panel.x0 - 4 || sg.x1 > panel.x1 + 4 || sg.y0 < panel.y0 - 4 || sg.y1 > panel.y1 + 4
    return !segs.some((sg) => overlap(sg, panel) > 0 && sg.y1 > panel.y0 && sg.y0 < panel.y1 && pokesOut(sg))
  })
}

/** Takes a page's hand-marked areas out of it: skipped text and images go, marked text is set aside. */
function splitRegions(page: PageContent, regions: Region[]): { page: PageContent; regions: { region: Region; page: PageContent }[] } {
  if (!regions.length) return { page, regions: [] }
  const inside = (r: Box, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
  // The area marked last wins.
  const owner = (x: number, y: number) => [...regions].reverse().find((r) => inside(r, x, y))
  const rest: PdfText[] = []
  const held = new Map<Region, PdfText[]>()
  for (const t of page.text) {
    const r = owner(t.x + t.w / 2, t.y - t.size * 0.3)
    if (!r) rest.push(t)
    else if (r.kind !== 'skip') held.set(r, [...(held.get(r) ?? []), t])
  }
  const images = page.images.filter((img) => owner((img.x0 + img.x1) / 2, (img.y0 + img.y1) / 2)?.kind !== 'skip')
  return {
    page: { ...page, text: rest, images },
    regions: regions.filter((r) => held.has(r)).map((region) => ({ region, page: { ...page, text: held.get(region)!, images: [] } })),
  }
}

/** The images worth showing: not page backgrounds, not decorations repeated on many pages, not specks. */
export function pickImages(pages: PageContent[]): (PdfImage & { page: number })[] {
  // pdf.js names a page's own images afresh on every page, so a decoration that is drawn again on
  // each page (a chapter tab, a border) is also known by its size and place.
  const keys = (img: PdfImage) => [`${img.width}x${img.height}:${img.id}`, `${img.width}x${img.height}@${Math.round(img.x0)},${Math.round(img.y0)}`]
  const seen = new Map<string, number>()
  for (const p of pages) for (const key of new Set(p.images.flatMap(keys))) seen.set(key, (seen.get(key) ?? 0) + 1)
  const repeated = (img: PdfImage) => pages.length >= 3 && keys(img).some((key) => (seen.get(key) ?? 0) >= Math.max(3, pages.length / 2))
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
      if (textAcross(p, img) >= 8) continue
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

/**
 * How many runs of text sit across the middle of a box. Text on a panel is laid out across it;
 * text wrapped round a picture only intrudes at the edges of the picture's box (which holds the
 * clear space round the art), and a caption is one run.
 */
function textAcross(page: PageContent, box: Box): number {
  const quarter = (box.x1 - box.x0) / 4
  return page.text.filter((t) => t.x + t.w / 2 > box.x0 + quarter && t.x + t.w / 2 < box.x1 - quarter && t.y > box.y0 && t.y < box.y1).length
}

// ---------------------------------------------------------------------------------------------
// 1. Lines and segments

/**
 * A page's text as segments: runs on one baseline, split where a gap wider than `gap` times the
 * text size opens (between columns, or table cells).
 */
function toSegments(page: PageContent, tol: Tolerance, gap = 0.9): Segment[] {
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
  // OCR words wander above and below their line, so a row is measured from its average baseline.
  const rows: { items: PdfText[]; y: number }[] = []
  for (const item of items) {
    const row = rows.at(-1)
    const ref = row?.items[0]
    if (row && ref && Math.abs(item.y - row.y) <= tol.row * Math.min(item.size, ref.size)) {
      row.items.push(item)
      if (tol.scan) row.y += (item.y - row.y) / row.items.length
    } else rows.push({ items: [item], y: item.y })
  }
  const segs: Segment[] = []
  for (const { items: row } of rows) {
    row.sort((a, b) => a.x - b.x)
    let current: PdfText[] = []
    const flush = () => {
      if (current.length) segs.push(makeSegment(page.number, current, tol.scan))
      current = []
    }
    const start = segs.length
    for (const item of row) {
      const prev = current.at(-1)
      if (prev && item.x - (prev.x + prev.w) > gap * Math.max(prev.size, item.size)) flush()
      current.push(item)
    }
    flush()
    // A contents line's dot leaders split it into pieces: put it back together.
    const pieces = segs.splice(start)
    if (pieces.length > 1 && pieces.some((s) => /^[.\s·…]+$|(\.\s*){4,}/.test(s.items.map((i) => i.str).join('')))) segs.push({ ...makeSegment(page.number, pieces.flatMap((s) => s.items), tol.scan), leader: true })
    else segs.push(...pieces)
  }
  // Page numbers are not part of the text: a number on its own line near the top or bottom edge.
  const alone = (s: Segment) => !segs.some((o) => o !== s && Math.abs(o.baseline - s.baseline) < s.size)
  return segs.filter((s) => !(/^\d{1,4}$/.test(segText(s).trim()) && (s.y0 > page.height * 0.85 || s.y1 < page.height * 0.08) && alone(s)))
}

/**
 * A segment's style is its biggest run's font and size. In scan mode every word has its own size
 * and the font says nothing, so the style is the line's typical size alone (except for ornaments).
 */
function makeSegment(page: number, items: PdfText[], scan = false): Segment {
  const biggest = items.reduce((a, b) => (b.size > a.size ? b : a))
  // Ornaments keep their font even in scan mode, so they can still be left out.
  if (scan && items.every((i) => SYMBOL_FONT.test(i.font))) scan = false
  const size = scan ? median(items.map((i) => i.size)) : biggest.size
  const styleSize = scan ? Math.round(size) : round(size)
  return {
    page,
    items,
    baseline: scan ? median(items.map((i) => i.y)) : biggest.y,
    size,
    style: scan ? `*@${styleSize}` : `${biggest.font}@${styleSize}`,
    font: scan ? 'Any font' : biggest.font,
    styleSize,
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

/** A page's columns: the gutters between them, and which columns (by number) are sidebars. */
interface Columns { gutters: Gutter[]; sidebars: Set<number> }

const crossesGutter = (b: Box, g: Gutter) => b.x0 < g.left - 2 && b.x1 > g.right + 2

/**
 * The vertical strips that the given text (almost) never crosses: covered by at most a third of the
 * typical number of lines. Across many pages, that is the gutter of a two-column book, both gutters
 * of a three-column one, or the edge of a sidebar on every page.
 */
function findGutters(pages: PageContent[], segs: Segment[]): Gutter[] {
  const width = Math.round(Math.max(...pages.map((p) => p.width), 0))
  if (!width || segs.length < 8) return []
  const cover = new Array<number>(width + 1).fill(0)
  for (const s of segs) for (let x = Math.max(0, Math.floor(s.x0)); x <= Math.min(width, Math.ceil(s.x1)); x++) cover[x]!++
  const mid0 = Math.round(width * 0.3)
  const mid1 = Math.round(width * 0.7)
  const typical = [...cover.slice(mid0, mid1)].sort((a, b) => a - b)[Math.floor((mid1 - mid0) * 0.75)] ?? 0
  if (typical < 4) return []
  const limit = typical * 0.35
  // Only between the outermost text: the margins are empty too.
  const first = cover.findIndex((c) => c > limit)
  let last = cover.length - 1
  while (last > 0 && cover[last]! <= limit) last--
  if (first < 0) return []
  const lo = Math.max(first + 1, Math.round(width * 0.12))
  const hi = Math.min(last, Math.round(width * 0.88))
  const gutters: Gutter[] = []
  for (let x = lo; x < hi; x++) {
    if (cover[x]! > limit) continue
    let end = x
    while (end + 1 < hi && cover[end + 1]! <= limit) end++
    // Within the quiet stretch, the gutter is its quietest part that is at least 6 points wide.
    let best: Gutter | null = null
    let bestScore = Infinity
    for (let a = x; a <= end; a++) {
      let b = a
      while (b + 1 < hi && cover[b + 1]! <= cover[a]! + 1) b++
      if (b - a >= 6 && cover[a]! < bestScore) {
        bestScore = cover[a]!
        best = { left: a, right: b }
      }
    }
    if (best) gutters.push(best)
    x = Math.max(end, best?.right ?? end)
  }
  return gutters
}

/**
 * How one page is laid out. A layout set for the page wins, then the book's (one column, or a
 * divider set by hand). Otherwise the book's gutters are used when the page keeps to them, and a
 * page laid out differently (three columns in a two-column book, a sidebar) is measured on its own.
 */
function pageLayout(page: PageContent, segs: Segment[], doc: Gutter[], chosen: PageLayout, size: number, book: Layout): Columns {
  const none: Columns = { gutters: [], sidebars: new Set() }
  if (chosen === 'one' || (chosen === 'auto' && book.columns === 1)) return none
  if (chosen !== 'auto') {
    const gutters = forcedGutters(segs, chosen === 'three' ? 3 : 2, chosen === 'sidebar')
    const widths = columnsOf(segs, gutters).map((c) => c.x1 - c.x0)
    const narrowest = widths.indexOf(Math.min(...widths))
    return { gutters, sidebars: chosen === 'sidebar' && gutters.length ? new Set([narrowest]) : new Set() }
  }
  const divider = book.divider?.[page.number % 2 ? 'odd' : 'even'] ?? book.divider?.odd ?? book.divider?.even
  if (divider !== undefined) {
    // Split where the book says, on pages with text in both columns.
    const gutter = { left: divider * page.width - 6, right: divider * page.width + 6 }
    return { gutters: keepGutters(segs, [gutter], () => 'lines'), sidebars: new Set() }
  }
  // Gutters away from the middle (a sidebar's) must also have text-like columns beside them.
  const unusual = (g: Gutter) => g.left < page.width * 0.3 || g.right > page.width * 0.7
  const fromDoc = keepGutters(segs, doc, (g) => (unusual(g) ? 'text' : 'lines'))
  const own = pageGutters(segs, size)
  const crossed = segs.filter((s) => fromDoc.some((g) => crossesGutter(s, g))).length > 0.2 * segs.length
  const gutters = own.length > fromDoc.length && (crossed || !fromDoc.length) ? own : fromDoc
  if (!gutters.length && book.columns === 2 && segs.length) return { gutters: [{ left: page.width / 2 - 3, right: page.width / 2 + 3 }], sidebars: new Set() }
  return { gutters, sidebars: sidebarsOf(segs, gutters) }
}

/** The page's columns between its gutters, from the leftmost text to the rightmost. */
function columnsOf(segs: Segment[], gutters: Gutter[]): { x0: number; x1: number }[] {
  const x0 = Math.min(...segs.map((s) => s.x0))
  const x1 = Math.max(...segs.map((s) => s.x1))
  const edges = [x0, ...gutters.flatMap((g) => [g.left, g.right]), x1]
  return Array.from({ length: gutters.length + 1 }, (_, i) => ({ x0: edges[i * 2]!, x1: edges[i * 2 + 1]! }))
}

/**
 * Drops gutters until every column between them holds text: at least four lines ("lines"), and for
 * "text" also mostly lines that fill the column, which a table's columns don't, and fewer lines
 * crossing the gutter than sit in the columns beside it.
 */
function keepGutters(segs: Segment[], gutters: Gutter[], test: (g: Gutter) => 'lines' | 'text', minLines = 4): Gutter[] {
  let kept = [...gutters].sort((a, b) => a.left - b.left)
  while (kept.length) {
    const cols = columnsOf(segs, kept)
    const inside = cols.map((c) => segs.filter((s) => s.x0 >= c.x0 - 2 && s.x1 <= c.x1 + 2))
    const crossing = kept.map((g) => segs.filter((s) => crossesGutter(s, g)).length)
    const textLike = (i: number) => {
      const c = cols[i]!
      const w = c.x1 - c.x0
      const lines = inside[i]!
      return lines.filter((s) => s.x1 - s.x0 >= 0.6 * w).length >= lines.length / 2
    }
    const bad = cols.findIndex((_, i) => {
      const beside = [kept[i - 1], kept[i]].filter((g): g is Gutter => !!g)
      if (inside[i]!.length < minLines) return true
      const strict = beside.filter((g) => test(g) === 'text')
      if (strict.length && !textLike(i)) return true
      return strict.some((g) => crossing[kept.indexOf(g)]! > Math.min(inside[kept.indexOf(g)]!.length, inside[kept.indexOf(g) + 1]!.length))
    })
    if (bad < 0) break
    // Merge the failing column into a neighbour, across the gutter more lines cross.
    const left = bad - 1
    const right = bad
    const drop = right >= kept.length ? left : left < 0 ? right : (crossing[left]! > crossing[right]! ? left : right)
    kept = kept.filter((_, i) => i !== drop)
  }
  return kept
}

/** Gutters found on the page alone, for pages laid out unlike the rest of the book. */
function pageGutters(segs: Segment[], size: number, minLines = 4): Gutter[] {
  if (segs.length < 2 * minLines) return []
  const x0 = Math.floor(Math.min(...segs.map((s) => s.x0)))
  const x1 = Math.ceil(Math.max(...segs.map((s) => s.x1)))
  const width = x1 - x0
  if (width < 10 * size) return []
  // Titles and other lines across the whole page would hide the gutters.
  const narrow = segs.filter((s) => s.x1 - s.x0 < 0.85 * width)
  const cover = new Array<number>(width + 1).fill(0)
  for (const s of narrow) for (let x = Math.max(0, Math.floor(s.x0) - x0); x <= Math.min(width, Math.ceil(s.x1) - x0); x++) cover[x]!++
  const limit = Math.max(1, Math.floor(narrow.length * 0.03))
  const gutters: Gutter[] = []
  for (let x = Math.ceil(width * 0.08); x < width * 0.92; x++) {
    if (cover[x]! > limit) continue
    let end = x
    while (end + 1 < width * 0.92 && cover[end + 1]! <= limit) end++
    if (end - x >= Math.max(6, 0.5 * size)) gutters.push({ left: x0 + x, right: x0 + end })
    x = end
  }
  return keepGutters(segs, gutters, () => 'text', minLines)
}

/** Gutters for a layout set by hand: the emptiest strip near where each should be. */
function forcedGutters(segs: Segment[], count: number, sidebar: boolean): Gutter[] {
  if (!segs.length) return []
  const x0 = Math.floor(Math.min(...segs.map((s) => s.x0)))
  const x1 = Math.ceil(Math.max(...segs.map((s) => s.x1)))
  const width = x1 - x0
  const narrow = segs.filter((s) => s.x1 - s.x0 < 0.85 * width)
  const cover = new Array<number>(width + 1).fill(0)
  for (const s of narrow.length ? narrow : segs) for (let x = Math.max(0, Math.floor(s.x0) - x0); x <= Math.min(width, Math.ceil(s.x1) - x0); x++) cover[x]!++
  const quietest = (from: number, to: number, centre: number): Gutter => {
    let best = { a: centre, b: centre, score: Infinity }
    for (let a = Math.max(0, Math.round(from)); a <= Math.min(width, Math.round(to)); a++) {
      let b = a
      while (b + 1 <= to && cover[b + 1] === cover[a]) b++
      // Emptier first, then wider, then nearer where the gutter should be.
      const score = cover[a]! * 1000 - (b - a) + Math.abs((a + b) / 2 - centre) * 0.01
      if (score < best.score) best = { a, b, score }
      a = b
    }
    return { left: x0 + best.a - (best.a === best.b ? 0.5 : 0), right: x0 + best.b + (best.a === best.b ? 0.5 : 0) }
  }
  if (sidebar) return [quietest(width * 0.12, width * 0.88, width / 2)]
  return Array.from({ length: count - 1 }, (_, i) => {
    const centre = ((i + 1) * width) / count
    return quietest(centre - (0.4 * width) / count, centre + (0.4 * width) / count, centre)
  })
}

/** Columns much narrower than the widest one are sidebars. */
function sidebarsOf(segs: Segment[], gutters: Gutter[]): Set<number> {
  if (!gutters.length) return new Set()
  const widths = columnsOf(segs, gutters).map((c) => c.x1 - c.x0)
  const widest = Math.max(...widths)
  return new Set(widths.flatMap((w, i) => (w < 0.6 * widest ? [i] : [])))
}

/**
 * A big heading's words are set far enough apart to be joined across the gutter with the line in
 * the other column. A segment crossing the gutter is split at a gap between its runs that sits
 * over the gutter; a line with no such gap (a title, a wide table's cell) does span the page.
 */
function splitAtGutter(seg: Segment, gutter: Gutter, scan: boolean): Segment[] {
  if (!crossesGutter(seg, gutter)) return [seg]
  const at = seg.items.findIndex((item, i) => {
    const prev = seg.items[i - 1]
    return !!prev && prev.x + prev.w <= gutter.right + 2 && item.x >= gutter.left - 2 && item.x - (prev.x + prev.w) > 0.25 * item.size
  })
  if (at < 1) return [seg]
  return [makeSegment(seg.page, seg.items.slice(0, at), scan), makeSegment(seg.page, seg.items.slice(at), scan)]
}

function orderPage(
  page: PageContent,
  segs: Segment[],
  images: PdfImage[],
  regions: { region: { kind: RegionKind | 'panel' }; segs: Segment[] }[],
  columns: Columns,
  roles: Map<string, Role>,
  tol: Tolerance,
): Line[] {
  const { gutters, sidebars } = columns
  const isHeading = (l: Line) => l.kind === 'text' && l.segs.length === 1 && !['body', 'ignore'].includes(roles.get(l.segs[0]!.style) ?? 'body')
  const crosses = (b: Box) => gutters.some((g) => crossesGutter(b, g))
  const crossesAll = (b: Box) => gutters.length > 0 && gutters.every((g) => crossesGutter(b, g))
  const mids = gutters.map((g) => (g.left + g.right) / 2)
  // The column a box sits in: where its middle is, or where it starts if it reaches over a gutter.
  const colOf = (b: Box) => {
    const x = crosses(b) ? b.x0 + 2 : (b.x0 + b.x1) / 2
    const i = mids.findIndex((m) => x < m)
    return i < 0 ? mids.length : i
  }
  for (const g of gutters) segs = segs.flatMap((s) => splitAtGutter(s, g, tol.scan))

  // A caption printed on a picture (its name, under the art) is a line of its own, not a cell in
  // the rows of text wrapped round the picture, which it would otherwise turn into a table.
  const art = page.images.filter((img) => img.x1 - img.x0 >= 36 && img.y1 - img.y0 >= 36 && (img.x1 - img.x0) * (img.y1 - img.y0) < page.width * page.height * 0.8 && textAcross(page, img) < 8)
  const onArt = (s: Segment) => art.some((img) => (s.x0 + s.x1) / 2 > img.x0 && (s.x0 + s.x1) / 2 < img.x1 && s.baseline > img.y0 && s.baseline < img.y1)
  const captions: Segment[] = segs.filter(onArt).map((s) => ({ ...s, caption: true }))
  segs = segs.filter((s) => !onArt(s))
  /** Lines of text either side of a picture: a gap in the row holds the picture. */
  const wrapsArt = (row: Segment[]) => art.some((img) => {
    const cx = (img.x0 + img.x1) / 2
    const across = [...row].sort((a, b) => a.x0 - b.x0)
    return row[0]!.baseline > img.y0 && row[0]!.baseline < img.y1 && across.some((s, i) => { const next = across[i + 1]; return !!next && s.x1 < cx && next.x0 > cx })
  })

  // Rows of segments on the same baseline; each caption is a row of its own.
  const rows: Segment[][] = []
  for (const s of [...segs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = rows.at(-1)
    const ref = row?.[0]
    if (row && ref && Math.abs(s.baseline - ref.baseline) <= tol.line * Math.min(s.size, ref.size)) row.push(s)
    else rows.push([s])
  }
  rows.push(...captions.map((c) => [c]))

  const textLine = (group: Segment[], col: Column): Line => ({
    kind: 'text', page: page.number, segs: group.sort((a, b) => a.x0 - b.x0), col, ...(sidebars.has(col) ? { side: true } : {}),
    size: Math.max(...group.map((s) => s.size)), baseline: group[0]!.baseline,
    x0: Math.min(...group.map((s) => s.x0)), x1: Math.max(...group.map((s) => s.x1)),
    y0: Math.min(...group.map((s) => s.y0)), y1: Math.max(...group.map((s) => s.y1)),
  })
  const imageLine = (image: PdfImage, col: Column): Line => ({ kind: 'image', page: page.number, image, col, ...(sidebars.has(col) ? { side: true } : {}), x0: image.x0, x1: image.x1, y0: image.y0, y1: image.y1 })
  const regionLines = regions.filter((r) => r.segs.length).map(({ region, segs: rs }): Line => {
    const box = { x0: Math.min(...rs.map((s) => s.x0)), x1: Math.max(...rs.map((s) => s.x1)), y0: Math.min(...rs.map((s) => s.y0)), y1: Math.max(...rs.map((s) => s.y1)) }
    const col = gutters.length && !crossesAll(box) ? colOf(box) : SPAN
    return { kind: 'region', page: page.number, region: region.kind, segs: rs, col, ...(sidebars.has(col) ? { side: true } : {}), ...box }
  })

  if (!gutters.length) {
    const lines = [...rows.map((r) => textLine(r, SPAN)), ...images.map((i) => imageLine(i, SPAN)), ...regionLines]
    return lines.sort((a, b) => a.y0 - b.y0)
  }

  const spanning: Line[] = []
  const cols: Line[][] = gutters.map(() => []).concat([[]])
  // A row with cells on both sides of a gutter, next to a wide table row, belongs to that table.
  const wide = rows.map((row) => row.some(crossesAll))
  const tableRow = (i: number) => wide[i] && (rows[i]?.length ?? 0) >= 2
  const columnWidth = Math.min(...columnsOf(segs.length ? segs : [{ x0: 0, x1: page.width } as Segment], gutters).filter((_, i) => !sidebars.has(i)).map((c) => c.x1 - c.x0))
  /** As long as a line of text: a column's line, not a table's cell. */
  const long = (s: Segment) => s.x1 - s.x0 > 0.65 * columnWidth
  // Rows with a wide gap across a gutter, one under another, are one table (or a contents list
  // whose dot leaders are drawn as lines): "Credits ........ 3".
  const gapped = rows.map((row) => !row.some(long) && !wrapsArt(row) && gutters.some((g) => row.some((l) => l.x1 < g.left - page.width * 0.1) && row.some((r) => r.x0 > g.right + page.width * 0.1) && row.every((s) => s.x1 < g.left || s.x0 > g.right)))
  gapped.forEach((g, i) => {
    const near = (j: number) => gapped[j] && Math.abs(rows[j]![0]!.baseline - rows[i]![0]!.baseline) < 3 * rows[i]![0]!.size
    if (g && (near(i - 1) || near(i + 1))) wide[i] = true
  })
  // A row of cells under (or over) a wide table row belongs to the table: cells on both sides of a
  // gutter, or cells (a header's first line) that each sit over a cell of the table row. Not when
  // one of its pieces is as long as a line of text: that is a line from each column, beside the
  // table by chance. Rows join a table from below and from above, so the pass runs until nothing
  // changes.
  for (let changed = true; changed;) {
    changed = false
    rows.forEach((row, i) => {
      if (wide[i] || row.length < 2 || row.some(long) || wrapsArt(row)) return
      const bothSides = mids.some((mid) => row.some((s) => s.x1 < mid) && row.some((s) => s.x0 > mid))
      const near = (j: number) => tableRow(j) && Math.abs(rows[j]![0]!.baseline - row[0]!.baseline) < 2.5 * row[0]!.size &&
        (bothSides || row.every((s) => rows[j]!.some((cell) => overlap(cell, s) > 0)))
      if (near(i - 1) || near(i + 1)) wide[i] = changed = true
    })
  }
  for (const [i, row] of rows.entries()) {
    if (wide[i] && !captions.includes(row[0]!)) spanning.push(textLine(row, SPAN))
    else {
      const byCol = new Map<number, Segment[]>()
      for (const s of row) byCol.set(colOf(s), [...(byCol.get(colOf(s)) ?? []), s])
      for (const [col, group] of byCol) cols[col]!.push(textLine(group, col))
    }
  }
  for (const img of images) {
    if (crossesAll(img)) spanning.push(imageLine(img, SPAN))
    else cols[colOf(img)]!.push(imageLine(img, colOf(img)))
  }
  for (const line of regionLines) (line.col === SPAN ? spanning : cols[line.col]!).push(line)
  spanning.sort((a, b) => a.y0 - b.y0)

  const main = cols.map((_, i) => i).filter((i) => !sidebars.has(i))
  const out: Line[] = []
  let from = -Infinity
  for (let i = 0; i <= spanning.length; i++) {
    const sep = spanning[i]
    const to = sep ? sep.y0 + 0.5 : Infinity
    const inBand = (l: Line) => l.y0 >= from && l.y0 < to
    const band = main.map((c) => cols[c]!.filter(inBand).sort((a, b) => a.y0 - b.y0))
    // A heading (or a table's title, set in another style) that sits below the last column, just
    // above a spanning line, introduces that line.
    const tail: Line[] = []
    const lastCol = band.at(-1) ?? []
    const style = (l: Line | undefined) => (l?.kind === 'text' ? l.segs[0]?.style : undefined)
    if (sep && lastCol.length && band.length > 1) {
      const bottom = Math.max(...lastCol.map((l) => l.y1))
      band.slice(0, -1).forEach((ls, c) => {
        const below = ls.filter((l) => l.y0 > bottom - 1)
        const first = below[0]
        const above = first && ls[ls.indexOf(first) - 1]
        const introduces = !!first && (isHeading(first) || (above !== undefined && style(first) !== style(above))) && sep.y0 - Math.max(...below.map((l) => l.y1)) < 2 * (first.kind === 'text' ? first.size : 12)
        if (introduces) {
          tail.push(...below)
          band[c] = ls.filter((l) => !below.includes(l))
        }
      })
    }
    out.push(...band.flat(), ...tail)
    if (sep) out.push(sep)
    from = to
  }
  // Sidebars are read after the rest of the page.
  for (const c of [...sidebars].sort((a, b) => a - b)) out.push(...cols[c]!.sort((a, b) => a.y0 - b.y0))
  return out
}

// ---------------------------------------------------------------------------------------------
// 3. Text styles

function detectStyles(segs: Segment[], bodySize: number, overrides: Record<string, Role>, scan: boolean): TextStyle[] {
  const stats = new Map<string, { font: string; size: number; chars: number; segs: number; example: string; pages: Set<number>; whole: number }>()
  const familyChars = new Map<string, number>()
  for (const s of segs) {
    const text = segText(s)
    const st = stats.get(s.style) ?? { font: s.font, size: s.styleSize, chars: 0, segs: 0, example: text.slice(0, 60), pages: new Set(), whole: 0 }
    // A short line wholly in this style, not ending a sentence: how headings look.
    if (s.items.every((i) => i.font === s.font || !i.str.trim()) && text.trim().length <= 60 && !/[.:,;]$/.test(text.trim())) st.whole++
    // Contents lines ("Credits . . . . 3") are long text, whatever their pieces look like.
    st.chars += s.leader ? 100 : text.length
    st.segs++
    st.pages.add(s.page)
    stats.set(s.style, st)
    for (const i of s.items) familyChars.set(family(i.font), (familyChars.get(family(i.font)) ?? 0) + i.str.length)
  }
  const bodyFamily = [...familyChars].sort((a, b) => b[1] - a[1])[0]?.[0]

  // In scan mode the font says nothing, and sizes wander: a heading is short and clearly bigger.
  const candidate = (st: { font: string; size: number; chars: number; segs: number }) => scan
    ? st.size >= bodySize * 1.2 && st.chars / st.segs <= 60
    : st.size >= bodySize * 1.15 &&
      st.chars / st.segs <= 40 &&
      !/italic|oblique/i.test(st.font) &&
      (family(st.font) !== bodyFamily || /bold|black|heavy|semibold/i.test(st.font))
  const ranked = [...new Set([...stats.values()].filter((st) => candidate(st) && st.segs >= 2).map((st) => st.size))].sort((a, b) => b - a)
  // Scanned sizes within a tenth of each other are one level.
  const tops = scan ? ranked.filter((size, i) => i === 0 || size < ranked[i - 1]! * 0.9) : []
  const levelFor = (size: number): Role => {
    let rank: number
    if (scan) {
      rank = tops.findIndex((t) => size >= t * 0.9)
      if (rank < 0) rank = tops.length
    } else {
      rank = ranked.findIndex((r) => r <= size)
      if (rank < 0) rank = ranked.length
      if (ranked[rank] !== size && rank > 0 && !ranked.includes(size)) rank = Math.max(0, rank - 1)
    }
    return (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(rank, 3)]!
  }

  // A word processor's export sets headings in the body face, only bold. Where the book has (almost)
  // no headings by size, short lines wholly in bold body text are the next level down.
  const boldHeading = (st: { font: string; size: number; segs: number; whole: number }) => !scan && ranked.length < 2 &&
    family(st.font) === bodyFamily && /bold|black|heavy|semibold/i.test(st.font) && Math.abs(st.size - bodySize) <= 1 &&
    st.segs >= 3 && st.whole >= 3 && st.whole >= 0.6 * st.segs
  return [...stats].map(([key, st]) => {
    const auto: Role = SYMBOL_FONT.test(st.font) ? 'ignore' : candidate(st) ? levelFor(st.size) : boldHeading(st) ? (['h1', 'h2', 'h3', 'h4'] as const)[ranked.length]! : 'body'
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
      /** Where the paragraph already sits in the blocks, when it carries on after an interruption. */
      index?: number
    }
  | { type: 'table'; lines: Segment[][]; page: number; boxes: PageBox[]; last: Line; size: number }

interface BlockContext {
  /** The pictures kept on each page, which text may wrap round. */
  art: Map<number, Box[]>
  /** Scan mode: the level a line set in capitals takes as a heading. */
  capsLevel?: 1 | 2 | 3 | 4
}

function buildBlocks(
  lines: Line[],
  roles: Map<string, Role>,
  edges: Map<string, { left: number; right: number }>,
  words: Set<string>,
  pages: PageContent[],
  tol: Tolerance,
  context: BlockContext,
): ReflowBlock[] {
  const blocks: ReflowBlock[] = []
  let open: Open | null = null
  const pageOf = new Map(pages.map((p) => [p.number, p]))
  /** Pictures met inside a paragraph, which text wraps round: they follow the paragraph. */
  let deferred: ReflowBlock[] = []
  /** A paragraph cut off mid-sentence by a table, a picture across the page or a sidebar, which may carry on after it. */
  let suspended: Extract<Open, { type: 'paragraph' }> | null = null

  const flush = () => {
    if (open?.type === 'heading') blocks.push({ type: 'heading', level: open.level, text: open.text.trim(), page: open.page, boxes: open.boxes })
    else if (open?.type === 'paragraph') {
      const runs = tidy(open.runs)
      if (runs.length) {
        const boxed = isBoxed(open.boxes, pageOf)
        const block: ReflowBlock = { type: 'paragraph', runs, ...(open.list ? { list: true } : {}), ...(boxed ? { boxed } : {}), page: open.page, boxes: open.boxes }
        if (open.index === undefined) {
          open.index = blocks.length
          blocks.push(block)
        } else blocks[open.index] = block
      }
    } else if (open?.type === 'table') blocks.push(...finishTable(open))
    open = null
    blocks.push(...deferred)
    deferred = []
  }
  /** Closes the open paragraph, keeping it to carry on if it stopped mid-sentence. */
  const interrupt = () => {
    const paragraph = open?.type === 'paragraph' && !open.list && !TERMINAL.test(open.runs.map((r) => r.text).join('').trimEnd()) ? open : null
    flush()
    if (paragraph) suspended = paragraph
  }

  for (const line of lines) {
    const box: PageBox = { page: line.page, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 }
    if (line.kind === 'image') {
      const image: ReflowBlock = { type: 'image', id: line.image.id, width: line.image.width, height: line.image.height, page: line.page, boxes: [box] }
      if (open?.type === 'paragraph') deferred.push(image)
      else {
        flush()
        blocks.push(image)
      }
      continue
    }
    if (line.kind === 'region') {
      interrupt()
      if (line.region === 'panel') blocks.push(...panelBlocks(line, roles, edges, words, pages, tol, context))
      else blocks.push(regionBlock(line, roles, words, pageOf))
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
        interrupt()
        open = { type: 'table', lines: [segs], page: line.page, boxes: [box], last: line, size: line.size }
      }
      continue
    }

    const seg = segs[0]!
    const text = segText(seg)
    let role = roles.get(seg.style) ?? 'body'
    if (role === 'ignore') continue
    // A heading style's line is mostly in that style: a bold lead-in ("Handaxe." and the rest of the
    // line in the body face) is text, even when bold lines alone are headings.
    if (role !== 'body' && !tol.scan && !mostlyIn(seg, seg.font)) role = 'body'
    if (role === 'body' && context.capsLevel && capitals(text)) role = `h${context.capsLevel}`

    if (role !== 'body') {
      const level = Number(role.slice(1)) as 1 | 2 | 3 | 4
      suspended = null
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
      suspended = null
      const first = runs[0]
      if (first) first.text = first.text.replace(BULLET, '')
      const textItem = seg.items.find((i) => !BULLET.test(i.str) || i.str.replace(BULLET, '').trim())
      const textX = textItem && BULLET.test(textItem.str) ? seg.x0 + seg.size : textItem?.x ?? seg.x0
      open = { type: 'paragraph', runs, list: true, offset: textX - colLeft, lines: 1, family: fam, size: seg.size, page: line.page, boxes: [box], last: line }
      continue
    }

    if (open?.type === 'paragraph' && continues(open, line, seg, runs, edges, tol, context.art)) {
      if (open.dropCap && open.lines === 1) open.family = fam
      appendLine(open.runs, runs, words)
      open.boxes.push(box)
      open.last = line
      if (!open.list || open.lines > 1) open.offset = line.x0 - colLeft
      open.lines++
      continue
    }
    // Main text cut off by a sidebar waits for the sidebar to end.
    if (open?.type === 'paragraph' && !!line.side && !open.last.side) interrupt()
    else flush()
    // The paragraph a table or picture cut off carries on here: mid-sentence, starting in lower case.
    const resumed = suspended as Extract<Open, { type: 'paragraph' }> | null
    if (resumed && !!resumed.last.side === !!line.side) {
      suspended = null
      if (/^[^\p{L}]*\p{Ll}/u.test(text) && continues(resumed, line, seg, runs, edges, tol, context.art, true)) {
        open = resumed
        appendLine(resumed.runs, runs, words)
        resumed.boxes.push(box)
        resumed.last = line
        resumed.offset = line.x0 - colLeft
        resumed.lines++
        continue
      }
    }
    open = { type: 'paragraph', runs, offset: line.x0 - colLeft, lines: 1, dropCap: seg.dropCap, family: fam, size: seg.size, page: line.page, boxes: [box], last: line }
  }
  flush()
  return blocks
}

/** Whether most of a segment's text is set in the given font. */
function mostlyIn(seg: Segment, font: string): boolean {
  const total = seg.items.reduce((n, i) => n + i.str.trim().length, 0)
  return seg.items.filter((i) => i.font === font).reduce((n, i) => n + i.str.trim().length, 0) >= total / 2
}

/** A short line in capitals, with a word of four letters or more: "THE SUNKEN TEMPLE", not "STR DEX CON". */
function capitals(text: string): boolean {
  const t = text.trim()
  return t.length <= 60 && !/\p{Ll}/u.test(t) && /\p{Lu}{4}/u.test(t) && !/[.,;]$/.test(t)
}

/**
 * A coloured panel's text, read on its own: in its own columns if it has them, then into
 * paragraphs, headings and tables like the page.
 */
function panelBlocks(line: Extract<Line, { kind: 'region' }>, roles: Map<string, Role>, edges: Map<string, { left: number; right: number }>, words: Set<string>, pages: PageContent[], tol: Tolerance, context: BlockContext): ReflowBlock[] {
  const page = pages.find((p) => p.number === line.page)
  if (!page) return []
  const size = median(line.segs.map((sg) => sg.size))
  // A panel is short, so two lines make a column.
  const gutters = pageGutters(line.segs, size, 2)
  // Columns inside the panel are numbered apart from the page's.
  const base = 1000 + Math.round(line.y0) * 10
  const inner = orderPage(page, line.segs, [], [], { gutters, sidebars: new Set() }, roles, tol).map((l) => ({ ...l, col: base + l.col + 1, side: line.side })) as Line[]
  const innerEdges = new Map(edges)
  for (const col of new Set(inner.map((l) => l.col))) {
    const ls = inner.filter((l) => l.col === col)
    innerEdges.set(`${line.page}:${col}`, { left: Math.min(...ls.map((l) => l.x0)), right: Math.max(...ls.map((l) => l.x1)) })
  }
  return buildBlocks(inner, roles, innerEdges, words, pages, tol, context)
}

/**
 * Whether a line carries on the open paragraph. `resume` is for a paragraph cut off by a table or a
 * picture: it is judged as if it carried on in the next column.
 */
function continues(open: Extract<Open, { type: 'paragraph' }>, line: Extract<Line, { kind: 'text' }>, seg: Segment, runs: Run[], edges: Map<string, { left: number; right: number }>, tol: Tolerance, art: Map<number, Box[]>, resume = false): boolean {
  const prev = open.last
  if (prev.kind !== 'text') return false
  if (seg.leader || seg.caption || prev.segs.some((s) => s.leader || s.caption)) return false
  // Main text never runs on into a sidebar, or out of one.
  if (!!prev.side !== !!line.side) return false
  // The line after a drop cap's first line changes font (small caps, then the body face).
  const afterDropCap = open.dropCap && open.lines === 1
  if (!afterDropCap && (!seg.items.some((i) => family(i.font) === open.family) || Math.abs(seg.size - open.size) > tol.sameSize(seg.size))) return false
  const align = tol.align(seg.size)
  const text = open.runs.map((r) => r.text).join('').trimEnd()
  const ended = TERMINAL.test(text)
  const lead = runs[0]?.bold && /^[^a-z].{0,60}[.:]\s*$/.test(runs[0].text)
  // "Handaxe." or "Armor Class:" in bold after a finished sentence starts a new entry.
  if (ended && lead) return false
  const startsBold = !!runs[0]?.bold && /^[^a-z]/.test(runs[0].text) && runs[0].text.trim().length > 1
  const edge = edges.get(`${line.page}:${line.col}`)
  const offset = line.x0 - (edge?.left ?? line.x0)

  if (resume || prev.page !== line.page || prev.col !== line.col) {
    // Carrying on in the next column or page: only mid-sentence, starting where the paragraph's lines start.
    if (ended || startsBold) return false
    return open.lines > 1 || open.list ? Math.abs(offset - open.offset) <= align : offset <= open.offset + align
  }

  if (line.y0 - prev.y1 > 0.9 * seg.size) return false
  if (open.list) return Math.abs(offset - open.offset) <= align || (afterDropCap ?? false)
  const prevEdge = edges.get(`${prev.page}:${prev.col}`)
  const centered = (l: Box) => !!prevEdge && Math.abs((l.x0 + l.x1) / 2 - (prevEdge.left + prevEdge.right) / 2) < 4 && l.x0 - prevEdge.left > seg.size
  // Text wrapped round a picture: a line that stops short of the picture, or starts after it, is
  // as good as a full one.
  const beside = (l: Box & { page: number }) => (art.get(l.page) ?? []).filter((img) => img.y0 < l.y1 && img.y1 > l.y0)
  const pictureRight = beside(prev).some((img) => img.x0 > prev.x0 + 4 * seg.size)
  const pictureLeft = beside(line).some((img) => img.x1 < line.x1 - 4 * seg.size && img.x1 > (prevEdge?.left ?? 0))
  const short = !!prevEdge && prev.x1 < prevEdge.right - 3 * seg.size && !pictureRight
  // A hanging indent ("Advancement: 18–19 HD (Large); …" with its later lines set in): the first
  // line fills its column and stops mid-sentence, and the next starts a little way in.
  const full = !!prevEdge && prev.x1 - prevEdge.left >= 0.8 * (prevEdge.right - prevEdge.left)
  const hanging = open.lines === 1 && full && !ended && line.x0 - prev.x0 <= 3 * seg.size
  if (line.x0 - prev.x0 > tol.indent * seg.size && !(centered(line) && centered(prev)) && !hanging && !pictureLeft) return false
  if (short && (ended || startsBold)) return false
  return true
}

/**
 * A hand-marked area's text: one paragraph (or one heading, if it is all heading text), or a table
 * whose columns are wherever no text sits from the top of the area to the bottom.
 */
function regionBlock(line: Extract<Line, { kind: 'region' }>, roles: Map<string, Role>, words: Set<string>, pages: Map<number, PageContent>): ReflowBlock {
  const rows: Segment[][] = []
  for (const s of [...line.segs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = rows.at(-1)
    if (row && Math.abs(s.baseline - row[0]!.baseline) <= 0.5 * Math.min(s.size, row[0]!.size)) row.push(s)
    else rows.push([s])
  }
  for (const row of rows) row.sort((a, b) => a.x0 - b.x0)
  const box: PageBox = { page: line.page, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 }
  if (line.region === 'table') return { type: 'table', ...regionTable(rows), page: line.page, boxes: [box] }

  const levels = line.segs.map((s) => roles.get(s.style) ?? 'body')
  if (levels.every((r) => /^h\d$/.test(r))) {
    const text = rows.map((row) => row.map(segText).join(' ').trim()).join(' ')
    return { type: 'heading', level: Number(levels[0]!.slice(1)) as 1 | 2 | 3 | 4, text, page: line.page, boxes: [box] }
  }
  const runs: Run[] = []
  for (const row of rows) {
    const rowRuns: Run[] = []
    for (const s of row) {
      if (rowRuns.length) pushRun(rowRuns, { text: ' ' })
      for (const r of segRuns(s)) pushRun(rowRuns, r)
    }
    if (runs.length) appendLine(runs, rowRuns, words)
    else for (const r of rowRuns) pushRun(runs, r)
  }
  const boxed = isBoxed([box], pages)
  return { type: 'paragraph', runs: tidy(runs), ...(boxed ? { boxed } : {}), page: line.page, boxes: [box] }
}

/** Rows of a marked table: columns split at the strips no row's text crosses; a row with nothing in the first column carries on the row above. */
function regionTable(rows: Segment[][]): { rows: Run[][][]; header: boolean } {
  const segs = rows.flat()
  const x0 = Math.floor(Math.min(...segs.map((s) => s.x0)))
  const x1 = Math.ceil(Math.max(...segs.map((s) => s.x1)))
  const cover = new Array<number>(x1 - x0 + 1).fill(0)
  for (const s of segs) for (let x = Math.ceil(s.x0) - x0; x <= Math.floor(s.x1) - x0; x++) cover[x]!++
  const splits: number[] = []
  for (let x = 1; x < cover.length - 1; x++) {
    if (cover[x] !== 0) continue
    let end = x
    while (end + 1 < cover.length && cover[end + 1] === 0) end++
    splits.push(x0 + (x + end) / 2)
    x = end
  }
  const colOf = (s: Segment) => splits.filter((x) => x < (s.x0 + s.x1) / 2).length
  const out: Run[][][] = []
  for (const row of rows) {
    const cells: Run[][] = Array.from({ length: splits.length + 1 }, () => [])
    for (const s of row) {
      const cell = cells[colOf(s)]!
      if (cell.length) pushRun(cell, { text: ' ' })
      for (const r of segRuns(s)) pushRun(cell, r)
    }
    const above = out.at(-1)
    if (above && !cells[0]!.length && splits.length) {
      cells.forEach((cell, i) => {
        if (!cell.length) return
        if (above[i]!.length) pushRun(above[i]!, { text: ' ' })
        for (const r of cell) pushRun(above[i]!, r)
      })
    } else out.push(cells)
  }
  const tidied = out.map((r) => r.map(tidy))
  const header = tidied.length > 1 && !!tidied[0]?.every((cell) => cell.length === 0 || cell.every((r) => r.bold))
  return { rows: tidied, header }
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

function median(ns: number[]): number {
  const sorted = [...ns].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function round(n: number): number {
  return Math.round(n * 2) / 2
}
