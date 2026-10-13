import type { LegendKeeper } from '@legendkeeper/sdk'
import { normalizeName, type IndexedResource, type ProjectIndex } from './projectIndex.js'

/** Lower tiers rank first: name matches, then aliases, then tags, then page text. */
export enum MatchTier {
  ExactName = 0,
  NamePrefix = 1,
  NameWord = 2,
  NameContains = 3,
  /** Every word of the query starts a word of the name, in any order ("dragon red" → Red Dragon). */
  NameWords = 4,
  /** The name is within a typo or two of the query ("grayhawk" → World of Greyhawk). */
  FuzzyName = 5,
  Alias = 6,
  FuzzyAlias = 7,
  Tag = 8,
  Content = 9,
}

export interface SearchHit {
  resource: IndexedResource
  path: string
  tier: MatchTier
  /** What matched: the alias, tag or highlighted passage. */
  matched?: string
  /** Orders hits within a tier; lower is better (edit distance, or how the alias matched). */
  score?: number
}

/**
 * Ranks the pages in the local index against a query, as you type. Typos are tolerated: up to one
 * edit for queries of 4–6 characters and two for longer ones, where an edit is an inserted,
 * deleted, replaced or swapped letter. A query starting with # lists pages with that tag.
 */
export function rankLocal(index: ProjectIndex, query: string, limit = 25): SearchHit[] {
  const raw = query.trim()
  if (raw.startsWith('#')) return rankByTag(index, raw.slice(1), limit)
  const q = normalizeName(raw)
  if (q.length === 0) return []
  // One-letter words ("d&d" → d, d) would match almost everything in any order.
  const queryWords = words(q).filter((w) => w.length >= 2)
  // Typos allowed grow with the query's letters and digits; punctuation never earns any.
  const letters = q.replace(/[^\p{L}\p{N}]/gu, '').length
  const maxEdits = letters >= 7 ? 2 : letters >= 4 ? 1 : 0
  const hits: SearchHit[] = []

  for (const resource of index.pages()) {
    const name = normalizeName(resource.name)
    const nameWords = words(name)
    let hit: Omit<SearchHit, 'resource' | 'path'> | undefined
    if (name === q) hit = { tier: MatchTier.ExactName }
    else if (name.startsWith(q)) hit = { tier: MatchTier.NamePrefix }
    else if (startsAWord(name, q)) hit = { tier: MatchTier.NameWord }
    else if (name.includes(q)) hit = { tier: MatchTier.NameContains }
    else if (queryWords.length > 1 && queryWords.every((w) => nameWords.some((n) => n.startsWith(w)))) hit = { tier: MatchTier.NameWords }
    else {
      const distance = maxEdits > 0 ? fuzzyDistance(q, name, maxEdits) : Infinity
      if (distance <= maxEdits) hit = { tier: MatchTier.FuzzyName, score: distance }
      else hit = matchAlias(resource, q, maxEdits) ?? matchTag(resource, q)
    }
    if (hit) hits.push({ resource, path: index.path(resource.id), ...hit })
  }

  return hits.sort(compareHits).slice(0, limit)
}

function matchAlias(resource: IndexedResource, q: string, maxEdits: number): Omit<SearchHit, 'resource' | 'path'> | undefined {
  let best: Omit<SearchHit, 'resource' | 'path'> | undefined
  for (const alias of resource.aliases) {
    const a = normalizeName(alias)
    const score = a === q ? 0 : a.startsWith(q) ? 1 : startsAWord(a, q) ? 2 : a.includes(q) ? 3 : undefined
    if (score !== undefined && (!best || best.tier !== MatchTier.Alias || score < (best.score ?? 9))) best = { tier: MatchTier.Alias, matched: alias, score }
    else if (score === undefined && (!best || best.tier === MatchTier.FuzzyAlias) && maxEdits > 0) {
      const distance = fuzzyDistance(q, a, maxEdits)
      if (distance <= maxEdits && (!best || distance < (best.score ?? 9))) best = { tier: MatchTier.FuzzyAlias, matched: alias, score: distance }
    }
  }
  return best
}

