/**
 * Measures the AI's mistakes on saved clips, so a change to the prompt or the checks can be judged
 * by numbers rather than by one lucky run. No LegendKeeper writes; it uses the saved templates in
 * test/fixtures/templates.
 *
 *   npm run eval:ai                        # every case once, with the first free OpenRouter model
 *   npm run eval:ai -- --runs 3            # each case three times (free models vary between runs)
 *   npm run eval:ai -- --model some/model:free
 *   npm run eval:ai -- --modes labels-ai,labels-ai-write
 *
 * For each field the final state is compared with what a careful person would put there:
 *   - right:    the expected value, ticked; or nothing, when nothing belongs there;
 *   - missed:   a value belongs there but the field is empty;
 *   - caught:   the AI suggested something wrong and the checks left it unticked;
 *   - WRONG:    something wrong is ticked and would go into the page.
 * "Wrong without the checks" adds the caught ones back: what the error count would be if every AI
 * suggestion were ticked.
 *
 * When someone reports a bad fill, add the clip to test/fixtures and a case here (and a replay of
 * the bad answer in test/fill.test.ts), so the same kind of mistake is measured from then on.
 * Gemini Nano runs only inside Chrome; this uses free OpenRouter models, which are larger, so it
 * shows where the checks help rather than Nano's own accuracy.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Block } from '@legendkeeper/sdk/blocks'
import { DOMParser } from 'linkedom'
import { htmlStringToBlocks } from '../src/clip/htmlToBlocks.js'
import { slotsForAi } from '../src/fill/ai.js'
import { DEFAULT_DERIVED, parseDerived } from '../src/fill/derived.js'
import { listFreeModels, OpenRouterEngine, suggest } from '../src/fill/engines.js'
import { DEFAULT_SYNONYMS, Synonyms } from '../src/fill/labels.js'
import { blocksForAi, comparable, planFill, type FillMode, type FillPlan } from '../src/fill/plan.js'
import { notesFor } from '../src/fill/notes.js'
import { buildSlots, type TemplateTree } from '../src/fill/template.js'

const { values: args } = parseArgs({ options: { runs: { type: 'string', default: '1' }, model: { type: 'string' }, verbose: { type: 'boolean', default: false }, modes: { type: 'string' } } })
const apiKey = process.env.OPENROUTER_API_KEY?.trim()
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY (free models only are used).')

/** What belongs in each field: the exact text, a pattern, or null for nothing. Fields not listed aren't scored. */
type Expected = Record<string, string | RegExp | null>

interface Case {
  name: string
  fixture: string
  template: string
  title: string
  modes: FillMode[]
  expected: Expected
}

const STATBLOCK_EMPTY = { 'Bonus Actions': null, 'Legendary Actions': null, Immunities: null }

const CASES: Case[] = [
  {
    name: 'Goblin',
    fixture: 'dndbeyond-goblin.html',
    template: 'Statblock_Template',
    title: 'Goblin',
    modes: ['labels-ai', 'labels-ai-write', 'ai'],
    expected: {
      'Armour Class': '15 (leather armor, shield)', Initiative: '+2', 'Hit Points': '7 (2d6)', Speed: '30 ft.',
      Strength: '8 (-1)', Dexterity: '14 (+2)', Constitution: '10 (+0)', Intelligence: '10 (+0)', Wisdom: '8 (-1)', Charisma: '8 (-1)',
      Skills: 'Stealth +6', Resistances: null, Senses: 'Darkvision 60 ft., Passive Perception 9', Languages: 'Common, Goblin',
      'Challenge Rating': '1/4 (50 XP)', 'Size, Creature Type, Alignment': 'Small Humanoid (Goblinoid), Neutral Evil',
      Traits: /^Nimble Escape/, Actions: /^Scimitar[\s\S]*Shortbow/, Description: null, ...STATBLOCK_EMPTY,
    },
  },
  {
    // The user's first on-device run: the name went into the type field, Saving Throws into
    // Legendary Actions, and Initiative stayed empty.
    name: 'Assassin',
    fixture: 'dndbeyond-assassin.html',
    template: 'Statblock_Template',
    title: 'Assassin',
    modes: ['labels-ai', 'labels-ai-write', 'ai'],
    expected: {
      'Armour Class': '15 (studded leather)', Initiative: '+3', 'Hit Points': '78 (12d8 + 24)', Speed: '30 ft.',
      Strength: '11 (+0)', Dexterity: '16 (+3)', Constitution: '14 (+2)', Intelligence: '13 (+1)', Wisdom: '11 (+0)', Charisma: '10 (+0)',
      Skills: /^Acrobatics \+6/, Resistances: 'Poison', Senses: 'Passive Perception 13', Languages: "Thieves' cant plus any two languages",
      'Challenge Rating': '8 (3,900 XP)', 'Size, Creature Type, Alignment': 'Medium Humanoid (Any Race), Any Non-Good Alignment',
      Traits: /^Assassinate[\s\S]*Sneak Attack/, Actions: /^Multiattack[\s\S]*Light Crossbow/, Description: /^Trained in the use of poison/, ...STATBLOCK_EMPTY,
    },
  },
  {
    // A fan-wiki layout: bold labels, lowercase values, an ability table, damage and condition
    // immunities on separate lines, and a trait with no "Traits" heading.
    name: 'Zombie',
    fixture: 'wiki-zombie.html',
    template: 'Statblock_Template',
    title: 'Zombie',
    modes: ['labels-ai', 'labels-ai-write', 'ai'],
    expected: {
      'Armour Class': '8', Initiative: '-2', 'Hit Points': '22 (3d8 + 9)', Speed: '20 ft.',
      Strength: '13 (+1)', Dexterity: '6 (−2)', Constitution: '16 (+3)', Intelligence: '3 (−4)', Wisdom: '6 (−2)', Charisma: '5 (−3)',
      Skills: null, Resistances: null, Immunities: /^poison\b/i, Senses: 'darkvision 60 ft., passive Perception 8',
      Languages: "understands the languages it knew in life but can't speak", 'Challenge Rating': '1/4 (50 XP)',
      'Size, Creature Type, Alignment': 'Medium undead, neutral evil', Actions: /^Slam\./, Description: null,
      'Bonus Actions': null, 'Legendary Actions': null,
    },
  },
]

