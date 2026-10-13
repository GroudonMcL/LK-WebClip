import { singularForms } from '../clip/links.js'

/**
 * Labels name the places a template takes a value ("Armour Class", "Actions") and the values in a
 * clip ("AC 15", a "Traits" heading). Both sides are compared in a cleaned form.
 */

/** Lowercase, no brackets, no trailing colon or full stop, single spaces, straight apostrophes. */
export function cleanLabel(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:.;,–—-]+$/u, '')
    .trim()
    .toLowerCase()
}

/**
 * Titles LegendKeeper gives blocks by default, or that templates use for every block of a kind.
 * They say nothing about what goes in the block, so they never match a clip label.
 */
const WEAK_LABELS = new Set(['text', 'stats', 'properties', 'property', 'image', 'embed', 'meter', 'collection', 'links', 'map', 'tags', 'aliases', ''])

export function isWeakLabel(label: string): boolean {
  return WEAK_LABELS.has(cleanLabel(label))
}

/** Raised when groups are added to DEFAULT_SYNONYMS, so saved lists get them once (see withNewDefaults). */
export const SYNONYMS_VERSION = 2

/**
 * Synonym groups that ship with the clipper, for the stat blocks and infoboxes people clip most.
 * Each line is one group; any label in a group matches any other. They are a starting point you
 * can edit in Settings.
 */
export const DEFAULT_SYNONYMS: string[][] = [
  ['Armour Class', 'Armor Class', 'AC'],
  ['Hit Points', 'HP', 'Hit Point'],
  ['Challenge Rating', 'Challenge', 'CR'],
  ['Strength', 'STR'],
  ['Dexterity', 'DEX'],
  ['Constitution', 'CON'],
  ['Intelligence', 'INT'],
  ['Wisdom', 'WIS'],
  ['Charisma', 'CHA'],
  ['Resistances', 'Damage Resistances'],
  ['Immunities', 'Damage Immunities'],
  ['Vulnerabilities', 'Damage Vulnerabilities'],
  ['Saving Throws', 'Saves'],
  ['Proficiency Bonus', 'PB'],
  ['Condition Immunities', 'Condition Immunity'],
  ['Bonus Actions', 'Bonus Action'],
  ['Legendary Actions', 'Legendary Action'],
  ['Lair Actions', 'Lair Action'],
  ['Hit Point Die', 'Hit Dice', 'Hit Die'],
  ['Casting Time', 'Cast Time'],
  ['Range/Area', 'Range', 'Area'],
  ['Level', 'Spell Level'],
  ['Type', 'Item Type'],
  ['Attunement', 'Requires Attunement'],
  ['Species', 'Race'],
  ['Professions', 'Profession', 'Occupation'],
  ['Titles', 'Title'],
  ['Foes', 'Enemies'],
  ['Pantheon', 'Pantheons'],
  ['Portfolio', 'Portfolios'],
  ['Population', 'Pop'],
  ['Government', 'Government Type'],
  ['Ruler', 'Rulers', 'Leader'],
  ['Religions', 'Religion', 'Deities'],
  ['Description', 'Overview', 'Summary'],
]

/** Parses the Settings text box: one group per line, labels separated by commas or "=". */
export function parseSynonyms(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.split(/[,=]/).map((label) => label.trim()).filter(Boolean))
    .filter((group) => group.length > 1)
}

export function formatSynonyms(groups: string[][]): string {
  return groups.map((group) => group.join(', ')).join('\n')
}

/** For each cleaned label, every cleaned label it is a synonym of (not including itself). */
export class Synonyms {
  private readonly map = new Map<string, Set<string>>()

  constructor(groups: string[][]) {
    for (const group of groups) {
      const keys = group.map(cleanLabel).filter(Boolean)
      for (const key of keys) {
        const set = this.map.get(key) ?? new Set<string>()
        for (const other of keys) if (other !== key) set.add(other)
        this.map.set(key, set)
      }
    }
  }

  of(key: string): Set<string> {
    return this.map.get(key) ?? new Set()
  }

  /** Every label in the list, cleaned. */
  labels(): string[] {
    return [...this.map.keys()]
  }

  /** The label and all its synonyms, cleaned. */
  variants(key: string): string[] {
    return [key, ...this.of(key)]
  }
}

/** How a clip label matched a template label, strictest first. */
export enum LabelMatch {
  Rule = 0,
  Exact = 1,
  Synonym = 2,
  /** The same apart from a plural or possessive ending. */
  Loose = 3,
  /** Within a small typo, for labels of 6 letters or more. */
  Typo = 4,
}

export const LABEL_MATCH_NAMES: Record<LabelMatch, string> = {
  [LabelMatch.Rule]: 'Saved rule',
  [LabelMatch.Exact]: 'Label',
  [LabelMatch.Synonym]: 'Synonym',
  [LabelMatch.Loose]: 'Similar label',
  [LabelMatch.Typo]: 'Similar label',
}

/** How well a clip label fits a template label, or undefined when it doesn't. Rules are handled by the caller. */
export function compareLabels(slotKey: string, candidateKey: string, synonyms: Synonyms): LabelMatch | undefined {
  if (!slotKey || !candidateKey) return undefined
  if (slotKey === candidateKey) return LabelMatch.Exact
  if (synonyms.of(slotKey).has(candidateKey)) return LabelMatch.Synonym
  const slotForms = new Set([slotKey, ...singularForms(slotKey)])
  const candidateForms = [candidateKey, ...singularForms(candidateKey)]
  if (candidateForms.some((form) => slotForms.has(form))) return LabelMatch.Loose
  // A synonym's plural ("Damage Resistance" for "Damage Resistances") is loose too.
  for (const synonym of synonyms.of(slotKey)) if (candidateForms.includes(synonym) || singularForms(synonym).includes(candidateKey)) return LabelMatch.Loose
  const letters = slotKey.replace(/[^\p{L}\p{N}]/gu, '').length
  if (letters >= 6 && editDistance(slotKey, candidateKey, 1) <= 1) return LabelMatch.Typo
  return undefined
}

/** Optimal string alignment distance, giving up (returning max + 1) once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1)
      row.push(d)
      best = Math.min(best, d)
    }
    if (best > max) return max + 1
    rows.push(row)
  }
  return rows[a.length]![b.length]!
}

/**
 * Text inside square brackets is a template's placeholder: "[Overview text]", "[Size, e.g. Small]".
 * Returns the bracketed labels without their examples, or [] when the text has none.
 */
export function placeholderLabels(text: string): string[] {
  return [...text.matchAll(/\[([^\]]*)\]?/g)]
    .map((m) => m[1]!.replace(/,?\s*e\.g\..*$/i, '').replace(/^["“]|["”]$/g, '').trim())
    .filter((label) => label.length > 0 && label !== '?' && label !== '...')
}

/** True when the text is nothing but bracketed placeholders and punctuation, such as "[Overview text]". */
export function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.includes('[')) return false
  return !/[\p{L}\p{N}]/u.test(trimmed.replace(/\[[^\]]*\]?/g, ''))
}
