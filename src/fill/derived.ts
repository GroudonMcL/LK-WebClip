/**
 * Worked-out fields: a field the clip doesn't state but another field decides, such as a D&D
 * creature's Initiative, which is its Dexterity modifier. Each rule is one line in Settings:
 *
 *   Initiative = Dexterity modifier
 *
 * The target is filled only when labels (and the AI) left it empty and the source field is filled.
 * The parts that can be taken from the source are:
 *   - "modifier": the signed number in "16 (+3)", or worked out from a lone ability score (16 → +3);
 *   - "number": the first number;
 *   - nothing: the whole value.
 */

export type DerivedPart = 'value' | 'modifier' | 'number'

export interface DerivedRule {
  target: string
  source: string
  part: DerivedPart
}

export const DEFAULT_DERIVED = 'Initiative = Dexterity modifier'

export function parseDerived(text: string): DerivedRule[] {
  const out: DerivedRule[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const words = match[2]!.split(/\s+/)
    const last = words.at(-1)!.toLowerCase()
    const part: DerivedPart = last === 'modifier' || last === 'mod' ? 'modifier' : last === 'number' ? 'number' : 'value'
    const source = (part === 'value' ? words : words.slice(0, -1)).join(' ')
    if (match[1] && source) out.push({ target: match[1], source, part })
  }
  return out
}

/** The part of a field's value a rule takes, or undefined when the value doesn't have it. */
export function deriveValue(text: string, part: DerivedPart): string | undefined {
  const value = text.trim()
  if (!value) return undefined
  if (part === 'value') return value
  if (part === 'number') return /[+\-−–]?\d+(?:[.,]\d+)?/.exec(value)?.[0]
  const signed = /\(\s*([+\-−–])\s*(\d+)\s*\)/.exec(value) ?? /(?:^|\s)([+\-−–])(\d+)\b/.exec(value)
  if (signed) return `${signed[1] === '+' ? '+' : '-'}${signed[2]}`
  const score = /^(\d{1,2})$/.exec(value)
  if (!score) return undefined
  const modifier = Math.floor((Number(score[1]) - 10) / 2)
  return modifier >= 0 ? `+${modifier}` : String(modifier)
}
