import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pickImages, reflow, type ReflowBlock } from '../src/pdf/reflow.js'
import type { PageContent, PdfText } from '../src/pdf/types.js'

// A letter-sized page laid out like a D&D book: 10pt body text in two columns (54–297 and 315–558).
const W = 612
const H = 792
const t = (str: string, x: number, y: number, opts: Partial<PdfText> = {}): PdfText => {
  const size = opts.size ?? 10
  return { str, x, y, w: str.length * size * 0.45, size, font: 'Body-Regular', bold: false, italic: false, ...opts }
}
const bold = (str: string, x: number, y: number, size = 10) => t(str, x, y, { font: 'Body-Bold', bold: true, size })
const page = (number: number, text: PdfText[], extra: Partial<PageContent> = {}): PageContent => ({ number, width: W, height: H, text, shapes: [], images: [], ...extra })

/** Lines of filler body text down one column, each reaching the column's right edge. */
function column(x: number, y: number, lines: string[]): PdfText[] {
  return lines.map((s, i) => ({ ...t(s, x, y + i * 12), w: 243 }))
}

/** Runs set one after another on a line, starting at x. */
function line(x: number, y: number, runs: PdfText[]): PdfText[] {
  return runs.map((r) => {
    const placed = { ...r, x, y }
    x += r.w
    return placed
  })
}

const plain = (b: ReflowBlock) => (b.type === 'paragraph' ? b.runs.map((r) => r.text).join('') : b.type === 'heading' ? b.text : b.type)

