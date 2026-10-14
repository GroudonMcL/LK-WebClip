import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DOMParser } from 'linkedom'
import type { Block } from '@legendkeeper/sdk/blocks'
import { htmlStringToBlocks } from '../src/clip/htmlToBlocks.js'
import { AiAnswerError, buildAiJob, parseAiAnswer, slotsForAi } from '../src/fill/ai.js'
import { extractCandidates, leftoverBlocks } from '../src/fill/candidates.js'
import { appendTree, appendedTemplate, applyComposition, compose, tidyRules } from '../src/fill/compose.js'
import { listFreeModels, OpenRouterEngine, OpenRouterError, suggest, type AiEngine } from '../src/fill/engines.js'
import { cleanLabel, compareLabels, DEFAULT_SYNONYMS, isPlaceholderText, LabelMatch, parseSynonyms, placeholderLabels, Synonyms } from '../src/fill/labels.js'
import { blocksForAi, mergeRules, planFill, rulesFromChoices, type AiSuggestion, type FillInput, type SavedRule } from '../src/fill/plan.js'
import { applyDerived, completes, DEFAULT_DERIVED, deriveValue, parseDerived } from '../src/fill/derived.js'
import { builtInPackFor, DND5E_STATBLOCK, notesFor, withNotes } from '../src/fill/notes.js'
import { buildNotesJob, NOTES_SYSTEM_PROMPT, parseNotesAnswer } from '../src/fill/notesAi.js'
import { isWritable, SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT } from '../src/fill/ai.js'
import { OnDeviceEngine } from '../src/fill/engines.js'
import { withNewDefaults, withNewDerived } from '../src/extension/state.js'
import { challengeTag, creatureLineTags, parseTags, statblockTags, withProjectSpelling } from '../src/fill/tags.js'
import { blockText, buildSlots, fillTree, forCopy, namesPage, type AnyBlock, type TemplateTree } from '../src/fill/template.js'

const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const synonyms = new Synonyms(DEFAULT_SYNONYMS)

function template(name: string): { id: string; tree: TemplateTree } {
  const t = JSON.parse(readFileSync(new URL(`./fixtures/templates/${name}.json`, import.meta.url), 'utf8'))
  return { id: t.id, tree: { docs: t.docs.filter((d: { type: string }) => d.type === 'page'), properties: t.properties } }
}
const blocks = (html: string): Block[] => htmlStringToBlocks(html, parser, { baseUrl: 'https://example.com/' }).blocks
const goblin = blocks(readFileSync(new URL('./fixtures/dndbeyond-goblin.html', import.meta.url), 'utf8'))
const statblock = template('Statblock_Template')
const plan = (overrides: Partial<FillInput> = {}) =>
  planFill({ tree: statblock.tree, templateId: statblock.id, clip: goblin, title: 'Goblin', site: 'dndbeyond.com', synonyms, rules: [], mode: 'labels', overrides: {}, ...overrides })
const slotNamed = (p: ReturnType<typeof plan>, label: string) => p.slots.find((s) => s.slot.label === label)!
const text = (list: Block[]) => list.map((b) => blockText(b as AnyBlock)).join('\n')

describe('labels', () => {
  it('cleans labels for comparison', () => {
    assert.equal(cleanLabel('  Type:  '), 'type')
    assert.equal(cleanLabel('[Overview text]'), 'overview text')
    assert.equal(cleanLabel('Dragon’s Lair.'), "dragon's lair")
  })

  it('compares strictest first: exact, synonym, plural, typo', () => {
    assert.equal(compareLabels('armour class', 'armour class', synonyms), LabelMatch.Exact)
    assert.equal(compareLabels('armour class', 'ac', synonyms), LabelMatch.Synonym)
    assert.equal(compareLabels('languages', 'language', synonyms), LabelMatch.Loose)
    assert.equal(compareLabels('constitution', 'constitusion', synonyms), LabelMatch.Typo)
    assert.equal(compareLabels('speed', 'seed', synonyms), undefined, 'short labels get no typo allowance')
  })

  it('reads placeholders in square brackets', () => {
    assert.deepEqual(placeholderLabels('[Size, e.g. Small] [Creature Type, e.g. Elemental], [Alignment, e.g. Neutral]'), ['Size', 'Creature Type', 'Alignment'])
    assert.equal(isPlaceholderText('[Overview text]'), true)
    assert.equal(isPlaceholderText('["Quote"] - [Source]'), true)
    assert.equal(isPlaceholderText('Level [?]: [Feature Name]'), false)
  })

  it('parses the synonyms box', () => {
    assert.deepEqual(parseSynonyms('AC, Armor Class\nlonely\nHP = Hit Points'), [['AC', 'Armor Class'], ['HP', 'Hit Points']])
  })
})

describe('slots', () => {
  it('finds rows, fields and sections in the Statblock template', () => {
    const slots = buildSlots(statblock.tree)
    const labels = slots.map((s) => `${s.kind}:${s.label}`)
    assert.ok(labels.includes('text:Armour Class') && labels.includes('text:Challenge Rating'))
    assert.ok(labels.includes('rich:Traits') && labels.includes('rich:Legendary Actions') && labels.includes('rich:Description'))
    // A weak title ("TEXT") is named by its placeholder.
    assert.ok(labels.includes('rich:Size, Creature Type, Alignment'))
    assert.ok(!labels.some((l) => /TAGS|ALIASES/i.test(l)), 'unsupported blocks are never slots')
    assert.equal(new Set(slots.map((s) => s.id)).size, slots.length, 'ids are unique')
  })

  it('finds the God template’s credit line, quote and overview placeholders, and its sidebar image', () => {
    const slots = buildSlots(template('God_Template').tree)
    assert.ok(slots.some((s) => s.kind === 'source'))
    assert.ok(slots.some((s) => s.label === 'Manifesto, Dogma, or Quote') && slots.some((s) => s.label === 'Overview'), 'neighbouring placeholders are separate slots')
    const image = slots.find((s) => s.kind === 'image')
    assert.equal(image?.doc, -1)
    assert.ok(image?.propertyId)
  })

  it('treats "[Spell] Name" as the page name, and leaves captions such as "Core [Class] Traits" alone', () => {
    assert.ok(buildSlots(template('Spell_Template').tree).some((s) => s.kind === 'name'))
    assert.ok(!buildSlots(template('Class_Template').tree).some((s) => /Core/.test(s.label)))
  })

  it('gives a page made from the template the same slot ids (they come from labels, not block ids)', () => {
    const copy: TemplateTree = JSON.parse(JSON.stringify(statblock.tree))
    let n = 0
    const addIds = (list: AnyBlock[]) => list.forEach((b) => ((b.id = `new${n++}`), addIds((b.children ?? b.rows ?? []) as AnyBlock[])))
    addIds(copy.docs[0]!.blocks as AnyBlock[])
    assert.deepEqual(buildSlots(copy).map((s) => s.id), buildSlots(statblock.tree).map((s) => s.id))
  })
})

