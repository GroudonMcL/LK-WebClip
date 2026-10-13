import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainText } from '@legendkeeper/sdk/blocks'
import {
  MatchTier, NotAppendableError, ProjectIndex, appendedClip, findSources, isSource, newPageClip, rankLocal, resolveAppendTarget,
  siteName, sniffImageType, sourcePageBlocks, type IndexedResource,
} from '../src/index.js'

function resource(id: string, name: string, parentId: string | null, extra: Partial<IndexedResource> = {}): IndexedResource {
  return {
    id, name, parentId, aliases: [], tags: [], rank: id, isHidden: false, updatedAt: null,
    documents: [{ id: `${id}-main`, name: 'Main', type: 'page' }],
    ...extra,
  }
}

const index = new ProjectIndex([
  resource('bestiary', 'Bestiary', null),
  resource('dragon', 'Dragon', 'bestiary'),
  resource('red', 'Red Dragon', 'dragon'),
  resource('copper', 'Copper Dragon', 'dragon'),
  resource('born', 'Dragonborn', 'bestiary'),
  resource('lair', "Snapdragon's Lair", null),
  resource('kobold', 'Kobold', 'bestiary', { tags: ['Dragon'] }),
  resource('iggwilv', 'Iggwilv', null, { aliases: ['Witch Queen of Perrenland'] }),
  resource('sources', 'Sources', null),
  resource('dndb', 'D&D Beyond', 'sources'),
  resource('mm', 'Monster Manual', null, { tags: ['Source'] }),
])

describe('ProjectIndex', () => {
  it('builds paths from the root down', () => {
    assert.equal(index.path('red'), 'Bestiary / Dragon / Red Dragon')
    assert.deepEqual(index.ancestors('red').map((r) => r.id), ['bestiary', 'dragon'])
    assert.equal(index.maxDepth(), 3)
  })

  it('survives a parent cycle', () => {
    const looped = new ProjectIndex([resource('a', 'A', 'b'), resource('b', 'B', 'a')])
    assert.equal(looped.path('a'), 'B / A')
  })

  it('finds by name or alias, ignoring case, spacing and curly quotes', () => {
    assert.deepEqual(index.findByName('  red   DRAGON ').map((r) => r.id), ['red'])
    assert.deepEqual(index.findByName('witch queen of perrenland').map((r) => r.id), ['iggwilv'])
    assert.deepEqual(index.findByName('Snapdragon’s Lair').map((r) => r.id), ['lair'])
    assert.deepEqual(index.findByName('witch queen of perrenland', { aliases: false }), [])
  })

  it('orders children by rank', () => {
    assert.deepEqual(index.children('dragon').map((r) => r.id), ['copper', 'red'])
  })
})

describe('rankLocal', () => {
  it('ranks exact, prefix, word, substring, alias then tag matches', () => {
    const hits = rankLocal(index, 'dragon')
    assert.deepEqual(
      hits.map((h) => [h.resource.id, MatchTier[h.tier]]),
      [
        ['dragon', 'ExactName'],
        ['born', 'NamePrefix'],
        ['red', 'NameWord'],
        ['copper', 'NameWord'],
        ['lair', 'NameContains'],
        ['kobold', 'Tag'],
      ],
    )
    assert.equal(hits[2]!.path, 'Bestiary / Dragon / Red Dragon')
  })

  it('matches aliases and reports which one', () => {
    const [hit] = rankLocal(index, 'witch queen')
    assert.equal(hit?.tier, MatchTier.Alias)
    assert.equal(hit?.matched, 'Witch Queen of Perrenland')
  })

  it('treats regex characters literally', () => {
    assert.deepEqual(rankLocal(index, 'd&d (').map((h) => h.resource.id), [])
    assert.deepEqual(rankLocal(index, 'd&d').map((h) => h.resource.id), ['dndb'])
  })

  it('returns nothing for an empty query', () => {
    assert.deepEqual(rankLocal(index, '   '), [])
  })
})

