import type { Block } from '@legendkeeper/sdk/blocks'
import type { AiSuggestion, BlockLabels, FillMode, FillPlan, SlotOverride } from './plan.js'
import { blockText, withNames, type AnyBlock, type Slot } from './template.js'

/**
 * The job given to a language model. It never retypes the clip: the clip's blocks are numbered and
 * the model answers, for each empty slot, with block numbers or a short value copied from the text.
 * The extension then moves the original blocks, so formatting, links and images survive, and
 * checks every answer before showing it on the review screen.
 */

export interface AiJob {
  system: string
  prompt: string
  /** A JSON schema for the answer: one entry per slot key (s1, s2…). */
  schema: Record<string, unknown>
  /** Slot key in the prompt → slot id. */
  slots: Map<string, string>
  /** Block number in the prompt → clip block index. */
  blocks: Map<number, number>
  /** True when some blocks were shortened or left out to fit the model. */
  truncated: boolean
}

export const SYSTEM_PROMPT = [
  'You fill in a template in a LegendKeeper wiki from content clipped from a web page.',
  'You never write new text. For each field, either give the numbers of the clip blocks that belong in it, or copy a short value exactly as it appears in the clip.',
  'Use block numbers for fields that hold paragraphs or sections, and for images. Use a copied value for one-line fields.',
  'Each block can go in at most one field.',
  'A block marked as labelled (for example labelled "Saving Throws") belongs only in a field with that label or one meaning the same; otherwise leave it out.',
  'A field that is a heading in the template (for example "Legendary Actions") takes only blocks under a heading with the same meaning in the clip.',
  'Never put the page name in a field.',
  'Most clips have nothing for some fields. If nothing in the clip clearly fits a field, answer with no blocks and an empty value. Never guess.',
  'Answer only with JSON in the requested shape.',
].join(' ')

/**
 * For "Labels then AI writes": the same rules, but short fields may be written in the template's
 * style from the clip's facts. Every number and name in a written value is checked against the
 * clip before it is ticked (see checkWritten in plan.ts).
 */
export const WRITE_SYSTEM_PROMPT = [
  'You fill in a template in a LegendKeeper wiki from content clipped from a web page.',
  'For fields marked "write", write a short value in the style the template and the notes ask for, using only facts stated in the clip: you may reword, reorder, combine and reformat them, and work out simple values the notes explain (such as a modifier), but never add a fact, number or name the clip does not have.',
  'For other fields, give the numbers of the clip blocks that belong in them; never write those.',
  'Each block can go in at most one field.',
  'A block marked as labelled (for example labelled "Saving Throws") belongs only in a field with that label or one meaning the same.',
  'A field that is a heading in the template (for example "Legendary Actions") takes only blocks under a heading with the same meaning in the clip.',
  'Never put the page name in a field.',
  'Most clips have nothing for some fields. If the clip has nothing for a field, answer with no blocks and an empty value. Never guess.',
  'Answer only with JSON in the requested shape.',
].join(' ')

/**
 * Fields the AI may write in "Labels then AI writes": one-line rows, and short text fields named by
 * their placeholder ("Size, Creature Type, Alignment"). Sections, titled fields and placeholders
 * standing for paragraphs keep the clip's own blocks, with their links and formatting.
 */
export function isWritable(slot: Slot): boolean {
  return slot.kind === 'text' || (slot.kind === 'rich' && slot.target.type === 'field' && !slot.titled)
}

const KIND_TEXT: Record<string, string> = {
  text: 'one line of text: copy a short value',
  rich: 'paragraphs or a section: give block numbers',
  image: 'an image: give the number of an image block',
}

/** The slots the AI should look at: empty ones (in "Labels then AI"), or every fillable one (in "AI"). */
export function slotsForAi(plan: FillPlan, mode: FillMode, overrides: Record<string, SlotOverride>): Slot[] {
  return plan.slots
    .filter((s) => ['text', 'rich', 'image'].includes(s.slot.kind))
    .filter((s) => !overrides[s.slot.id]?.choice)
    .filter((s) => (mode === 'ai' ? true : s.status === 'empty'))
    // A field a rule works out (Initiative from Dexterity) needs no AI.
    .filter((s) => s.origin !== 'derived')
    .map((s) => s.slot)
}

export interface AiInput {
  slots: Slot[]
  clip: Block[]
  /** The clip blocks the AI may use (top-level indexes). */
  blockIndexes: number[]
  title: string
  nameOf?: (resourceId: string) => string | undefined
  /** What the clip says about each block (FillPlan.blockLabels), shown to the model with the block. */
  labels?: Map<number, BlockLabels>
  /** Notes about the template (what belongs in each field, and how it is written), for every mode. */
  notes?: string
  /** "Labels then AI writes": short fields may be written. `notes` here is the older place for the notes. */
  write?: { notes?: string }
}

export function buildAiJob(input: AiInput, limits: { maxChars?: number; maxBlockChars?: number } = {}): AiJob | undefined {
  return withNames(input.nameOf, () => job(input, limits))
}