describe('candidates', () => {
  it('reads a D&D Beyond stat block, where labels are plain text', () => {
    const { candidates } = extractCandidates(goblin, { knownLabels: ['armor class', 'hit points', 'str', 'traits', 'actions', 'challenge'] })
    const pairs = new Map(candidates.filter((c) => c.kind === 'pair').map((c) => [c.label, c.text]))
    assert.equal(pairs.get('Armor Class'), '15 (leather armor, shield)')
    assert.equal(pairs.get('STR'), '8 (-1)')
    assert.equal(pairs.get('Challenge'), '1/4 (50 XP)')
    const traits = candidates.find((c) => c.kind === 'section' && c.label === 'Traits')
    assert.match(traits!.text, /^Nimble Escape\./)
    assert.ok(!candidates.some((c) => c.kind === 'image'), 'decorative SVG dividers are not images')
  })

  it('splits a paragraph at each bold label, and keeps what was not used', () => {
    const clip = blocks('<p><b>AC</b> 18 <b>Initiative</b> +14 (24)</p>')
    const extraction = extractCandidates(clip, { knownLabels: [] })
    assert.deepEqual(extraction.candidates.map((c) => [c.label, c.text]), [['AC', '18'], ['Initiative', '+14 (24)']])
    const left = leftoverBlocks(clip, extraction, extraction.candidates[0]!.units)
    assert.equal(text(left), 'Initiative +14 (24)')
  })

  it('reads "Label: value", tables of label rows, and a header row over one data row', () => {
    const clip = blocks('<p>Rarity: Very rare</p><table><tr><td>Weight</td><td>3 lb.</td></tr></table><table><tr><th>STR</th><th>DEX</th></tr><tr><td>18 (+4)</td><td>10 (+0)</td></tr></table>')
    assert.deepEqual(extractCandidates(clip, { knownLabels: [] }).candidates.map((c) => [c.label, c.text]), [['Rarity', 'Very rare'], ['Weight', '3 lb.'], ['STR', '18 (+4)'], ['DEX', '10 (+0)']])
  })

  it('does not take a bold sentence subject for a label', () => {
    const clip = blocks(`<p><b>Tiamat</b> is a supremely strong and powerful five-headed draconic goddess of greed, envy and evil dragons, worshipped by chromatic dragons and kobolds.</p>`)
    assert.equal(extractCandidates(clip, { knownLabels: [] }).candidates.length, 0)
  })

  it('reads page links by their page names', () => {
    const clip: Block[] = [{ kind: 'paragraph', content: [{ mention: { resourceId: 'ac' } }, { text: ' 15 (natural armor)' }] }]
    const p = planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: 'X', site: '', synonyms, rules: [], mode: 'labels', overrides: {}, nameOf: (id) => (id === 'ac' ? 'Armor Class' : undefined) })
    assert.equal(slotNamed(p, 'Armour Class').text, '15 (natural armor)')
  })
})

describe('planFill', () => {
  it('fills the Statblock template from the goblin with labels and synonyms', () => {
    const p = plan()
    assert.equal(slotNamed(p, 'Armour Class').origin, 'synonym')
    assert.equal(slotNamed(p, 'Strength').text, '8 (-1)')
    assert.equal(slotNamed(p, 'Hit Points').origin, 'label')
    assert.match(slotNamed(p, 'Actions').text, /Scimitar[\s\S]*Shortbow/)
    assert.equal(slotNamed(p, 'Initiative').status, 'empty')
    // The name line is the page title, so it isn't repeated in the unused content.
    assert.equal(text(p.leftovers), 'Small Humanoid (Goblinoid), Neutral Evil')
    assert.equal(slotNamed(p, 'Proficiency Bonus').text, '+2')
  })

  it('never guesses between two equally good values', () => {
    const clip = blocks('<p>Speed: 30 ft.</p><p>Speed: 40 ft.</p>')
    const p = planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: '', site: '', synonyms, rules: [], mode: 'labels', overrides: {} })
    const speed = slotNamed(p, 'Speed')
    assert.equal(speed.status, 'ambiguous')
    assert.deepEqual(speed.contenders.map((c) => c.text), ['30 ft.', '40 ft.'])
  })

  it('applies the user’s choices: a candidate, a typed value, an unticked value', () => {
    const first = plan()
    const scimitar = first.candidates.find((c) => c.label === 'Scimitar')!
    const p = plan({ overrides: {
      [slotNamed(first, 'Bonus Actions').slot.id]: { choice: scimitar.id },
      [slotNamed(first, 'Initiative').slot.id]: { choice: 'typed', text: '+2 (12)' },
      [slotNamed(first, 'Speed').slot.id]: { off: true },
    } })
    assert.equal(slotNamed(p, 'Bonus Actions').origin, 'manual')
    assert.equal(slotNamed(p, 'Initiative').text, '+2 (12)')
    assert.equal(slotNamed(p, 'Speed').status, 'off')
    assert.ok(text(p.leftovers).includes('Speed 30 ft.'), 'an unticked value goes back to the unused content')
  })

  it('keeps an entry’s bold name in a text field, and lets its section keep the rest', () => {
    const first = plan()
    const shortbow = first.candidates.find((c) => c.label === 'Shortbow')!
    const p = plan({ overrides: { [slotNamed(first, 'Legendary Actions').slot.id]: { choice: shortbow.id } } })
    assert.match(text(slotNamed(p, 'Legendary Actions').candidate!.blocks), /^Shortbow\. Ranged/)
    assert.match(slotNamed(p, 'Actions').text, /^Scimitar\./)
    assert.ok(!slotNamed(p, 'Actions').text.includes('Shortbow'))
    assert.ok(!text(p.leftovers).includes('Scimitar'), 'the rest of the section is not repeated at the end')
  })

  it('uses a saved rule for that site and template before anything else', () => {
    const rule: SavedRule = { site: 'dndbeyond.com', templateId: statblock.id, templateName: 'Statblock Template', slotKey: 'skills', slotLabel: 'Skills', candidateKey: 'proficiency bonus', candidateLabel: 'Proficiency Bonus' }
    const p = plan({ rules: [{ ...rule, slotKey: 'initiative', slotLabel: 'Initiative' }] })
    assert.equal(slotNamed(p, 'Initiative').origin, 'rule')
    assert.equal(slotNamed(p, 'Initiative').text, '+2')
    assert.equal(slotNamed(plan({ rules: [{ ...rule, site: 'other.com', slotKey: 'initiative' }] }), 'Initiative').status, 'empty', 'rules for other sites are ignored')
  })

  it('remembers manual choices the user asked to keep', () => {
    const first = plan()
    assert.ok(first.candidates.some((c) => c.key === 'proficiency bonus'), 'a label the page marks by class is a label, even with no field for it')
    const scimitar = first.candidates.find((c) => c.label === 'Scimitar')!
    const id = slotNamed(first, 'Bonus Actions').slot.id
    const overrides = { [id]: { choice: scimitar.id, remember: true } }
    const rules = rulesFromChoices(plan({ overrides }), overrides, { site: 'dndbeyond.com', templateId: statblock.id, templateName: 'Statblock Template' })
    assert.deepEqual(rules.map((r) => [r.candidateLabel, r.slotLabel]), [['Scimitar', 'Bonus Actions']])
    assert.equal(mergeRules([...rules, { ...rules[0]!, site: 'x' }], [{ ...rules[0]!, candidateLabel: 'Bite', candidateKey: 'bite' }]).length, 2, 'a new rule for the same slot replaces the old one')
  })

  it('takes AI suggestions only for empty slots, and checks them', () => {
    const first = plan({ mode: 'labels-ai' })
    const ai = new Map<string, AiSuggestion>([
      [slotNamed(first, 'Size, Creature Type, Alignment').slot.id, { blocks: [1], value: '' }],
      [slotNamed(first, 'Initiative').slot.id, { blocks: [], value: '+2 (12)' }],
      [slotNamed(first, 'Armour Class').slot.id, { blocks: [], value: '99' }],
      [slotNamed(first, 'Description').slot.id, { blocks: [], value: 'A small, cowardly humanoid.' }],
    ])
    const p = plan({ mode: 'labels-ai', ai })
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').origin, 'ai')
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').text, 'Small Humanoid (Goblinoid), Neutral Evil')
    assert.equal(slotNamed(p, 'Armour Class').origin, 'synonym', 'labels win over the AI')
    assert.equal(slotNamed(p, 'Initiative').origin, 'ai-written', 'a value not in the clip is flagged')
    assert.equal(slotNamed(p, 'Initiative').status, 'off', '…and needs a tick')
    assert.equal(slotNamed(p, 'Description').status, 'off', 'a section answered with typed text needs a tick too')
    assert.ok(!text(p.leftovers).includes('Small Humanoid'), 'blocks the AI placed are not repeated')
  })
})

