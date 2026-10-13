import type { Block, ListItemBlock, Run, TableCellBlock, TableRowBlock } from '@legendkeeper/sdk/blocks'

/**
 * Converts captured web content into LegendKeeper blocks.
 *
 * Works on any standard DOM (the browser's, or linkedom in tests) and only reads nodes, so the
 * same code runs in the side panel and in Node. Every rule here keeps the output inside what the
 * API accepts; the limits below were found by writing each nesting to a live project.
 *   - A list item's first child must be a paragraph.
 *   - A table cell cannot hold a table.
 *   - A code run carries no other mark, not even a link.
 *   - Links must be http, https or mailto (the API refuses javascript: and similar).
 *   - Image blocks take only the project's own asset URLs, so images are uploaded before writing.
 */

export interface ConvertOptions {
  /** Resolves relative links and image sources. Usually the clipped page's URL. */
  baseUrl?: string
  /** Keep images (as blocks to upload). When false they are left out. */
  images?: boolean
  /**
   * Shift headings so the highest one in the clip becomes this level. The clip sits under the
   * "From <Source>" Heading 1, so the default of 2 keeps the clip's own structure beneath it.
   * Set to 0 to keep the original levels.
   */
  topHeadingLevel?: number
}

export interface ClipImage {
  /** The original image URL (http, https or data:). */
  src: string
  alt: string
}

export interface ConvertResult {
  blocks: Block[]
  images: ClipImage[]
  warnings: string[]
}

interface Marks {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  sub?: boolean
  sup?: boolean
  link?: string
}

interface Context {
  options: Required<Pick<ConvertOptions, 'images'>> & ConvertOptions
  images: ClipImage[]
  warnings: Set<string>
  /** Inside a table cell, where a nested table has to be flattened. */
  inTable: boolean
  /** Inside a code block's ancestors: whitespace is kept. */
  pre: boolean
}

const ELEMENT = 1
const TEXT = 3
const FRAGMENT = 11

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'button', 'input',
  'select', 'textarea', 'link', 'meta', 'head', 'title', 'map', 'area', 'source', 'track', 'dialog',
])

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'ul', 'body', 'html', 'menu',
])

const INLINE_MARKS: Record<string, Marks> = {
  b: { bold: true }, strong: { bold: true },
  i: { italic: true }, em: { italic: true }, cite: { italic: true }, dfn: { italic: true }, var: { italic: true },
  u: { underline: true }, ins: { underline: true },
  s: { strike: true }, strike: { strike: true }, del: { strike: true },
  code: { code: true }, kbd: { code: true }, samp: { code: true }, tt: { code: true },
  sub: { sub: true }, sup: { sup: true },
}

/** Lists made from stray <li> elements, so neighbouring ones merge into one list. */
const orphanLists = new WeakSet<Block>()

export function htmlToBlocks(root: Node, options: ConvertOptions = {}): ConvertResult {
  const context: Context = { options: { images: true, ...options }, images: [], warnings: new Set(), inTable: false, pre: false }
  let blocks = convertChildren(root, context, {})
  const top = options.topHeadingLevel ?? 2
  if (top > 0) blocks = shiftHeadings(blocks, top)
  if (blocks.length === 0) {
    const text = collapse(root.textContent ?? '').trim()
    if (text) blocks = [{ kind: 'paragraph', content: [{ text }] }]
  }
  return { blocks, images: context.images, warnings: [...context.warnings] }
}

/** Parses an HTML string with the given DOMParser (the browser's, or linkedom's in tests) and converts its body. */
export function htmlStringToBlocks(html: string, parser: { parseFromString(html: string, type: 'text/html'): Document }, options: ConvertOptions = {}): ConvertResult {
  const doc = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')
  return htmlToBlocks(doc.body ?? doc.documentElement, options)
}

// ------------------------------------------------------------------------------------- blocks

class BlockBuilder {
  readonly blocks: Block[] = []
  private runs: Run[] = []

  addRun(run: Run): void {
    this.runs.push(run)
  }

