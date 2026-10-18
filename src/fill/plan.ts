import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { extractCandidates, goneBlocks, leftoverBlocks, overlaps, type Candidate, type Extraction } from './candidates.js'
import { isWritable } from './ai.js'
import { applyDerived, completes, type DerivedRule } from './derived.js'
import { cleanLabel, compareLabels, LabelMatch, namedMatch, type Synonyms } from './labels.js'
import { blockText, blocksToRuns, buildSlots, mentionsIn, runsText, SIDEBAR, withNames, type AnyBlock, type Slot, type SlotFill, type TemplateTree } from './template.js'

/**
 * Decides what goes in each slot of a template: saved rules, then label matching, then the AI's
 * suggestions, then the user's own choices on the review screen, which always win.
 */

/**
 * - labels: label matching only, no AI.
 * - ai: the AI fills every field, by picking parts of the clip.
 * - labels-ai: labels first, then the AI picks parts of the clip for what is left.
 * - labels-ai-write: labels first, then the AI, which may also write short fields in the
 *   template's style from the clip's facts, guided by notes about the template.
 */
export type FillMode = 'labels' | 'ai' | 'labels-ai' | 'labels-ai-write'

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

/** What the AI said about one slot: clip block numbers (0-based, top level), a short copied value, or both. */
export interface AiSuggestion {
  blocks: number[]
  value: string
}

/** "ai-written": the AI made up a value where it should have copied. "ai-wrote": it wrote one where it may. */
export type SlotOrigin = 'rule' | 'label' | 'synonym' | 'similar' | 'ai' | 'ai-written' | 'ai-wrote' | 'derived' | 'manual' | 'typed' | 'title'

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
  /**
   * Why an AI suggestion was left unticked: it disagrees with the clip's own structure ("The clip
   * labels this “Saving Throws”, not “Legendary Actions”").
   */
  warning?: string
  /** Where a worked-out value came from ("From Dexterity: 16 (+3)"). */
  note?: string
  /**
   * Every part of the clip a filled slot uses (see Candidate.units), including parts dropped with
   * its value (a table's caption) and table rows added to its list. The mapper uses it to keep the
   * slots you don't touch exactly as they are.
   */
  units?: string[]
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
  /** Fields worked out from other fields when nothing fills them (Initiative from Dexterity). */
  derived?: DerivedRule[]
  /** The template's name: "Class Template" makes "[Class]" in its headings stand for the page's name. */
  templateName?: string
  /** The notes the AI was given, so a value copied from them rather than the clip is caught. */
  notes?: string
  /** Add a clip table's other rows to a template list it filled (default true). */
  extraRows?: boolean
}

/** What the clip itself says about a top-level block: the labels in it and the heading it is under. */
export interface BlockLabels {
  /** Field labels in the block ("Saving Throws"), not entry names ("Multiattack."). */
  labels: string[]
  /** The nearest heading or label line the block is under ("Traits"), apart from the page name. */
  under?: string
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
  /** By top-level block index, for the AI's prompt and for checking its answer. */
  blockLabels: Map<number, BlockLabels>
  /** Blocks that only repeat the page's name, which no field takes. */
  titleBlocks: number[]
  /** "[Class]" in the template's headings, to be written as the page's name ("Core [Class] Traits" → "Core Bard Traits"). */
  subject?: { placeholder: string; name: string }
  /** Rows of a clip table added to a template list it filled, because the template has no row for them ("Tool Proficiencies"). */
  extraRows: { label: string; text: string; slotId: string; unit: string }[]
}

const ORIGIN_OF: Record<LabelMatch, SlotOrigin> = {
  [LabelMatch.Rule]: 'rule',
  [LabelMatch.Exact]: 'label',
  [LabelMatch.Synonym]: 'synonym',
  [LabelMatch.Loose]: 'similar',
  [LabelMatch.Typo]: 'similar',
  [LabelMatch.Named]: 'similar',
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
  if (slot.kind === 'links') return candidate.kind !== 'image' && mentionsIn(candidate.runs ?? candidate.blocks).length > 0
  return false
}

export function planFill(input: FillInput): FillPlan {
  return withNames(input.nameOf, () => plan(input))
}