describe('compose and fill', () => {
  const heading: Block = { kind: 'heading', level: 1, content: [{ text: 'From ' }, { mention: { resourceId: 'src' } }] }

  it('fills the tree, keeps row ids, and removes unfilled slots when asked', () => {
    const p = plan()
    const filled = applyComposition(statblock.tree, compose(statblock.tree, p, { sourceHeading: heading, keepUnfilled: false }))
    const main = filled.docs[0]!
    const box = main[1] as AnyBlock
    const firstRows = (box.rows[0].rows as AnyBlock[])
    assert.equal(firstRows[0]!.id, 'uyi47pta')
    assert.deepEqual(firstRows.map((r) => r.key), ['Armour Class', 'Hit Points', 'Speed'], 'the empty Initiative row is gone')
    const all = JSON.stringify(main)
    assert.ok(!all.includes('Bonus Actions') && !all.includes('[Description text]'))
    assert.equal(main[0], heading, 'the credit comes first')
    assert.deepEqual(main.slice(-2).map((b) => b.kind), ['rule', 'paragraph'], 'one divider, then the unused content')
  })

  it('keeps placeholders when asked', () => {
    const filled = applyComposition(statblock.tree, compose(statblock.tree, plan(), { sourceHeading: heading, keepUnfilled: true }))
    assert.ok(JSON.stringify(filled.docs[0]).includes('[Description text]'))
  })

  it('puts the credit and unused content under a template’s own "From [Source]" heading', () => {
    const god = template('God_Template')
    const clip = blocks('<p>Tiamat is the queen of evil dragons.</p>')
    const p = planFill({ tree: god.tree, templateId: god.id, clip, title: 'Tiamat', site: '', synonyms, rules: [], mode: 'labels', overrides: {} })
    const main = applyComposition(god.tree, compose(god.tree, p, { sourceHeading: heading, keepUnfilled: true })).docs[0]!
    const at = main.findIndex((b) => JSON.stringify(b).includes('"resourceId":"src"'))
    assert.ok(at > 0)
    assert.equal(blockText(main[at + 1] as AnyBlock), 'Tiamat is the queen of evil dragons.')
    assert.ok(!JSON.stringify(main).includes('[Source text]'))
    assert.equal(main.filter((b) => b.kind === 'rule').length, 1, 'no second divider')
  })

  it('without a credit, leaves out the heading and still adds unused content', () => {
    const filled = applyComposition(statblock.tree, compose(statblock.tree, plan(), { keepUnfilled: false }))
    const tail = filled.docs[0]!.slice(-2)
    assert.deepEqual(tail.map((b) => b.kind), ['rule', 'paragraph'])
    assert.ok(!filled.docs[0]!.some((b) => b.kind === 'heading' && blockText(b as AnyBlock).startsWith('From ')))
  })

  it('appends the main tab after a divider, with no ids and nothing unsupported', () => {
    const tree = appendTree(template('Character_Template').tree)
    const p = planFill({ tree, templateId: 'c', clip: blocks('<p>Species: Elf</p>'), title: 'Arwen', site: '', synonyms, rules: [], mode: 'labels', overrides: {} })
    const out = appendedTemplate(tree, compose(tree, p, { sourceHeading: heading, keepUnfilled: true }))
    assert.equal(out[0]!.kind, 'rule')
    assert.deepEqual(out[1], heading, 'the credit tops the added content')
    const json = JSON.stringify(out)
    assert.ok(!json.includes('"id"') && !json.includes('unsupported'))
    assert.ok(json.includes('Elf'))
  })

  it('keeps a quote placeholder a quote, and tidies doubled dividers', () => {
    const tree: TemplateTree = { docs: [{ name: 'Main', blocks: [{ kind: 'quote', children: [{ kind: 'paragraph', content: [{ text: '[Quote]' }] }] }] }], properties: [] }
    const slots = buildSlots(tree)
    const out = fillTree(tree, slots, new Map([[slots[0]!.id, { blocks: [{ kind: 'paragraph', content: [{ text: 'Hail!' }] }] }]]))
    assert.equal(out.docs[0]![0]!.kind, 'quote')
    assert.deepEqual(tidyRules([{ kind: 'rule' }, { kind: 'paragraph', content: [] }, { kind: 'rule' }, { kind: 'paragraph', content: [{ text: 'x' }] }, { kind: 'rule' }]).map((b) => b.kind), ['paragraph', 'rule', 'paragraph'])
  })

  it('strips ids and unsupported rows for a copy', () => {
    const copy = forCopy(statblock.tree.docs[0]!.blocks)
    assert.ok(!JSON.stringify(copy).includes('"id"'))
  })
})

