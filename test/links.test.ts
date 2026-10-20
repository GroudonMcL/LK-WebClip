import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DOMParser } from 'linkedom'
import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { DEFAULT_LINK_OPTIONS, hyperlinkCandidates, htmlStringToBlocks, linkClip, singularForms, tokenize, type LinkOptions } from '../src/clip/index.js'
import { ProjectIndex, type IndexedResource } from '../src/index.js'

const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const blocks = (html: string) => htmlStringToBlocks(html, parser, { baseUrl: 'https://example.com/', topHeadingLevel: 0 }).blocks

function resource(id: string, name: string, aliases: string[] = [], parentId: string | null = null): IndexedResource {
  return { id, name, parentId, aliases, tags: [], rank: id, isHidden: false, updatedAt: null, documents: [{ id: `${id}-d`, name: 'Main', type: 'page' }] }
}

const index = new ProjectIndex([
  resource('gh', 'World of Greyhawk', ['Greyhawk']),
  resource('city', 'Free City of Greyhawk'),
  resource('dragon', 'Dragon'),
  resource('rd', 'Red Dragon'),
  resource('born', 'Dragonborn'),
  resource('k1', 'King'),
  resource('k2', 'King'),
  resource('nat', 'Natasha', ['Natasha the Dark']),
  resource('nal', 'Natalie', ['Natasha the Dark']),
  resource('ar', 'Attack Rolls', ['attack roll', 'Attack Roll']),
  resource('lair', "Dragon's Lair"),
  resource('io', 'Io'),
  resource('d20', '20'),
  resource('npc', 'Nonplayer Character', ['NPC']),
  resource('half', 'Half-Orc'),
  resource('tpl', 'Red Dragon Template', [], 'templates'),
])

// Most tests here are of the looser linking; "exact names" has its own tests.
const link = (html: string, options: Partial<LinkOptions> = {}) => linkClip(blocks(html), index, { ...DEFAULT_LINK_OPTIONS, exactNames: false, ...options })
/** The paragraph's runs, with mentions written as [[id|label]] so expectations read easily. */
function show(result: { blocks: Block[] }): string {
  const runs = (b: Block): Run[] => ('content' in b && Array.isArray(b.content) ? (b.content as Run[]) : [])
  const all: string[] = []
  const walk = (list: Block[]) => {
    for (const b of list) {
      all.push(runs(b).map((r) => ('mention' in r ? `[[${r.mention.resourceId}${r.mention.text ? `|${r.mention.text}` : ''}]]` : 'text' in r ? r.text : '\n')).join(''))
      if ('children' in b && Array.isArray(b.children)) walk(b.children as Block[])
    }
  }
  walk(result.blocks)
  return all.filter(Boolean).join(' / ')
}

