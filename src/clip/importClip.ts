import type { LegendKeeper } from '@legendkeeper/sdk'
import type { Block } from '@legendkeeper/sdk/blocks'
import { ensureAssetFolder, importImage } from '../lk/images.js'
import { appendToDocument, appendedClip, createPage, newPageClip, type DocumentRef } from '../lk/pages.js'
import type { IndexedResource, ProjectIndex } from '../lk/projectIndex.js'
import { createSource, type SourceConfig } from '../lk/sources.js'
import { htmlStringToBlocks, mapBlocks, visit, type ClipImage } from './htmlToBlocks.js'
import { resolveLinks, type AmbiguousLink, type LinkConversion } from './links.js'

/** What the capture script sends from the page. */
export interface Capture {
  /** selection: highlighted content; image: a right-clicked image; link: a right-clicked link; article: the page's main content. */
  kind: 'selection' | 'image' | 'link' | 'article'
  html: string
  text: string
  url: string
  /** The page's <title>. */
  title: string
  /** A useful default name for a new page: the article title or the heading nearest the selection. */
  suggestedTitle: string
  meta: { ogSiteName?: string; applicationName?: string; ogTitle?: string }
  capturedAt: string
}

export interface PrepareOptions {
  /** Turn links whose text names a page into LegendKeeper mentions. */
  linkify: boolean
  images: boolean
  parser: { parseFromString(html: string, type: 'text/html'): Document }
}

/** A converted clip, ready to preview and to import. */
export interface ClipPlan {
  blocks: Block[]
  images: ClipImage[]
  converted: LinkConversion[]
  ambiguous: AmbiguousLink[]
  warnings: string[]
}

export function prepareClip(capture: Capture, index: ProjectIndex, options: PrepareOptions): ClipPlan {
  const converted = htmlStringToBlocks(capture.html, options.parser, { baseUrl: capture.url, images: options.images })
  const links = options.linkify ? resolveLinks(converted.blocks, index) : { blocks: converted.blocks, converted: [], ambiguous: [] }
  const warnings = [...converted.warnings]
  if (links.blocks.length === 0) warnings.push('Nothing to import: the capture holds no text or images.')
  // Only images still in the tree count (an image inside a dropped element is gone).
  const srcs = new Set<string>()
  visit(links.blocks, (block) => {
    if (block.kind === 'image') srcs.add(block.url)
  })
  const images = converted.images.filter((image, i, all) => srcs.has(image.src) && all.findIndex((other) => other.src === image.src) === i)
  return { blocks: links.blocks, images, converted: links.converted, ambiguous: links.ambiguous, warnings }
}

export type Destination =
  | { mode: 'new'; parentId?: string; title: string }
  | { mode: 'append'; target: DocumentRef }

export type SourceSpec = { kind: 'existing'; resourceId: string } | { kind: 'new'; name: string }

export interface ImportOptions {
  destination: Destination
  source: SourceSpec
  sourceConfig: SourceConfig
  /** The asset-library folder clipped images go into. */
  assetFolderName?: string
  onProgress?: (message: string) => void
  fetchImpl?: typeof fetch
}

export interface ImportResult {
  resourceId: string
  documentId: string
  source: IndexedResource
  sourceCreated: boolean
  imagesUploaded: number
  imagesFailed: { src: string; reason: string }[]
  /** Opens the page in the LegendKeeper app. */
  url: string
}

export function appUrl(projectId: string, resourceId: string): string {
  return `https://www.legendkeeper.com/app/${projectId}/${resourceId}/`
}

export async function importClip(lk: LegendKeeper, index: ProjectIndex, plan: ClipPlan, options: ImportOptions): Promise<ImportResult> {
  const progress = options.onProgress ?? (() => {})
  const project = await lk.project()

  // 1. The Source, so the heading can mention it.
  let source: IndexedResource
  let sourceCreated = false
  if (options.source.kind === 'existing') {
    const found = index.get(options.source.resourceId)
    if (!found) throw new Error('The chosen Source is no longer in the project. Refresh and pick it again.')
    source = found
  } else {
    progress(`Creating the Source "${options.source.name}"…`)
    source = await createSource(lk, index, options.source.name, options.sourceConfig)
    sourceCreated = true
  }

  // 2. Images: upload each one once, then point the blocks at the uploaded copies.
  const uploaded = new Map<string, Block>()
  const imagesFailed: { src: string; reason: string }[] = []
  if (plan.images.length > 0) {
    const folderId = await ensureAssetFolder(lk, options.assetFolderName ?? 'LK Web Clipper')
    for (const [i, image] of plan.images.entries()) {
      progress(`Uploading image ${i + 1} of ${plan.images.length}…`)
      const name = image.alt || imageName(image.src)
      const result = await importImage(lk, image.src, { name, alt: image.alt || undefined, folderId, fetchImpl: options.fetchImpl })
      if (!result.ok) imagesFailed.push({ src: image.src, reason: result.reason })
      uploaded.set(image.src, result.block)
    }
  }
  const content = mapBlocks(plan.blocks, (block) => (block.kind === 'image' && uploaded.has(block.url) ? withAlt(uploaded.get(block.url)!, block) : block))

  // 3. Write.
  let ref: DocumentRef
  if (options.destination.mode === 'new') {
    progress('Creating the page…')
    const created = await createPage(lk, index, { parentId: options.destination.parentId, name: options.destination.title, blocks: newPageClip(source.id, content) })
    ref = created.document
  } else {
    progress('Appending to the page…')
    ref = options.destination.target
    await appendToDocument(lk, ref, appendedClip(source.id, content))
  }

  return {
    resourceId: ref.resourceId,
    documentId: ref.documentId,
    source,
    sourceCreated,
    imagesUploaded: plan.images.length - imagesFailed.length,
    imagesFailed,
    url: appUrl(project.id, ref.resourceId),
  }
}

function withAlt(replacement: Block, original: Block): Block {
  if (replacement.kind === 'image' && original.kind === 'image' && original.alt) return { ...replacement, alt: original.alt }
  return replacement
}

function imageName(src: string): string {
  if (src.startsWith('data:')) return 'Clipped image'
  try {
    const file = decodeURIComponent(new URL(src).pathname.split('/').filter(Boolean).at(-1) ?? '')
    return file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Clipped image'
  } catch {
    return 'Clipped image'
  }
}