describe('AI job', () => {
  const p = plan({ mode: 'labels-ai' })
  const slots = slotsForAi(p, 'labels-ai', {})

  it('numbers the unused blocks and lists only the empty fields', () => {
    const job = buildAiJob({ slots, clip: goblin, blockIndexes: p.unusedBlockIndexes, title: 'Goblin' })!
    assert.ok(job.prompt.includes('[2] (paragraph) Small Humanoid (Goblinoid), Neutral Evil'))
    assert.ok(!job.prompt.includes('Armor Class 15'), 'blocks labels used are not sent')
    assert.ok(job.prompt.includes('"Initiative"') && !job.prompt.includes('"Strength"'))
    assert.deepEqual((job.schema as { required: string[] }).required, [...job.slots.keys()])
  })

  it('checks the answer: bad numbers dropped, each block used once, JSON found inside prose', () => {
    const job = buildAiJob({ slots, clip: goblin, blockIndexes: p.unusedBlockIndexes, title: 'Goblin' })!
    const keys = [...job.slots.keys()]
    const answer = `Sure! {"${keys[0]}": {"blocks": [999], "value": "+2"}, "${keys[1]}": {"blocks": [2], "value": ""}, "${keys[2]}": {"blocks": [2], "value": ""}}`
    const result = parseAiAnswer(job, answer)
    assert.deepEqual(result.get(job.slots.get(keys[0]!)!), { blocks: [], value: '+2' })
    assert.deepEqual(result.get(job.slots.get(keys[1]!)!), { blocks: [1], value: '' })
    assert.equal(result.get(job.slots.get(keys[2]!)!), undefined, 'block 2 was already used')
    assert.throws(() => parseAiAnswer(job, 'no idea'), AiAnswerError)
  })

  it('retries a malformed answer once, and halves a prompt that is too big', async () => {
    const answers = ['not json', '{"s1": {"blocks": [], "value": ""}}']
    const sizes: number[] = []
    const engine: AiEngine = {
      name: 'fake',
      maxChars: 8000,
      async run(job) {
        sizes.push(job.prompt.length)
        if (sizes.length === 1) throw Object.assign(new Error('too big'), { name: 'QuotaExceededError' })
        return answers.shift()!
      },
    }
    const result = await suggest(engine, { slots, clip: goblin, blockIndexes: p.unusedBlockIndexes, title: 'Goblin' })
    assert.equal(sizes.length, 3)
    assert.equal(result.suggestions.size, 0)
  })
})

// The user's first on-device run (Assassin, Statblock Template, "Labels then AI") made three
// mistakes. Each is replayed here, with variants, so the same kind of mistake stays caught.
describe('AI answers checked against the clip (Assassin)', () => {
  const assassin = blocks(readFileSync(new URL('./fixtures/dndbeyond-assassin.html', import.meta.url), 'utf8'))
  const index = (start: string) => assassin.findIndex((b) => blockText(b as AnyBlock).startsWith(start))
  const run = (overrides: Partial<FillInput> = {}, clip = assassin) =>
    planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: 'Assassin', site: 'dndbeyond.com', synonyms, rules: [], mode: 'labels-ai', overrides: {}, derived: parseDerived(DEFAULT_DERIVED), ...overrides })
  const ids = (p: ReturnType<typeof run>) => (label: string) => slotNamed(p, label).slot.id

  it('works out Initiative from Dexterity when the stat block has none', () => {
    const p = run()
    const initiative = slotNamed(p, 'Initiative')
    assert.equal(initiative.status, 'filled')
    assert.equal(initiative.origin, 'derived')
    assert.equal(initiative.text, '+3 (13)')
    assert.match(initiative.note!, /Dexterity: 16 \(\+3\)/)
    assert.ok(!slotsForAi(p, 'labels-ai', {}).some((s) => s.label === 'Initiative'), 'the AI is not asked about it')
  })

  it('reads labels the page marks by class, so they are not offered to the AI as loose text', () => {
    const p = run()
    const slots = slotsForAi(p, 'labels-ai', {})
    const offered = blocksForAi(p, slots, 'labels-ai', assassin.length, synonyms).map((i) => blockText(assassin[i] as AnyBlock))
    assert.deepEqual(offered, ['Medium Humanoid (Any Race), Any Non-Good Alignment'])
  })

  it('leaves out the page name the AI included with the creature type', () => {
    const id = ids(run())
    const p = run({ ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [index('Assassin'), index('Medium Humanoid')], value: '' }]]) })
    const size = slotNamed(p, 'Size, Creature Type, Alignment')
    assert.equal(size.status, 'filled')
    assert.equal(size.text, 'Medium Humanoid (Any Race), Any Non-Good Alignment')
  })

  it('…also when the name is a line of the same paragraph, or a heading, or typed into a value', () => {
    const joined = blocks('<p><strong>Assassin</strong><br>Medium Humanoid (Any Race), Any Non-Good Alignment</p><p><strong>Armor Class</strong> 15</p>')
    const id = ids(run({}, joined))
    const p = run({ ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [0], value: '' }]]) }, joined)
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').text, 'Medium Humanoid (Any Race), Any Non-Good Alignment')

    const headed = blocks('<h2>Assassin</h2><p>Medium Humanoid (Any Race), Any Non-Good Alignment</p><p><strong>Armor Class</strong> 15</p>')
    assert.ok(!run({}, headed).unusedBlockIndexes.includes(0), 'a heading that is the page name is not offered to the AI')

    const typed = run({ ai: new Map([[id('Immunities'), { blocks: [], value: 'Assassin\nPoison' }]]) })
    assert.ok(!slotNamed(typed, 'Immunities').text.includes('Assassin'))
  })

  it('does not put a labelled line into a field with another label (Saving Throws → Legendary Actions)', () => {
    const id = ids(run())
    const p = run({ ai: new Map([[id('Legendary Actions'), { blocks: [index('Saving Throws')], value: '' }]]) })
    const legendary = slotNamed(p, 'Legendary Actions')
    assert.equal(legendary.status, 'off', 'shown, but unticked')
    assert.match(legendary.warning!, /labels this “Saving Throws”, not “Legendary Actions”/)
    assert.ok(text(p.leftovers).includes('Saving Throws DEX +6'), 'so it stays in the unused content')
  })

  it('…nor a value copied from another label’s line (Resistances’ “Poison” → Immunities)', () => {
    const id = ids(run())
    const p = run({ ai: new Map([[id('Immunities'), { blocks: [], value: 'Poison' }]]) })
    assert.match(slotNamed(p, 'Immunities').warning!, /labels this “Damage Resistances”/)
  })

  it('fills a template heading only from under a heading like it', () => {
    const id = ids(run({ mode: 'ai' }))
    const actions = [index('Multiattack'), index('Shortsword'), index('Light Crossbow')]
    const p = run({ mode: 'ai', ai: new Map<string, AiSuggestion>([
      [id('Actions'), { blocks: actions.slice(0, 2), value: '' }],
      [id('Legendary Actions'), { blocks: [actions[2]!], value: '' }],
      [id('Bonus Actions'), { blocks: [index('Medium Humanoid')], value: '' }],
    ]) })
    assert.equal(slotNamed(p, 'Actions').status, 'filled', 'Actions from under “Actions” is fine')
    assert.equal(slotNamed(p, 'Actions').warning, undefined)
    assert.match(slotNamed(p, 'Legendary Actions').warning!, /under “Actions”, not “Legendary Actions”/)
    assert.match(slotNamed(p, 'Bonus Actions').warning!, /no “Bonus Actions” heading/)
    assert.equal(slotNamed(p, 'Bonus Actions').status, 'off')
  })

  it('uses the half of an answer the clip agrees with (an off-by-one block number, a right value)', () => {
    const id = ids(run({ mode: 'ai' }))
    const p = run({ mode: 'ai', ai: new Map([[id('Dexterity'), { blocks: [index('CON')], value: '16 (+3)' }]]) })
    assert.equal(slotNamed(p, 'Dexterity').text, '16 (+3)')
    assert.equal(slotNamed(p, 'Dexterity').status, 'filled')
    assert.equal(slotNamed(p, 'Dexterity').warning, undefined)
  })

  it('does not take what the clip has under a heading that names another field', () => {
    const id = ids(run({ mode: 'ai' }))
    const p = run({ mode: 'ai', ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [index('Trained in the use')], value: '' }]]) })
    assert.match(slotNamed(p, 'Size, Creature Type, Alignment').warning!, /under “Description”, which is a field of its own/)
  })

  it('checks the heading of a copied value that is a whole line, as for a picked line', () => {
    const id = ids(run({ mode: 'ai' }))
    const p = run({ mode: 'ai', ai: new Map([[id('Bonus Actions'), { blocks: [], value: 'Medium Humanoid (Any Race), Any Non-Good Alignment' }]]) })
    assert.match(slotNamed(p, 'Bonus Actions').warning!, /no “Bonus Actions” heading/)
  })

  it('lets you tick a flagged suggestion to use it anyway', () => {
    const id = ids(run())
    const ai = new Map([[id('Legendary Actions'), { blocks: [index('Saving Throws')], value: '' }]])
    const p = run({ ai, overrides: { [id('Legendary Actions')]: { off: false } } })
    assert.equal(slotNamed(p, 'Legendary Actions').status, 'filled')
  })

  it('tells the model what the clip labels each block and which heading it is under', () => {
    const p = run({ mode: 'ai' })
    const slots = slotsForAi(p, 'ai', {})
    const job = buildAiJob({ slots, clip: assassin, blockIndexes: blocksForAi(p, slots, 'ai', assassin.length, synonyms), title: 'Assassin', labels: p.blockLabels })!
    assert.match(job.prompt, /\(paragraph, labelled "Armor Class"\) Armor Class 15/)
    assert.match(job.prompt, /\(paragraph, under "Traits"\) Assassinate\./)
    assert.match(job.prompt, /"Legendary Actions" \(Legendary Actions\) — .* A heading in the template\./)
    assert.ok(!job.prompt.includes('Saving Throws DEX'), 'a line labelled for no asked field is left out')
  })
})