describe('linkClip: plain text', () => {
  it('links names and aliases, preferring the longest match', () => {
    assert.equal(
      show(link('<p>A Red Dragon flew over Greyhawk and the Free City of Greyhawk.</p>')),
      'A [[rd]] flew over [[gh|Greyhawk]] and the [[city]].',
    )
  })

  it('matches whole words only', () => {
    assert.equal(show(link('<p>Dragonborn are not Dragons, and dragonfly is not a Dragon.</p>')), '[[born]] are not Dragons, and dragonfly is not a [[dragon]].')
  })

  it('matches capitalisation by default, so "king" is not the King', () => {
    assert.equal(show(link('<p>The old king met Natasha.</p>')), 'The old king met [[nat]].')
    assert.equal(show(link('<p>The old king met Natasha.</p>', { matchCase: false })), 'The old king met Natasha.'.replace('Natasha', '[[nat]]'))
  })

  it('lets a lowercase alias start a sentence, and uses the case-exact alias otherwise', () => {
    assert.equal(show(link('<p>Make an attack roll. Attack roll twice.</p>', { firstOnly: false })), 'Make an [[ar|attack roll]]. [[ar|Attack roll]] twice.')
  })

  it('ignoring case finds every spelling', () => {
    assert.equal(show(link('<p>the npc in greyhawk</p>', { matchCase: false })), 'the [[npc|npc]] in [[gh|greyhawk]]')
  })

  it("links a name followed by 's, and names with apostrophes, curly or straight", () => {
    assert.equal(show(link('<p>Greyhawk’s walls hide Dragon’s Lair.</p>')), '[[gh|Greyhawk]]’s walls hide [[lair|Dragon’s Lair]].')
  })

  it('leaves names glued into hyphenated words alone, but matches hyphenated names', () => {
    assert.equal(show(link('<p>A Dragon-kin and a Half-Orc.</p>')), 'A Dragon-kin and a [[half]].')
    assert.equal(show(link("<p>'Greyhawk' is a city.</p>")), "'[[gh|Greyhawk]]' is a city.")
  })

  it('links only the first mention of each page unless told otherwise', () => {
    assert.equal(show(link('<p>Dragon, Dragon.</p><p>Dragon.</p>')), '[[dragon]], Dragon. / Dragon.')
    assert.equal(show(link('<p>Dragon, Dragon.</p>', { firstOnly: false })), '[[dragon]], [[dragon]].')
  })

  it('keeps marks around a match and joins a match split across marks', () => {
    const result = link('<p><i>The <b>Red</b> Dragon roars.</i></p>')
    assert.deepEqual(result.blocks[0], { kind: 'paragraph', content: [{ text: 'The ', italic: true }, { mention: { resourceId: 'rd' } }, { text: ' roars.', italic: true }] })
  })

  it('skips headings, code, existing links and very short or numeric names', () => {
    assert.equal(show(link('<h2>Dragon</h2><p><code>Dragon</code> <a href="/x">Dragon</a> Io rolled a 20.</p>', { hyperlinks: false })), 'Dragon / Dragon Dragon Io rolled a 20.')
  })

  it('reports a name shared by several pages as ambiguous and leaves it unlinked', () => {
    const result = link('<p>Natasha the Dark and the King.</p>')
    assert.equal(show(result), 'Natasha the Dark and the King.')
    const ambiguous = result.terms.filter((t) => t.status === 'ambiguous')
    assert.deepEqual(ambiguous.map((t) => [t.text, t.candidates.map((c) => c.id)]), [['Natasha the Dark', ['nat', 'nal']], ['King', ['k1', 'k2']]])
  })

  it('applies the user’s choices: pick a page for an ambiguous name, or switch a link off', () => {
    const choices = { 'text:natasha the dark': 'nal', 'text:dragon': null }
    const result = link('<p>Natasha the Dark rode a Dragon.</p>', { choices })
    assert.equal(show(result), '[[nal|Natasha the Dark]] rode a Dragon.')
    assert.deepEqual(result.terms.map((t) => [t.text, t.status]), [['Natasha the Dark', 'chosen'], ['Dragon', 'off']])
  })

  it('never links to excluded pages or templates', () => {
    assert.equal(show(link('<p>Red Dragon Template, Red Dragon.</p>', { exclude: new Set(['rd']) })), 'Red Dragon Template, Red Dragon.')
  })

  it('counts every mention of a term, linked or not', () => {
    const [dragon] = link('<p>Dragon, Dragon and Dragon.</p>').terms
    assert.deepEqual([dragon?.found, dragon?.linked], [3, 1])
  })

  it('works inside lists, quotes and tables', () => {
    assert.equal(show(link('<ul><li>Red Dragon</li></ul><blockquote>Natasha</blockquote><table><tr><td>Dragonborn</td><td>x</td></tr></table>')), '[[rd]] / [[nat]] / [[born]] / x')
  })

  it('can be limited to one pass', () => {
    assert.equal(show(link('<p><a href="/g">Greyhawk</a> and Greyhawk</p>', { text: false })), '[[gh|Greyhawk]] and Greyhawk')
    assert.equal(show(link('<p><a href="/g">Greyhawk</a> and Red Dragon</p>', { hyperlinks: false })), 'Greyhawk and [[rd]]')
  })
})

describe('linkClip: hyperlinks', () => {
  it('turns a link naming one page into a mention, even across marks', () => {
    assert.equal(show(link('<p>The <a href="https://x.org/gh">Greyhawk</a> sages fear the <a href="/rd"><b>Red</b> Dragon</a>.</p>', { text: false })), 'The [[gh|Greyhawk]] sages fear the [[rd]].')
  })

  it('keeps the web link when the text names several pages or none', () => {
    const result = link('<p><a href="/k">King</a> and <a href="/q">Queen</a></p>', { text: false })
    assert.equal(show(result), 'King and Queen')
    assert.equal(result.blocks[0]?.kind === 'paragraph' && result.blocks[0].content.filter((r) => 'link' in r && r.link).length, 2)
    assert.deepEqual(result.terms.map((t) => [t.text, t.status]), [['King', 'ambiguous']])
  })

  it('turns every link to a page into a mention, even with "first mention only" (which limits plain text)', () => {
    const result = link('<p><a href="/a">Dragon</a> then <a href="/b">Dragon</a> then Dragon.</p>')
    assert.equal(show(result), '[[dragon]] then [[dragon]] then Dragon.')
    const runs = result.blocks[0]?.kind === 'paragraph' ? result.blocks[0].content : []
    assert.ok(!runs.some((r) => 'link' in r && r.link), 'no web link to a page is kept')
  })

  it('reads link text loosely: case, plural and possessive', () => {
    assert.deepEqual(hyperlinkCandidates('red dragons', index).map((r) => r.id), ['rd'])
    assert.deepEqual(hyperlinkCandidates("Greyhawk's", index).map((r) => r.id), ['gh'])
    assert.deepEqual(hyperlinkCandidates('Natasha', index).map((r) => r.id), ['nat'])
  })

  it('prefers a page name over another page’s alias', () => {
    const shared = new ProjectIndex([resource('a', 'Tasha'), resource('b', 'Iggwilv', ['Tasha'])])
    assert.deepEqual(hyperlinkCandidates('Tasha', shared).map((r) => r.id), ['a'])
  })

  it('resolves links in headings, where plain text is left alone', () => {
    assert.equal(show(link('<h2><a href="/rd">Red Dragon</a> and Dragon</h2>')), '[[rd]] and Dragon')
  })
})

