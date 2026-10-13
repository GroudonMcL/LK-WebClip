import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { extractCandidates, leftoverBlocks, overlaps, type Candidate, type Extraction } from './candidates.js'
import { cleanLabel, compareLabels, LabelMatch, type Synonyms } from './labels.js'
import { blockText, blocksToRuns, buildSlots, withNames, type AnyBlock, type Slot, type SlotFill, type TemplateTree } from './template.js'

/**
 * Decides what goes in each slot of a template: saved rules, then label matching, then the AI's
 * suggestions, then the user's own choices on the review screen, which always win.
 */

export type FillMode = 'labels' | 'ai' | 'labels-ai'

/** "On dndbeyond.com, 'Challenge' goes in 'CR' for the Statblock Template." */
export interface SavedRule {
  site: string
  templateId: string
  templateName: string
  slotKey: string
  slotLabel: string
  candidateKey: string
  candidateLabel: string
}

/** A choice made on the review screen for one slot. */
export interface SlotOverride {
  /** A candidate id, "empty" to leave the slot unfilled, or "typed" to use `text`. */
  choice?: string
  text?: string
  /** Unticked: leave the slot unfilled. Ticked: use the value even if the AI made it up. */
  off?: boolean
  /** Save the choice as a rule for this site. */
  remember?: boolean
}

/** What the AI said about one slot: clip block numbers (0-based, top level) or a short value. */
export interface AiSuggestion {
  blocks: number[]
  value: string
}

export type SlotOrigin = 'rule' | 'label' | 'synonym' | 'similar' | 'ai' | 'ai-written' | 'manual' | 'typed' | 'title'

export interface SlotState {
  slot: Slot
  status: 'filled' | 'empty' | 'ambiguous' | 'off'
  candidate?: Candidate
  origin?: SlotOrigin
  /** The value as plain text, for the review screen. */
  text: string
  /** Every clip value that could go here, best match first. */
  options: Candidate[]
  /** For an ambiguous slot: the equally good candidates. */
  contenders: Candidate[]
}

export interface FillInput {
  tree: TemplateTree
  templateId: string
  clip: Block[]
  title: string
  /** The clipped site's host name, for saved rules. */
  site: string
  synonyms: Synonyms
  rules: SavedRule[]
  mode: FillMode
  /** By slot id. */
  ai?: Map<string, AiSuggestion>
  overrides: Record<string, SlotOverride>
  /** Page names for mentions in the clip (the linker's mentions carry only an id). */
  nameOf?: (resourceId: string) => string | undefined
}

export interface FillPlan {
  slots: SlotState[]
  candidates: Candidate[]
  extraction: Extraction
  /** The clip with everything used in a slot taken out. */
  leftovers: Block[]
  /** Values for fillTree, without the Source heading and unused content (see placeCredit). */
  fills: Map<string, SlotFill>
  /** Top-level clip blocks not used by any slot, for the AI. */
  unusedBlockIndexes: number[]
}

const ORIGIN_OF: Record<LabelMatch, SlotOrigin> = {
  [LabelMatch.Rule]: 'rule',
  [LabelMatch.Exact]: 'label',
  [LabelMatch.Synonym]: 'synonym',
  [LabelMatch.Loose]: 'similar',
  [LabelMatch.Typo]: 'similar',
}

/** Every label the template uses, with synonyms, so the clip can be searched for them. */
export function knownLabels(slots: Slot[], synonyms: Synonyms, rules: SavedRule[]): Set<string> {
  const out = new Set<string>()
  for (const slot of slots) for (const variant of synonyms.variants(slot.key)) if (variant) out.add(variant)
  for (const rule of rules) out.add(rule.candidateKey)
  return out
}

/** Whether a candidate can go in a slot at all. */
export function fits(slot: Slot, candidate: Candidate): boolean {
  if (slot.kind === 'text') return candidate.kind === 'pair' || (candidate.kind === 'section' && candidate.text.length <= 200 && candidate.blocks.length <= 3 && candidate.blocks.every((b) => b.kind === 'paragraph'))
  if (slot.kind === 'rich') return candidate.kind === 'section' || candidate.kind === 'pair'
  if (slot.kind === 'image') return candidate.kind === 'image'
  return false
}