describe('AI values that appear more than once', () => {
  it('puts a repeated value in each field it belongs to (CON and INT are both “10 (+0)”)', () => {
    const first = plan({ mode: 'ai' })
    const id = (label: string) => slotNamed(first, label).slot.id
    const p = plan({ mode: 'ai', ai: new Map<string, AiSuggestion>([
      [id('Intelligence'), { blocks: [], value: '10 (+0)' }],
      [id('Constitution'), { blocks: [], value: '10 (+0)' }],
    ]) })
    assert.equal(slotNamed(p, 'Constitution').text, '10 (+0)')
    assert.equal(slotNamed(p, 'Intelligence').text, '10 (+0)')
    assert.equal(slotNamed(p, 'Constitution').status, 'filled')
    assert.equal(slotNamed(p, 'Intelligence').status, 'filled')
    assert.ok(!text(p.leftovers).includes('10 (+0)'), 'both blocks are used')
  })
})

describe('AI picks snap to the clip’s labels', () => {
  it('drops the label from a labelled line or section the AI picked for that field', () => {
    const first = plan({ mode: 'ai' })
    const id = (label: string) => slotNamed(first, label).slot.id
    const at = (start: string) => goblin.findIndex((b) => blockText(b as AnyBlock).startsWith(start))
    const traits = goblin.map((b, i) => (blockText(b as AnyBlock) === 'Traits' || blockText(b as AnyBlock).startsWith('Nimble') ? i : -1)).filter((i) => i >= 0)
    const p = plan({ mode: 'ai', ai: new Map<string, AiSuggestion>([
      [id('Armour Class'), { blocks: [at('Armor Class')], value: '' }],
      [id('Hit Points'), { blocks: [], value: 'Hit Points 7 (2d6)' }],
      [id('Traits'), { blocks: traits, value: '' }],
    ]) })
    assert.equal(slotNamed(p, 'Armour Class').text, '15 (leather armor, shield)')
    assert.equal(slotNamed(p, 'Hit Points').text, '7 (2d6)')
    assert.match(slotNamed(p, 'Traits').text, /^Nimble Escape\./)
    for (const label of ['Armour Class', 'Hit Points', 'Traits']) assert.equal(slotNamed(p, label).origin, 'ai')
  })
})