function matchTag(resource: IndexedResource, q: string): Omit<SearchHit, 'resource' | 'path'> | undefined {
  for (const tag of resource.tags) {
    const t = normalizeName(tag)
    if (t === q) return { tier: MatchTier.Tag, matched: tag, score: 0 }
  }
  const tag = resource.tags.find((t) => normalizeName(t).includes(q))
  return tag === undefined ? undefined : { tier: MatchTier.Tag, matched: tag, score: 1 }
}

function rankByTag(index: ProjectIndex, tagQuery: string, limit: number): SearchHit[] {
  const q = normalizeName(tagQuery)
  const hits: SearchHit[] = []
  for (const resource of index.pages()) {
    const exact = resource.tags.find((t) => normalizeName(t) === q)
    const partial = exact ?? (q ? resource.tags.find((t) => normalizeName(t).startsWith(q)) : resource.tags[0])
    if (partial !== undefined) hits.push({ resource, path: index.path(resource.id), tier: MatchTier.Tag, matched: partial, score: exact !== undefined ? 0 : 1 })
  }
  return hits.sort(compareHits).slice(0, limit)
}

export interface SearchOptions {
  limit?: number
  /** Called with ids the API found but the local index lacks: a sign the page list is out of date. */
  onMissing?: (resourceIds: string[]) => void
}

/**
 * Local matches first, then the API's full-text results for pages whose text (not name) matches.
 * search.search returns at most 100 results and does not paginate.
 */
export async function searchResources(lk: LegendKeeper, index: ProjectIndex, query: string, options: SearchOptions | number = {}): Promise<SearchHit[]> {
  const { limit = 25, onMissing } = typeof options === 'number' ? { limit: options } : options
  const local = rankLocal(index, query, limit)
  if (query.trim().startsWith('#')) return local
  const seen = new Set(local.map((hit) => hit.resource.id))
  const remote = await lk.search.search({ q: query, limit: Math.min(100, limit * 2) })

  const content: SearchHit[] = []
  const missing: string[] = []
  for (const hit of remote.data) {
    if (seen.has(hit.resource.id)) continue
    const resource = index.get(hit.resource.id)
    if (!resource) {
      missing.push(hit.resource.id)
      continue
    }
    if (index.isTemplate(resource.id)) continue
    seen.add(resource.id)
    const passage = hit.document?.highlights?.[0]?.segment
    content.push({ resource, path: index.path(resource.id), tier: MatchTier.Content, matched: passage })
  }
  if (missing.length > 0) onMissing?.(missing)

  return [...local, ...content].slice(0, limit)
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) - (b.score ?? 0)
  // Within a tier, shorter names are closer to the query ("Red Dragon" before "Red Dragon Wyrmling").
  if (a.resource.name.length !== b.resource.name.length) return a.resource.name.length - b.resource.name.length
  return a.path.localeCompare(b.path)
}

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}']+/u).filter(Boolean)
}

function startsAWord(text: string, q: string): boolean {
  for (let i = text.indexOf(q); i > 0; i = text.indexOf(q, i + 1)) {
    if (!/[\p{L}\p{N}]/u.test(text[i - 1]!)) return true
  }
  return false
}

/**
 * The fewest edits that turn `query` into the start of `text` or of any word in it, giving up
 * above `max`. So "dragn" is 1 from "Dragon Turtle", and "grayhawk" is 1 from "World of Greyhawk".
 */
export function fuzzyDistance(query: string, text: string, max: number): number {
  let best = Infinity
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1]!)) continue
    best = Math.min(best, prefixEditDistance(query, text.slice(i, i + query.length + max), max))
    if (best === 0) break
  }
  return best
}

/** Optimal-string-alignment distance from `a` to the closest prefix of `b`. */
function prefixEditDistance(a: string, b: string, max: number): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1)
      row.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return Infinity
    rows.push(row)
  }
  return Math.min(...rows[a.length]!)
}
