import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DOMParser } from 'linkedom'
import type { Block } from '@legendkeeper/sdk/blocks'
import { blocksToHtml, htmlStringToBlocks, shiftHeadings, tidyRuns, type ConvertOptions } from '../src/clip/index.js'

const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const base = 'https://example.com/wiki/Dragons'
const convert = (html: string, options: ConvertOptions = {}) => htmlStringToBlocks(html, parser, { baseUrl: base, topHeadingLevel: 0, ...options })
const blocks = (html: string, options?: ConvertOptions) => convert(html, options).blocks

describe('htmlToBlocks: text and marks', () => {
  it('collapses whitespace like a browser and trims paragraph edges', () => {
    assert.deepEqual(blocks('<p>\n  Red   dragons\n are <b> greedy </b> .  </p>'), [
      { kind: 'paragraph', content: [{ text: 'Red dragons are ' }, { text: 'greedy ', bold: true }, { text: '.' }] },
    ])
  })

  it('keeps every inline mark the API supports', () => {
    const [p] = blocks('<p><strong>b</strong><em>i</em><u>u</u><del>s</del><code>c</code><sub>2</sub><sup>3</sup><span style="font-weight:700">B</span></p>')
    assert.deepEqual(p, {
      kind: 'paragraph',
      content: [
        { text: 'b', bold: true }, { text: 'i', italic: true }, { text: 'u', underline: true }, { text: 's', strike: true },
        { text: 'c', code: true }, { text: '2', sub: true }, { text: '3', sup: true }, { text: 'B', bold: true },
      ],
    })
  })

  it('drops other marks from code runs, and drops code when it is a link', () => {
    assert.deepEqual(blocks('<p><b><code>x</code></b></p>'), [{ kind: 'paragraph', content: [{ text: 'x', code: true }] }])
    assert.deepEqual(blocks('<p><a href="/a"><code>x</code></a></p>'), [{ kind: 'paragraph', content: [{ text: 'x', link: 'https://example.com/a' }] }])
  })

  it('resolves relative links and drops ones the API refuses', () => {
    const [p] = blocks('<p><a href="Red_Dragon">red</a> <a href="javascript:alert(1)">js</a> <a href="mailto:a@b.c">mail</a></p>')
    assert.deepEqual(p, {
      kind: 'paragraph',
      content: [{ text: 'red', link: 'https://example.com/wiki/Red_Dragon' }, { text: ' js ' }, { text: 'mail', link: 'mailto:a@b.c' }],
    })
  })

  it('turns <br> into line breaks without stray spaces', () => {
    assert.deepEqual(blocks('<p>one <br> two<br><br></p>'), [{ kind: 'paragraph', content: [{ text: 'one' }, { break: true }, { text: 'two' }] }])
  })

  it('wraps loose inline content into paragraphs around blocks', () => {
    assert.deepEqual(
      blocks('Intro <i>text</i><h2>Title</h2>tail').map((b) => b.kind),
      ['paragraph', 'heading', 'paragraph'],
    )
  })

  it('skips scripts, styles and hidden elements', () => {
    assert.deepEqual(blocks('<p>a<script>evil()</script><span style="display:none">hidden</span><span hidden>h</span>b</p>'), [
      { kind: 'paragraph', content: [{ text: 'ab' }] },
    ])
  })

  it('falls back to plain text when nothing else is found', () => {
    assert.deepEqual(blocks('just text'), [{ kind: 'paragraph', content: [{ text: 'just text' }] }])
    assert.deepEqual(blocks('   '), [])
  })
})