function plan(input: FillInput): FillPlan {
  const slots = buildSlots(input.tree)
  const siteRules = input.rules.filter((r) => r.site === input.site && r.templateId === input.templateId)
  const extraction = extractCandidates(input.clip, { knownLabels: knownLabels(slots, input.synonyms, siteRules), vocabulary: input.synonyms.labels() })
  const titleKey = comparable(input.title)
  const blockLabels = labelBlocks(input.clip, extraction, cleanLabel(input.title))
  const writable = new Set(input.mode === 'labels-ai-write' ? slots.filter(isWritable).map((s) => s.id) : [])
  const aiCandidates = input.ai ? suggestionsToCandidates(input.ai, input.clip, input.title, writable) : new Map<string, Candidate[]>()
  // Only the clip states facts. The notes' examples are not facts: a small model copies them.
  const clipText = input.clip.map((b) => blockText(b as AnyBlock)).join('\n')
  const clipFacts = facts(clipText)
  const tables = tableCandidates(input.clip, extraction)
  const candidates = [...extraction.candidates, ...tables, ...[...aiCandidates.values()].flat()]
  const byId = new Map(candidates.map((c) => [c.id, c]))

  const states = new Map<string, SlotState>()
  const used: string[] = []
  /** The parts of the clip each slot uses, kept alongside `used`. */
  const slotUnits = new Map<string, string[]>()
  const taken = new Set<string>()
  /**
   * The blocks under a section's heading, by the slot holding them. A field matched by label to a
   * part of that section takes the part over: "Bard Class Details" holds everything under it until
   * "As a Level 1 Bard", the level table and "Bard Class Features" go to fields of their own.
   */
  const softOwner = new Map<string, string>()
  const isSection = (c: Candidate) => c.kind === 'section' && c.units.length === c.blocks.length + 1
  /** Whether `c` lies wholly inside the section held by `owner`, so it may take its part over. */
  const nestedIn = (c: Candidate, owner: string) => {
    const held = states.get(owner)?.candidate?.units ?? []
    return c.units.length > 0 && c.units.every((u) => overlaps([u], held))
  }
  const blocking = (c: Candidate, takeOver: boolean) => used.filter((u) => !(takeOver && softOwner.has(u) && nestedIn(c, softOwner.get(u)!)))
  /**
   * What is left of a candidate once other slots have taken parts of the clip. A section gives up
   * the blocks taken elsewhere (its heading must still be free); anything else is all or nothing.
   * With `takeOver`, a part of another slot's section is not in the way (label matching only).
   */
  const available = (c: Candidate, takeOver = false): Candidate | undefined => {
    if (taken.has(c.id)) return undefined
    const inTheWay = blocking(c, takeOver)
    if (!overlaps(c.units, inTheWay)) return c
    if (!isSection(c) || overlaps([c.units[0]!], inTheWay)) return undefined
    const keep = c.blocks.map((_, k) => !overlaps([c.units[k + 1]!], inTheWay))
    const blocks = c.blocks.filter((_, k) => keep[k])
    if (blocks.length === 0) return undefined
    return { ...c, blocks, units: [c.units[0]!, ...c.units.slice(1).filter((_, k) => keep[k])], text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
  }
  const free = (c: Candidate, takeOver = false) => available(c, takeOver) !== undefined
  /** Takes `units` out of the sections other slots hold; a section left with nothing is emptied. */
  const takeFromSections = (units: string[], by: string) => {
    const lost = new Map<string, Set<string>>()
    for (const [unit, owner] of softOwner) {
      if (owner === by || !overlaps([unit], units)) continue
      if (!lost.has(owner)) lost.set(owner, new Set())
      lost.get(owner)!.add(unit)
    }
    for (const [owner, gone] of lost) {
      const state = states.get(owner)!
      const c = state.candidate!
      for (const unit of gone) {
        softOwner.delete(unit)
        used.splice(used.indexOf(unit), 1)
      }
      slotUnits.set(owner, (slotUnits.get(owner) ?? []).filter((u) => !gone.has(u)))
      const keep = c.blocks.map((_, k) => !gone.has(c.units[k + 1]!))
      const blocks = c.blocks.filter((_, k) => keep[k])
      if (blocks.length === 0) {
        used.splice(used.indexOf(c.units[0]!), 1)
        slotUnits.delete(owner)
        taken.delete(c.id)
        states.set(owner, { ...state, status: 'empty', candidate: undefined, origin: undefined, text: '' })
        continue
      }
      const rest = { ...c, blocks, units: [c.units[0]!, ...c.units.slice(1).filter((_, k) => keep[k])], text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
      states.set(owner, { ...state, candidate: rest, text: state.slot.kind === 'rich' ? rest.text : state.text })
    }
  }
  /**
   * A written value may reformat a line of the clip but not leave part of it out: when every word
   * of it comes from one short unused line, and that line has more ("Medium Humanoid, Any Non-Good
   * Alignment" from "Medium Humanoid (Any Race), Any Non-Good Alignment"), the clip's line is used.
   */
  const unshortened = (c: Candidate): Candidate => {
    if (!c.id.endsWith(':wrote')) return c
    const words = wordsOf(c.text)
    if (words.size === 0) return c
    for (const [i, block] of input.clip.entries()) {
      if (block.kind !== 'paragraph' || overlaps([`b${i}`], used) || (blockLabels.get(i)?.labels.length ?? 0) > 0) continue
      const line = blockText(block as AnyBlock)
      if (line.length > 200) continue
      const lineWords = wordsOf(line)
      if ([...words].every((w) => lineWords.has(w)) && [...lineWords].some((w) => !words.has(w))) {
        return { ...c, id: c.id.replace(/:wrote$/, ':value'), blocks: [block], runs: (block as AnyBlock).content as Run[], text: line, units: [`b${i}`], found: [i] }
      }
    }
    return c
  }

  /**
   * The AI decides where content goes; the clip's own labels decide what the value is. When the
   * AI picks a labelled line or a section for a field with that label ("Armor Class 15 (studded
   * leather)" for Armour Class, or "Traits" and its entries for Traits), the field gets the value
   * without its label, exactly as label matching would have given it.
   */
  const snapped = (slot: Slot, c: Candidate): Candidate => {
    if (c.units.length === 0 || c.kind === 'image') return c
    const chosen = new Set(c.units.map(blockOf))
    const inChosen = (e: Candidate) => e.units.filter((u) => chosen.has(blockOf(u))).length
    const preferred = slot.kind === 'text' ? 'pair' : 'section'
    const best = extraction.candidates
      .filter((e) => (e.kind === 'pair' || e.kind === 'section') && !e.entry && fits(slot, e) && free(e) && inChosen(e) > 0 && compareLabels(slot.key, e.key, input.synonyms) !== undefined)
      .sort((a, b) => Number(b.kind === preferred) - Number(a.kind === preferred) || inChosen(b) - inChosen(a))[0]
    if (!best) return c
    if (best.kind !== 'section' || best.units.length !== best.blocks.length + 1) return { ...best, id: c.id, label: 'AI', found: undefined }
    // Only the entries the AI picked: snapping takes the heading off, it never adds to the answer.
    const keep = best.blocks.map((_, k) => chosen.has(blockOf(best.units[k + 1]!)))
    const blocks = best.blocks.filter((_, k) => keep[k])
    if (blocks.length === 0) return c
    return { ...best, id: c.id, label: 'AI', blocks, units: [best.units[0]!, ...best.units.slice(1).filter((_, k) => keep[k])], text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
  }
  /**
   * A value the AI copied may appear in several blocks ("10 (+0)" for both CON and INT): use one
   * that is still free, the one the clip labels for this field first.
   */
  const copiedFrom = (slot: Slot, c: Candidate): Candidate => {
    if (!c.found || c.units.length === 0) return c
    const fitsSlot = (i: number) => (blockLabels.get(i)?.labels ?? []).some((label) => compareLabels(slot.key, cleanLabel(label), input.synonyms) !== undefined)
    const whole = c.found.filter((i) => comparable(blockText(input.clip[i] as AnyBlock)) === comparable(c.text)).sort((a, b) => Number(fitsSlot(b)) - Number(fitsSlot(a)))
    const pick = whole.find((i) => !overlaps([`b${i}`], used))
    if (pick === undefined) return c
    const block = input.clip[pick]!
    return { ...c, units: [`b${pick}`], blocks: [block], runs: Array.isArray((block as AnyBlock).content) ? ((block as AnyBlock).content as Run[]) : c.runs }
  }
  const assign = (slot: Slot, original: Candidate, origin: SlotOrigin, takeOver = false) => {
    const candidate = available(original, takeOver) ?? original
    if (takeOver) takeFromSections(candidate.units, slot.id)
    // Show what will be written: a text field gets the whole entry, a row only the value.
    const text = slot.kind === 'rich' ? candidate.blocks.map((b) => blockText(b as AnyBlock)).join('\n') : candidate.text
    states.set(slot.id, { ...states.get(slot.id)!, status: 'filled', candidate, origin, text })
    taken.add(candidate.id)
    used.push(...candidate.units)
    slotUnits.set(slot.id, [...candidate.units])
    if (isSection(candidate)) for (const unit of candidate.units.slice(1)) softOwner.set(unit, slot.id)
  }

  const fillable = slots.filter((s) => s.kind !== 'name' && s.kind !== 'source')
  for (const slot of slots) {
    const options = fillable.includes(slot) ? rankOptions(slot, slot.table ? [...tables, ...extraction.candidates] : extraction.candidates, input.synonyms, siteRules, input.title) : []
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
    for (const tier of [LabelMatch.Rule, LabelMatch.Exact, LabelMatch.Synonym, LabelMatch.Loose, LabelMatch.Typo, LabelMatch.Named]) {
      const open = fillable.filter((s) => states.get(s.id)!.status === 'empty' && !input.overrides[s.id]?.choice)
      const edges: { slot: Slot; candidate: Candidate }[] = []
      for (const slot of open) {
        for (const candidate of extraction.candidates) {
          if (!free(candidate, true) || !fits(slot, candidate)) continue
          if (matchTier(slot, candidate, input.synonyms, siteRules, input.title) === tier) edges.push({ slot, candidate })
        }
      }
      // Smaller parts first, so a section nested in a bigger one goes to its own field.
      const size = (slot: Slot) => Math.min(...edges.filter((e) => e.slot === slot).map((e) => e.candidate.blocks.length))
      for (const slot of [...open].sort((a, b) => size(a) - size(b))) {
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
        if (free(distinct[0]!.candidate, true)) assign(slot, distinct[0]!.candidate, ORIGIN_OF[tier], true)
      }
    }
    // A table in the template (a class's level table) takes the clip table with its column headings.
    for (const slot of fillable) {
      if (!slot.table || states.get(slot.id)!.status !== 'empty' || input.overrides[slot.id]?.choice) continue
      const match = bestTable(slot.table, tables, input.clip)
      if (!match || !free(match.candidate, true)) continue
      assign(slot, match.candidate, 'similar', true)
      states.get(slot.id)!.note = `Its columns match the template’s table: ${match.columns.join(', ')}.`
    }
    // Images have no labels worth matching: the clip's images go into image slots in order.
    for (const slot of fillable.filter((s) => s.kind === 'image' && states.get(s.id)!.status === 'empty' && !input.overrides[s.id]?.choice)) {
      const image = extraction.candidates.find((c) => c.kind === 'image' && free(c) && !/\.svg(\?|$)/i.test(String((c.blocks[0] as AnyBlock).url)))
      if (image) assign(slot, image, 'label')
    }
  }

  // 3. The AI, for what is still empty. It never overrides a label or a choice, and an answer that
  //    disagrees with the clip's own labels and headings is shown unticked, with the reason.
  if (input.mode !== 'labels' && input.ai) {
    for (const slot of fillable) {
      if (states.get(slot.id)!.status !== 'empty' || input.overrides[slot.id]?.choice) continue
      // The model may answer with block numbers and a copied value; when they disagree, the one the
      // clip agrees with wins ("[10]" is the CON label, "16 (+3)" is Dexterity's value).
      let pick: { candidate: Candidate; verified: boolean; warning?: string } | undefined
      for (const suggested of aiCandidates.get(slot.id) ?? []) {
        const candidate = snapped(slot, copiedFrom(slot, unshortened(suggested)))
        if (!free(candidate) || !aiFits(slot, candidate)) continue
        // A section answered with typed-out text rather than block numbers is not trusted either.
        const wrote = candidate.id.endsWith(':wrote')
        const verified = wrote || (!candidate.id.endsWith(':written') && !(slot.kind === 'rich' && candidate.units.length === 0))
        const ownWords = facts(`${slot.label} ${slot.placeholder}`)
        const warning = !verified ? undefined : (wrote ? checkWritten(candidate.text, clipFacts, ownWords) ?? fromNotes(candidate.text, input.notes, clipText) : undefined) ?? aiWarning(slot, candidate, { blockLabels, synonyms: input.synonyms, rules: siteRules, slots: fillable, title: input.title })
        if (!pick || (verified && !warning && (!pick.verified || pick.warning))) pick = { candidate, verified, warning }
      }
      if (!pick) continue
      assign(slot, pick.candidate, pick.candidate.id.endsWith(':wrote') ? 'ai-wrote' : pick.verified ? 'ai' : 'ai-written')
      const state = states.get(slot.id)!
      state.options.unshift(pick.candidate)
      state.warning = pick.warning
    }
  }

  // 4. Ticks. An AI-written value, or one that disagrees with the clip, needs an explicit tick.
  for (const slot of fillable) {
    const state = states.get(slot.id)!
    if (state.status !== 'filled') continue
    const off = input.overrides[slot.id]?.off ?? (state.origin === 'ai-written' || state.warning !== undefined)
    if (off) {
      state.status = 'off'
      slotUnits.delete(slot.id)
      if (state.candidate) {
        taken.delete(state.candidate.id)
        for (const unit of state.candidate.units) {
          used.splice(used.indexOf(unit), 1)
          if (softOwner.get(unit) === slot.id) softOwner.delete(unit)
        }
      }
    }
  }

  // 5. Worked-out fields, for what is still empty: Initiative from Dexterity's modifier. A value the
  // clip states is completed when it is only the start of the worked-out one ("+3" → "+3 (13)").
  for (const rule of input.derived ?? []) {
    const targetKey = cleanLabel(rule.target)
    const sources: SlotState[] = []
    const value = applyDerived(rule, (name) => {
      const key = cleanLabel(name)
      const source = fillable.map((s) => states.get(s.id)!).find((s) => s.status === 'filled' && s.slot.key !== targetKey && compareLabels(s.slot.key, key, input.synonyms) !== undefined)
      if (source && !sources.includes(source)) sources.push(source)
      return source?.text
    })
    if (!value || sources.length === 0) continue
    const from = sources.map((s) => s.slot.label).join(' and ')
    for (const slot of fillable) {
      const state = states.get(slot.id)!
      if (slot.kind !== 'text' || input.overrides[slot.id]?.choice || compareLabels(slot.key, targetKey, input.synonyms) === undefined) continue
      // An AI answer left unticked (made up, or at odds with the clip) gives way to a worked-out value.
      const open = state.status === 'empty' || (state.status === 'off' && (state.origin === 'ai-written' || state.origin === 'ai-wrote' || state.warning !== undefined) && input.overrides[slot.id]?.off === undefined)
      const completing = state.status === 'filled' && completes(state.text, value)
      if (!open && !completing) continue
      const candidate = { ...typedCandidate(slot, value), id: `derived:${slot.id}`, label: `From ${from}` }
      const off = input.overrides[slot.id]?.off === true
      // A completed value keeps the clip's line in use: the worked-out value includes it.
      const note = completing ? `The clip gives “${state.text}”; completed from ${sources.map((s) => `${s.slot.label}: ${s.text}`).join(', ')}` : `From ${sources.map((s) => `${s.slot.label}: ${s.text}`).join(', ')}`
      states.set(slot.id, { ...state, status: off ? 'off' : 'filled', origin: 'derived', text: value, candidate, warning: undefined, note })
      state.options.unshift(candidate)
    }
  }

  // Name slots take the page name.
  for (const slot of slots.filter((s) => s.kind === 'name')) {
    states.set(slot.id, { ...states.get(slot.id)!, status: 'filled', origin: 'title', text: input.title })
  }

  // A section that gave parts to other fields drops what only went with them: a table's caption
  // ("Bard Features") and a heading everything under which went elsewhere ("Becoming a Bard…").
  for (const state of states.values()) {
    const c = state.candidate
    if (state.status !== 'filled' || !c || !isSection(c) || c.units.length < 2 || !c.units.every((u) => /^b\d+$/.test(u))) continue
    const held = new Set(c.units.slice(1).map((u) => blockOf(u)!))
    const missing = new Set(input.clip.map((_, i) => i).filter((i) => !held.has(i)))
    const gone = goneBlocks(input.clip, extraction, new Set([...missing].map((i) => `b${i}`)))
    const keep = c.units.slice(1).map((u) => !gone.has(blockOf(u)!))
    if (keep.every(Boolean) || !keep.some(Boolean)) continue
    const blocks = c.blocks.filter((_, k) => keep[k])
    // The dropped blocks stay used: they belong with what was taken.
    state.candidate = { ...c, blocks, units: [c.units[0]!, ...c.units.slice(1).filter((_, k) => keep[k])], text: blocks.map((b) => blockText(b as AnyBlock)).join('\n') }
    if (state.slot.kind === 'rich') state.text = state.candidate.text
  }

  // A clip table that filled rows of a template list adds the rows the list doesn't have
  // ("Tool Proficiencies" for a class whose template has no row for it), at the end of the list.
  const extraRows: FillPlan['extraRows'] = []
  const extraFor = new Map<string, { key: string; content: Run[] }[]>()
  if (input.extraRows !== false) {
    const lists = new Map<string, SlotState[]>()
    for (const state of states.values()) {
      if (state.slot.target.type !== 'row' || state.slot.doc === SIDEBAR || state.status !== 'filled' || !state.candidate) continue
      const key = `${state.slot.doc}:${state.slot.target.at.join('.')}`
      lists.set(key, [...(lists.get(key) ?? []), state])
    }
    for (const rows of lists.values()) {
      const fromTables = new Map<number, number>()
      for (const state of rows) for (const unit of state.candidate!.units) {
        const row = /^b(\d+)\.r\d+$/.exec(unit)
        if (row) fromTables.set(Number(row[1]), (fromTables.get(Number(row[1])) ?? 0) + 1)
      }
      const added: { key: string; content: Run[] }[] = []
      for (const [table, count] of fromTables) {
        if (count < 2) continue
        for (const c of extraction.candidates) {
          if (c.kind !== 'pair' || c.units.length !== 1 || !c.units[0]!.startsWith(`b${table}.r`) || overlaps(c.units, used) || !c.runs) continue
          if (rows.some((r) => r.slot.key === c.key) || c.key === titleKey) continue
          added.push({ key: c.label, content: c.runs })
          extraRows.push({ label: c.label, text: c.text, slotId: rows.at(-1)!.slot.id, unit: c.units[0]! })
          used.push(c.units[0]!)
          slotUnits.get(rows.at(-1)!.slot.id)?.push(c.units[0]!)
        }
      }
      if (added.length > 0) extraFor.set(rows.at(-1)!.slot.id, added)
    }
  }

  const fills = new Map<string, SlotFill>()
  for (const state of states.values()) {
    if (state.status !== 'filled') continue
    state.units = slotUnits.get(state.slot.id) ?? []
    if (state.slot.kind === 'name') fills.set(state.slot.id, { runs: [{ text: input.title }] })
    else if (state.candidate) {
      const fill = valueFor(state.slot, state.candidate)
      const extra = extraFor.get(state.slot.id)
      fills.set(state.slot.id, extra && 'runs' in fill ? { ...fill, extraRows: extra } : fill)
    }
  }

  // A line or heading that is just the page's name (a stat block's title) would only repeat it.
  const titleBlocks = titleKey
    ? input.clip.map((block, i) => ((block.kind === 'paragraph' || block.kind === 'heading') && comparable(blockText(block as AnyBlock)) === titleKey ? i : -1)).filter((i) => i >= 0)
    : []
  for (const i of titleBlocks) if (!overlaps([`b${i}`], used)) used.push(`b${i}`)
  const leftovers = leftoverBlocks(input.clip, extraction, used)
  const unusedBlockIndexes = input.clip.map((_, i) => i).filter((i) => !used.some((u) => u === `b${i}` || u.startsWith(`b${i}.`)))
  const subjectName = input.templateName?.replace(/\s*template\s*$/i, '').trim()
  const subject = subjectName ? { placeholder: subjectName, name: input.title } : undefined
  return { slots: slots.map((s) => states.get(s.id)!), candidates, extraction, leftovers, fills, unusedBlockIndexes, blockLabels, titleBlocks, subject, extraRows }
}

/** Every top-level table in the clip, whole, with its caption as its heading when it has one. */
function tableCandidates(clip: Block[], extraction: Extraction): Candidate[] {
  const out: Candidate[] = []
  clip.forEach((block, t) => {
    if (block.kind !== 'table') return
    const caption = [...extraction.captions].find(([, table]) => table === t)?.[0]
    const label = caption !== undefined ? blockText(clip[caption] as AnyBlock).trim() : 'Table'
    out.push({ id: `table:b${t}`, label, key: cleanLabel(label), kind: caption !== undefined ? 'section' : 'pair', blocks: [block], text: blockText(block as AnyBlock), units: caption !== undefined ? [`b${caption}`, `b${t}`] : [`b${t}`] })
  })
  return out
}

/**
 * The clip table whose column headings best match a template table's: at least two of them, and a
 * third of the template's. Rows above the matching heading row (a spanning "Spell Slots per Spell
 * Level" row) are left out, so the table starts as the template's does.
 */
function bestTable(headers: string[], tables: Candidate[], clip: Block[]): { candidate: Candidate; columns: string[] } | undefined {
  const want = headers.map(cleanLabel)
  let best: { candidate: Candidate; columns: string[]; row: number } | undefined
  for (const candidate of tables) {
    const table = clip[blockOf(candidate.units.at(-1)!)!] as AnyBlock
    const rows = (table.children ?? []) as AnyBlock[]
    rows.slice(0, 3).forEach((row, r) => {
      const cells = ((row.children ?? []) as AnyBlock[]).map((cell) => cleanLabel(blockText(cell)))
      const columns = headers.filter((_, k) => cells.includes(want[k]!))
      if (columns.length > (best?.columns.length ?? 0)) best = { candidate, columns, row: r }
    })
  }
  if (!best || best.columns.length < 2 || best.columns.length < want.length / 3) return undefined
  if (best.row === 0) return best
  const table = best.candidate.blocks[0] as AnyBlock
  const trimmed = { ...table, children: (table.children as AnyBlock[]).slice(best.row) } as Block
  return { ...best, candidate: { ...best.candidate, blocks: [trimmed], text: blockText(trimmed as AnyBlock) } }
}

/**
 * A written value that repeats a run of five words from the template's notes the clip doesn't have
 * came from the notes, which describe the template, not this clip.
 */
function fromNotes(value: string, notes: string | undefined, clipText: string): string | undefined {
  if (!notes) return undefined
  const words = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []
  const said = words(value)
  const inNotes = ` ${words(notes).join(' ')} `
  const inClip = ` ${words(clipText).join(' ')} `
  for (let i = 0; i + 5 <= said.length; i++) {
    const run = ` ${said.slice(i, i + 5).join(' ')} `
    if (inNotes.includes(run) && !inClip.includes(run)) return 'This is from the template’s AI notes, not the clip.'
  }
  return undefined
}

/**
 * The clip blocks to show the AI: the unused ones (all of them in "AI" mode), apart from blocks
 * labelled for something none of the asked fields could be. Those could only be wrong answers
 * ("Saving Throws DEX +6" when no field is about saving throws), and a small model does better
 * with fewer distractions.
 */
export function blocksForAi(plan: FillPlan, slots: Slot[], mode: FillMode, clipLength: number, synonyms: Synonyms): number[] {
  const indexes = mode === 'ai' ? Array.from({ length: clipLength }, (_, i) => i).filter((i) => !plan.titleBlocks.includes(i)) : plan.unusedBlockIndexes
  return indexes.filter((i) => {
    const labels = plan.blockLabels.get(i)?.labels ?? []
    return labels.length === 0 || labels.some((label) => slots.some((slot) => compareLabels(slot.key, cleanLabel(label), synonyms) !== undefined))
  })
}

/** The top-level block a unit belongs to ("b3.s0" → 3). */
function blockOf(unit: string): number | undefined {
  const match = /^b(\d+)(?:\.|$)/.exec(unit)
  return match ? Number(match[1]) : undefined
}

/**
 * The labels and headings the clip gives each block. A section's blocks are under its heading (the
 * nearest one wins); a heading is under itself. The page's own name, as a heading over everything,
 * says nothing about what a block is. A label on its own line ("CHA", "Traits") is a looser
 * heading: what follows it is under it only up to the next line with a label of its own.
 */
function labelBlocks(clip: Block[], extraction: Extraction, titleKey: string): Map<number, BlockLabels> {
  const out = new Map<number, BlockLabels>()
  const at = (i: number) => out.get(i) ?? (out.set(i, { labels: [] }), out.get(i)!)
  for (const c of extraction.candidates) {
    if (c.kind !== 'pair' || c.entry || !c.key || c.key === titleKey) continue
    for (const i of new Set(c.units.map(blockOf))) if (i !== undefined && !at(i).labels.includes(c.label)) at(i).labels.push(c.label)
  }
  const sections = extraction.candidates.filter((c) => c.kind === 'section' && c.key && c.key !== titleKey).sort((a, b) => b.units.length - a.units.length)
  for (const c of sections) {
    const loose = clip[blockOf(c.units[0]!)!]?.kind !== 'heading'
    for (const [k, unit] of c.units.entries()) {
      const i = blockOf(unit)
      if (i === undefined) continue
      const labels = out.get(i)?.labels ?? []
      if (loose && k > 0 && labels.length > 0 && !labels.includes(c.label)) break
      at(i).under = c.label
    }
  }
  return out
}

/**
 * Checks an AI suggestion against what the clip itself says, so a small model's slip is shown
 * unticked with the reason instead of going into the page:
 *   1. A labelled value belongs in a field with that label (or a synonym, or a saved rule):
 *      "Saving Throws DEX +6" is not a Legendary Action, and "Poison" from "Damage Resistances
 *      Poison" is not an Immunity.
 *   2. A heading in the template ("Legendary Actions") takes only what the clip has under a heading
 *      like it, and no field takes what the clip has under a heading that names another field
 *      (the paragraph under "Description" is not the creature's size and type).
 *   3. A one-line field takes one short line.
 */
function aiWarning(slot: Slot, candidate: Candidate, { blockLabels, synonyms, rules, slots, title }: { blockLabels: Map<number, BlockLabels>; synonyms: Synonyms; rules: SavedRule[]; slots: Slot[]; title: string }): string | undefined {
  // Prose that happens to contain a copied value ("poison") says nothing; a labelled line does.
  const fitsLabel = (label: string) => {
    const key = cleanLabel(label)
    return compareLabels(slot.key, key, synonyms) !== undefined || namedMatch(slot.label, label, title) || rules.some((r) => r.slotKey === slot.key && r.candidateKey === key)
  }
  // Blocks the AI chose must each be right; a copied value must be right in at least one place it appears.
  const chosen = candidate.found === undefined
  const indexes = candidate.found ?? [...new Set(candidate.units.map(blockOf).filter((i) => i !== undefined))]
  const wrongLabel = (i: number) => {
    const labels = blockLabels.get(i)?.labels ?? []
    return labels.length > 0 && !labels.some(fitsLabel) ? labels[0] : undefined
  }
  const labelled = chosen ? indexes : indexes.filter((i) => (blockLabels.get(i)?.labels.length ?? 0) > 0)
  const wrong = chosen ? labelled.map(wrongLabel).find(Boolean) : labelled.length > 0 && labelled.every((i) => wrongLabel(i)) ? wrongLabel(labelled[0]!) : undefined
  if (wrong) return `The clip labels this “${wrong}”, not “${slot.label}”.`
  // Where it lands in the clip: the blocks picked, or the whole block a copied value turned out to be.
  const placed = [...new Set(candidate.units.map(blockOf).filter((i) => i !== undefined))]
  if (slot.titled && placed.length > 0) {
    const under = placed.map((i) => blockLabels.get(i)?.under)
    const other = under.find((u) => u && !fitsLabel(u))
    if (other) return `In the clip this is under “${other}”, not “${slot.label}”.`
    // Content under no heading, in a clip that has headings: had the clip a section like this, it would be under it.
    const clipHasSections = [...blockLabels.values()].some((b) => b.under)
    if (clipHasSections && under.some((u) => !u)) return `The clip has no “${slot.label}” heading for this.`
  } else if (placed.length > 0) {
    const other = placed.map((i) => blockLabels.get(i)?.under).find((u) => u && !fitsLabel(u) && slots.some((s) => s !== slot && compareLabels(s.key, cleanLabel(u), synonyms) !== undefined))
    if (other) return `In the clip this is under “${other}”, which is a field of its own.`
  }
  if (slot.kind === 'text' && (candidate.text.length > 200 || candidate.text.trim().includes('\n'))) return 'Too long for a one-line field.'
  return undefined
}

function matchTier(slot: Slot, candidate: Candidate, synonyms: Synonyms, rules: SavedRule[], title = ''): LabelMatch | undefined {
  if (rules.some((r) => r.slotKey === slot.key && r.candidateKey === candidate.key)) return LabelMatch.Rule
  if (slot.kind === 'image') return undefined
  return compareLabels(slot.key, candidate.key, synonyms) ?? (namedMatch(slot.label, candidate.label, title) ? LabelMatch.Named : undefined)
}

function rankOptions(slot: Slot, candidates: Candidate[], synonyms: Synonyms, rules: SavedRule[], title: string): Candidate[] {
  return candidates
    .filter((c) => fits(slot, c))
    .map((c, i) => ({ c, tier: matchTier(slot, c, synonyms, rules, title) ?? 9, i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.c)
}

function typedCandidate(slot: Slot, text: string): Candidate {
  const runs: Run[] = [{ text }]
  return { id: `typed:${slot.id}`, label: slot.label, key: slot.key, kind: 'pair', runs, blocks: text.split(/\n+/).map((line) => ({ kind: 'paragraph', content: [{ text: line }] })), text, units: [] }
}

export function valueFor(slot: Slot, candidate: Candidate): SlotFill {
  if (slot.kind === 'image') {
    const image = candidate.blocks[0] as AnyBlock
    return { image: { url: String(image.url), ...(image.alt ? { alt: String(image.alt) } : {}) } }
  }
  if (slot.kind === 'text') return { runs: candidate.runs ?? blocksToRuns(candidate.blocks) }
  if (slot.kind === 'links') return { links: mentionsIn(candidate.runs ?? candidate.blocks) }
  // Sub-headings keep their depth under the section's heading: "Level 1: Bardic Inspiration" two
  // levels below "Bard Class Features" stays two levels below the template's heading.
  if (slot.target.type === 'section' && candidate.level !== undefined) {
    const shift = slot.target.level - candidate.level
    return { blocks: candidate.blocks.map((b) => (b.kind === 'heading' ? { ...b, level: Math.max(1, Math.min(6, b.level + shift)) as typeof b.level } : b)) }
  }
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
export function suggestionsToCandidates(ai: Map<string, AiSuggestion>, clip: Block[], title = '', writable: Set<string> = new Set()): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>()
  const clipText = comparable(clip.map((b) => blockText(b as AnyBlock)).join('\n'))
  const titleKey = comparable(title)
  for (const [slotId, suggestion] of ai) {
    const options: Candidate[] = []
    out.set(slotId, options)
    const numbers = [...new Set(suggestion.blocks)].filter((n) => Number.isInteger(n) && n >= 0 && n < clip.length).sort((a, b) => a - b)
    if (numbers.length > 0) {
      // The page's name is never part of a field's value ("Assassin" above "Medium Humanoid…").
      const blocks = numbers.map((n) => withoutTitle(clip[n]!, titleKey)).filter((b): b is Block => b !== undefined)
      const allImages = blocks.every((b) => b.kind === 'image')
      if (blocks.length > 0) options.push({
        id: `ai:${slotId}`,
        label: 'AI',
        key: '',
        kind: allImages ? 'image' : 'section',
        blocks,
        runs: allImages ? undefined : blocksToRuns(blocks),
        text: blocks.map((b) => blockText(b as AnyBlock)).join('\n'),
        units: numbers.map((n) => `b${n}`),
      })
    }
    // Square brackets only mark a template's placeholders; a written value never needs them.
    const raw = writable.has(slotId) ? suggestion.value.replace(/\[([^\]]*)\]/g, '$1') : suggestion.value
    const lines = raw.trim().split(/\n+/)
    while (lines.length > 0 && titleKey && comparable(lines[0]!) === titleKey) lines.shift()
    const value = lines.join('\n').trim()
    if (!value) continue
    const verified = clipText.includes(comparable(value))
    // A value that is a whole block of the clip uses that block, so it isn't repeated at the end.
    const whole = clip.findIndex((b) => comparable(blockText(b as AnyBlock)) === comparable(value))
    const found = clip.map((b, i) => (comparable(blockText(b as AnyBlock)).includes(comparable(value)) ? i : -1)).filter((i) => i >= 0)
    options.push({
      // Not in the clip: written, where the mode allows it; made up, where it should have been copied.
      id: verified ? `ai:${slotId}:value` : writable.has(slotId) ? `ai:${slotId}:wrote` : `ai:${slotId}:written`,
      label: 'AI',
      key: '',
      kind: 'pair',
      runs: whole >= 0 && Array.isArray((clip[whole] as AnyBlock).content) ? ((clip[whole] as AnyBlock).content as Run[]) : [{ text: value }],
      blocks: whole >= 0 ? [clip[whole]!] : [{ kind: 'paragraph', content: [{ text: value }] }],
      text: value,
      units: whole >= 0 ? [`b${whole}`] : [],
      found,
    })
  }
  return out
}

function wordsOf(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))
}

/** The numbers and words in a text, for checking a written value against the clip. */
interface Facts {
  numbers: Set<string>
  words: Set<string>
}

function facts(text: string): Facts {
  const plain = text.normalize('NFKC').replace(/(\d),(\d{3})\b/g, '$1$2')
  return {
    numbers: new Set(plain.match(/\d+(?:[./]\d+)?/g) ?? []),
    words: new Set((plain.toLowerCase().match(/\p{L}[\p{L}'’-]*/gu) ?? []).map((w) => w.replace(/’/g, "'"))),
  }
}

/**
 * A value the AI wrote may reword the clip, but not add to it: every number in it must be in the
 * clip, and every capitalised word (a name, a type, a place) must be in the clip or the field's own
 * label and placeholder. Lowercase linking words ("and", "or") are free.
 */
function checkWritten(value: string, clip: Facts, own: Facts): string | undefined {
  const { numbers } = facts(value)
  const number = [...numbers].find((n) => !clip.numbers.has(n) && !own.numbers.has(n))
  if (number) return `The AI wrote “${number}”, which isn’t in the clip.`
  const capitalised = value.normalize('NFKC').match(/\p{Lu}[\p{L}'’-]*/gu) ?? []
  const word = capitalised.find((w) => {
    const key = w.toLowerCase().replace(/’/g, "'")
    return !clip.words.has(key) && !own.words.has(key)
  })
  if (word) return `The AI wrote “${word}”, which isn’t in the clip.`
  return undefined
}

/** A block without a first line that is only the page's name; undefined when nothing else is left. */
function withoutTitle(block: Block, titleKey: string): Block | undefined {
  if (!titleKey || !('content' in block) || !Array.isArray(block.content)) return block
  const runs = block.content as Run[]
  const cut = runs.findIndex((r) => 'break' in r)
  const first = cut === -1 ? runs : runs.slice(0, cut)
  if (comparable(runsText(first)) !== titleKey) return block
  if (cut === -1) return undefined
  const rest = runs.slice(cut + 1)
  return runsText(rest).trim() ? ({ ...block, content: rest } as Block) : undefined
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
