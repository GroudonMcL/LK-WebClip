import type { LegendKeeper, components } from '@legendkeeper/sdk'

type ResourceListItem = components['schemas']['ResourceListItem']
type ListedDocument = components['schemas']['ListedDocument']

export interface IndexedDocument {
  id: string
  name: string
  type: string
}

export interface IndexedResource {
  id: string
  name: string
  parentId: string | null
  aliases: string[]
  tags: string[]
  rank: string
  isHidden: boolean
  updatedAt: string | null
  documents: IndexedDocument[]
}

export const TEMPLATES_ROOT = 'templates'

/** Document types the clipper can write blocks into. A blank document becomes a page on its first block write. */
export const WRITABLE_DOCUMENT_TYPES = new Set(['page', 'blank'])

export function writableDocuments(resource: IndexedResource): IndexedDocument[] {
  return resource.documents.filter((doc) => WRITABLE_DOCUMENT_TYPES.has(doc.type))
}

/**
 * An in-memory copy of the project's resource tree: names, aliases, tags, parents and documents.
 * Phase 3 caches this and fuzzy-searches it; Phase 1 only proves it can be built and kept current.
 */
export class ProjectIndex {
  readonly byId = new Map<string, IndexedResource>()
  loadedAt: Date | null = null
  pagesFetched = 0
  /** Changes whenever a resource is added or replaced, so derived data (such as the link matcher) can be cached. */
  version = 0
  private pagesCache: IndexedResource[] | undefined

  constructor(resources: Iterable<IndexedResource> = []) {
    for (const resource of resources) this.upsert(resource)
  }

  static fromListItem(item: ResourceListItem): IndexedResource {
    return {
      id: item.id,
      name: item.name,
      parentId: item.parentId ?? null,
      aliases: item.aliases ?? [],
      tags: item.tags ?? [],
      rank: item.rank ?? '',
      isHidden: item.isHidden ?? false,
      updatedAt: item.updatedAt ?? null,
      documents: (item.documents ?? []).map((doc: ListedDocument) => ({ id: doc.id, name: doc.name ?? '', type: doc.type ?? 'blank' })),
    }
  }

  /** Reads every page of resources.list (100 per request, the API maximum). */
  static async load(lk: LegendKeeper): Promise<ProjectIndex> {
    const index = new ProjectIndex()
    let page: Awaited<ReturnType<LegendKeeper['resources']['list']>> | null = await lk.resources.list({ limit: 100 })
    while (page !== null) {
      index.pagesFetched++
      for (const item of page.data) index.upsert(ProjectIndex.fromListItem(item))
      page = await page.next()
    }
    index.loadedAt = new Date()
    return index
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): IndexedResource | undefined {
    return this.byId.get(id)
  }

  /** Adds or replaces one resource, such as one the clipper just created, without reloading everything. */
  upsert(resource: IndexedResource): void {
    this.byId.set(resource.id, resource)
    this.version++
    this.pagesCache = undefined
  }

  children(parentId: string | null): IndexedResource[] {
    return [...this.byId.values()]
      .filter((resource) => resource.parentId === parentId)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
  }

  /** Ancestors from the root down, excluding the resource itself. Stops on a missing parent or a cycle. */
  ancestors(id: string): IndexedResource[] {
    const trail: IndexedResource[] = []
    const seen = new Set<string>([id])
    let parentId = this.byId.get(id)?.parentId ?? null
    while (parentId !== null && !seen.has(parentId)) {
      const parent = this.byId.get(parentId)
      if (!parent) break
      trail.unshift(parent)
      seen.add(parentId)
      parentId = parent.parentId
    }
    return trail
  }

  /** "Bestiary / Dragon / Adult Red Dragon" */
  path(id: string): string {
    const self = this.byId.get(id)
    if (!self) return ''
    return [...this.ancestors(id), self].map((resource) => resource.name).join(' / ')
  }

  /**
   * Templates come back from resources.list alongside ordinary pages. They sit under the virtual
   * root "templates", which is not itself a resource, and are never clip destinations or link targets.
   */
  isTemplate(id: string): boolean {
    const seen = new Set<string>()
    let parentId = this.byId.get(id)?.parentId ?? null
    while (parentId !== null && !seen.has(parentId)) {
      if (parentId === TEMPLATES_ROOT) return true
      seen.add(parentId)
      parentId = this.byId.get(parentId)?.parentId ?? null
    }
    return false
  }

  /** Every resource except templates. */
  pages(): IndexedResource[] {
    this.pagesCache ??= [...this.byId.values()].filter((resource) => !this.isTemplate(resource.id))
    return this.pagesCache
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    return this.ancestors(id).some((resource) => resource.id === ancestorId)
  }

  /** Resources whose name or alias equals the given text, ignoring case and surrounding space. */
  findByName(name: string, { aliases = true } = {}): IndexedResource[] {
    const wanted = normalizeName(name)
    return this.pages().filter(
      (resource) =>
        normalizeName(resource.name) === wanted || (aliases && resource.aliases.some((alias) => normalizeName(alias) === wanted)),
    )
  }

  maxDepth(): number {
    let depth = 0
    for (const id of this.byId.keys()) depth = Math.max(depth, this.ancestors(id).length + 1)
    return depth
  }
}

export function normalizeName(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
}
