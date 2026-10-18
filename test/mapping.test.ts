import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DOMParser } from 'linkedom'
import type { Block } from '@legendkeeper/sdk/blocks'
import { htmlStringToBlocks } from '../src/clip/htmlToBlocks.js'
import { leftoverBlocks } from '../src/fill/candidates.js'
import { applyComposition, compose } from '../src/fill/compose.js'
import { DEFAULT_SYNONYMS, Synonyms } from '../src/fill/labels.js'
import {
  accepts, applyMapping, buildMapBase, canRemember, cardIndex, carryOver, clearSlot, cut, FILLABLE, initialMapping, mappedPlan, place, placements, rulesFromMapping,
  setRemember, summarize, typeValue, unplace, useGhost, type MapBase, type Mapping,
} from '../src/fill/mapping.js'
import { planFill, type FillInput, type FillPlan } from '../src/fill/plan.js'
import { blockText, buildSlots, fillTree, type AnyBlock, type TemplateTree } from '../src/fill/template.js'

const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const synonyms = new Synonyms(DEFAULT_SYNONYMS)
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const blocks = (html: string): Block[] => htmlStringToBlocks(html, parser, { baseUrl: 'https://example.com/' }).blocks
function template(name: string): { id: string; tree: TemplateTree } {
  const t = JSON.parse(fixture(`templates/${name}.json`))
  return { id: t.id, tree: { docs: t.docs.filter((d: { type: string }) => d.type === 'page'), properties: t.properties } }
}
const text = (list: Block[]) => list.map((b) => blockText(b as AnyBlock)).join('\n')
const statblock = template('Statblock_Template')
const classTemplate = template('Class_Template')

const clips = {
  goblin: { clip: blocks(fixture('dndbeyond-goblin.html')), title: 'Goblin', tpl: statblock, name: 'Statblock Template' },
  assassin: { clip: blocks(fixture('dndbeyond-assassin.html')), title: 'Assassin', tpl: statblock, name: 'Statblock Template' },
  zombie: { clip: blocks(fixture('wiki-zombie.html')), title: 'Zombie', tpl: statblock, name: 'Statblock Template' },
  bard: { clip: blocks(fixture('dndbeyond-bard.html')), title: 'Bard', tpl: classTemplate, name: 'Class Template' },
}
type ClipName = keyof typeof clips

function setup(name: ClipName, overrides: Partial<FillInput> = {}): { plan: FillPlan; base: MapBase; mapping: Mapping } {
  const c = clips[name]
  const plan = planFill({ tree: c.tpl.tree, templateId: c.tpl.id, templateName: c.name, clip: c.clip, title: c.title, site: 'dndbeyond.com', synonyms, rules: [], mode: 'labels', overrides: {}, ...overrides })
  const base = buildMapBase(plan, overrides.clip ?? c.clip, { key: name, synonyms: DEFAULT_SYNONYMS })
  return { plan, base, mapping: initialMapping(base) }
}
const slotId = (base: MapBase, label: string) => base.slots.find((s) => s.slot.label === label)!.slot.id
const cardWith = (base: MapBase, test: (text: string) => boolean, kind?: string) => base.cards.find((c) => (!kind || c.kind === kind) && test(c.text))!
const resultSlot = (base: MapBase, mapping: Mapping, label: string) => applyMapping(base, mapping).slots.find((s) => s.slot.label === label)!
/** The page's text, as written: every tab with the unused content. */
const pageText = (name: ClipName, base: MapBase, mapping: Mapping) => {
  const tree = clips[name].tpl.tree
  const filled = applyComposition(tree, compose(tree, applyMapping(base, mapping), { keepUnfilled: true }))
  return filled.docs.map((d) => text(d)).join('\n')
}