describe('linkClip: exact names only (the default)', () => {
  const exact = (html: string, options: Partial<LinkOptions> = {}) => linkClip(blocks(html), index, { ...DEFAULT_LINK_OPTIONS, ...options })

  it('links only text written as a page’s name or alias, with the same capitals', () => {
    assert.equal(
      show(exact('<p>Make attack rolls, or Attack Rolls, near the Free City of Greyhawk.</p>')),
      'Make attack rolls, or [[ar]], near the [[city]].',
    )
    assert.equal(show(exact('<p>Greyhawk is old.</p>')), '[[gh|Greyhawk]] is old.')
    assert.equal(show(exact('<p>A dragon and a Dragon’s hoard.</p>')), 'A dragon and a [[dragon]]’s hoard.')
  })

  it('links an alias such as "Paralyzed" to its page "Paralysed", in text and in web links', () => {
    const conditions = new ProjectIndex([resource('par', 'Paralysed', ['Paralyzed']), resource('fr', 'Frightened')])
    const run = (html: string) => show(linkClip(blocks(html), conditions, DEFAULT_LINK_OPTIONS))
    assert.equal(run('<p>Immunities Fire; Frightened, Paralyzed</p>'), 'Immunities Fire; [[fr]], [[par|Paralyzed]]')
    assert.equal(run('<p><a href="/c#Paralyzed">Paralyzed</a> and <a href="/c#Paralyzed">Paralyzed</a></p>'), '[[par|Paralyzed]] and [[par|Paralyzed]]')
  })

  it('keeps a web link whose text is not a page’s exact name or alias', () => {
    const result = exact('<p><a href="/ar">attack rolls</a> and <a href="/rd">Red Dragon</a></p>')
    assert.equal(show(result), 'attack rolls and [[rd]]')
    const runs = result.blocks[0]?.kind === 'paragraph' ? result.blocks[0].content : []
    assert.ok(runs.some((r) => 'link' in r && r.link === 'https://example.com/ar'))
    assert.deepEqual(hyperlinkCandidates('red dragons', index, true), [])
    assert.deepEqual(hyperlinkCandidates('attack roll', index, true).map((r) => r.id), ['ar'])
  })

  it('leaves bold field labels unlinked, so "**Initiative** +18" stays a label', () => {
    const rules = new ProjectIndex([resource('init', 'Initiative'), resource('sk', 'Skills'), resource('per', 'Perception')])
    const run = (html: string) => show(linkClip(blocks(html), rules, DEFAULT_LINK_OPTIONS))
    assert.equal(run('<p><strong>AC</strong> 25 <strong>Initiative</strong> +18 (28)</p><p><strong>Skills</strong> Perception +9</p>'), 'AC 25 Initiative +18 (28) / Skills [[per]] +9')
    assert.equal(run('<p>Roll Initiative, then <b>Skills</b>.</p>'), 'Roll [[init]], then [[sk]].', 'bold in running text still links')
  })
})

describe('helpers', () => {
  it('tokenizes words and punctuation, straightening apostrophes', () => {
    assert.deepEqual(tokenize('Dragon’s Lair, D&D').map((t) => t.key), ['Dragon', "'", 's', 'Lair', ',', 'D', '&', 'D'])
  })

  it('makes singular and possessive forms', () => {
    assert.deepEqual(singularForms('Liches'), ['Lich', 'Liche'])
    assert.deepEqual(singularForms('Harpies'), ['Harpy', 'Harpie'])
    assert.deepEqual(singularForms("Greyhawk's"), ['Greyhawk'])
  })
})