export function planFill(input: FillInput): FillPlan {
  return withNames(input.nameOf, () => plan(input))
}

function plan(input: FillInput): FillPlan {
  const slots = buildSlots(input.tree)
  const siteRules = input.rules.filter((r) => r.site === input.site && r.templateId === input.templateId)
  const extraction = extractCandidates(input.clip, { knownLabels: knownLabels(slots, input.synonyms, siteRules) })
  const aiCandidates = input.ai ? suggestionsToCandidates(input.ai, input.clip) : new Map<string, Candidate>()
  const candidates = [...extraction.candidates, ...aiCandidates.values()]
  const byId = new Map(candidates.map((c) => [c.id, c]))

  const states = new Map<string, SlotState>()
  const used: string[] = []
  const taken = new Set<string>()
  /**
   * What is left of a candidate once other slots have taken parts of the clip. A section gives up
   * the blocks taken elsewhere (its heading must still be free); anything else is all or nothing.
   */
  const available = (c: Candidate): Candidate | undefined => {
    if (taken.has(c.id)) return undefined
    if (!overlaps(c.units, used)) return c
    if (c.kind !== 'section' || c.units.length !== c.blocks.length + 1 || overlaps([c.units[0]!], used)) return undefined
    const keep = c.blocks.map((_, k) => !overlaps([c.units[k + 1]!], used))
    const blocks = c.blocks.filter((_, k) => keep[k])
    if (blocks.length === 0) return undefined
    return { ...c, blocks, units: [c.units[0]!, ...c.units.slice(1).filter((_, k) => keep[k])], text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
  }
  const free = (c: Candidate) => available(c) !== undefined
  const assign = (slot: Slot, original: Candidate, origin: SlotOrigin) => {
    const candidate = available(original) ?? original
    // Show what will be written: a text field gets the whole entry, a row only the value.
    const text = slot.kind === 'rich' ? candidate.blocks.map((b) => blockText(b as AnyBlock)).join('\n') : candidate.text
    states.set(slot.id, { ...states.get(slot.id)!, status: 'filled', candidate, origin, text })
    taken.add(candidate.id)
    used.push(...candidate.units)
  }

  const fillable = slots.filter((s) => s.kind !== 'name' && s.kind !== 'source')
  for (const slot of slots) {
    const options = fillable.includes(slot) ? rankOptions(slot, extraction.candidates, input.synonyms, siteRules) : []
    states.set(slot.id, { slot, status: 'empty', text: '', options, contenders: [] })
  }

  // 1. The user's choices.
  for (const slot of fillable) {
    const override = input.overrides[slot.id]
    if (!override?.choice || override.choice === 'empty') continue
    if (override.choice === 'typed') {
      const text = override.text?.trim() ?? ''
      if (text) states.set(slot.id, { ...states.get(slot.id)!, status: 'filled', origin: 'typed', text, candidate: typedCandidate(slot, text) })
      continue
    }
    const candidate = byId.get(override.choice)
    if (candidate && free(candidate)) assign(slot, candidate, 'manual')
  }

  // 2. Rules and labels, tier by tier. A tie is never guessed.
  if (input.mode !== 'ai') {
    for (const tier of [LabelMatch.Rule, LabelMatch.Exact, LabelMatch.Synonym, LabelMatch.Loose, LabelMatch.Typo]) {
      const open = fillable.filter((s) => states.get(s.id)!.status === 'empty' && !input.overrides[s.id]?.choice)
      const edges: { slot: Slot; candidate: Candidate }[] = []
      for (const slot of open) {
        for (const candidate of extraction.candidates) {
          if (!free(candidate) || !fits(slot, candidate)) continue
          if (matchTier(slot, candidate, input.synonyms, siteRules) === tier) edges.push({ slot, candidate })
        }
      }
      for (const slot of open) {
        const mine = edges.filter((e) => e.slot === slot)
        if (mine.length === 0) continue
        // Prefer a pair for a row and a section for a field when both kinds share the label.
        const preferred = mine.filter((e) => (slot.kind === 'text' ? e.candidate.kind === 'pair' : slot.kind === 'rich' ? e.candidate.kind === 'section' : true))
        const pool = preferred.length > 0 ? preferred : mine
        const distinct = pool.filter((e, i) => pool.findIndex((o) => o.candidate.key === e.candidate.key && o.candidate.text === e.candidate.text) === i)
        // The same candidate fitting another slot equally well is also a tie.
        const shared = distinct.length === 1 && edges.some((e) => e.slot !== slot && e.candidate === distinct[0]!.candidate && !input.overrides[e.slot.id]?.choice)
        if (distinct.length > 1 || shared) {
          states.set(slot.id, { ...states.get(slot.id)!, status: 'ambiguous', contenders: distinct.map((e) => e.candidate) })
          continue
        }
        if (free(distinct[0]!.candidate)) assign(slot, distinct[0]!.candidate, ORIGIN_OF[tier])
      }
    }
    // Images have no labels worth matching: the clip's images go into image slots in order.
    for (const slot of fillable.filter((s) => s.kind === 'image' && states.get(s.id)!.status === 'empty' && !input.overrides[s.id]?.choice)) {
      const image = extraction.candidates.find((c) => c.kind === 'image' && free(c) && !/\.svg(\?|$)/i.test(String((c.blocks[0] as AnyBlock).url)))
      if (image) assign(slot, image, 'label')
    }
  }

  // 3. The AI, for what is still empty. It never overrides a label or a choice.
  if (input.mode !== 'labels' && input.ai) {
    for (const slot of fillable) {
      const state = states.get(slot.id)!
      if (state.status !== 'empty' || input.overrides[slot.id]?.choice) continue
      const candidate = aiCandidates.get(slot.id)
      if (!candidate || !free(candidate) || !aiFits(slot, candidate)) continue
      // A section answered with typed-out text rather than block numbers is not trusted either.
      const verified = !candidate.id.endsWith(':written') && !(slot.kind === 'rich' && candidate.units.length === 0)
      assign(slot, candidate, verified ? 'ai' : 'ai-written')
      states.get(slot.id)!.options.unshift(candidate)
    }
  }

  // 4. Ticks. An AI-written value needs an explicit tick.
  for (const slot of fillable) {
    const state = states.get(slot.id)!
    if (state.status !== 'filled') continue
    const off = input.overrides[slot.id]?.off ?? state.origin === 'ai-written'
    if (off) {
      state.status = 'off'
      if (state.candidate) {
        taken.delete(state.candidate.id)
        for (const unit of state.candidate.units) used.splice(used.indexOf(unit), 1)
      }
    }
  }

  // Name slots take the page name.
  for (const slot of slots.filter((s) => s.kind === 'name')) {
    states.set(slot.id, { ...states.get(slot.id)!, status: 'filled', origin: 'title', text: input.title })
  }

  const fills = new Map<string, SlotFill>()
  for (const state of states.values()) {
    if (state.status !== 'filled') continue
    if (state.slot.kind === 'name') fills.set(state.slot.id, { runs: [{ text: input.title }] })
    else if (state.candidate) fills.set(state.slot.id, valueFor(state.slot, state.candidate))
  }

  // A line that is just the page's name (a stat block's title) would only repeat it.
  const title = comparable(input.title)
  if (title) input.clip.forEach((block, i) => {
    if (block.kind === 'paragraph' && comparable(blockText(block as AnyBlock)) === title && !overlaps([`b${i}`], used)) used.push(`b${i}`)
  })
  const leftovers = leftoverBlocks(input.clip, extraction, used)
  const unusedBlockIndexes = input.clip.map((_, i) => i).filter((i) => !used.some((u) => u === `b${i}` || u.startsWith(`b${i}.`)))
  return { slots: slots.map((s) => states.get(s.id)!), candidates, extraction, leftovers, fills, unusedBlockIndexes }
}

function matchTier(slot: Slot, candidate: Candidate, synonyms: Synonyms, rules: SavedRule[]): LabelMatch | undefined {
  if (rules.some((r) => r.slotKey === slot.key && r.candidateKey === candidate.key)) return LabelMatch.Rule
  if (slot.kind === 'image') return undefined
  return compareLabels(slot.key, candidate.key, synonyms)
}

function rankOptions(slot: Slot, candidates: Candidate[], synonyms: Synonyms, rules: SavedRule[]): Candidate[] {
  return candidates
    .filter((c) => fits(slot, c))
    .map((c, i) => ({ c, tier: matchTier(slot, c, synonyms, rules) ?? 9, i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.c)
}

function typedCandidate(slot: Slot, text: string): Candidate {
  const runs: Run[] = [{ text }]
  return { id: `typed:${slot.id}`, label: slot.label, key: slot.key, kind: 'pair', runs, blocks: text.split(/\n+/).map((line) => ({ kind: 'paragraph', content: [{ text: line }] })), text, units: [] }
}

function valueFor(slot: Slot, candidate: Candidate): SlotFill {
  if (slot.kind === 'image') {
    const image = candidate.blocks[0] as AnyBlock
    return { image: { url: String(image.url), ...(image.alt ? { alt: String(image.alt) } : {}) } }
  }
  if (slot.kind === 'text') return { runs: candidate.runs ?? blocksToRuns(candidate.blocks) }
  return { blocks: candidate.blocks }
}

function aiFits(slot: Slot, candidate: Candidate): boolean {
  if (slot.kind === 'image') return candidate.kind === 'image'
  return candidate.kind !== 'image'
}

/** Clip text cleaned for checking that the AI copied a value rather than writing one. */
export function comparable(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Turns the AI's answer into candidates. Block numbers become those blocks, so formatting, links
 * and images survive. A short value must appear in the clip; if it doesn't, it is marked as written
 * by the AI (the id ends in ":written") and needs a tick.
 */
export function suggestionsToCandidates(ai: Map<string, AiSuggestion>, clip: Block[]): Map<string, Candidate> {
  const out = new Map<string, Candidate>()
  const clipText = comparable(clip.map((b) => blockText(b as AnyBlock)).join('\n'))
  for (const [slotId, suggestion] of ai) {
    const numbers = [...new Set(suggestion.blocks)].filter((n) => Number.isInteger(n) && n >= 0 && n < clip.length).sort((a, b) => a - b)
    if (numbers.length > 0) {
      const blocks = numbers.map((n) => clip[n]!)
      const allImages = blocks.every((b) => b.kind === 'image')
      out.set(slotId, {
        id: `ai:${slotId}`,
        label: 'AI',
        key: '',
        kind: allImages ? 'image' : 'section',
        blocks,
        runs: allImages ? undefined : blocksToRuns(blocks),
        text: blocks.map((b) => blockText(b as AnyBlock)).join('\n'),
        units: numbers.map((n) => `b${n}`),
      })
      continue
    }
    const value = suggestion.value.trim()
    if (!value) continue
    const verified = clipText.includes(comparable(value))
    // A value that is a whole block of the clip uses that block, so it isn't repeated at the end.
    const whole = clip.findIndex((b) => comparable(blockText(b as AnyBlock)) === comparable(value))
    out.set(slotId, {
      id: verified ? `ai:${slotId}` : `ai:${slotId}:written`,
      label: 'AI',
      key: '',
      kind: 'pair',
      runs: whole >= 0 && Array.isArray((clip[whole] as AnyBlock).content) ? ((clip[whole] as AnyBlock).content as Run[]) : [{ text: value }],
      blocks: whole >= 0 ? [clip[whole]!] : [{ kind: 'paragraph', content: [{ text: value }] }],
      text: value,
      units: whole >= 0 ? [`b${whole}`] : [],
    })
  }
  return out
}

/** Rules to save from the review screen: manual choices the user asked to remember. */
export function rulesFromChoices(plan: FillPlan, overrides: Record<string, SlotOverride>, context: { site: string; templateId: string; templateName: string }): SavedRule[] {
  const out: SavedRule[] = []
  for (const state of plan.slots) {
    const override = overrides[state.slot.id]
    if (!override?.remember || state.origin !== 'manual' || !state.candidate?.key || !state.slot.key) continue
    out.push({ ...context, slotKey: state.slot.key, slotLabel: state.slot.label, candidateKey: state.candidate.key, candidateLabel: state.candidate.label })
  }
  return out
}

/** Adds rules, replacing any for the same site, template and slot. */
export function mergeRules(existing: SavedRule[], added: SavedRule[]): SavedRule[] {
  const key = (r: SavedRule) => `${r.site}|${r.templateId}|${r.slotKey}`
  const replaced = new Set(added.map(key))
  return [...existing.filter((r) => !replaced.has(key(r))), ...added]
}

export { cleanLabel }