describe('mapper: with nothing moved', () => {
  for (const name of Object.keys(clips) as ClipName[]) {
    it(`writes exactly what label matching does (${name})`, () => {
      const { plan, base, mapping } = setup(name)
      const result = applyMapping(base, mapping)
      assert.deepEqual(result.fills, plan.fills)
      assert.deepEqual(result.leftovers, plan.leftovers)
      assert.equal(mappedPlan(plan, base, mapping), plan, 'the plan itself is used')
    })

    it(`knows which parts of the clip each slot uses (${name})`, () => {
      const { plan, base } = setup(name)
      const used = [...plan.slots.flatMap((s) => (s.status === 'filled' ? (s.units ?? []) : [])), ...plan.titleBlocks.map((i) => `b${i}`)]
      assert.deepEqual(leftoverBlocks(base.clip, plan.extraction, used), plan.leftovers)
    })

    it(`goes through chrome.storage unchanged (${name})`, () => {
      const { base, mapping } = setup(name)
      const copied = JSON.parse(JSON.stringify(base)) as MapBase
      assert.deepEqual(applyMapping(copied, mapping).fills, applyMapping(base, mapping).fills)
      assert.deepEqual(applyMapping(copied, mapping).leftovers, applyMapping(base, mapping).leftovers)
    })
  }

  for (const name of ['goblin', 'assassin', 'zombie'] as ClipName[]) {
    it(`rebuilds every slot from its cards to the same page (${name})`, () => {
      const { plan, base, mapping } = setup(name)
      const all = { ...mapping, touched: base.slots.filter((s) => FILLABLE.has(s.slot.kind)).map((s) => s.slot.id) }
      const result = applyMapping(base, all)
      assert.deepEqual(result.fills, plan.fills)
      assert.deepEqual(result.leftovers, plan.leftovers)
    })
  }
})

describe('mapper: cards', () => {
  it('shows the clip as labelled values, sections and blocks, without the page name', () => {
    const { base } = setup('goblin')
    const listed = base.cards.filter((c) => c.listed)
    assert.ok(!listed.some((c) => c.text === 'Goblin'), 'the name line only repeats the page name')
    assert.ok(listed.some((c) => c.kind === 'pair' && c.label === 'Armor Class' && c.text === '15 (leather armor, shield)'))
    assert.ok(listed.some((c) => c.kind === 'pair' && c.label === 'STR' && c.text === '8 (-1)'), '"STR" and "8 (-1)" are one card')
    assert.ok(!listed.some((c) => c.text === 'STR'), 'not three')
    const actions = listed.find((c) => c.kind === 'section' && c.label === 'Actions')!
    assert.deepEqual(actions.body!.map((id) => base.cards.find((c) => c.id === id)!.text.split('.')[0]), ['Scimitar', 'Shortbow'])
    assert.ok(!listed.some((c) => c.kind === 'block' && c.text === 'Actions'), 'the heading is shown as its section')
    assert.ok(listed.some((c) => c.kind === 'block' && c.text.startsWith('Small Humanoid')))
  })

  it('shows a table whole, with its labelled rows under it', () => {
    const { base } = setup('bard')
    const table = base.cards.find((c) => c.listed && c.blockKind === 'table' && c.text.startsWith('Primary Ability'))!
    const row = base.cards.find((c) => c.kind === 'pair' && c.label === 'Hit Point Die')!
    assert.ok(table && row.listed && row.depth > table.depth)
  })

  it('lets each kind of slot take only what fits', () => {
    const { base } = setup('goblin')
    const cards = cardIndex(base, initialMapping(base))
    const slot = (label: string) => base.slots.find((s) => s.slot.label === label)!.slot
    const ac = cardWith(base, (t) => t.startsWith('15 (leather'), 'pair')
    const actions = base.cards.find((c) => c.kind === 'section' && c.label === 'Actions')!
    assert.ok(accepts(slot('Armour Class'), ac))
    assert.ok(accepts(slot('Traits'), ac), 'a section takes anything')
    assert.ok(!accepts(slot('Armour Class'), actions), 'a row takes no long section')
    assert.ok(accepts(slot('Armour Class'), cards.get('b25')!), 'a short paragraph fits a row')
    assert.ok(!accepts(slot('Armour Class'), { ...cards.get('b25')!, text: 'word '.repeat(80) }), 'a long one doesn’t')
    const withImage = blocks('<p><img src="https://example.com/goblin.png" alt="A goblin"></p><p>Armor Class 15</p>')
    const image = buildMapBase(planFill({ tree: statblock.tree, templateId: statblock.id, clip: withImage, title: 'Goblin', site: '', synonyms, rules: [], mode: 'labels', overrides: {} }), withImage, { key: 'x', synonyms: DEFAULT_SYNONYMS })
    const picture = image.cards.find((c) => c.kind === 'image')!
    assert.ok(picture, 'an image is a card')
    assert.ok(!accepts(slot('Armour Class'), picture))
    assert.ok(accepts(slot('Traits'), picture))
  })
})