describe('htmlToBlocks: structure', () => {
  it('converts headings, quotes, rules and code blocks', () => {
    const out = blocks('<h1>A</h1><h3>B <em>c</em></h3><blockquote><p>Q</p></blockquote><hr><pre class="language-js">let x = 1\n  x++\n</pre>')
    assert.deepEqual(out, [
      { kind: 'heading', level: 1, content: [{ text: 'A' }] },
      { kind: 'heading', level: 3, content: [{ text: 'B ' }, { text: 'c', italic: true }] },
      { kind: 'quote', children: [{ kind: 'paragraph', content: [{ text: 'Q' }] }] },
      { kind: 'rule' },
      { kind: 'code', text: 'let x = 1\n  x++', language: 'js' },
    ])
  })

  it('shifts headings so the clip sits under the Source heading', () => {
    const out = blocks('<h1>A</h1><h2>B</h2><h6>C</h6>', { topHeadingLevel: 2 })
    assert.deepEqual(out.map((b) => b.kind === 'heading' && b.level), [2, 3, 6])
    assert.deepEqual(shiftHeadings(blocks('<h4>A</h4>'), 2).map((b) => b.kind === 'heading' && b.level), [2])
  })

  it('builds nested lists whose items always start with a paragraph', () => {
    const out = blocks('<ol start="3"><li>One<ul><li>Sub</li></ul></li><li><ul><li>No text first</li></ul></li></ol>')
    assert.deepEqual(out, [
      {
        kind: 'orderedList',
        start: 3,
        children: [
          {
            kind: 'listItem',
            children: [
              { kind: 'paragraph', content: [{ text: 'One' }] },
              { kind: 'bulletList', children: [{ kind: 'listItem', children: [{ kind: 'paragraph', content: [{ text: 'Sub' }] }] }] },
            ],
          },
          {
            kind: 'listItem',
            children: [
              { kind: 'paragraph', content: [] },
              { kind: 'bulletList', children: [{ kind: 'listItem', children: [{ kind: 'paragraph', content: [{ text: 'No text first' }] }] }] },
            ],
          },
        ],
      },
    ])
  })

  it('attaches a list nested directly in a list to the previous item', () => {
    const [list] = blocks('<ul><li>A</li><ul><li>A1</li></ul><li>B</li></ul>')
    assert.ok(list?.kind === 'bulletList')
    assert.equal(list.children.length, 2)
    assert.deepEqual((list.children[0] as any).children.map((c: Block) => c.kind), ['paragraph', 'bulletList'])
  })

  it('groups list items selected without their list into one list', () => {
    const out = blocks('<li>A</li>\n<li>B</li>')
    assert.equal(out.length, 1)
    assert.ok(out[0]?.kind === 'bulletList' && out[0].children.length === 2)
  })

  it('converts tables with header cells and spans', () => {
    const [table] = blocks('<table><thead><tr><th colspan="2">Stats</th></tr></thead><tbody><tr><td>STR</td><td><b>27</b></td></tr></tbody></table>')
    assert.deepEqual(table, {
      kind: 'table',
      children: [
        { kind: 'tableRow', children: [{ kind: 'tableCell', header: true, colspan: 2, children: [{ kind: 'paragraph', content: [{ text: 'Stats' }] }] }] },
        {
          kind: 'tableRow',
          children: [
            { kind: 'tableCell', children: [{ kind: 'paragraph', content: [{ text: 'STR' }] }] },
            { kind: 'tableCell', children: [{ kind: 'paragraph', content: [{ text: '27', bold: true }] }] },
          ],
        },
      ],
    })
  })

  it('flattens a table nested in a table cell, which the API cannot store', () => {
    const result = convert('<table><tr><td>a</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr></table>')
    const cell = result.blocks[0]?.kind === 'table' ? (result.blocks[0].children[0] as any).children[1] : undefined
    assert.deepEqual(cell?.children, [{ kind: 'paragraph', content: [{ text: 'x | y' }] }])
    assert.equal(result.warnings.length, 1)
  })

  it('unwraps one-cell layout tables and keeps captions', () => {
    assert.deepEqual(blocks('<table><tr><td><p>Just content</p></td></tr></table>'), [{ kind: 'paragraph', content: [{ text: 'Just content' }] }])
    assert.deepEqual(blocks('<table><caption>Loot</caption><tr><td>a</td><td>b</td></tr></table>').map((b) => b.kind), ['paragraph', 'table'])
  })

  it('treats table rows selected without their table as text', () => {
    assert.deepEqual(blocks('<tr><td>a</td><td>b</td></tr>'), [{ kind: 'paragraph', content: [{ text: 'a b' }] }])
  })

  it('keeps definition lists, figures and details readable', () => {
    assert.deepEqual(blocks('<dl><dt>Armor Class</dt><dd>19</dd></dl>'), [
      { kind: 'paragraph', content: [{ text: 'Armor Class', bold: true }] },
      { kind: 'paragraph', content: [{ text: '19' }] },
    ])
    assert.deepEqual(blocks('<details><summary>More</summary>Hidden lore</details>'), [
      { kind: 'paragraph', content: [{ text: 'More', bold: true }] },
      { kind: 'paragraph', content: [{ text: 'Hidden lore' }] },
    ])
  })

  it('handles block elements inside inline ones', () => {
    assert.deepEqual(blocks('<a href="/x"><div>Card title</div><div>Card text</div></a>'), [
      { kind: 'paragraph', content: [{ text: 'Card title', link: 'https://example.com/x' }] },
      { kind: 'paragraph', content: [{ text: 'Card text', link: 'https://example.com/x' }] },
    ])
  })
})

