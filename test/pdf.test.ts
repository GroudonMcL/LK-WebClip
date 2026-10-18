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