describe('mapper: moving cards', () => {
  it('moves one entry out of a section into another slot, and the page follows', () => {
    const { base, mapping } = setup('goblin')
    const shortbow = cardWith(base, (t) => t.startsWith('Shortbow'), 'block')
    const m = place(base, mapping, shortbow.id, slotId(base, 'Legendary Actions'))
    assert.match(resultSlot(base, m, 'Actions').text, /^Scimitar/)
    assert.ok(!resultSlot(base, m, 'Actions').text.includes('Shortbow'))
    assert.match(resultSlot(base, m, 'Legendary Actions').text, /^Shortbow/)
    assert.equal(resultSlot(base, m, 'Legendary Actions').origin, 'manual')
    assert.equal(m.origins[shortbow.id], 'manual')
    const page = pageText('goblin', base, m)
    assert.equal(page.split('Shortbow.').length, 2, 'written once')
  })

  it('moves a whole section, heading and all, and back again', () => {
    const { base, mapping } = setup('goblin')
    const actions = base.cards.find((c) => c.kind === 'section' && c.label === 'Actions')!
    let m = place(base, mapping, actions.id, slotId(base, 'Bonus Actions'))
    assert.equal(resultSlot(base, m, 'Actions').status, 'empty')
    assert.match(resultSlot(base, m, 'Bonus Actions').text, /^Scimitar[\s\S]*Shortbow/)
    m = unplace(base, m, actions.id)
    assert.equal(resultSlot(base, m, 'Bonus Actions').status, 'empty')
    const unused = text(applyMapping(base, m).leftovers)
    assert.match(unused, /Actions\nScimitar[\s\S]*Shortbow/, 'the section goes to the end, with its heading')
  })

  it('reorders cards in a section', () => {
    const { base, mapping } = setup('goblin')
    const shortbow = cardWith(base, (t) => t.startsWith('Shortbow'), 'block')
    const scimitar = cardWith(base, (t) => t.startsWith('Scimitar'), 'block')
    const m = place(base, mapping, shortbow.id, slotId(base, 'Actions'), scimitar.id)
    assert.match(resultSlot(base, m, 'Actions').text, /^Shortbow[\s\S]*Scimitar/)
  })

  it('replaces the value of a one-line slot, sending the old one to the unused content', () => {
    const { base, mapping } = setup('goblin')
    const languages = cardWith(base, (t) => t.startsWith('Common, Goblin'), 'pair')
    const m = place(base, mapping, languages.id, slotId(base, 'Senses'))
    assert.equal(resultSlot(base, m, 'Senses').text, 'Common, Goblin')
    assert.equal(resultSlot(base, m, 'Languages').status, 'empty')
    assert.match(text(applyMapping(base, m).leftovers), /Senses Darkvision 60 ft\., Passive Perception 9/)
  })

  it('refuses a card a slot can’t take', () => {
    const { base, mapping } = setup('goblin')
    const actions = base.cards.find((c) => c.kind === 'section' && c.label === 'Actions')!
    assert.equal(place(base, mapping, actions.id, slotId(base, 'Speed')), mapping)
  })

  it('clears a slot and takes a typed value', () => {
    const { base, mapping } = setup('goblin')
    let m = clearSlot(mapping, slotId(base, 'Armour Class'))
    assert.equal(resultSlot(base, m, 'Armour Class').status, 'empty')
    assert.match(text(applyMapping(base, m).leftovers), /Armor Class 15 \(leather armor, shield\)/, 'nothing is lost')
    m = typeValue(m, slotId(base, 'Initiative'), '+2 (12)')
    assert.equal(resultSlot(base, m, 'Initiative').text, '+2 (12)')
    assert.equal(resultSlot(base, m, 'Initiative').origin, 'typed')
  })

  it('splits a selection off a card and keeps the rest', () => {
    const { base, mapping } = setup('goblin')
    const senses = cardWith(base, (t) => t.startsWith('Darkvision'), 'pair')
    const darkvision = 'Darkvision 60 ft.'
    const split = cut(base, mapping, senses.id, 0, darkvision.length)
    assert.ok(split.piece)
    const pieces = [...cardIndex(base, split.mapping).values()].filter((c) => c.of === senses.id)
    assert.deepEqual(pieces.map((c) => c.text), ['Darkvision 60 ft.', ', Passive Perception 9'])
    assert.equal(resultSlot(base, split.mapping, 'Senses').text, 'Darkvision 60 ft., Passive Perception 9', 'in its slot, the pieces still make the value')
    const m = place(base, split.mapping, pieces[1]!.id, slotId(base, 'Description'))
    assert.equal(resultSlot(base, m, 'Senses').text, 'Darkvision 60 ft.')
    assert.match(resultSlot(base, m, 'Description').text, /Passive Perception 9/)
    const moved = unplace(base, m, pieces[1]!.id)
    assert.match(text(applyMapping(base, moved).leftovers), /Senses , Passive Perception 9/, 'an unused piece goes back with its label')
  })

  it('splits a paragraph in the unused content', () => {
    const { base, mapping } = setup('goblin')
    const line = cardWith(base, (t) => t.startsWith('Small Humanoid'), 'block')
    const split = cut(base, mapping, line.id, 0, 'Small Humanoid (Goblinoid)'.length)
    const m = place(base, split.mapping, split.piece!, slotId(base, 'Size, Creature Type, Alignment'))
    assert.equal(resultSlot(base, m, 'Size, Creature Type, Alignment').text, 'Small Humanoid (Goblinoid)')
    assert.equal(text(applyMapping(base, m).leftovers), ', Neutral Evil')
  })

  it('never loses part of the clip, whatever is moved', () => {
    const { base, mapping } = setup('goblin')
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    // Labels are the template's own in the page ("Strength" for "STR"), so only values must all be there.
    const labels = words(base.cards.map((c) => c.label).join(' '))
    const clipWords = new Set([...words(text(base.clip))].filter((w) => !labels.has(w)))
    let m = mapping
    const ops = [
      () => place(base, m, cardWith(base, (t) => t.startsWith('Shortbow'), 'block').id, slotId(base, 'Bonus Actions')),
      () => clearSlot(m, slotId(base, 'Hit Points')),
      () => unplace(base, m, base.cards.find((c) => c.kind === 'section' && c.label === 'Traits')!.id),
      () => place(base, m, cardWith(base, (t) => t.startsWith('Common'), 'pair').id, slotId(base, 'Description')),
      () => cut(base, m, cardWith(base, (t) => t.startsWith('Small Humanoid'), 'block').id, 0, 5).mapping,
    ]
    for (const op of ops) {
      m = op()
      const page = words(pageText('goblin', base, m))
      const missing = [...clipWords].filter((w) => !page.has(w) && w !== 'goblin')
      assert.deepEqual(missing, [], 'every word of the clip is still in the page')
    }
  })

  it('shows where each card is, and what is unused', () => {
    const { base, mapping } = setup('goblin')
    const result = applyMapping(base, mapping)
    const { slotOf, unused } = placements(base, mapping, result)
    assert.equal(slotOf.get(cardWith(base, (t) => t.startsWith('Scimitar'), 'block').id), slotId(base, 'Actions'))
    assert.deepEqual(unused.map((id) => base.cards.find((c) => c.id === id)!.text), ['Small Humanoid (Goblinoid), Neutral Evil'])
    assert.deepEqual(summarize(result), { filled: 16, empty: 7, unused: 1, toChoose: 0 })
  })
})

