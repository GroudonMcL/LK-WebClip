import type { Block } from '@legendkeeper/sdk/blocks'
import type { AiSuggestion, FillMode, FillPlan, SlotOverride } from './plan.js'
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
  'Each block can go in at most one field. If nothing in the clip fits a field, answer with no blocks and an empty value. Never guess.',
  'Answer only with JSON in the requested shape.',
].join(' ')

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
    .map((s) => s.slot)
}

export interface AiInput {
  slots: Slot[]
  clip: Block[]
  /** The clip blocks the AI may use (top-level indexes). */
  blockIndexes: number[]
  title: string
  nameOf?: (resourceId: string) => string | undefined
}

export function buildAiJob(input: AiInput, limits: { maxChars?: number; maxBlockChars?: number } = {}): AiJob | undefined {
  return withNames(input.nameOf, () => job(input, limits))
}

function job({ slots, clip, blockIndexes, title }: AiInput, { maxChars = 12_000, maxBlockChars = 600 }: { maxChars?: number; maxBlockChars?: number }): AiJob | undefined {
  if (slots.length === 0 || blockIndexes.length === 0) return undefined
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
    const line = `[${number}] (${block.kind === 'heading' ? `heading ${block.level}` : block.kind}) ${text}`
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
    return `${key}: "${slot.label}" (${slot.path}) — ${KIND_TEXT[slot.kind] ?? 'text'}.${example}`
  })

  const entry = { type: 'object', properties: { blocks: { type: 'array', items: { type: 'integer' } }, value: { type: 'string' } }, required: ['blocks', 'value'], additionalProperties: false }
  const schema = { type: 'object', properties: Object.fromEntries([...slotKeys.keys()].map((k) => [k, entry])), required: [...slotKeys.keys()], additionalProperties: false }
  const example = `{${[...slotKeys.keys()].slice(0, 2).map((k) => `"${k}": {"blocks": [], "value": ""}`).join(', ')}${slotKeys.size > 2 ? ', …' : ''}}`
  const prompt = [
    `Page name: ${title}`,
    '',
    'Clip blocks:',
    ...lines,
    '',
    'Fields to fill:',
    ...fieldLines,
    '',
    `Answer with JSON like ${example}, with an entry for every field.`,
  ].join('\n')
  return { system: SYSTEM_PROMPT, prompt, schema, slots: slotKeys, blocks, truncated }
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
    if (numbers.length > 0 || text) out.set(slotId, { blocks: numbers, value: numbers.length > 0 ? '' : text })
  }
  if (recognised === 0) throw new AiAnswerError('The AI’s answer had none of the fields asked for.', raw)
  return out
}
