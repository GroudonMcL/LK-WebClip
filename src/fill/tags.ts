import { builtInPackFor, DND5E_STATBLOCK } from './notes.js'
import { cleanLabel, compareLabels, type Synonyms } from './labels.js'
import type { FillPlan } from './plan.js'

/**
 * Tags for a page filled from a D&D stat block template: the creature's size, type, alignment and
 * challenge rating, read from the filled fields. "Medium Humanoid (Any Race), Any Non-Good
 * Alignment" with CR 8 gives Medium, Humanoid, Any Non-Good Alignment and "CR 8". Words in brackets
 * and "Typically" are left out. The review screen shows them so they can be changed.
 */

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan']
const SIZE = new RegExp(`^(${SIZES.join('|')})\\b`, 'i')
const LINE_FIELDS = ['size, creature type, alignment', 'size, type, alignment', 'creature type', 'type']
const FRACTIONS: Record<string, string> = { '½': '1/2', '¼': '1/4', '⅛': '1/8' }

const SMALL_WORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the', 'to', 'in'])

/** Capitalises each word ("Non-Good" too), keeping words in capitals ("CR") and small words after the first ("Swarm of Tiny Beasts"). */
export function titleCase(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word, i) => {
      if (word === word.toUpperCase()) return word
      if (i > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase()
      return word.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('-')
    })
    .join(' ')
}

/** Size, type and alignment tags from a line like "Small Fey (Goblinoid), Typically Chaotic Neutral". */
export function creatureLineTags(line: string): string[] {
  const text = line.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return []
  const comma = text.indexOf(',')
  let left = (comma >= 0 ? text.slice(0, comma) : text).trim()
  const right = comma >= 0 ? text.slice(comma + 1).trim() : ''
  const out: string[] = []
  // "Medium or Small Humanoid": both sizes.
  for (;;) {
    const size = SIZE.exec(left)
    if (!size) break
    out.push(titleCase(size[1]!))
    left = left.slice(size[0].length).replace(/^\s*(?:or|\/)\s*/i, '').trim()
  }
  if (left) out.push(titleCase(left))
  const alignment = right.replace(/^typically\s+/i, '').replace(/[.;]+$/, '').trim()
  if (alignment) out.push(titleCase(alignment))
  return out
}

/** "CR 8" from "8 (3,900 XP)", "CR 1/4" from "1/4 (50 XP)" or "¼". */
export function challengeTag(value: string): string | undefined {
  const text = value.replace(/[½¼⅛]/g, (c) => FRACTIONS[c]!)
  const cr = /^\s*(?:CR\s*)?(\d+\s*\/\s*\d+|\d+)/i.exec(text)
  return cr ? `CR ${cr[1]!.replace(/\s+/g, '')}` : undefined
}

/** The tags for a filled plan, or none when the template isn't a stat block template. */
export function statblockTags(plan: FillPlan, synonyms: Synonyms): string[] {
  const slots = plan.slots.map((s) => s.slot)
  if (builtInPackFor(slots, synonyms) !== DND5E_STATBLOCK) return []
  const filled = plan.slots.filter((s) => s.status === 'filled' && s.text.trim())
  const named = (keys: string[]) => keys.map((key) => filled.find((s) => compareLabels(s.slot.key, cleanLabel(key), synonyms) !== undefined)).find((s) => s)
  const out: string[] = []
  const line = named(LINE_FIELDS)
  if (line) out.push(...creatureLineTags(line.text.split('\n')[0]!))
  else {
    // Separate Size and Alignment fields.
    for (const key of ['size', 'alignment']) {
      const field = named([key])
      if (field) out.push(titleCase(field.text.replace(/^typically\s+/i, '')))
    }
  }
  const cr = named(['challenge rating', 'challenge', 'cr'])
  const crTag = cr && challengeTag(cr.text)
  if (crTag) out.push(crTag)
  return unique(out)
}

/** The tags written as the project already spells them (tags match exactly, including case). */
export function withProjectSpelling(tags: string[], existing: Iterable<string>): string[] {
  const known = new Map<string, string>()
  for (const tag of existing) if (!known.has(tag.toLowerCase())) known.set(tag.toLowerCase(), tag)
  return unique(tags.map((tag) => known.get(tag.toLowerCase()) ?? tag))
}

export function parseTags(text: string): string[] {
  return unique(text.split(',').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))
}

function unique(tags: string[]): string[] {
  const seen = new Set<string>()
  return tags.filter((tag) => {
    const key = tag.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