function job({ slots, clip, blockIndexes, title, labels, write, notes: givenNotes }: AiInput, { maxChars = 12_000, maxBlockChars = 600 }: { maxChars?: number; maxBlockChars?: number }): AiJob | undefined {
  if (slots.length === 0 || blockIndexes.length === 0) return undefined
  // The notes share the model's window with the clip.
  const notes = (givenNotes ?? write?.notes)?.trim() ?? ''
  maxChars = Math.max(1000, maxChars - notes.length)
  const blocks = new Map<number, number>()
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const index of blockIndexes) {
    const block = clip[index] as AnyBlock | undefined
    if (!block) continue
    const number = index + 1
    let text = block.kind === 'image' ? `alt text: ${String(block.alt ?? '') || '(none)'}` : blockText(block).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (text.length > maxBlockChars) {
      text = `${text.slice(0, maxBlockChars)}…`
      truncated = true
    }
    const about = [block.kind === 'heading' ? `heading ${block.level}` : block.kind]
    const known = labels?.get(index)
    if (known?.labels.length) about.push(`labelled ${known.labels.map((l) => `"${l}"`).join(', ')}`)
    if (known?.under && block.kind !== 'heading') about.push(`under "${known.under}"`)
    const line = `[${number}] (${about.join(', ')}) ${text}`
    if (used + line.length > maxChars) {
      truncated = true
      break
    }
    used += line.length
    blocks.set(number, index)
    lines.push(line)
  }
  if (blocks.size === 0) return undefined

  const slotKeys = new Map<string, string>()
  const fieldLines = slots.map((slot, i) => {
    const key = `s${i + 1}`
    slotKeys.set(key, slot.id)
    const example = slot.placeholder && slot.kind !== 'image' ? ` Template example: "${slot.placeholder.replace(/\s+/g, ' ').slice(0, 120)}"` : ''
    const heading = slot.titled ? ' A heading in the template.' : ''
    const kind = write && isWritable(slot) ? 'write: a short value from the clip\'s facts, in the template\'s style' : KIND_TEXT[slot.kind] ?? 'text'
    return `${key}: "${slot.label}" (${slot.path}) — ${kind}.${heading}${example}`
  })

  const entry = { type: 'object', properties: { blocks: { type: 'array', items: { type: 'integer' } }, value: { type: 'string' } }, required: ['blocks', 'value'], additionalProperties: false }
  const schema = { type: 'object', properties: Object.fromEntries([...slotKeys.keys()].map((k) => [k, entry])), required: [...slotKeys.keys()], additionalProperties: false }
  const example = `{${[...slotKeys.keys()].slice(0, 2).map((k) => `"${k}": {"blocks": [], "value": ""}`).join(', ')}${slotKeys.size > 2 ? ', …' : ''}}`
  const prompt = [
    `Page name: ${title}`,
    '',
    // When the AI only picks, the notes say where things belong; values are still copied as the clip has them.
    ...(notes ? [write ? 'Notes about this template:' : 'Notes about this template (they say what belongs in each field; copy values as the clip has them, never reformat):', notes, ''] : []),
    'Clip blocks:',
    ...lines,
    '',
    'Fields to fill:',
    ...fieldLines,
    '',
    `Answer with JSON like ${example}, with an entry for every field.`,
  ].join('\n')
  return { system: write ? WRITE_SYSTEM_PROMPT : SYSTEM_PROMPT, prompt, schema, slots: slotKeys, blocks, truncated }
}

export class AiAnswerError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message)
    this.name = 'AiAnswerError'
  }
}

/** Checks the model's answer against the job. Throws AiAnswerError when it isn't the right shape at all. */
export function parseAiAnswer(job: AiJob, raw: string): Map<string, AiSuggestion> {
  let data: unknown
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    data = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw)
  } catch {
    throw new AiAnswerError('The AI did not answer with JSON.', raw)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AiAnswerError('The AI’s answer was not in the expected shape.', raw)
  const out = new Map<string, AiSuggestion>()
  const usedBlocks = new Set<number>()
  let recognised = 0
  for (const [key, slotId] of job.slots) {
    const entry = (data as Record<string, unknown>)[key]
    if (!entry || typeof entry !== 'object') continue
    recognised++
    const { blocks, value } = entry as { blocks?: unknown; value?: unknown }
    // Numbers outside the clip are dropped, and a block goes in one slot only.
    const numbers = (Array.isArray(blocks) ? blocks : [])
      .map((n) => (typeof n === 'string' ? Number(n) : n))
      .filter((n): n is number => typeof n === 'number' && job.blocks.has(n))
      .map((n) => job.blocks.get(n)!)
      .filter((index) => !usedBlocks.has(index))
    for (const index of numbers) usedBlocks.add(index)
    const text = typeof value === 'string' ? value.trim().slice(0, 500) : ''
    // Both are kept: when the numbers and the value disagree, the plan uses the one the clip agrees with.
    if (numbers.length > 0 || text) out.set(slotId, { blocks: numbers, value: text })
  }
  if (recognised === 0) throw new AiAnswerError('The AI’s answer had none of the fields asked for.', raw)
  return out
}
