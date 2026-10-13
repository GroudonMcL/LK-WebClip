import type { LegendKeeper } from '@legendkeeper/sdk'
import { collection, h, mention, p, type Block, type HeadingBlock, type ResourceCollectionBlock } from '@legendkeeper/sdk/blocks'
import { ProjectIndex, normalizeName, type IndexedResource } from './projectIndex.js'

export interface SourceConfig {
  /** The resource whose descendants are Sources, e.g. the project's "Sources" page. */
  sourcesRootId: string
  /** A tag that also marks a resource as a Source wherever it sits in the tree. */
  sourceTag?: string
}

/**
 * A dynamic collection of every resource that links to the page holding it. This is the same
 * filter the app writes for a "Backlinks" collection, so pages made here match hand-made ones.
 */
export function backlinksCollection(): ResourceCollectionBlock {
  return collection({
    filter: { type: 'filter', filterType: 'field', id: 'backlinks', scope: 'edges', field: 'targetId', operator: 'equals', value: '$self' },
    title: 'Backlinks',
    isTitleHidden: false,
  })
}

/** The blocks of a new Source page: the backlinks collection, then an empty line to type into. */
export function sourcePageBlocks(): Block[] {
  return [backlinksCollection(), p()]
}

/** "From <Source>", where the source name is a mention so the Source page's backlinks list this page. */
export function sourceHeading(sourceId: string): HeadingBlock {
  return h(1, 'From ', mention({ resourceId: sourceId }))
}

export function isSource(index: ProjectIndex, resource: IndexedResource, config: SourceConfig): boolean {
  if (resource.id === config.sourcesRootId) return false
  if (config.sourceTag && resource.tags.some((tag) => normalizeName(tag) === normalizeName(config.sourceTag!))) return true
  return index.isDescendantOf(resource.id, config.sourcesRootId)
}

export function listSources(index: ProjectIndex, config: SourceConfig): IndexedResource[] {
  return [...index.byId.values()].filter((resource) => isSource(index, resource, config)).sort((a, b) => a.name.localeCompare(b.name))
}

/** Sources whose name or alias equals `name`. More than one means the UI must ask. */
export function findSources(index: ProjectIndex, name: string, config: SourceConfig): IndexedResource[] {
  return index.findByName(name).filter((resource) => isSource(index, resource, config))
}

export async function createSource(lk: LegendKeeper, index: ProjectIndex, name: string, config: SourceConfig): Promise<IndexedResource> {
  const created = await lk.resources.create({
    name,
    parentId: config.sourcesRootId,
    documents: [{ type: 'page', name: 'Main', blocks: sourcePageBlocks() }],
  })
  const indexed = ProjectIndex.fromListItem(created)
  index.upsert(indexed)
  return indexed
}

export interface SourceChoice {
  source: IndexedResource
  created: boolean
  /** Existing Sources with the same name, which the UI offers before creating a duplicate. */
  existing: IndexedResource[]
}

/**
 * Reuses a Source with this name when exactly one exists, and otherwise creates one. The extension
 * will prompt instead of deciding; `onExisting: 'create'` is that prompt's "create another" answer.
 */
export async function findOrCreateSource(
  lk: LegendKeeper,
  index: ProjectIndex,
  name: string,
  config: SourceConfig,
  { onExisting = 'reuse' }: { onExisting?: 'reuse' | 'create' } = {},
): Promise<SourceChoice> {
  const existing = findSources(index, name, config)
  if (existing.length > 0 && onExisting === 'reuse') return { source: existing[0]!, created: false, existing }
  return { source: await createSource(lk, index, name, config), created: true, existing }
}

export interface PageMetadata {
  url: string
  /** <meta property="og:site_name"> */
  ogSiteName?: string
  /** <meta name="application-name"> */
  applicationName?: string
}

/**
 * The name of the website a clip came from, for the "From This Website" Source: the site's
 * declared name when it has one, otherwise a readable form of the host ("www.dndbeyond.com" → "Dndbeyond").
 */
export function siteName(meta: PageMetadata): string {
  for (const declared of [meta.ogSiteName, meta.applicationName]) {
    const name = declared?.replace(/\s+/g, ' ').trim()
    if (name) return name
  }
  const host = new URL(meta.url).hostname.replace(/^www\d*\./, '')
  const labels = host.split('.')
  // Drop the public suffix: one label ("com"), or two for forms like "co.uk".
  const suffixLength = labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? 2 : 1
  const core = labels.length > suffixLength ? labels.slice(0, -suffixLength) : labels
  const main = core.at(-1) ?? host
  return main.charAt(0).toUpperCase() + main.slice(1)
}