const parser = new DOMParser() as unknown as { parseFromString(html: string, type: 'text/html'): Document }
const synonyms = new Synonyms(DEFAULT_SYNONYMS)
const derived = parseDerived(DEFAULT_DERIVED)
const onlyModes = args.modes?.split(',') as FillMode[] | undefined
const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')
const template = (name: string): { id: string; tree: TemplateTree } => {
  const t = JSON.parse(fixture(`templates/${name}.json`))
  return { id: t.id, tree: { docs: t.docs.filter((d: { type: string }) => d.type === 'page'), properties: t.properties } }
}

const models = await listFreeModels()
const model = args.model ?? models[0]?.id
if (!model) throw new Error('No free OpenRouter model is available.')
const engine = new OpenRouterEngine({ apiKey, model, fallbacks: models })
console.log(`Model: ${model}\n`)

const totals = { right: 0, missed: 0, caught: 0, wrong: 0, failed: 0 }
for (let run = 1; run <= Number(args.runs); run++) {
  for (const c of CASES) {
    const clip: Block[] = htmlStringToBlocks(fixture(c.fixture), parser, { baseUrl: 'https://www.dndbeyond.com/' }).blocks
    const { id, tree } = template(c.template)
    for (const mode of c.modes.filter((m) => !onlyModes || onlyModes.includes(m))) {
      const templateNotes = mode === 'labels-ai-write' ? notesFor(c.template.replace(/_/g, ' '), buildSlots(tree), [], synonyms)?.text : undefined
      const base = { tree, templateId: id, clip, title: c.title, site: 'eval', synonyms, rules: [], mode, overrides: {}, derived }
      const first = planFill(base)
      const slots = slotsForAi(first, mode, {})
      const started = Date.now()
      let plan: FillPlan = first
      try {
        const result = await suggest(engine, { slots, clip, blockIndexes: blocksForAi(first, slots, mode, clip.length, synonyms), title: c.title, labels: first.blockLabels, write: mode === 'labels-ai-write' ? { notes: templateNotes } : undefined })
        plan = planFill({ ...base, ai: result.suggestions })
        if (args.verbose) console.log(`${result.job?.prompt}\n\nAnswer: ${result.raw}\n`)
      } catch (error) {
        totals.failed++
        console.log(`✘ ${c.name} (${mode}), run ${run}: the AI failed: ${error instanceof Error ? error.message : String(error)}\n`)
        continue
      }
      const score = { right: 0, missed: 0, caught: 0, wrong: 0 }
      const notes: string[] = []
      for (const [label, expected] of Object.entries(c.expected)) {
        const state = plan.slots.find((s) => s.slot.label === label)
        if (!state) throw new Error(`${c.template} has no field "${label}"`)
        const value = state.text.replace(/\s+/g, ' ').trim()
        // The same words in another case or punctuation are the same value ("Medium, Undead, Neutral Evil").
        const words = (text: string) => comparable(text).replace(/[−–]/g, '-').match(/[\p{L}\p{N}+-]+/gu)?.join(' ') ?? ''
        const matches = expected === null ? false : typeof expected === 'string' ? words(value) === words(expected) : expected.test(state.text)
        const ai = state.origin === 'ai' || state.origin === 'ai-written' || state.origin === 'ai-wrote'
        let verdict: keyof typeof score
        if (state.status === 'filled') verdict = matches ? 'right' : 'wrong'
        // A correct AI value left unticked counts as missed: the checks were too strict there.
        else if (state.status === 'off' && ai) verdict = matches ? 'missed' : 'caught'
        else verdict = expected === null ? 'right' : 'missed'
        score[verdict]++
        if (verdict !== 'right') notes.push(`    ${verdict.toUpperCase().padEnd(6)} ${label}: ${value ? `“${value.slice(0, 70)}”` : '(empty)'}${state.origin ? ` [${state.origin}]` : ''}${state.warning ? ` ⚠ ${state.warning}` : ''}`)
      }
      for (const key of Object.keys(score) as (keyof typeof score)[]) totals[key] += score[key]
      const seconds = ((Date.now() - started) / 1000).toFixed(0)
      console.log(`${score.wrong ? '✘' : '✔'} ${c.name} (${mode}), run ${run}, ${seconds} s: ${score.right} right, ${score.missed} missed, ${score.caught} caught, ${score.wrong} wrong`)
      for (const note of notes) console.log(note)
      console.log()
    }
  }
}
console.log(`Total: ${totals.right} right, ${totals.missed} missed, ${totals.caught} caught by the checks, ${totals.wrong} wrong${totals.failed ? `, ${totals.failed} AI call(s) failed` : ''}.`)
console.log(`Wrong without the checks: ${totals.wrong + totals.caught}.`)
