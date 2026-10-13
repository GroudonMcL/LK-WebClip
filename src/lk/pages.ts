import { VersionMismatchError, type LegendKeeper } from '@legendkeeper/sdk'
import { rule, type Block, type DocumentBlocks } from '@legendkeeper/sdk/blocks'
import { ProjectIndex, WRITABLE_DOCUMENT_TYPES, writableDocuments, type IndexedResource } from './projectIndex.js'
import { sourceHeading } from './sources.js'

export interface DocumentRef {
  resourceId: string
  documentId: string
}

/** The content of a new clip page: the Source heading (unless the credit is off), then the clipped blocks. */
export function newPageClip(sourceId: string | undefined, content: Block[]): Block[] {
  return [...(sourceId ? [sourceHeading(sourceId)] : []), ...content]
}

/** What an append adds to the end of a page: a divider, the Source heading (unless the credit is off), then the clipped blocks. */
export function appendedClip(sourceId: string | undefined, content: Block[]): Block[] {
  return [rule(), ...(sourceId ? [sourceHeading(sourceId)] : []), ...content]
}

export async function createPage(
  lk: LegendKeeper,
  index: ProjectIndex,
  { parentId, name, blocks, tags }: { parentId?: string; name: string; blocks: Block[]; tags?: string[] },
): Promise<{ resource: IndexedResource; document: DocumentRef }> {
  const created = await lk.resources.create({
    name,
    ...(parentId ? { parentId } : {}),
    ...(tags ? { tags } : {}),
    documents: [{ type: 'page', name: 'Main', blocks }],
  })
  const resource = ProjectIndex.fromListItem(created)
  index.upsert(resource)
  return { resource, document: { resourceId: resource.id, documentId: resource.documents[0]!.id } }
}

export class NotAppendableError extends Error {
  constructor(
    readonly resource: IndexedResource,
    readonly documentType: string,
  ) {
    super(`"${resource.name}" is a ${documentType} document, so clipped text cannot be appended to it. Pick a page tab instead.`)
    this.name = 'NotAppendableError'
  }
}

/**
 * The document to append to. A resource with one writable tab needs no choice; with several the
 * caller must name one (the extension will ask). Maps, boards and timelines are never targets.
 */
export function resolveAppendTarget(resource: IndexedResource, documentId?: string): DocumentRef {
  if (documentId) {
    const doc = resource.documents.find((d) => d.id === documentId)
    if (!doc) throw new Error(`"${resource.name}" has no document ${documentId}.`)
    if (!WRITABLE_DOCUMENT_TYPES.has(doc.type)) throw new NotAppendableError(resource, doc.type)
    return { resourceId: resource.id, documentId: doc.id }
  }
  const writable = writableDocuments(resource)
  if (writable.length === 0) throw new NotAppendableError(resource, resource.documents[0]?.type ?? 'missing')
  if (writable.length > 1) {
    throw new Error(`"${resource.name}" has ${writable.length} page tabs (${writable.map((d) => d.name).join(', ')}). Choose one.`)
  }
  return { resourceId: resource.id, documentId: writable[0]!.id }
}

export interface AppendResult {
  document: DocumentBlocks
  /** How many writes were tried; more than one means a concurrent edit was detected and re-read. */
  attempts: number
  strategy: AppendStrategy
}

/**
 * - `replace`: one atomic write of the existing tree plus the new blocks, guarded by ifMatch.
 *   Nothing appears unless everything does. The whole page travels in the request (1 MB limit).
 * - `insert`: one blocks.insert per new block at the end of the page, each guarded by ifMatch.
 *   Existing blocks are never sent back, but a failure part-way leaves a partial clip.
 */
export type AppendStrategy = 'replace' | 'insert'

export interface AppendOptions {
  strategy?: AppendStrategy
  maxAttempts?: number
  /** Called after each read and before the write. The proof of concept uses it to simulate a concurrent edit. */
  beforeWrite?: (attempt: number, read: DocumentBlocks) => Promise<void>
}

/** Above this the replace strategy would risk the API's 1 MB request limit, so append block by block. */
const REPLACE_BODY_LIMIT = 900_000

export async function appendToDocument(lk: LegendKeeper, ref: DocumentRef, blocks: Block[], options: AppendOptions = {}): Promise<AppendResult> {
  const maxAttempts = options.maxAttempts ?? 3
  for (let attempt = 1; ; attempt++) {
    let read = await lk.documents.getBlocks(ref)
    if (read.blocks.some((block) => !block.id)) {
      // Pages written before block ids existed. Unsupported blocks can only be echoed by id, so give them ids first.
      await lk.documents.assignBlockIds(ref)
      read = await lk.documents.getBlocks(ref)
    }
    await options.beforeWrite?.(attempt, read)

    const strategy = options.strategy ?? (JSON.stringify(read.blocks).length + JSON.stringify(blocks).length > REPLACE_BODY_LIMIT ? 'insert' : 'replace')
    try {
      if (strategy === 'replace') {
        const document = await lk.documents.replaceBlocks(ref, { blocks: [...read.blocks, ...blocks], ifMatch: read.version })
        return { document, attempts: attempt, strategy }
      }
      let version = read.version
      for (const [i, block] of blocks.entries()) {
        try {
          version = (await lk.blocks.insert(ref, { block, ifMatch: version })).version
        } catch (error) {
          // Only a conflict on the first block is safe to retry from scratch: nothing has been written yet.
          if (i > 0 && error instanceof VersionMismatchError) throw new PartialAppendError(i, blocks.length, error)
          throw error
        }
      }
      return { document: await lk.documents.getBlocks(ref), attempts: attempt, strategy }
    } catch (error) {
      if (!(error instanceof VersionMismatchError) || attempt >= maxAttempts) throw error
    }
  }
}

export class PartialAppendError extends Error {
  constructor(
    readonly written: number,
    readonly total: number,
    override readonly cause: unknown,
  ) {
    super(`The page changed while the clip was being appended: ${written} of ${total} blocks were written.`)
    this.name = 'PartialAppendError'
  }
}