describe('worked-out fields', () => {
  it('reads rules and takes the right part of a value', () => {
    assert.deepEqual(parseDerived('Initiative = Dexterity modifier\nnonsense\nSpeed = Base Speed\nInit = {Dexterity modifier} ({10 + Dexterity modifier})\nBad = {Dexterity'), [
      { target: 'Initiative', pieces: [{ source: 'Dexterity', part: 'modifier' }] },
      { target: 'Speed', pieces: [{ source: 'Base Speed', part: 'value' }] },
      { target: 'Init', pieces: [{ source: 'Dexterity', part: 'modifier' }, ' (', { source: 'Dexterity', part: 'modifier', add: 10 }, ')'] },
    ])
    assert.equal(deriveValue('16 (+3)', 'modifier'), '+3')
    assert.equal(deriveValue('8 (−1)', 'modifier'), '-1')
    assert.equal(deriveValue('16', 'modifier'), '+3', 'from a lone ability score')
    assert.equal(deriveValue('9', 'modifier'), '-1')
    assert.equal(deriveValue('Darkvision 60 ft.', 'modifier'), undefined)
    assert.equal(deriveValue('30 ft., fly 60 ft.', 'number'), '30')
  })

  it('writes Initiative as the modifier and, in brackets, 10 plus it', () => {
    const [rule] = parseDerived(DEFAULT_DERIVED)
    const dex = (text: string) => applyDerived(rule!, (name) => (name === 'Dexterity' ? text : undefined))
    assert.equal(dex('12 (+1)'), '+1 (11)')
    assert.equal(dex('6 (−2)'), '-2 (8)')
    assert.equal(dex('10 (+0)'), '+0 (10)')
    assert.equal(dex('nothing'), undefined)
    assert.equal(applyDerived(rule!, () => undefined), undefined)
    assert.ok(completes('+3', '+3 (13)'))
    assert.ok(completes('−2', '-2 (8)'))
    assert.ok(!completes('+3 (13)', '+3 (13)'))
    assert.ok(!completes('+1', '+13 (23)'))
  })

  it('replaces an old default rule in saved settings', () => {
    assert.equal(withNewDerived('Initiative = Dexterity modifier\nSpeed = Base Speed'), `${DEFAULT_DERIVED}\nSpeed = Base Speed`)
  })

  it('completes a value the clip only starts', () => {
    const clip = blocks('<p><strong>DEX</strong> 16 (+3)</p><p><strong>Initiative</strong> +3</p>')
    const p = planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: 'X', site: '', synonyms, rules: [], mode: 'labels', overrides: {}, derived: parseDerived(DEFAULT_DERIVED) })
    assert.equal(slotNamed(p, 'Initiative').text, '+3 (13)')
    assert.equal(slotNamed(p, 'Initiative').origin, 'derived')
    assert.match(slotNamed(p, 'Initiative').note ?? '', /The clip gives “\+3”/)
    assert.ok(!p.leftovers.some((b) => blockText(b as AnyBlock).includes('Initiative')), 'the clip’s line counts as used')
  })

  it('wins over an AI guess that was left unticked', () => {
    const first = plan({ mode: 'ai', derived: parseDerived(DEFAULT_DERIVED) })
    const id = (label: string) => slotNamed(first, label).slot.id
    const dex = goblin.findIndex((b) => blockText(b as AnyBlock) === '14 (+2)')
    const p = plan({ mode: 'ai', derived: parseDerived(DEFAULT_DERIVED), ai: new Map<string, AiSuggestion>([
      [id('Dexterity'), { blocks: [dex], value: '' }],
      [id('Initiative'), { blocks: [], value: '+2 (12)' }],
    ]) })
    assert.equal(slotNamed(p, 'Initiative').origin, 'derived')
    assert.equal(slotNamed(p, 'Initiative').text, '+2 (12)')
  })

  it('never replaces a value the clip states', () => {
    const clip = blocks('<p><strong>DEX</strong> 16 (+3)</p><p><strong>Initiative</strong> +7 (17)</p>')
    const p = planFill({ tree: statblock.tree, templateId: statblock.id, clip, title: 'X', site: '', synonyms, rules: [], mode: 'labels', overrides: {}, derived: parseDerived(DEFAULT_DERIVED) })
    assert.equal(slotNamed(p, 'Initiative').text, '+7 (17)')
    assert.equal(slotNamed(p, 'Initiative').origin, 'label')
  })
})

describe('labels in the clip', () => {
  it('treats an element with a label class as a bold label', () => {
    const [block] = blocks('<div><span class="stat__attribute-label">Saving Throws</span> <span>DEX +6</span></div>')
    assert.deepEqual((block as AnyBlock).content, [{ text: 'Saving Throws', bold: true }, { text: ' DEX +6' }])
  })

  it('recognises a label from the synonym list at the start of a short plain line, not in prose', () => {
    const clip = blocks('<p>Saving Throws DEX +6, INT +4</p><p>Saving Throws are rolled when a creature resists a spell, a trap, a poison, a disease or a similar threat, and the Game Master decides which ability is used for the roll each time.</p>')
    const { candidates } = extractCandidates(clip, { knownLabels: [], vocabulary: synonyms.labels() })
    assert.deepEqual(candidates.map((c) => [c.key, c.text]), [['saving throws', 'DEX +6, INT +4']])
  })

  it('keeps labels inside a value together (a linked “Saving Throws” page name, then DEX and INT)', () => {
    const clip: Block[] = [
      { kind: 'paragraph', content: [{ text: 'Saving Throws DEX +6, INT +4' }] },
      { kind: 'paragraph', content: [{ text: 'Armor Class 15 Hit Points 78 (12d8 + 24)' }] },
    ]
    const { candidates } = extractCandidates(clip, { knownLabels: ['dex', 'int', 'armor class', 'hit points'], vocabulary: synonyms.labels() })
    assert.deepEqual(candidates.map((c) => [c.key, c.text]), [['saving throws', 'DEX +6, INT +4'], ['armor class', '15'], ['hit points', '78 (12d8 + 24)']])
  })

  it('adds new default synonyms to a saved list once, without undoing your edits', () => {
    const saved = [['Armour Class', 'AC'], ['Hit Points', 'HP']]
    const merged = withNewDefaults(saved)
    assert.ok(merged.some((g) => g.includes('Proficiency Bonus')))
    assert.deepEqual(merged.find((g) => g.includes('AC')), ['Armour Class', 'AC'], 'your groups are kept as they are')
  })
})

