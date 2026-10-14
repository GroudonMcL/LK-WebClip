/**
 * Worked-out fields: a field the clip doesn't state but other fields decide, such as a D&D
 * creature's Initiative, which is its Dexterity modifier and, in brackets, 10 plus that modifier.
 * Each rule is one line in Settings:
 *
 *   Initiative = {Dexterity modifier} ({10 + Dexterity modifier})
 *
 * Text in braces is taken from another field; everything else is written as it is. Inside braces:
 *   - "Field modifier": the signed number in "16 (+3)", or worked out from a lone ability score (16 → +3);
 *   - "Field number": the first number;
 *   - "Field": the whole value;
 *   - "10 + Field modifier" (or "-"): a sum, written without a sign (13).
 * The older one-part form "Initiative = Dexterity modifier" still works: it means "{Dexterity modifier}".
 *
 * The target is filled when labels (and the AI) left it empty, or when the clip states only the
 * start of the worked-out value ("+3" where the rule gives "+3 (13)").
 */

export type DerivedPart = 'value' | 'modifier' | 'number'

export interface DerivedRef {
  source: string
  part: DerivedPart
  /** Added to the number, for sums like "10 + Dexterity modifier". */
  add?: number
}

export interface DerivedRule {
  target: string
  /** Literal text and references to other fields, in order. */
  pieces: (string | DerivedRef)[]
}

export const DEFAULT_DERIVED = 'Initiative = {Dexterity modifier} ({10 + Dexterity modifier})'
/** Earlier defaults, replaced by DEFAULT_DERIVED when found unchanged in saved settings. */
export const OLD_DEFAULT_DERIVED = ['Initiative = Dexterity modifier']

function parseRef(text: string): DerivedRef | undefined {
  let rest = text.trim()
  let add: number | undefined
  const sum = /^([+\-−]?\s*\d+)\s*([+\-−])\s*(.+)$/.exec(rest)
  if (sum) {
    add = Number(sum[1]!.replace(/[\s−]/g, (c) => (c === '−' ? '-' : '')))
    if (sum[2] !== '+') return undefined
    rest = sum[3]!
  } else {
    const after = /^(.+?)\s*([+\-−])\s*(\d+)$/.exec(rest)
    if (after) {
      add = Number(after[3]) * (after[2] === '+' ? 1 : -1)
      rest = after[1]!
    }
  }
  const words = rest.split(/\s+/)
  const last = words.at(-1)!.toLowerCase()
  const part: DerivedPart = last === 'modifier' || last === 'mod' ? 'modifier' : last === 'number' ? 'number' : 'value'
  const source = (part === 'value' ? words : words.slice(0, -1)).join(' ')
  if (!source) return undefined
  return { source, part, ...(add !== undefined ? { add } : {}) }
}

export function parseDerived(text: string): DerivedRule[] {
  const out: DerivedRule[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(line)
    if (!match || !match[1]) continue
    const body = match[2]!
    const pieces: DerivedRule['pieces'] = []
    if (!body.includes('{')) {
      const ref = parseRef(body)
      if (ref) pieces.push(ref)
    } else {
      let bad = false
      for (const [i, piece] of body.split(/[{}]/).entries()) {
        if (i % 2 === 0) {
          if (piece) pieces.push(piece)
        } else {
          const ref = parseRef(piece)
          if (ref) pieces.push(ref)
          else bad = true
        }
      }
      if (bad || (body.match(/\{/g) ?? []).length !== (body.match(/\}/g) ?? []).length) continue
    }
    if (pieces.some((p) => typeof p !== 'string')) out.push({ target: match[1], pieces })
  }
  return out
}

/** The fields a rule reads. */
export function sourcesOf(rule: DerivedRule): string[] {
  return [...new Set(rule.pieces.filter((p): p is DerivedRef => typeof p !== 'string').map((p) => p.source))]
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

/**
 * The rule's value, given the text of the fields it reads (`valueOf` returns undefined for a field
 * that isn't filled). Undefined when any part can't be worked out.
 */
export function applyDerived(rule: DerivedRule, valueOf: (source: string) => string | undefined): string | undefined {
  let out = ''
  for (const piece of rule.pieces) {
    if (typeof piece === 'string') {
      out += piece
      continue
    }
    const text = valueOf(piece.source)
    const value = text === undefined ? undefined : deriveValue(text, piece.part)
    if (value === undefined) return undefined
    if (piece.add === undefined) {
      out += value
      continue
    }
    const n = Number(value.replace(/[−–]/g, '-').replace(/,/g, ''))
    if (!Number.isFinite(n)) return undefined
    out += String(n + piece.add)
  }
  return out.trim() || undefined
}

/**
 * Whether a value the clip states is only the start of the worked-out one ("+3" of "+3 (13)"), so
 * the worked-out value adds to it without changing what the clip says.
 */
export function completes(found: string, worked: string): boolean {
  const norm = (s: string) => s.replace(/[−–]/g, '-').replace(/\s+/g, ' ').trim()
  const a = norm(found)
  const b = norm(worked)
  return a !== '' && a !== b && b.startsWith(a) && /^[\s(]/.test(b.slice(a.length))
}