describe('reflow: reading order', () => {
  it('reads the left column before the right, under a title that spans both', () => {
    const pages = [page(1, [
      { ...t('Adventure Summary', 54, 60, { size: 36, font: 'Display' }), w: 400 },
      ...column(54, 100, ['left one runs on and on', 'left two runs on and on', 'left three ends here.']),
      ...column(315, 100, ['right one runs on and on', 'right two runs on and on', 'right three ends here.']),
      { ...t('Other Title', 54, 400, { size: 36, font: 'Display' }), w: 400 },
      ...column(54, 440, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9 end.']),
      ...column(315, 440, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9 end.']),
    ])]
    const blocks = reflow(pages).blocks
    assert.deepEqual(blocks.map(plain), [
      'Adventure Summary',
      'left one runs on and on left two runs on and on left three ends here.',
      'right one runs on and on right two runs on and on right three ends here.',
      'Other Title',
      'l1 l2 l3 l4 l5 l6 l7 l8 l9 end.',
      'r1 r2 r3 r4 r5 r6 r7 r8 r9 end.',
    ])
    assert.equal(blocks[0]?.type === 'heading' && blocks[0].level, 1)
  })

  it('carries a paragraph on into the next column and joins words broken by a hyphen', () => {
    const pages = [page(1, [
      ...column(54, 100, ['The party', 'goes into', 'the dark', 'tomb with great advan-']),
      ...column(315, 100, ['tage and some advantage', 'later on.', 'x', 'y']),
    ])]
    const [first] = reflow(pages).blocks
    assert.match(plain(first!), /^The party goes into the dark tomb with great advantage and some advantage later on\./)
  })
})

describe('reflow: structure', () => {
  it('starts a new paragraph at a bold lead-in after a finished sentence', () => {
    const pages = [page(1, [
      ...line(54, 100, [bold('Multiattack. ', 0, 0), { ...t('It makes two attacks.', 0, 0), w: 180 }]),
      ...line(54, 112, [bold('Handaxe. ', 0, 0), { ...t('Melee Weapon Attack: +5 to hit.', 0, 0), w: 200 }]),
    ])]
    assert.deepEqual(reflow(pages).blocks.map(plain), ['Multiattack. It makes two attacks.', 'Handaxe. Melee Weapon Attack: +5 to hit.'])
  })

  it('joins a drop cap to the word it begins', () => {
    const pages = [page(1, [t('W', 54, 140, { size: 100, font: 'Fancy' }), t('elcome, adventurers', 120, 100), t('to the World', 120, 112)])]
    assert.equal(plain(reflow(pages).blocks[0]!), 'Welcome, adventurers to the World')
  })

  it('makes a table from aligned rows and groups a stat block under its name', () => {
    const pages = [page(1, [
      bold('Bolton Bluntaxe', 54, 80, 14),
      t('medium humanoid (dwarf), lawful evil', 54, 95, { italic: true, font: 'Body-Italic' }),
      bold('Armor Class:', 54, 115), t('15 (breastplate)', 115, 115),
      bold('STR', 60, 140, 8), bold('DEX', 110, 140, 8), bold('CON', 160, 140, 8),
      t('16 (+3)', 58, 155, { size: 9 }), t('12 (+1)', 108, 155, { size: 9 }), t('14 (+2)', 158, 155, { size: 9 }),
      bold('Actions', 54, 190, 14),
      bold('Multiattack:', 54, 210), t('two attacks.', 120, 210),
      bold('Other Heading', 54, 260, 14),
      bold('Armor Class:', 54, 280), t('9', 115, 280),
    ])]
    const [block] = reflow(pages, { styles: { 'Body-Bold@14': 'h3' } }).blocks
    assert.equal(block?.type, 'statblock')
    if (block?.type !== 'statblock') return
    assert.equal(block.name, 'Bolton Bluntaxe')
    const table = block.blocks.find((b) => b.type === 'table')
    assert.deepEqual(table?.type === 'table' && table.rows.map((r) => r.map((c) => c.map((x) => x.text).join(''))), [['STR', 'DEX', 'CON'], ['16 (+3)', '12 (+1)', '14 (+2)']])
    assert.ok(block.blocks.some((b) => plain(b) === 'Actions'), '"Actions" stays inside the stat block')
    assert.ok(!block.blocks.some((b) => plain(b) === 'Other Heading'))
  })

  it('reports detected styles and applies corrections', () => {
    const pages = [page(1, [
      t('Big Title', 54, 60, { size: 24, font: 'Display' }),
      t('Another Big One', 54, 300, { size: 24, font: 'Display' }),
      ...column(54, 100, ['body text body text', 'body text body text', 'body text body text']),
    ])]
    const auto = reflow(pages)
    assert.equal(auto.styles.find((s) => s.key === 'Display@24')?.role, 'h1')
    const fixed = reflow(pages, { styles: { 'Display@24': 'body' } })
    assert.equal(fixed.blocks.filter((b) => b.type === 'heading').length, 0)
    assert.equal(fixed.styles.find((s) => s.key === 'Display@24')?.auto, false)
  })

  it('title-cases small caps headings', () => {
    const sc = (str: string, size: number) => t(str, 0, 0, { font: 'Gothic-SC700', size })
    const pages = [page(1, [
      ...line(54, 100, [sc('h', 18), sc('ired ', 12.5), sc('b', 18), sc('Y THE ', 12.5), sc('s', 18), sc('eekers', 12.5)]),
      ...line(54, 300, [sc('X', 18), sc('yz', 12.5)]),
      ...column(54, 500, ['body text', 'body text', 'body text']),
    ])]
    assert.equal(plain(reflow(pages).blocks[0]!), 'Hired by the Seekers')
  })
})

describe('reflow: layout', () => {
  /** Two columns of body text at the given left edges, long enough for a gutter to show. */
  const twoColumns = (number: number, leftX: number, rightX: number, lines = 8) => page(number, [
    ...column(leftX, 100, Array.from({ length: lines }, (_, i) => `left ${number} line ${i} runs on and on${i === lines - 1 ? ' end.' : ''}`)),
    ...column(rightX, 100, Array.from({ length: lines }, (_, i) => `right ${number} line ${i} runs on and on${i === lines - 1 ? ' end.' : ''}`)),
  ])
  const texts = (pages: PageContent[], options = {}) => reflow(pages, options).blocks.map(plain)

  it('finds each page its own gutter when the margins mirror', () => {
    // Odd pages are set 24pt further right than even pages, so no one gutter fits the whole book.
    const pages = [twoColumns(1, 78, 339), twoColumns(2, 54, 315), twoColumns(3, 78, 339), twoColumns(4, 54, 315)]
    const result = reflow(pages)
    assert.deepEqual(Object.keys(result.dividers), ['1', '2', '3', '4'])
    assert.ok(result.dividers[1]! > result.dividers[2]!, 'odd pages divide further right than even ones')
    assert.equal(result.blocks.length, 8)
    for (const b of result.blocks) assert.equal(new Set(plain(b).match(/(left|right) \d/g)).size, 1, `columns are not mixed: ${plain(b)}`)
  })

  it('takes the gutter the other pages on that side share, on a page of wide tables', () => {
    const wide = page(3, [
      ...column(78, 100, ['left 3 line 0 runs on and on and on', 'left 3 line 1 runs on and on and on']),
      ...column(339, 100, ['right 3 line 0 runs on and on and on', 'right 3 line 1 runs on and on and on']),
      // A table whose cells straddle the gutter on every row.
      ...[0, 1, 2, 3, 4, 5].flatMap((r) => [t('Name', 78, 200 + r * 12), t('Cell across the middle', 250, 200 + r * 12), t('End', 500, 200 + r * 12)]),
    ])
    const result = reflow([twoColumns(1, 78, 339), twoColumns(2, 54, 315), wide, twoColumns(4, 54, 315), twoColumns(5, 78, 339), twoColumns(6, 54, 315), twoColumns(7, 78, 339)])
    assert.equal(Math.round(result.dividers[3]!), Math.round(result.dividers[1]!))
    assert.ok(result.blocks.some((b) => b.type === 'table' && b.page === 3 && b.rows.length === 6), 'the wide table is read as one table')
  })

  it('reads every page as one column when the layout says so, and splits at a divider set by hand', () => {
    const pages = [twoColumns(1, 78, 339), twoColumns(2, 54, 315)]
    const one = reflow(pages, { layout: { columns: 1 } })
    assert.deepEqual(one.dividers, {})
    assert.ok(Object.keys(reflow(pages).dividers).length === 2, 'found on its own otherwise')
    // No gutter can be found on two pages alone, so the divider has to be given.
    const divided = reflow([twoColumns(1, 78, 339, 5), twoColumns(2, 54, 315, 5)], { layout: { divider: { odd: 330 / W, even: 304 / W } } })
    assert.deepEqual(divided.dividers, { 1: 330, 2: 304 })
    assert.deepEqual(texts([twoColumns(1, 78, 339, 5)], { layout: { divider: { odd: 330 / W } } }), [
      'left 1 line 0 runs on and on left 1 line 1 runs on and on left 1 line 2 runs on and on left 1 line 3 runs on and on left 1 line 4 runs on and on end.',
      'right 1 line 0 runs on and on right 1 line 1 runs on and on right 1 line 2 runs on and on right 1 line 3 runs on and on right 1 line 4 runs on and on end.',
    ])
  })

  it('leaves out the margins the layout says to ignore', () => {
    const pages = [page(1, [
      t('Running head', 54, 30),
      ...column(54, 100, ['body text runs on', 'body text runs on', 'body text ends.']),
      t('42', 300, 770),
    ])]
    assert.deepEqual(texts(pages, { layout: { margins: { top: 0.06, bottom: 0.05 } } }), ['body text runs on body text runs on body text ends.'])
  })

  it('drops page numbers set large near the bottom edge and letters down the side of the page', () => {
    const tab = ['C', 'H', 'A', 'P', 'T', 'E', 'R'].map((c, i) => t(c, 580, 120 + i * 18, { size: 24, font: 'Display' }))
    const pages = [page(1, [
      ...column(54, 100, ['body text runs on and on and on', 'body text runs on and on and on', 'body text runs on and on and on', 'body text ends.']),
      ...column(315, 100, ['right text runs on and on and on', 'right text runs on and on and on', 'right text runs on and on and on', 'right text ends.']),
      ...tab,
      t('161', 540, 700, { size: 24, font: 'Display' }),
    ])]
    assert.deepEqual(texts(pages), [
      'body text runs on and on and on body text runs on and on and on body text runs on and on and on body text ends.',
      'right text runs on and on and on right text runs on and on and on right text runs on and on and on right text ends.',
    ])
  })

  const filler = (n: number) => Array.from({ length: n }, (_, i) => (i === n - 1 ? 'text ends here.' : 'text runs on and on and on'))
  it('keeps lines of text beside a wide table out of it', () => {
    const pages = [page(1, [
      ...column(54, 100, filler(16)),
      ...column(315, 100, filler(16)),
      // A wide table just under the columns.
      ...[0, 1, 2].flatMap((r) => [bold('Age', 54, 304 + r * 12, 9), bold('Size', 150, 304 + r * 12, 9), bold('Across the gutter', 250, 304 + r * 12, 9), bold('SR', 500, 304 + r * 12, 9)]),
    ])]
    const blocks = reflow(pages).blocks
    const table = blocks.find((b) => b.type === 'table')
    assert.ok(table?.type === 'table' && table.rows.length === 3, 'three table rows')
    assert.equal(blocks.filter((b) => plain(b) === filler(16).join(' ')).length, 2, 'both columns stay paragraphs')
  })

  it('splits a big heading joined across the gutter with the other column', () => {
    const pages = [page(1, [
      t('CHARACTER', 100, 80, { size: 28, font: 'Display' }), t('4. REVIEW THE', 317, 84, { size: 18, font: 'Display' }),
      t('CREATION BASICS', 54, 108, { size: 28, font: 'Display' }), t('PACKAGES', 317, 98, { size: 18, font: 'Display' }),
      ...column(54, 140, filler(12)),
      ...column(315, 140, filler(12)),
    ])]
    const headings = reflow(pages).blocks.filter((b) => b.type === 'heading').map(plain)
    assert.ok(headings.includes('CHARACTER CREATION BASICS'), `headings: ${headings.join(' / ')}`)
    assert.ok(headings.includes('4. REVIEW THE PACKAGES'), `headings: ${headings.join(' / ')}`)
  })

  it('carries on a hanging indent, and reads a table title under the columns before the table', () => {
    const pages = [page(1, [
      ...column(54, 100, filler(12)),
      ...column(315, 100, filler(10)),
      ...line(315, 220, [bold('Advancement: ', 0, 0), { ...t('Juvenile 18–19 HD (Large); young adult 21–22', 0, 0), w: 180 }]),
      { ...t('HD (Huge); adult 24–25 HD (Huge).', 333, 232), w: 150 },
      t('Lungs by Age', 54, 244, { font: 'Caps-Bold', bold: true }),
      ...[0, 1, 2].flatMap((r) => [bold('Age', 54, 258 + r * 12, 9), bold('Size', 150, 258 + r * 12, 9), bold('Across the gutter', 250, 258 + r * 12, 9), bold('SR', 500, 258 + r * 12, 9)]),
    ])]
    const out = texts(pages)
    assert.ok(out.includes('Advancement: Juvenile 18–19 HD (Large); young adult 21–22 HD (Huge); adult 24–25 HD (Huge).'), out.join(' / '))
    assert.equal(out.indexOf('Lungs by Age'), out.indexOf('table') - 1, `the title comes just before its table: ${out.join(' / ')}`)
    assert.ok(out.indexOf('Lungs by Age') > out.indexOf('Advancement: Juvenile 18–19 HD (Large); young adult 21–22 HD (Huge); adult 24–25 HD (Huge).'), 'after the right column')
  })

  it('keeps text wrapped round a picture, and its caption, out of tables', () => {
    const art = { id: 'art', width: 600, height: 400, x0: 200, y0: 240, x1: 420, y1: 400 }
    const short = (x: number, y: number, str: string, w: number) => ({ ...t(str, x, y), w })
    const pages = [page(1, [
      ...column(54, 100, filler(10)),
      ...column(315, 100, filler(10)),
      // Lines either side of the picture, and its name printed on it.
      ...[0, 1, 2, 3, 4].flatMap((r) => [short(54, 260 + r * 12, 'left wrapped line', 120), short(440, 260 + r * 12, 'right wrapped line', 118)]),
      t('Dokufu', 290, 390, { italic: true, font: 'Body-Italic' }),
    ], { images: [art] })]
    const blocks = reflow(pages).blocks
    assert.ok(!blocks.some((b) => b.type === 'table'), `no tables: ${blocks.map(plain).join(' / ')}`)
    assert.ok(blocks.some((b) => plain(b) === 'Dokufu'), 'the caption is a line of its own')
    assert.ok(blocks.some((b) => b.type === 'image' && b.id === 'art'), 'the picture is kept')
  })

  it('leaves out ornament fonts and reports scanned pages', () => {
    const pages = [page(1, [
      t('pqqqqrs', 54, 90, { font: 'IndecisionLines', size: 10 }),
      ...column(54, 100, ['body text runs on', 'body text runs on', 'body text ends.']),
    ], { hiddenText: true })]
    const result = reflow(pages)
    assert.equal(result.styles.find((s) => s.font === 'IndecisionLines')?.role, 'ignore')
    assert.deepEqual(result.blocks.map(plain), ['body text runs on body text runs on body text ends.'])
    assert.deepEqual(result.scanned, [1])
  })
})

describe('extractPage', () => {
  it('places text and shapes by the page as shown, when the CropBox is offset and the page is turned', async () => {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { extractPage } = await import('../src/pdf/extract.js')
    // Two pages: one with its CropBox 54pt in from a larger MediaBox, one rotated 90°.
    const content = (text: string) => `BT /F1 12 Tf 100 700 Td (${text}) Tj ET 0 0 1 rg 100 600 200 20 re f`
    const pdf = smallPdf([
      { boxes: '/MediaBox [0 0 702 891] /CropBox [54 54 648 837]', content: content('Hello') },
      { boxes: '/MediaBox [0 0 612 792] /Rotate 90', content: content('Turned') },
    ])
    const task = getDocument({ data: pdf, fontExtraProperties: true, verbosity: 0 })
    const doc = await task.promise
    const first = await extractPage(await doc.getPage(1), OPS as unknown as Record<string, number>)
    assert.equal(Math.round(first.width), 594)
    assert.equal(Math.round(first.height), 783)
    const hello = first.text.find((t) => t.str === 'Hello')!
    assert.equal(Math.round(hello.x), 100 - 54)
    assert.equal(Math.round(hello.y), 837 - 700)
    const shape = first.shapes.find((s) => s.fill === '#0000ff')!
    assert.deepEqual([shape.x0, shape.y0, shape.x1, shape.y1].map(Math.round), [46, 217, 246, 237])
    assert.equal(first.hiddenText, undefined)

    const second = await extractPage(await doc.getPage(2), OPS as unknown as Record<string, number>)
    assert.equal(Math.round(second.width), 792)
    assert.equal(Math.round(second.height), 612)
    // Upright text on a page turned 90° is not upright as shown, so it is left out.
    assert.equal(second.text.length, 0)
    await task.destroy()
  })

  it('notes text drawn invisibly, as OCR lays it over a scan', async () => {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { extractPage } = await import('../src/pdf/extract.js')
    const pdf = smallPdf([{ boxes: '/MediaBox [0 0 612 792]', content: 'BT 3 Tr /F1 12 Tf 100 700 Td (Recognised) Tj ET' }])
    const task = getDocument({ data: pdf, verbosity: 0 })
    const doc = await task.promise
    const page = await extractPage(await doc.getPage(1), OPS as unknown as Record<string, number>)
    assert.equal(page.hiddenText, true)
    assert.equal(page.text[0]?.str, 'Recognised')
    await task.destroy()
  })
})

/** A small PDF with the standard Helvetica font and one content stream per page. */
function smallPdf(pages: { boxes: string; content: string }[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => { objects.push(body); return objects.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = objects.length + 1 + pages.length * 2
  const pageIds = pages.map((p) => {
    const stream = add(`<< /Length ${Buffer.byteLength(p.content)} >>\nstream\n${p.content}\nendstream`)
    return add(`<< /Type /Page /Parent ${pagesId} 0 R ${p.boxes} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`)
  })
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'binary'))
}

describe('pickImages', () => {
  it('drops page backgrounds, repeated decorations, art drawn twice and panels under text', () => {
    const bg = { id: 'bg', width: 2448, height: 1584, x0: 0, y0: 0, x1: W, y1: H }
    const logo = { id: 'logo', width: 200, height: 200, x0: 500, y0: 700, x1: 560, y1: 760 }
    const art = { width: 999, height: 1132, x0: 54, y0: 180, x1: 553, y1: 748 }
    const panelText = Array.from({ length: 10 }, (_, i) => ({ ...t('a row of text across the panel', 100, 420 + i * 12), w: 400 }))
    const pages = [
      page(1, [], { images: [bg, logo, { ...art, id: 'knockout' }, { ...art, id: 'art' }] }),
      page(2, panelText, { images: [bg, logo, { id: 'panel', width: 1000, height: 900, x0: 54, y0: 400, x1: 554, y1: 560 }] }),
      page(3, [], { images: [bg, logo] }),
    ]
    assert.deepEqual(pickImages(pages).map((i) => `${i.page}:${i.id}`), ['1:art'])
  })
})

describe('isPdfUrl', () => {
  it('spots PDFs by their path, on the web and on disk', async () => {
    const { isPdfUrl } = await import('../src/extension/tabCapture.js')
    assert.equal(isPdfUrl('https://example.com/books/tomb.pdf'), true)
    assert.equal(isPdfUrl('https://example.com/books/TOMB.PDF?download=1'), true)
    assert.equal(isPdfUrl('file:///C:/Users/me/Downloads/The_Forgotten_Tomb_of_Acererak.pdf'), true)
    assert.equal(isPdfUrl('https://example.com/pdf-guide'), false)
    assert.equal(isPdfUrl(undefined), false)
  })
})