describe('mapper: ties, AI answers and rules', () => {
  it('offers the competing values of a tie, and places the one picked', () => {
    const clip = blocks('<p>Speed: 30 ft.</p><p>Speed: 40 ft.</p>')
    const plan = planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: '', site: '', synonyms, rules: [], mode: 'labels', overrides: {} })
    const base = buildMapBase(plan, clip, { key: 'tie', synonyms: DEFAULT_SYNONYMS })
    const speed = base.slots.find((s) => s.slot.label === 'Speed')!
    assert.equal(speed.status, 'ambiguous')
    assert.deepEqual(speed.contenders.map((id) => base.cards.find((c) => c.id === id)!.text), ['30 ft.', '40 ft.'])
    const m = place(base, initialMapping(base), speed.contenders[1]!, speed.slot.id)
    assert.equal(resultSlot(base, m, 'Speed').text, '40 ft.')
    assert.equal(summarize(applyMapping(base, m)).toChoose, 0)
  })

  it('offers an unticked AI answer, to use anyway', () => {
    const assassin = clips.assassin.clip
    const saving = assassin.findIndex((b) => blockText(b as AnyBlock).startsWith('Saving Throws'))
    const first = setup('assassin')
    const legendaryId = slotId(first.base, 'Legendary Actions')
    const { base, mapping } = setup('assassin', { mode: 'labels-ai', ai: new Map([[legendaryId, { blocks: [saving], value: '' }]]) })
    const legendary = base.slots.find((s) => s.slot.id === legendaryId)!
    assert.equal(legendary.status, 'off')
    assert.ok(legendary.ghost && legendary.warning)
    const m = useGhost(base, mapping, legendaryId)
    assert.match(resultSlot(base, m, 'Legendary Actions').text, /DEX \+6/)
    assert.equal(resultSlot(base, m, 'Legendary Actions').origin, 'ai')
  })

  it('remembers a labelled value you placed, but not prose', () => {
    const { base, mapping } = setup('goblin')
    const challenge = cardWith(base, (t) => t.startsWith('1/4'), 'pair')
    let m = place(base, mapping, challenge.id, slotId(base, 'Initiative'))
    assert.ok(canRemember(base, m, slotId(base, 'Initiative')))
    m = setRemember(m, slotId(base, 'Initiative'), true)
    assert.deepEqual(rulesFromMapping(base, m, { site: 'dndbeyond.com', templateId: 't', templateName: 'Statblock Template' }), [
      { site: 'dndbeyond.com', templateId: 't', templateName: 'Statblock Template', slotKey: 'initiative', slotLabel: 'Initiative', candidateKey: 'challenge', candidateLabel: 'Challenge' },
    ])
    const prose = place(base, mapping, cardWith(base, (t) => t.startsWith('Small Humanoid'), 'block').id, slotId(base, 'Description'))
    assert.ok(!canRemember(base, prose, slotId(base, 'Description')), 'prose has no label to remember')
    assert.ok(!canRemember(base, mapping, slotId(base, 'Hit Points')), 'label matching put this there, not you')
  })

  it('keeps your changes when the plan is made again, and the AI fills only what you left', () => {
    const { base, mapping } = setup('goblin')
    const shortbow = cardWith(base, (t) => t.startsWith('Shortbow'), 'block')
    let m = place(base, mapping, shortbow.id, slotId(base, 'Legendary Actions'))
    m = typeValue(m, slotId(base, 'Initiative'), '+2 (12)')
    const descriptionId = slotId(base, 'Description')
    const line = base.clip.findIndex((b) => blockText(b as AnyBlock).startsWith('Small Humanoid'))
    const again = setup('goblin', { mode: 'labels-ai', ai: new Map([[descriptionId, { blocks: [line], value: '' }], [slotId(base, 'Legendary Actions'), { blocks: [line], value: '' }]]) })
    const carried = carryOver(m, again.base)
    assert.match(resultSlot(again.base, carried, 'Legendary Actions').text, /^Shortbow/, 'your choice stays')
    assert.equal(resultSlot(again.base, carried, 'Initiative').text, '+2 (12)')
    assert.ok(!resultSlot(again.base, carried, 'Actions').text.includes('Shortbow'))
    assert.deepEqual(applyMapping(again.base, carryOver(again.mapping, again.base)).fills, again.plan.fills, 'carrying over an untouched mapping changes nothing')
  })

  it('gives import a plan with the mapping applied', () => {
    const { plan, base, mapping } = setup('goblin')
    const m = place(base, mapping, cardWith(base, (t) => t.startsWith('Shortbow'), 'block').id, slotId(base, 'Legendary Actions'))
    const mapped = mappedPlan(plan, base, m)
    assert.equal(mapped.slots.find((s) => s.slot.label === 'Legendary Actions')!.status, 'filled')
    assert.equal(mapped.slots.find((s) => s.slot.label === 'Hit Points'), plan.slots.find((s) => s.slot.label === 'Hit Points'), 'untouched slots are the plan’s own')
  })
})

