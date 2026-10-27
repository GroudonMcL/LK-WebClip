import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { looksScanned, pickImages, reflow, type ReflowBlock } from '../src/pdf/reflow.js'
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
function column(x: number, y: number, lines: string[], w = 243): PdfText[] {
  return lines.map((s, i) => ({ ...t(s, x, y + i * 12), w }))
}

/** n lines named prefix1…prefixn, the last ending a sentence. */
const filler = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}${i === n - 1 ? ' end.' : ''}`)

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

describe('reflow: layouts', () => {
  // Three columns, 54–210, 228–384 and 402–558.
  const threeColumns = (n: number) => page(n, [
    ...column(54, 100, filler('a', 10), 156),
    ...column(228, 100, filler('b', 10), 156),
    ...column(402, 100, filler('c', 10), 156),
  ])

  it('reads three columns left to right', () => {
    const result = reflow([threeColumns(1)])
    assert.deepEqual(result.blocks.map(plain), ['a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 end.', 'b1 b2 b3 b4 b5 b6 b7 b8 b9 b10 end.', 'c1 c2 c3 c4 c5 c6 c7 c8 c9 c10 end.'])
    assert.deepEqual(result.layouts, [{ page: 1, columns: 3, sidebar: false, layout: 'auto' }])
  })

  it('finds three columns on one page of a two-column book', () => {
    const two = (n: number) => page(n, [...column(54, 100, filler(`l${n}-`, 12)), ...column(315, 100, filler(`r${n}-`, 12))])
    const result = reflow([two(1), threeColumns(2), two(3)])
    assert.deepEqual(result.layouts.map((l) => l.columns), [2, 3, 2])
    assert.deepEqual(result.blocks.filter((b) => b.page === 2).map((b) => plain(b).slice(0, 2)), ['a1', 'b1', 'c1'])
  })

  it('reads a sidebar after the main text, and never runs the main text into it', () => {
    const pages = [page(1, [
      ...column(54, 100, ['Sidebar: the town', 'of Hommlet has', 'a mill, an inn', 'and a temple.', 'Its people are', 'wary of strangers.'], 120),
      ...column(200, 100, ['The main text runs', 'down the wide column', 'for a good many lines', 'and keeps going on', 'until the page ends', 'in the middle of a', 'sentence that carries'], 358),
    ])]
    const result = reflow(pages)
    assert.deepEqual(result.layouts[0], { page: 1, columns: 2, sidebar: true, layout: 'auto' })
    assert.deepEqual(result.blocks.map(plain), [
      'The main text runs down the wide column for a good many lines and keeps going on until the page ends in the middle of a sentence that carries',
      'Sidebar: the town of Hommlet has a mill, an inn and a temple. Its people are wary of strangers.',
    ])
  })

  it('takes a layout set by hand', () => {
    // Too few lines in each column for the columns to be found.
    const pages = [page(1, [...column(54, 100, ['left one', 'left two', 'left three.']), ...column(315, 100, ['right one', 'right two', 'right three.'])])]
    assert.equal(reflow(pages).blocks[0]?.type, 'table')
    const result = reflow(pages, { layouts: { 1: 'two' } })
    assert.deepEqual(result.blocks.map(plain), ['left one left two left three.', 'right one right two right three.'])
    assert.equal(result.layouts[0]?.layout, 'two')
    const sidebar = reflow([page(1, [...column(54, 100, ['side one', 'side two'], 100), ...column(200, 100, ['main one', 'main two'], 358)])], { layouts: { 1: 'sidebar' } })
    assert.deepEqual(sidebar.blocks.map(plain), ['main one main two', 'side one side two'])
    const one = reflow([threeColumns(1)], { layouts: { 1: 'one' } })
    assert.equal(one.layouts[0]?.columns, 1)
  })
})

describe('reflow: marked areas', () => {
  it('leaves out a skipped area', () => {
    const pages = [page(1, [...column(54, 100, ['Keep this line.', 'Credits: the art team.', 'And this one.'])])]
    const blocks = reflow(pages, { regions: [{ page: 1, kind: 'skip', x0: 50, y0: 104, x1: 300, y1: 114 }] }).blocks
    assert.deepEqual(blocks.map(plain), ['Keep this line.', 'And this one.'])
  })

  it('reads a marked area as one block, in its place', () => {
    // Centred lines of a letter, which would otherwise split oddly.
    const pages = [page(1, [
      { ...t('Before the letter.', 54, 80), w: 243 },
      t('Dear Lord Wyvern,', 120, 120), t('come at once to', 140, 132), t('the old mill.', 150, 144), t('Signed, a friend.', 125, 168),
      { ...t('After the letter.', 54, 220), w: 243 },
    ])]
    const blocks = reflow(pages, { regions: [{ page: 1, kind: 'block', x0: 100, y0: 105, x1: 260, y1: 175 }] }).blocks
    assert.deepEqual(blocks.map(plain), ['Before the letter.', 'Dear Lord Wyvern, come at once to the old mill. Signed, a friend.', 'After the letter.'])
  })

  it('reads a marked area as a table, with wrapped cells', () => {
    // Cells set closer together than the gap that normally splits a table's cells.
    const cell = (s: string, x: number, y: number) => t(s, x, y)
    const pages = [page(1, [
      bold('d6', 60, 100), bold('Encounter', 80, 100),
      cell('1', 60, 112), cell('A lost goblin', 80, 112),
      cell('looking for home', 80, 124),
      cell('2', 60, 136), cell('Two wolves', 80, 136),
    ])]
    const [table] = reflow(pages, { regions: [{ page: 1, kind: 'table', x0: 50, y0: 85, x1: 300, y1: 140 }] }).blocks
    assert.equal(table?.type, 'table')
    if (table?.type !== 'table') return
    assert.equal(table.header, true)
    assert.deepEqual(table.rows.map((r) => r.map((c) => c.map((x) => x.text).join(''))), [['d6', 'Encounter'], ['1', 'A lost goblin looking for home'], ['2', 'Two wolves']])
  })
})

describe('reflow: scan mode', () => {
  // OCR text: one font for everything, and every word at its own height and size.
  const jitter = [0.6, -0.5, 0.3, -0.8, 0.7, -0.2, 0.5, -0.6]
  const ocrLine = (words: string[], x: number, y: number, size: number, k: number): PdfText[] => words.map((w, i) => {
    const s = size * (1 + jitter[(i + k) % jitter.length]! * 0.04)
    const item = { ...t(w, x, y + jitter[(i * 3 + k) % jitter.length]! * size * 0.08, { size: s, font: 'Times' }), w: w.length * s * 0.45 }
    x += item.w + size * 0.3
    return item
  })
  const scanned = page(1, [
    ...ocrLine(['The', 'Old', 'Mill'], 54, 80, 18, 0),
    ...['the miller has gone', 'missing and nobody in', 'the village will say', 'where he went.'].flatMap((l, i) => ocrLine(l.split(' '), 54, 110 + i * 12, 10, i + 1)),
    ...ocrLine(['The', 'Inn'], 54, 190, 18, 5),
    ...['the inn is warm and', 'the beer is cheap.'].flatMap((l, i) => ocrLine(l.split(' '), 54, 220 + i * 12, 10, i + 2)),
  ])

  it('is spotted, and joins jittery words into lines and headings by size alone', () => {
    assert.equal(looksScanned([scanned]), true)
    const result = reflow([scanned])
    assert.equal(result.scan, true)
    assert.deepEqual(result.blocks.map((b) => `${b.type === 'heading' ? `h${b.level}` : b.type}: ${plain(b)}`), [
      'h1: The Old Mill',
      'paragraph: the miller has gone missing and nobody in the village will say where he went.',
      'h1: The Inn',
      'paragraph: the inn is warm and the beer is cheap.',
    ])
  })

  it('is not used for typeset text unless asked for', () => {
    const typeset = [page(1, [t('Title', 54, 60, { size: 24, font: 'Display' }), ...column(54, 100, filler('x', 50))])]
    assert.equal(looksScanned(typeset), false)
    assert.equal(reflow(typeset).scan, false)
    assert.equal(reflow([scanned], { scan: false }).scan, false)
  })
})

describe('reflow: sample PDFs read with pdf.js', () => {
  // Made by test/fixtures/make-layouts-pdf.py.
  const read = async (name: string) => {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { extractPage } = await import('../src/pdf/extract.js')
    const data = new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)))
    const doc = await getDocument({ data, fontExtraProperties: true, disableFontFace: true, verbosity: 0 }).promise
    const pages: PageContent[] = []
    for (let n = 1; n <= doc.numPages; n++) pages.push(await extractPage(await doc.getPage(n), OPS as unknown as Record<string, number>))
    await doc.cleanup()
    return pages
  }

  it('finds two columns, three columns and a sidebar, page by page', async () => {
    const pages = await read('layouts.pdf')
    const result = reflow(pages)
    assert.equal(result.scan, false)
    assert.deepEqual(result.layouts.map((l) => `${l.columns}${l.sidebar ? '+sidebar' : ''}`), ['2', '2', '3', '2+sidebar', '1'])
    const page1 = result.blocks.filter((b) => b.page === 1)
    assert.ok(page1.some((b) => /the travellers keep on walking until nightfall\.$/.test(plain(b))), 'a paragraph carries on into the next column')
    // The sidebar comes after the main text.
    const page4 = result.blocks.filter((b) => b.page === 4).map(plain)
    assert.equal(page4.indexOf('Village Notes'), page4.length - 2)
    assert.ok(result.blocks.some((b) => b.type === 'statblock' && b.name === 'Goblin Boss'))
  })

  it('reads marked areas and set layouts', async () => {
    const pages = await read('layouts.pdf')
    const result = reflow(pages, {
      layouts: { 3: 'one' },
      regions: [
        { page: 5, kind: 'block', x0: 100, y0: 105, x1: 512, y1: 190 },
        { page: 5, kind: 'table', x0: 50, y0: 218, x1: 200, y1: 285 },
        { page: 5, kind: 'skip', x0: 50, y0: 55, x1: 300, y1: 75 },
      ],
    })
    assert.equal(result.layouts[2]?.columns, 1)
    const page5 = result.blocks.filter((b) => b.page === 5)
    assert.deepEqual(page5.slice(0, 2).map(plain), ['My dear Lord Wyvern, come at once to the old mill, for the miller has seen the thing in the river again. Your friend, Ostler Gundigoot', 'table'])
    const table = page5[1]
    assert.deepEqual(table?.type === 'table' && table.rows.map((r) => r.map((c) => c.map((x) => x.text).join(''))), [['d6', 'Encounter'], ['1', 'A lost goblin'], ['2', 'Two wolves'], ['3', 'A hungry bear']])
  })

  it('spots a scan and finds its headings by size', async () => {
    const result = reflow(await read('scanned.pdf'))
    assert.equal(result.scan, true)
    assert.deepEqual(result.blocks.map((b) => b.type), ['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph'])
    assert.deepEqual(result.blocks.filter((b) => b.type === 'heading').map(plain), ['Chapter 1', 'Chapter 2', 'Chapter 3'])
  })
})

describe('pickImages', () => {
  it('drops page backgrounds, repeated decorations, art drawn twice and panels under text', () => {
    const bg = { id: 'bg', width: 2448, height: 1584, x0: 0, y0: 0, x1: W, y1: H }
    const logo = { id: 'logo', width: 200, height: 200, x0: 500, y0: 700, x1: 560, y1: 760 }
    const art = { width: 999, height: 1132, x0: 54, y0: 180, x1: 553, y1: 748 }
    const panelText = Array.from({ length: 10 }, (_, i) => t('row', 100, 420 + i * 12))
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