describe('htmlToBlocks: images', () => {
  it('collects images as blocks to upload, splitting the paragraph around them', () => {
    const result = convert('<p>Before <img src="/img/red.png" alt="A red dragon"> after</p>')
    assert.deepEqual(result.blocks, [
      { kind: 'paragraph', content: [{ text: 'Before' }] },
      { kind: 'image', url: 'https://example.com/img/red.png', alt: 'A red dragon' },
      { kind: 'paragraph', content: [{ text: 'after' }] },
    ])
    assert.deepEqual(result.images, [{ src: 'https://example.com/img/red.png', alt: 'A red dragon' }])
  })

  it('prefers a real source over a lazy-loading placeholder, and the largest srcset entry', () => {
    const lazy = convert('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/big.jpg">')
    assert.equal(lazy.images[0]?.src, 'https://example.com/big.jpg')
    const srcset = convert('<img srcset="/a-320.jpg 320w, /a-1280.jpg 1280w, /a-640.jpg 640w">')
    assert.equal(srcset.images[0]?.src, 'https://example.com/a-1280.jpg')
  })

  it('skips tracking pixels and can leave images out entirely', () => {
    assert.deepEqual(convert('<img src="/pixel.gif" width="1" height="1">').images, [])
    assert.deepEqual(convert('<p>a<img src="/x.png">b</p>', { images: false }).blocks, [{ kind: 'paragraph', content: [{ text: 'ab' }] }])
  })

  it('moves an image out of a heading so the heading stays text', () => {
    assert.deepEqual(blocks('<h2><img src="/i.png" alt="icon"> Red Dragon</h2>').map((b) => b.kind), ['heading', 'image'])
  })
})

describe('tidyRuns', () => {
  it('merges runs with the same marks and drops empty ones', () => {
    assert.deepEqual(tidyRuns([{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c', bold: true }]), [{ text: 'ab' }, { text: 'c', bold: true }])
  })
})

describe('blocksToHtml', () => {
  it('renders blocks and escapes text', () => {
    const html = blocksToHtml([
      { kind: 'heading', level: 2, content: [{ text: '<script>' }] },
      { kind: 'paragraph', content: [{ mention: { resourceId: 'rd' } }, { text: ' & ', bold: true }, { text: 'x', link: 'https://e.com/"' }] },
    ] as Block[], { nameOf: () => 'Red Dragon' })
    assert.equal(
      html,
      '<h2>&lt;script&gt;</h2><p><span class="lk-mention" title="LegendKeeper page: Red Dragon">Red Dragon</span><strong> &amp; </strong><a href="https://e.com/&quot;" target="_blank" rel="noopener noreferrer">x</a></p>',
    )
  })
})