describe('Labels then AI writes', () => {
  const run = (overrides: Partial<FillInput> = {}) => plan({ mode: 'labels-ai-write', derived: parseDerived(DEFAULT_DERIVED), ...overrides })
  const id = (label: string) => slotNamed(run(), label).slot.id

  it('uses your notes for a template, or the built-in pack that fits it', () => {
    const slots = buildSlots(statblock.tree)
    assert.equal(notesFor('Statblock Template', slots, [], synonyms)?.from, DND5E_STATBLOCK.name)
    const saved = withNotes([], 'Statblock Template', 'Initiative: +N.')
    assert.deepEqual(notesFor('statblock template', slots, saved, synonyms), { text: 'Initiative: +N.', from: 'yours' })
    assert.deepEqual(withNotes(saved, 'Statblock Template', ''), [], 'empty notes are removed')
    assert.equal(notesFor('God Template', buildSlots(template('God_Template').tree), [], synonyms)?.from, 'Deity', 'the stat block pack doesn’t fit a god; its own pack does')
  })

  it('lets the AI write short fields only, and gives it the notes', () => {
    const p = run()
    const slots = slotsForAi(p, 'labels-ai-write', {})
    assert.deepEqual(slots.filter(isWritable).map((s) => s.label), ['Resistances', 'Immunities', 'Size, Creature Type, Alignment'])
    assert.ok(!slots.some((s) => s.label === 'Initiative'), 'a worked-out field isn’t asked about')
    const job = buildAiJob({ slots, clip: goblin, blockIndexes: p.unusedBlockIndexes, title: 'Goblin', labels: p.blockLabels, write: { notes: DND5E_STATBLOCK.text } })!
    assert.equal(job.system, WRITE_SYSTEM_PROMPT)
    assert.match(job.prompt, /Notes about this template:\nA Dungeons & Dragons/)
    assert.match(job.prompt, /"Size, Creature Type, Alignment" .* — write: a short value/)
    assert.match(job.prompt, /"Legendary Actions" .* — paragraphs or a section: give block numbers/)
  })

  it('ticks a written value whose numbers and names are all in the clip', () => {
    const p = run({ ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [], value: 'Small Humanoid (Goblinoid); alignment Neutral Evil' }]]) })
    const size = slotNamed(p, 'Size, Creature Type, Alignment')
    assert.equal(size.origin, 'ai-wrote')
    assert.equal(size.status, 'filled')
    assert.equal(size.text, 'Small Humanoid (Goblinoid); alignment Neutral Evil')
  })

  it('leaves a written value unticked when it adds a number or a name', () => {
    const p = run({ ai: new Map([
      [id('Size, Creature Type, Alignment'), { blocks: [], value: 'Large Humanoid (Goblinoid), Neutral Evil' }],
      [id('Immunities'), { blocks: [], value: 'Poison 12' }],
    ]) })
    assert.match(slotNamed(p, 'Size, Creature Type, Alignment').warning!, /“Large”, which isn’t in the clip/)
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').status, 'off')
    assert.match(slotNamed(p, 'Immunities').warning!, /“12”/)
  })

  it('keeps the clip’s line when a written value leaves part of it out, and drops placeholder brackets', () => {
    const p = run({ ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [], value: '[Small] [Humanoid], [Neutral Evil]' }]]) })
    const size = slotNamed(p, 'Size, Creature Type, Alignment')
    assert.equal(size.text, 'Small Humanoid (Goblinoid), Neutral Evil')
    assert.equal(size.origin, 'ai')
    assert.equal(size.status, 'filled')
    assert.ok(!text(p.leftovers).includes('Small Humanoid'), 'the line is used, not repeated')
  })

  it('does not take the notes’ examples as facts (a small model copied the Assassin example for a zombie)', () => {
    const p = run({ ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [], value: 'Medium Humanoid (Any Race), Any Non-Good Alignment' }]]) })
    assert.match(slotNamed(p, 'Size, Creature Type, Alignment').warning!, /“Medium”, which isn’t in the clip/)
  })

  it('still only copies in the other AI modes', () => {
    const p = plan({ mode: 'labels-ai', ai: new Map([[id('Size, Creature Type, Alignment'), { blocks: [], value: 'Small Humanoid, Neutral Evil' }]]) })
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').origin, 'ai-written')
    assert.equal(slotNamed(p, 'Size, Creature Type, Alignment').status, 'off')
  })
})

describe('on-device engine', () => {
  it('keeps a session per system prompt and asks each clip in a fresh copy', async () => {
    const created: string[] = []
    const asked: { system: string; copy: boolean }[] = []
    let destroyed = 0
    const session = (system: string, copy = false): Record<string, unknown> => ({
      async prompt() { asked.push({ system, copy }); return '{"s1": {"blocks": [], "value": ""}}' },
      async clone() { return session(system, true) },
      destroy() { if (copy) destroyed++ },
    })
    const g = globalThis as { LanguageModel?: unknown }
    g.LanguageModel = {
      availability: async () => 'available',
      create: async (options: { initialPrompts: { content: string }[] }) => (created.push(options.initialPrompts[0]!.content), session(options.initialPrompts[0]!.content)),
    }
    try {
      const engine = new OnDeviceEngine()
      const job = buildAiJob({ slots: slotsForAi(plan({ mode: 'labels-ai' }), 'labels-ai', {}), clip: goblin, blockIndexes: [1], title: 'Goblin' })!
      await engine.run(job)
      await engine.run(job)
      await engine.run({ ...job, system: WRITE_SYSTEM_PROMPT })
      assert.equal(created.length, 2, 'one session per system prompt')
      assert.ok(asked.every((a) => a.copy), 'every clip is asked in a copy')
      assert.equal(destroyed, 3, 'and the copy is thrown away')
    } finally {
      delete g.LanguageModel
    }
  })
})

describe('OpenRouter engine', () => {
  const job = buildAiJob({ slots: slotsForAi(plan({ mode: 'labels-ai' }), 'labels-ai', {}), clip: goblin, blockIndexes: [1], title: 'Goblin' })!
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('uses free models only', () => {
    assert.throws(() => new OpenRouterEngine({ apiKey: 'k', model: 'openai/gpt-5' }), /free/)
  })

  it('lists free text models, those with JSON schema support first', async () => {
    const models = await listFreeModels(async () => reply(200, { data: [
      { id: 'a/paid', supported_parameters: ['structured_outputs'] },
      { id: 'b/plain:free', name: 'Plain' },
      { id: 'c/schema:free', name: 'Schema', supported_parameters: ['structured_outputs', 'response_format'] },
      { id: 'd/content-safety:free', name: 'Safety' },
    ] }))
    assert.deepEqual(models.map((m) => m.id), ['c/schema:free', 'b/plain:free'])
  })

  it('sends the schema, and tries the next free model once when one is gone', async () => {
    const calls: { model: string; format?: unknown }[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ model: body.model, format: body.response_format?.type })
      return body.model === 'gone:free' ? reply(404, { error: { message: 'No endpoints' } }) : reply(200, { choices: [{ message: { content: '{"s1": {"blocks": [], "value": ""}}' } }] })
    }) as typeof fetch
    const engine = new OpenRouterEngine({ apiKey: 'k', model: 'gone:free', fallbacks: [{ id: 'gone:free', name: '', contextLength: 0, structured: true, jsonMode: true }, { id: 'next:free', name: '', contextLength: 0, structured: true, jsonMode: true }], fetchImpl })
    assert.match(await engine.run(job), /s1/)
    assert.deepEqual(calls, [{ model: 'gone:free', format: 'json_schema' }, { model: 'next:free', format: 'json_schema' }])
  })

  it('does not retry a rate limit, and says why in plain words', async () => {
    let calls = 0
    const fetchImpl = (async () => (calls++, new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))) as unknown as typeof fetch
    const engine = new OpenRouterEngine({ apiKey: 'k', model: 'a:free', fallbacks: [{ id: 'b:free', name: '', contextLength: 0, structured: false, jsonMode: false }], fetchImpl })
    await assert.rejects(engine.run(job), (error: unknown) => error instanceof OpenRouterError && /30 seconds/.test(error.message))
    assert.equal(calls, 1)
  })
})

