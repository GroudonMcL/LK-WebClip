import type { Block } from '@legendkeeper/sdk/blocks'
import type { AiJob } from './ai.js'
import type { AiEngine } from './engines.js'
import { blockText, withNames, type AnyBlock, type Slot } from './template.js'

/**
 * "Suggest notes with AI" in Settings: the AI drafts notes for a template from its fields, the
 * notes you already have, and the clip open in the panel as an example. The draft is only shown;
 * you edit it and save it yourself.
 */

export const NOTES_SYSTEM_PROMPT = [
  'You write short notes for another AI that fills in a template in a LegendKeeper wiki from content clipped from web pages.',
  'The notes say what the template is for and, for each field, what belongs in it, where it is usually found in a clip, and how it is written.',
  'Examples in the notes show the format only, so make them up for a different subject than the example clip, and say they are examples.',
  'Never tell the other AI to invent or guess facts: values must come from the clip.',
  'Answer only with JSON in the requested shape.',
].join(' ')

export interface NotesInput {
  templateName: string
  slots: Slot[]
  /** Notes the template already has (yours or built-in), to improve on. */
  current?: string
  /** The clip open in the panel, as an example of what clips look like. */
  clip?: { blocks: Block[]; title: string }
  nameOf?: (resourceId: string) => string | undefined
}

const KIND: Record<string, string> = { text: 'one line', rich: 'paragraphs', image: 'an image' }

export function buildNotesJob(input: NotesInput, { maxChars = 12_000 }: { maxChars?: number } = {}): AiJob {
  return withNames(input.nameOf, () => {
    const fields = input.slots
      .filter((s) => ['text', 'rich', 'image'].includes(s.kind))
      .map((s) => {
        const example = s.placeholder && s.kind !== 'image' ? `; the template shows "${s.placeholder.replace(/\s+/g, ' ').slice(0, 120)}"` : ''
        return `- "${s.label}" (${KIND[s.kind] ?? s.kind}${s.titled ? ', a heading in the template' : ''}${example})`
      })
    const current = input.current?.trim()
    const clipLines: string[] = []
    if (input.clip) {
      // The example clip gets what is left of the budget.
      let budget = Math.max(1000, maxChars - fields.join('\n').length - (current?.length ?? 0) - 1500)
      for (const block of input.clip.blocks) {
        const text = blockText(block as AnyBlock).replace(/\s+/g, ' ').trim()
        if (!text) continue
        const line = text.length > 300 ? `${text.slice(0, 300)}…` : text
        if (line.length > budget) break
        budget -= line.length
        clipLines.push(line)
      }
    }
    const prompt = [
      `Template: ${input.templateName}`,
      '',
      'Its fields:',
      ...fields,
      '',
      ...(current ? ['Notes it has now (keep what is right, fix and add to them):', current, ''] : []),
      ...(clipLines.length ? [`An example clip, "${input.clip!.title}" (for what clips look like; do not use its facts in the notes):`, ...clipLines, ''] : []),
      'Write the notes: one sentence on what the template is for and where clips usually come from, then one line per field starting with "- Field name:", then one line on what in a clip belongs in no field.',
      'Use the field names exactly as listed. Keep the notes under 1,500 characters.',
      'Answer with JSON like {"notes": "…"}.',
    ].join('\n')
    const schema = { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false }
    return { system: NOTES_SYSTEM_PROMPT, prompt, schema, slots: new Map(), blocks: new Map(), truncated: false }
  })
}

/** The notes in an answer: JSON {"notes": …}, or failing that the text itself. */
export function parseNotesAnswer(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (json) {
    try {
      const notes = (JSON.parse(json) as { notes?: unknown }).notes
      if (typeof notes === 'string' && notes.trim()) return tidy(notes)
    } catch {
      // Not JSON after all.
    }
  }
  return tidy(text)
}

function tidy(notes: string): string {
  return notes.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function suggestNotes(engine: AiEngine, input: NotesInput, signal?: AbortSignal): Promise<{ notes: string; job: AiJob; raw: string }> {
  const job = buildNotesJob(input, { maxChars: engine.maxChars })
  const raw = await engine.run(job, signal)
  const notes = parseNotesAnswer(raw)
  if (!notes) throw new Error('The AI gave no notes. Try again.')
  return { notes, job, raw }
}
