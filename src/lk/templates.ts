import { VersionMismatchError, type LegendKeeper } from '@legendkeeper/sdk'
import type { Block, PropertyBlock } from '@legendkeeper/sdk/blocks'
import { applyComposition, type Composition } from '../fill/compose.js'
import type { PropertyOp, TemplateTree } from '../fill/template.js'
import { readBlocks } from './pages.js'
import { ProjectIndex, TEMPLATES_ROOT, type IndexedResource } from './projectIndex.js'

/**
 * Templates live in the project under the virtual root "templates". They come back from
 * resources.list with everything else, so the page list already holds them: no extra request is
 * needed to list them, and they are kept out of search and linking (see ProjectIndex.pages).
 */

export interface TemplateSummary {
  resource: IndexedResource
  /** "Class Template / Subclass Template" for a nested template. */
  path: string
}

export function listTemplates(index: ProjectIndex): TemplateSummary[] {
  return [...index.byId.values()]
    .filter((resource) => index.isTemplate(resource.id))
    .map((resource) => ({ resource, path: index.ancestors(resource.id).filter((a) => a.id !== TEMPLATES_ROOT).map((a) => a.name).concat(resource.name).join(' / ') }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export interface TemplateContent {
  id: string
  name: string
  updatedAt: string | null
  tree: TemplateTree
  /** Tabs that are not pages (maps, boards…), which templates copy but slots ignore. */
  otherTabs: string[]
}

/**
 * Reads a template's page tabs and sidebar. Each read is cached by template id and its updatedAt,
 * so choosing the same template again is instant and a template edited in LegendKeeper is re-read.
 */
export class TemplateCache {
  private readonly cache = new Map<string, Promise<TemplateContent>>()

  get(lk: LegendKeeper, template: IndexedResource): Promise<TemplateContent> {
    const key = `${template.id}@${template.updatedAt ?? ''}`
    let entry = this.cache.get(key)
    if (!entry) {
      entry = readTemplate(lk, template.id)
      entry.catch(() => this.cache.delete(key))
      this.cache.set(key, entry)
    }
    return entry
  }
}

export async function readTemplate(lk: LegendKeeper, templateId: string): Promise<TemplateContent> {
  const resource = await lk.resources.get({ resourceId: templateId })
  const docs: TemplateTree['docs'] = []
  const otherTabs: string[] = []
  for (const doc of resource.documents) {
    if (doc.type !== 'page') {
      if (doc.type !== 'blank') otherTabs.push(doc.name ?? doc.type)
      continue
    }
    const read = await readBlocks(lk, { resourceId: templateId, documentId: doc.id })
    docs.push({ name: doc.name ?? 'Main', blocks: read.blocks })
  }
  return { id: resource.id, name: resource.name, updatedAt: resource.updatedAt ?? null, tree: { docs, properties: (resource.properties ?? []) as PropertyBlock[] }, otherTabs }
}

/** The new page was made, but writing the values into it failed. */
export class TemplateFillError extends Error {
  constructor(
    readonly resource: IndexedResource,
    override readonly cause: unknown,
  ) {
    super(`The page "${resource.name}" was created from the template, but filling it in failed.`)
    this.name = 'TemplateFillError'
  }
}

export async function createFromTemplate(
  lk: LegendKeeper,
  index: ProjectIndex,
  { templateId, name, parentId }: { templateId: string; name: string; parentId?: string },
): Promise<IndexedResource> {
  // Child pages of templates are not copied (includeChildren stays off).
  const created = await lk.resources.createFromTemplate({ templateId, name, ...(parentId ? { parentId } : {}) })
  const resource = ProjectIndex.fromListItem(created as Parameters<typeof ProjectIndex.fromListItem>[0])
  index.upsert(resource)
  return resource
}

/**
 * Writes a composition into a page made from the template: one replaceBlocks per page tab, guarded
 * by the version just read (a concurrent edit is re-read and filled again), then the sidebar.
 * Blocks the API can't express come back as "unsupported" with ids and are echoed unchanged.
 */
export async function fillPage(lk: LegendKeeper, resourceId: string, composition: Composition, { maxAttempts = 3 } = {}): Promise<{ missing: string[] }> {
  const resource = await lk.resources.get({ resourceId })
  const pages = resource.documents.filter((d) => d.type === 'page')
  const missing = new Set<string>()
  let ops: PropertyOp[] = []
  for (let attempt = 1; ; attempt++) {
    const reads = []
    for (const doc of pages) {
      const ref = { resourceId, documentId: doc.id }
      let read = await readBlocks(lk, ref)
      if (read.blocks.some((b) => !b.id)) {
        await lk.documents.assignBlockIds(ref)
        read = await readBlocks(lk, ref)
      }
      reads.push({ ref, doc, read })
    }
    const tree: TemplateTree = { docs: reads.map((r) => ({ name: r.doc.name ?? 'Main', blocks: r.read.blocks })), properties: (resource.properties ?? []) as PropertyBlock[] }
    const filled = applyComposition(tree, composition)
    for (const id of filled.missing) missing.add(id)
    ops = filled.properties
    try {
      for (const [i, r] of reads.entries()) {
        const blocks = filled.docs[i] as Block[]
        if (JSON.stringify(blocks) === JSON.stringify(r.read.blocks)) continue
        await lk.documents.replaceBlocks(r.ref, { blocks, ifMatch: r.read.version })
      }
      break
    } catch (error) {
      if (!(error instanceof VersionMismatchError) || attempt >= maxAttempts) throw error
    }
  }
  for (const op of ops) await propertyOp(lk, resourceId, op)
  return { missing: [...missing] }
}

async function propertyOp(lk: LegendKeeper, resourceId: string, op: PropertyOp): Promise<void> {
  const ref = { resourceId, propertyId: op.propertyId }
  if (op.op === 'updateRow') await lk.properties.updateRow({ ...ref, rowId: op.rowId }, { content: op.content })
  else if (op.op === 'deleteRow') await lk.properties.deleteRow({ ...ref, rowId: op.rowId })
  else if (op.op === 'delete') await lk.properties.delete(ref)
  else await lk.properties.update(ref, op.patch as Parameters<LegendKeeper['properties']['update']>[1])
}
