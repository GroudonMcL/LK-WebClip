import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MatchTier, ProjectIndex, fuzzyDistance, rankLocal, type IndexedResource } from '../src/index.js'

function resource(id: string, name: string, extra: Partial<IndexedResource> = {}): IndexedResource {
  return { id, name, parentId: null, aliases: [], tags: [], rank: id, isHidden: false, updatedAt: null, documents: [], ...extra }
}

const index = new ProjectIndex([
  resource('gh', 'World of Greyhawk'),
  resource('igg', 'Iggwilv', { aliases: ['Witch Queen of Perrenland'] }),
  resource('rd', 'Red Dragon'),
  resource('ard', 'Adult Red Dragon'),
  resource('dt', 'Dragon Turtle'),
  resource('tiamat', 'Tiamat', { tags: ['God', 'Dragon'] }),
  resource('bahamut', 'Bahamut', { tags: ['God'] }),
  resource('tpl', 'Red Dragon Template', { parentId: 'templates' }),
])
const search = (q: string) => rankLocal(index, q).map((h) => [h.resource.id, MatchTier[h.tier]])

describe('fuzzy search', () => {
  it('forgives a typo in a name, at the start of any word', () => {
    assert.deepEqual(search('grayhawk'), [['gh', 'FuzzyName']])
    assert.deepEqual(search('iggwilf'), [['igg', 'FuzzyName']])
    assert.deepEqual(search('dragn'), [['rd', 'FuzzyName'], ['dt', 'FuzzyName'], ['ard', 'FuzzyName']])
  })

  it('handles swapped letters', () => {
    assert.deepEqual(search('tiamta'), [['tiamat', 'FuzzyName']])
  })

  it('finds names from their words in any order', () => {
    assert.deepEqual(search('dragon red'), [['rd', 'NameWords'], ['ard', 'NameWords']])
  })

  it('forgives typos in aliases too, after name matches', () => {
    assert.deepEqual(search('witch qeen'), [['igg', 'FuzzyAlias']])
  })

  it('does not stretch short queries', () => {
    assert.deepEqual(search('rex'), [])
  })

  it('ranks exact tags above partial ones, and lists a tag with #', () => {
    assert.deepEqual(search('#god').map(([id]) => id), ['tiamat', 'bahamut'])
    assert.deepEqual(search('#drag'), [['tiamat', 'Tag']])
  })

  it('keeps templates out of results', () => {
    assert.ok(!search('red dragon').some(([id]) => id === 'tpl'))
  })

  it('ranks closer matches first', () => {
    assert.deepEqual(search('red dragon').map(([id]) => id), ['rd', 'ard'])
  })
})

describe('fuzzyDistance', () => {
  it('measures edits to the start of the text or of any word in it', () => {
    assert.equal(fuzzyDistance('greyhawk', 'world of greyhawk', 2), 0)
    assert.equal(fuzzyDistance('grayhawk', 'world of greyhawk', 2), 1)
    assert.equal(fuzzyDistance('dragn', 'dragon turtle', 1), 1)
    assert.equal(fuzzyDistance('xyz', 'dragon', 1), Infinity)
  })
})

describe('searchResources', () => {
  it('reports pages the API found but the local list lacks, so the list can be refreshed', async () => {
    const { searchResources } = await import('../src/index.js')
    const fakeApi = { search: { search: async () => ({ data: [{ resource: { id: 'tiamat' } }, { resource: { id: 'brand-new' } }] }) } }
    let missing: string[] = []
    const hits = await searchResources(fakeApi as never, index, 'scales', { onMissing: (ids) => (missing = ids) })
    assert.deepEqual(hits.map((h) => [h.resource.id, MatchTier[h.tier]]), [['tiamat', 'Content']])
    assert.deepEqual(missing, ['brand-new'])
  })
})