describe('stat block tags', () => {
  it('reads size, type and alignment from the creature line', () => {
    assert.deepEqual(creatureLineTags('Medium Humanoid (Any Race), Any Non-Good Alignment'), ['Medium', 'Humanoid', 'Any Non-Good Alignment'])
    assert.deepEqual(creatureLineTags('Small Fey (Goblinoid), Typically Chaotic Neutral'), ['Small', 'Fey', 'Chaotic Neutral'])
    assert.deepEqual(creatureLineTags('medium undead, neutral evil'), ['Medium', 'Undead', 'Neutral Evil'])
    assert.deepEqual(creatureLineTags('Medium or Small Humanoid, Unaligned'), ['Medium', 'Small', 'Humanoid', 'Unaligned'])
    assert.deepEqual(creatureLineTags('Large Swarm of Tiny Beasts, unaligned'), ['Large', 'Swarm of Tiny Beasts', 'Unaligned'])
    assert.deepEqual(creatureLineTags('Gargantuan Dragon'), ['Gargantuan', 'Dragon'])
  })

  it('writes the challenge rating as "CR n"', () => {
    assert.equal(challengeTag('8 (3,900 XP)'), 'CR 8')
    assert.equal(challengeTag('1/4 (50 XP)'), 'CR 1/4')
    assert.equal(challengeTag('½'), 'CR 1/2')
    assert.equal(challengeTag('CR 13 (XP 10,000; PB +5)'), 'CR 13')
    assert.equal(challengeTag('none'), undefined)
  })

  it('tags a filled stat block template, and nothing else', () => {
    const p = plan({ mode: 'labels' })
    const withLine = planFill({ tree: statblock.tree, templateId: statblock.id, clip: goblin, title: 'Goblin', site: '', synonyms, rules: [], mode: 'labels', overrides: { [slotNamed(p, 'Size, Creature Type, Alignment').slot.id]: { choice: 'typed', text: 'Small Humanoid (Goblinoid), Neutral Evil' } } })
    assert.deepEqual(statblockTags(withLine, synonyms), ['Small', 'Humanoid', 'Neutral Evil', 'CR 1/4'])
    const spell = template('Spell_Template')
    assert.deepEqual(statblockTags(planFill({ tree: spell.tree, templateId: spell.id, clip: goblin, title: 'X', site: '', synonyms, rules: [], mode: 'labels', overrides: {} }), synonyms), [])
  })

  it('uses the project’s spelling of a tag, and reads edited tags', () => {
    assert.deepEqual(withProjectSpelling(['Humanoid', 'CR 8', 'Neutral Evil'], ['humanoid', 'Creature']), ['humanoid', 'CR 8', 'Neutral Evil'])
    assert.deepEqual(parseTags(' Medium,, humanoid , Medium '), ['Medium', 'humanoid'])
  })
})

describe('built-in notes and AI-suggested notes', () => {
  const names = ['Character_Template', 'Class_Template', 'God_Template', 'Large_Location_Template', 'Magic_Item_Template', 'Other_Location_Template', 'Spell_Template', 'Statblock_Template', 'Subclass_Template']

  it('has notes for every template in the test project, naming its own fields', () => {
    const packs = names.map((name) => {
      const slots = buildSlots(template(name).tree)
      const pack = builtInPackFor(slots, synonyms, name.replace(/_/g, ' '))
      assert.ok(pack, `${name} has a pack`)
      for (const slot of slots.filter((s) => ['text', 'rich'].includes(s.kind))) {
        assert.ok(pack.text.toLowerCase().includes(slot.label.toLowerCase().slice(0, 12)), `${pack.name} notes mention “${slot.label}”`)
      }
      return pack.name
    })
    assert.equal(new Set(packs).size, names.length, 'each template has its own pack')
  })

  it('does not treat a feature heading as the page name', () => {
    assert.ok(namesPage('[Spell] Name') && namesPage('[Magic Item] Name') && namesPage('[Name]'))
    assert.ok(!namesPage('Level [?]: [Feature Name]'))
    assert.ok(!buildSlots(template('Subclass_Template').tree).some((s) => s.kind === 'name'))
  })

  it('asks for notes from the fields, the notes so far and an example clip, and reads the answer', () => {
    const slots = buildSlots(statblock.tree)
    const job = buildNotesJob({ templateName: 'Statblock Template', slots, current: 'Initiative: +N.', clip: { blocks: goblin, title: 'Goblin' } })
    assert.match(job.prompt, /- "Armour Class" \(one line\)/)
    assert.match(job.prompt, /- "Traits" \(paragraphs, a heading in the template/)
    assert.match(job.prompt, /Notes it has now[\s\S]*Initiative: \+N\./)
    assert.match(job.prompt, /An example clip, "Goblin"[\s\S]*Nimble Escape/)
    assert.equal(job.system, NOTES_SYSTEM_PROMPT)
    assert.equal(parseNotesAnswer('```json\n{"notes": "A creature.\\n- Speed: 30 ft."}\n```'), 'A creature.\n- Speed: 30 ft.')
    assert.equal(parseNotesAnswer('Plain notes.'), 'Plain notes.')
  })

  it('gives the notes to the AI in every mode, telling it to copy when it only picks', () => {
    const p = plan({ mode: 'labels-ai' })
    const slots = slotsForAi(p, 'labels-ai', {})
    const pick = buildAiJob({ slots, clip: goblin, blockIndexes: goblin.map((_, i) => i), title: 'Goblin', notes: 'Speed: walking first.' })!
    assert.match(pick.prompt, /Notes about this template \(they say what belongs in each field; copy values as the clip has them, never reformat\):\nSpeed: walking first\./)
    assert.equal(pick.system, SYSTEM_PROMPT)
    const write = buildAiJob({ slots, clip: goblin, blockIndexes: goblin.map((_, i) => i), title: 'Goblin', notes: 'Speed: walking first.', write: {} })!
    assert.match(write.prompt, /Notes about this template:\nSpeed: walking first\./)
    assert.equal(write.system, WRITE_SYSTEM_PROMPT)
  })
})
