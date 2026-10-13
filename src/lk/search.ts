import type { LegendKeeper } from '@legendkeeper/sdk'
import { normalizeName, type IndexedResource, type ProjectIndex } from './projectIndex.js'

/** Lower tiers rank first. The order follows the brief: name, then alias, then tag, then page content. */
export enum MatchTier {
  ExactName = 0,
  NamePrefix = 1,
  NameWord = 2,
  NameContains = 3,
  Alias = 4,
  Tag = 5,
  Content = 6,
}

export interface SearchHit {
  resource: IndexedResource
  path: string
  tier: MatchTier
  /** What matched: the alias, tag or highlighted passage. */
  matched?: string
}

/**
 * Ranks resources in the local index against a query. Phase 1 uses plain substring tiers so the
 * ordering is predictable; Phase 3 adds typo tolerance on top of the same tiers.
 */
export function rankLocal(index: ProjectIndex, query: string, limit = 25): SearchHit[] {
  const q = normalizeName(query)
  if (q.length === 0) return []
  const wordStart = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, 'u')
  const hits: SearchHit[] = []

  for (const resource of index.pages()) {
    const name = normalizeName(resource.name)
    let tier: MatchTier | undefined
    let matched: string | undefined
    if (name === q) tier = MatchTier.ExactName
    else if (name.startsWith(q)) tier = MatchTier.NamePrefix
    else if (wordStart.test(name)) tier = MatchTier.NameWord
    else if (name.includes(q)) tier = MatchTier.NameContains
    else {
      const alias = resource.aliases.find((a) => normalizeName(a).includes(q))
      if (alias !== undefined) {
        tier = MatchTier.Alias
        matched = alias
      } else {
        const tag = resource.tags.find((t) => normalizeName(t).includes(q))
        if (tag !== undefined) {
          tier = MatchTier.Tag
          matched = tag
        }
      }
    }
    if (tier !== undefined) hits.push({ resource, path: index.path(resource.id), tier, matched })
  }

  return hits.sort(compareHits).slice(0, limit)
}

/**
 * Local tiers first, then the API's full-text results for pages whose content (not name) matches.
 * search.search returns at most 100 results and does not paginate.
 */
export async function searchResources(lk: LegendKeeper, index: ProjectIndex, query: string, limit = 25): Promise<SearchHit[]> {
  const local = rankLocal(index, query, limit)
  const seen = new Set(local.map((hit) => hit.resource.id))
  const remote = await lk.search.search({ q: query, limit: Math.min(100, limit * 2) })

  const content: SearchHit[] = []
  for (const hit of remote.data) {
    if (seen.has(hit.resource.id)) continue
    const resource = index.get(hit.resource.id)
    if (!resource || index.isTemplate(resource.id)) continue // Missing: the caller should refresh the index.
    seen.add(resource.id)
    const passage = hit.document?.highlights?.[0]?.segment
    content.push({ resource, path: index.path(resource.id), tier: MatchTier.Content, matched: passage })
  }

  return [...local, ...content].slice(0, limit)
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  // Within a tier, shorter names are closer to the query ("Red Dragon" before "Red Dragon Wyrmling").
  if (a.resource.name.length !== b.resource.name.length) return a.resource.name.length - b.resource.name.length
  return a.path.localeCompare(b.path)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