  flush(): void {
    const content = tidyRuns(this.runs)
    this.runs = []
    if (content.length > 0) this.blocks.push({ kind: 'paragraph', content })
  }

  addBlock(block: Block): void {
    this.flush()
    const last = this.blocks.at(-1)
    if (orphanLists.has(block) && last && orphanLists.has(last) && last.kind === 'bulletList' && block.kind === 'bulletList') {
      last.children.push(...block.children)
      return
    }
    this.blocks.push(block)
  }

  finish(): Block[] {
    this.flush()
    return this.blocks
  }
}

function convertChildren(node: Node, context: Context, marks: Marks): Block[] {
  const builder = new BlockBuilder()
  for (const child of Array.from(node.childNodes)) convertNode(child, builder, context, marks)
  return builder.finish()
}

function convertNode(node: Node, out: BlockBuilder, context: Context, marks: Marks): void {
  if (node.nodeType === TEXT) {
    const raw = node.nodeValue ?? ''
    const text = context.pre ? raw : collapse(raw)
    if (text) out.addRun(makeRun(text, marks))
    return
  }
  if (node.nodeType === FRAGMENT) {
    for (const child of Array.from(node.childNodes)) convertNode(child, out, context, marks)
    return
  }
  if (node.nodeType !== ELEMENT) return
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (SKIP.has(tag) || isHidden(el)) return

  switch (tag) {
    case 'br':
      out.addRun({ break: true })
      return
    case 'img':
      convertImage(el, out, context)
      return
    case 'hr':
      out.addBlock({ kind: 'rule' })
      return
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const inner = convertInline(el, context, marks)
      if (inner.runs.length > 0) out.addBlock({ kind: 'heading', level: Number(tag[1]) as 1, content: inner.runs })
      for (const block of inner.blocks) out.addBlock(block)
      return
    }
    case 'p': case 'div': case 'section': case 'article': case 'main': case 'header': case 'footer': case 'aside': case 'nav':
    case 'address': case 'center': case 'fieldset': case 'form': case 'hgroup': case 'figure': case 'details': case 'body':
    case 'html': case 'dl':
      out.flush()
      for (const child of Array.from(el.childNodes)) convertNode(child, out, context, marks)
      out.flush()
      return
    case 'dt': case 'summary': case 'caption':
      out.flush()
      for (const child of Array.from(el.childNodes)) convertNode(child, out, context, { ...marks, bold: true })
      out.flush()
      return
    case 'figcaption':
      out.flush()
      for (const child of Array.from(el.childNodes)) convertNode(child, out, context, { ...marks, italic: true })
      out.flush()
      return
    case 'dd':
      out.flush()
      for (const child of Array.from(el.childNodes)) convertNode(child, out, context, marks)
      out.flush()
      return
    case 'ul': case 'ol': case 'menu': {
      const list = convertList(el, context, marks)
      if (list) out.addBlock(list)
      return
    }
    case 'li': {
      const list: Block = { kind: 'bulletList', children: [convertListItem(el, context, marks)] }
      orphanLists.add(list)
      out.addBlock(list)
      return
    }
    case 'blockquote': {
      const children = convertChildren(el, context, marks)
      if (children.length > 0) out.addBlock({ kind: 'quote', children })
      return
    }
    case 'pre': {
      const text = (el.textContent ?? '').replace(/^\n/, '').replace(/\s+$/, '')
      if (text) {
        const language = codeLanguage(el)
        out.addBlock({ kind: 'code', text, ...(language ? { language } : {}) })
      }
      return
    }
    case 'table': {
      for (const block of convertTable(el, context, marks)) out.addBlock(block)
      return
    }
    case 'thead': case 'tbody': case 'tfoot': case 'tr': case 'td': case 'th': {
      // Table parts selected without their table: treat what they hold as plain content.
      const cell = tag === 'td' || tag === 'th'
      if (!cell) out.flush()
      for (const child of Array.from(el.childNodes)) convertNode(child, out, context, marks)
      if (cell) out.addRun({ text: ' ' })
      else out.flush()
      return
    }
  }

  // Inline elements: carry their marks down. Block content inside them (a <div> inside an <a>) still becomes blocks.
  const inner = inlineMarks(el, tag, context)
  if (BLOCK.has(tag)) out.flush()
  for (const child of Array.from(el.childNodes)) convertNode(child, out, context, { ...marks, ...inner })
  if (BLOCK.has(tag)) out.flush()
}

