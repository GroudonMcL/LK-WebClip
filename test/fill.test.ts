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
import { mergeRules, planFill, rulesFromChoices, type AiSuggestion, type FillInput, type SavedRule } from '../src/fill/plan.js'
import { blockText, buildSlots, fillTree, forCopy, type AnyBlock, type TemplateTree } from '../src/fill/template.js'

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
    assert.equal(text(p.leftovers), 'Small Humanoid (Goblinoid), Neutral Evil\nProficiency Bonus +2')
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
    const proficiency = first.candidates.find((c) => c.key === 'proficiency bonus')
    assert.equal(proficiency, undefined, 'unknown labels are not candidates…')
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
    const box = main[0] as AnyBlock
    const firstRows = (box.rows[0].rows as AnyBlock[])
    assert.equal(firstRows[0]!.id, 'uyi47pta')
    assert.deepEqual(firstRows.map((r) => r.key), ['Armour Class', 'Hit Points', 'Speed'], 'the empty Initiative row is gone')
    const all = JSON.stringify(main)
    assert.ok(!all.includes('Bonus Actions') && !all.includes('[Description text]'))
    assert.deepEqual(main.slice(-4).map((b) => b.kind), ['rule', 'heading', 'paragraph', 'paragraph'], 'one divider, then the credit and unused content')
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
    const tail = filled.docs[0]!.slice(-3)
    assert.deepEqual(tail.map((b) => b.kind), ['rule', 'paragraph', 'paragraph'])
  })

  it('appends the main tab after a divider, with no ids and nothing unsupported', () => {
    const tree = appendTree(template('Character_Template').tree)
    const p = planFill({ tree, templateId: 'c', clip: blocks('<p>Species: Elf</p>'), title: 'Arwen', site: '', synonyms, rules: [], mode: 'labels', overrides: {} })
    const out = appendedTemplate(tree, compose(tree, p, { sourceHeading: heading, keepUnfilled: true }))
    assert.equal(out[0]!.kind, 'rule')
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