describe('sources', () => {
  const config = { sourcesRootId: 'sources', sourceTag: 'source' }

  it('counts descendants of the Sources page and tagged resources, but not the root itself', () => {
    assert.equal(isSource(index, index.get('dndb')!, config), true)
    assert.equal(isSource(index, index.get('mm')!, config), true)
    assert.equal(isSource(index, index.get('sources')!, config), false)
    assert.equal(isSource(index, index.get('dragon')!, config), false)
    assert.deepEqual(findSources(index, 'd&d beyond', config).map((r) => r.id), ['dndb'])
  })

  it('gives new Source pages the same backlinks collection the app writes', () => {
    const [collection, empty] = sourcePageBlocks()
    assert.deepEqual(collection, {
      kind: 'resourceCollection',
      filter: { type: 'filter', filterType: 'field', id: 'backlinks', scope: 'edges', field: 'targetId', operator: 'equals', value: '$self' },
      title: 'Backlinks',
      isTitleHidden: false,
    })
    assert.equal(empty?.kind, 'paragraph')
  })

  it('names websites from metadata first, then the host', () => {
    assert.equal(siteName({ url: 'https://www.dndbeyond.com/x', ogSiteName: ' D&D  Beyond ' }), 'D&D Beyond')
    assert.equal(siteName({ url: 'https://www.dndbeyond.com/x', applicationName: 'D&D Beyond' }), 'D&D Beyond')
    assert.equal(siteName({ url: 'https://www.dndbeyond.com/monsters/1' }), 'Dndbeyond')
    assert.equal(siteName({ url: 'https://forgottenrealms.fandom.com/wiki/Iuz' }), 'Fandom')
    assert.equal(siteName({ url: 'https://www.bbc.co.uk/news' }), 'Bbc')
    assert.equal(siteName({ url: 'http://localhost:3000/' }), 'Localhost')
  })
})

describe('clip layout', () => {
  it('starts a new page with the Source heading', () => {
    const [heading] = newPageClip('dndb', [])
    assert.equal(heading?.kind, 'heading')
    assert.ok(heading?.kind === 'heading' && heading.level === 1)
    assert.deepEqual(heading?.kind === 'heading' && heading.content, [{ text: 'From ' }, { mention: { resourceId: 'dndb' } }])
  })

  it('puts a divider before the Source heading when appending', () => {
    const blocks = appendedClip('dndb', [{ kind: 'paragraph', content: [{ text: 'Clipped.' }] }])
    assert.deepEqual(blocks.map((b) => b.kind), ['rule', 'heading', 'paragraph'])
    assert.equal(plainText(blocks[2]!), 'Clipped.')
  })
})

describe('resolveAppendTarget', () => {
  it('picks the only writable tab, including a blank one', () => {
    const r = resource('r', 'R', null, { documents: [{ id: 'm', name: 'Map', type: 'map' }, { id: 'b', name: 'Main', type: 'blank' }] })
    assert.deepEqual(resolveAppendTarget(r), { resourceId: 'r', documentId: 'b' })
  })

  it('refuses maps, boards and timelines', () => {
    const r = resource('r', 'R', null, { documents: [{ id: 'm', name: 'Map', type: 'map' }] })
    assert.throws(() => resolveAppendTarget(r), NotAppendableError)
    const t = resource('t', 'T', null, { documents: [{ id: 'p', name: 'Main', type: 'page' }, { id: 'tl', name: 'Timeline', type: 'time' }] })
    assert.throws(() => resolveAppendTarget(t, 'tl'), NotAppendableError)
  })

  it('asks for a tab when there are several pages', () => {
    const r = resource('r', 'R', null, { documents: [{ id: 'a', name: 'Main', type: 'page' }, { id: 'b', name: 'DM', type: 'page' }] })
    assert.throws(() => resolveAppendTarget(r), /2 page tabs \(Main, DM\)/)
    assert.deepEqual(resolveAppendTarget(r, 'b'), { resourceId: 'r', documentId: 'b' })
  })
})

describe('sniffImageType', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)])
  it('recognises the formats LegendKeeper accepts', () => {
    assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png')
    assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
    assert.equal(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif')
    assert.equal(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), 'image/webp')
  })
  it('rejects HTML and SVG', () => {
    assert.equal(sniffImageType(new TextEncoder().encode('<!DOCTYPE html><html>')), undefined)
    assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), undefined)
  })
})