/** Inline content of a heading or similar; any images or blocks inside come back separately. */
function convertInline(el: Element, context: Context, marks: Marks): { runs: Run[]; blocks: Block[] } {
  const builder = new BlockBuilder()
  for (const child of Array.from(el.childNodes)) convertNode(child, builder, context, marks)
  const blocks = builder.finish()
  const runs: Run[] = []
  const rest: Block[] = []
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      if (runs.length > 0) runs.push({ text: ' ' })
      runs.push(...block.content)
    } else rest.push(block)
  }
  return { runs: tidyRuns(runs), blocks: rest }
}

function inlineMarks(el: Element, tag: string, context: Context): Marks {
  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href'), context.options.baseUrl)
    return href ? { link: href } : {}
  }
  const marks: Marks = { ...INLINE_MARKS[tag] }
  const style = el.getAttribute('style') ?? ''
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) marks.bold = true
  if (/font-style\s*:\s*italic/i.test(style)) marks.italic = true
  if (/text-decoration[^;]*underline/i.test(style)) marks.underline = true
  if (/text-decoration[^;]*line-through/i.test(style)) marks.strike = true
  return marks
}

function convertImage(el: Element, out: BlockBuilder, context: Context): void {
  if (!context.options.images) return
  const width = Number(el.getAttribute('width'))
  const height = Number(el.getAttribute('height'))
  if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return // tracking pixels
  const src = imageSource(el, context.options.baseUrl)
  if (!src) {
    context.warnings.add('An image without a usable source was left out.')
    return
  }
  const alt = collapse(el.getAttribute('alt') ?? el.getAttribute('title') ?? '').trim()
  context.images.push({ src, alt })
  // The URL is the original for now; the importer swaps in the uploaded asset's URL.
  out.addBlock({ kind: 'image', url: src, ...(alt ? { alt } : {}) })
}

function imageSource(el: Element, baseUrl?: string): string | undefined {
  const candidates = [el.getAttribute('src'), el.getAttribute('data-src'), el.getAttribute('data-original'), el.getAttribute('data-lazy-src')]
  const srcset = el.getAttribute('srcset') ?? el.getAttribute('data-srcset')
  if (srcset) candidates.push(largestFromSrcset(srcset))
  for (const candidate of candidates) {
    if (!candidate) continue
    const trimmed = candidate.trim()
    // Lazy-loading placeholders are usually tiny data: GIFs; prefer a real URL when one exists.
    if (trimmed.startsWith('data:')) {
      if (trimmed.length > 200 && /^data:image\/(png|jpe?g|gif|webp)/i.test(trimmed)) return trimmed
      continue
    }
    const absolute = absolutize(trimmed, baseUrl)
    if (absolute && /^https?:/i.test(absolute)) return absolute
  }
  return undefined
}

function largestFromSrcset(srcset: string): string | null {
  let best: { url: string; size: number } | null = null
  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/)
    if (!url) continue
    const size = descriptor ? parseFloat(descriptor) || 1 : 1
    if (!best || size > best.size) best = { url, size }
  }
  return best?.url ?? null
}