describe('links slots', () => {
  const tree: TemplateTree = {
    docs: [{ name: 'Main', blocks: [{ kind: 'resourceLink', title: 'Allies', items: [] } as unknown as Block, { kind: 'resourceCollection', title: 'Backlinks', filter: { kind: 'linksTo' } } as unknown as Block] }],
    properties: [{ kind: 'resourceLink', id: 'p1', title: 'Enemies', items: [] } as never],
  }

  it('finds links blocks and hand-picked collections, but not a filtered collection', () => {
    const slots = buildSlots(tree)
    assert.deepEqual(slots.map((s) => [s.label, s.kind]), [['Allies', 'links'], ['Enemies', 'links']])
  })

  it('fills them with the pages the clip links to, by label or by dragging', () => {
    const clip: Block[] = [
      { kind: 'paragraph', content: [{ text: 'Allies: ' }, { mention: { resourceId: 'r1' } }, { text: ', ' }, { mention: { resourceId: 'r2' } }] } as Block,
      { kind: 'paragraph', content: [{ text: 'Sworn foe of ' }, { mention: { resourceId: 'r3' } }, { text: '.' }] } as Block,
    ]
    const plan = planFill({ tree, templateId: 't', clip, title: 'Hero', site: '', synonyms, rules: [], mode: 'labels', overrides: {}, nameOf: (id) => ({ r1: 'Ann', r2: 'Bo', r3: 'Cy' })[id] })
    const allies = plan.slots.find((s) => s.slot.label === 'Allies')!
    assert.equal(allies.status, 'filled')
    assert.deepEqual(plan.fills.get(allies.slot.id), { links: ['r1', 'r2'] })
    const base = buildMapBase(plan, clip, { key: 'l', names: { r1: 'Ann', r2: 'Bo', r3: 'Cy' }, synonyms: DEFAULT_SYNONYMS })
    const enemies = base.slots.find((s) => s.slot.label === 'Enemies')!.slot.id
    const m = place(base, initialMapping(base), 'b1', enemies)
    assert.equal(resultSlot(base, m, 'Enemies').text, 'Cy')
    const filled = fillTree(tree, buildSlots(tree), applyMapping(base, m).fills)
    assert.deepEqual((filled.docs[0]![0] as unknown as { items: unknown }).items, [{ resourceId: 'r1' }, { resourceId: 'r2' }])
    assert.deepEqual(filled.properties, [{ op: 'update', propertyId: 'p1', patch: { items: [{ resourceId: 'r3' }] } }])
  })
})