function convertList(el: Element, context: Context, marks: Marks): Block | undefined {
  const items: ListItemBlock[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === ELEMENT) {
      const childEl = child as Element
      const tag = childEl.tagName.toLowerCase()
      if (SKIP.has(tag) || isHidden(childEl)) continue
      if (tag === 'li') {
        items.push(convertListItem(childEl, context, marks))
        continue
      }
      if ((tag === 'ul' || tag === 'ol') && items.length > 0) {
        // A list nested directly in a list (invalid HTML, but common): it belongs to the previous item.
        const nested = convertList(childEl, context, marks)
        if (nested) items.at(-1)!.children.push(nested)
        continue
      }
    }
    if (child.nodeType === TEXT && !(child.nodeValue ?? '').trim()) continue
    // Anything else directly inside the list becomes an item of its own.
    const blocks = convertChildrenOf([child], context, marks)
    if (blocks.length > 0) items.push(listItem(blocks))
  }
  if (items.length === 0) return undefined
  if (el.tagName.toLowerCase() === 'ol') {
    const start = Number(el.getAttribute('start'))
    return { kind: 'orderedList', ...(Number.isInteger(start) && start !== 1 ? { start } : {}), children: items }
  }
  return { kind: 'bulletList', children: items }
}

function convertChildrenOf(nodes: Node[], context: Context, marks: Marks): Block[] {
  const builder = new BlockBuilder()
  for (const node of nodes) convertNode(node, builder, context, marks)
  return builder.finish()
}

function convertListItem(el: Element, context: Context, marks: Marks): ListItemBlock {
  return listItem(convertChildren(el, context, marks))
}

function listItem(children: Block[]): ListItemBlock {
  if (children[0]?.kind !== 'paragraph') children.unshift({ kind: 'paragraph', content: [] })
  return { kind: 'listItem', children: children as ListItemBlock['children'] }
}

function convertTable(el: Element, context: Context, marks: Marks): Block[] {
  const rows = tableRows(el)
  if (context.inTable) {
    // A table inside a table cell cannot be written; keep its text, one paragraph per row.
    context.warnings.add('A table nested inside another table was flattened into text.')
    return rows
      .map((row) => cellsOf(row).map((cell) => collapse(cell.textContent ?? '').trim()).filter(Boolean).join(' | '))
      .filter(Boolean)
      .map((text) => ({ kind: 'paragraph', content: [{ text }] }))
  }

  const before: Block[] = []
  const caption = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'caption')
  if (caption) {
    const text = collapse(caption.textContent ?? '').trim()
    if (text) before.push({ kind: 'paragraph', content: [{ text, bold: true }] })
  }

  const cellContext = { ...context, inTable: true }
  const outRows: TableRowBlock[] = []
  for (const row of rows) {
    const cells: TableCellBlock[] = []
    for (const cell of cellsOf(row)) {
      const colspan = Number(cell.getAttribute('colspan'))
      const rowspan = Number(cell.getAttribute('rowspan'))
      cells.push({
        kind: 'tableCell',
        ...(cell.tagName.toLowerCase() === 'th' ? { header: true } : {}),
        ...(colspan > 1 ? { colspan } : {}),
        ...(rowspan > 1 ? { rowspan } : {}),
        children: convertChildren(cell, cellContext, marks) as TableCellBlock['children'],
      })
    }
    if (cells.length > 0) outRows.push({ kind: 'tableRow', children: cells })
  }
  if (outRows.length === 0) return before
  // A one-cell table is a layout wrapper, not data: keep only its content.
  if (outRows.length === 1 && outRows[0]!.children.length === 1) return [...before, ...convertChildren(cellsOf(rows[0]!)[0]!, context, marks)]
  return [...before, { kind: 'table', children: outRows }]
}

function tableRows(table: Element): Element[] {
  const rows: Element[] = []
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase()
    if (tag === 'tr') rows.push(child)
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') rows.push(...Array.from(child.children).filter((r) => r.tagName.toLowerCase() === 'tr'))
  }
  return rows
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((c) => ['td', 'th'].includes(c.tagName.toLowerCase()) && !isHidden(c))
}

// --------------------------------------------------------------------------------------- runs

function makeRun(text: string, marks: Marks): Run {
  const link = marks.link
  if (marks.code && !link) return { text, code: true }
  const run: Run = { text }
  if (marks.bold) run.bold = true
  if (marks.italic) run.italic = true
  if (marks.underline) run.underline = true
  if (marks.strike) run.strike = true
  if (marks.sup) run.sup = true
  else if (marks.sub) run.sub = true
  if (link) run.link = link
  return run
}

/** Trims a paragraph's edges, collapses spaces across runs, and merges runs with the same marks. */
export function tidyRuns(input: Run[]): Run[] {
  const out: Run[] = []
  let lastText = ''
  for (const run of input) {
    if ('text' in run) {
      let text = run.text
      if (!('code' in run && run.code)) {
        // A space at the start of a line, or after another space, is not rendered by the browser either.
        if (/(^|[\s\n])$/.test(lastText) || out.length === 0 || 'break' in (out.at(-1) ?? {})) text = text.replace(/^ +/, '')
      }
      if (!text) continue
      const prev = out.at(-1)
      if (prev && 'text' in prev && sameMarks(prev, run)) prev.text += text
      else out.push({ ...run, text })
      lastText = text
    } else {
      if ('break' in run) {
        const prev = out.at(-1)
        if (prev && 'text' in prev) prev.text = prev.text.replace(/ +$/, '')
        lastText = '\n'
      } else lastText = 'x'
      out.push(run)
    }
  }
  // Trim the end: trailing spaces, then trailing line breaks.
  while (out.length > 0) {
    const last = out.at(-1)!
    if ('break' in last) {
      out.pop()
      continue
    }
    if ('text' in last) {
      last.text = last.text.replace(/\s+$/, '')
      if (!last.text) {
        out.pop()
        continue
      }
    }
    break
  }
  while (out.length > 0 && 'break' in out[0]!) out.shift()
  return out.filter((run) => !('text' in run) || run.text.length > 0)
}

function sameMarks(a: Run, b: Run): boolean {
  const keys = ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup', 'link'] as const
  return keys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
}

// ------------------------------------------------------------------------------------ helpers

function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ')
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  const style = el.getAttribute('style') ?? ''
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}

function codeLanguage(pre: Element): string | undefined {
  const classes = `${pre.getAttribute('class') ?? ''} ${pre.querySelector('code')?.getAttribute('class') ?? ''}`
  return /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1]
}

export function absolutize(href: string, baseUrl?: string): string | undefined {
  try {
    return new URL(href, baseUrl).href
  } catch {
    return undefined
  }
}

/** An http(s) or mailto URL the API will accept, or undefined. */
export function safeHref(href: string | null, baseUrl?: string): string | undefined {
  if (!href) return undefined
  const absolute = absolutize(href.trim(), baseUrl)
  if (!absolute || !/^(https?:|mailto:)/i.test(absolute) || absolute.length > 2048) return undefined
  return absolute
}

/** Moves every heading so the highest one in the clip lands at `top` (capped at 6). */
export function shiftHeadings(blocks: Block[], top: number): Block[] {
  let min = 7
  visit(blocks, (block) => {
    if (block.kind === 'heading') min = Math.min(min, block.level)
  })
  if (min === 7 || min === top) return blocks
  const delta = top - min
  visit(blocks, (block) => {
    if (block.kind === 'heading') block.level = Math.max(1, Math.min(6, block.level + delta)) as typeof block.level
  })
  return blocks
}

/** Calls `fn` on every block, depth first, including nested children. */
export function visit(blocks: Block[], fn: (block: Block) => void): void {
  for (const block of blocks) {
    fn(block)
    if ('children' in block && Array.isArray(block.children)) visit(block.children as Block[], fn)
  }
}

/** Replaces blocks anywhere in the tree. Returning an array splices several blocks in; [] removes the block. */
export function mapBlocks(blocks: Block[], fn: (block: Block) => Block | Block[]): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    const copy = 'children' in block && Array.isArray(block.children) ? ({ ...block, children: mapBlocks(block.children as Block[], fn) } as Block) : block
    const mapped = fn(copy)
    out.push(...(Array.isArray(mapped) ? mapped : [mapped]))
  }
  return out
}
