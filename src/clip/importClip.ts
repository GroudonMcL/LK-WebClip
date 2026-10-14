import type { LegendKeeper } from '@legendkeeper/sdk'
import type { Block } from '@legendkeeper/sdk/blocks'
import { ensureAssetFolder, importImage } from '../lk/images.js'
import { appendTree, appendedTemplate, compose, imageUrls, mapImages, type Composition } from '../fill/compose.js'
import type { FillPlan } from '../fill/plan.js'
import { appendToDocument, appendedClip, createPage, newPageClip, type DocumentRef } from '../lk/pages.js'
import type { IndexedResource, ProjectIndex } from '../lk/projectIndex.js'
import { createSource, sourceHeading, type SourceConfig } from '../lk/sources.js'
import { createFromTemplate, fillPage, TemplateFillError, type TemplateContent } from '../lk/templates.js'
import { htmlStringToBlocks, mapBlocks, visit, type ClipImage } from './htmlToBlocks.js'
import { linkClip, type LinkOptions, type LinkTerm } from './links.js'

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
  /** How to link the clip to existing pages; omit to leave it unlinked. */
  links?: LinkOptions
  images: boolean
  parser: { parseFromString(html: string, type: 'text/html'): Document }
}

/** A converted clip, ready to preview and to import. */
export interface ClipPlan {
  blocks: Block[]
  images: ClipImage[]
  /** Every name or link that could become a page link, with what was decided for it. */
  terms: LinkTerm[]
  warnings: string[]
}

export function prepareClip(capture: Capture, index: ProjectIndex, options: PrepareOptions): ClipPlan {
  const converted = htmlStringToBlocks(capture.html, options.parser, { baseUrl: capture.url, images: options.images })
  const links = options.links ? linkClip(converted.blocks, index, options.links) : { blocks: converted.blocks, terms: [] }
  const warnings = [...converted.warnings]
  if (links.blocks.length === 0) warnings.push('Nothing to import: the capture holds no text or images.')
  // Only images still in the tree count (an image inside a dropped element is gone).
  const srcs = new Set<string>()
  visit(links.blocks, (block) => {
    if (block.kind === 'image') srcs.add(block.url)
  })
  const images = converted.images.filter((image, i, all) => srcs.has(image.src) && all.findIndex((other) => other.src === image.src) === i)
  return { blocks: links.blocks, images, terms: links.terms, warnings }
}

export type Destination =
  | { mode: 'new'; parentId?: string; title: string }
  | { mode: 'append'; target: DocumentRef }

export type SourceSpec = { kind: 'existing'; resourceId: string } | { kind: 'new'; name: string }

/** A template to fill: the plan is made on the full template for a new page, or on appendTree() for an append. */
export interface TemplateImport {
  content: TemplateContent
  plan: FillPlan
  /** Keep the template's placeholders in slots nothing was found for; otherwise remove those slots. */
  keepUnfilled: boolean
  /** Tags to add to the page (a stat block's size, type, alignment and CR). */
  tags?: string[]
}

export interface ImportOptions {
  destination: Destination
  /** The Source to credit with a "From <Source>" heading; undefined leaves the credit out. */
  source?: SourceSpec
  template?: TemplateImport
  sourceConfig: SourceConfig
  /** The asset-library folder clipped images go into. */
  assetFolderName?: string
  onProgress?: (message: string) => void
  fetchImpl?: typeof fetch
}

export interface ImportResult {
  resourceId: string
  documentId: string
  source?: IndexedResource
  sourceCreated: boolean
  /** Template slots the new page didn't have (the template changed while the clip was open). */
  templateMissing: string[]
  /** Tags added to the page. */
  tagsAdded: string[]
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
  let source: IndexedResource | undefined
  let sourceCreated = false
  if (options.source?.kind === 'existing') {
    const found = index.get(options.source.resourceId)
    if (!found) throw new Error('The chosen Source is no longer in the project. Refresh and pick it again.')
    source = found
  } else if (options.source?.kind === 'new') {
    progress(`Creating the Source "${options.source.name}"…`)
    source = await createSource(lk, index, options.source.name, options.sourceConfig)
    sourceCreated = true
  }

  // With a template, only the images that end up in the page are uploaded.
  const template = options.template
  const templateTree = template ? (options.destination.mode === 'new' ? template.content.tree : appendTree(template.content.tree)) : undefined
  let composition: Composition | undefined
  if (template && templateTree) {
    composition = compose(templateTree, template.plan, { sourceHeading: source ? sourceHeading(source.id) : undefined, keepUnfilled: template.keepUnfilled })
  }
  const wanted = composition ? imageUrls(composition) : undefined
  const images = wanted ? plan.images.filter((image) => wanted.has(image.src)) : plan.images

  // 2. Images: upload each one once, then point the blocks at the uploaded copies.
  const uploaded = new Map<string, Block>()
  const imagesFailed: { src: string; reason: string }[] = []
  if (images.length > 0) {
    const folderId = await ensureAssetFolder(lk, options.assetFolderName ?? 'LK Web Clipper')
    for (const [i, image] of images.entries()) {
      progress(`Uploading image ${i + 1} of ${images.length}…`)
      const name = image.alt || imageName(image.src)
      const result = await importImage(lk, image.src, { name, alt: image.alt || undefined, folderId, fetchImpl: options.fetchImpl })
      if (!result.ok) imagesFailed.push({ src: image.src, reason: result.reason })
      uploaded.set(image.src, result.block)
    }
  }
  const content = mapBlocks(plan.blocks, (block) => (block.kind === 'image' && uploaded.has(block.url) ? withAlt(uploaded.get(block.url)!, block) : block))

  // 3. Write.
  let ref: DocumentRef
  let templateMissing: string[] = []
  if (composition && templateTree && template) {
    composition = mapImages(composition, (url) => uploaded.get(url))
    if (options.destination.mode === 'new') {
      progress(`Creating the page from ${template.content.name}…`)
      const created = await createFromTemplate(lk, index, { templateId: template.content.id, name: options.destination.title, parentId: options.destination.parentId })
      progress('Filling in the template…')
      try {
        templateMissing = (await fillPage(lk, created.id, composition)).missing
      } catch (error) {
        throw Object.assign(new TemplateFillError(created, error), { composition, url: appUrl(project.id, created.id) })
      }
      ref = { resourceId: created.id, documentId: created.documents.find((d) => d.type === 'page' && d.name.toLowerCase() === 'main')?.id ?? created.documents[0]!.id }
    } else {
      progress('Adding the template to the page…')
      ref = options.destination.target
      await appendToDocument(lk, ref, appendedTemplate(templateTree, composition))
    }
  } else if (options.destination.mode === 'new') {
    progress('Creating the page…')
    const created = await createPage(lk, index, { parentId: options.destination.parentId, name: options.destination.title, blocks: newPageClip(source?.id, content) })
    ref = created.document
  } else {
    progress('Appending to the page…')
    ref = options.destination.target
    await appendToDocument(lk, ref, appendedClip(source?.id, content))
  }

  // 4. Tags, added to the ones the page has (a new page has the template's).
  let tagsAdded: string[] = []
  if (template?.tags?.length) {
    progress('Adding tags…')
    const current = (await lk.resources.get({ resourceId: ref.resourceId })).tags ?? []
    tagsAdded = template.tags.filter((tag) => !current.includes(tag))
    if (tagsAdded.length > 0) {
      const tags = [...current, ...tagsAdded]
      await lk.resources.update({ resourceId: ref.resourceId }, { tags })
      const indexed = index.get(ref.resourceId)
      if (indexed) index.upsert({ ...indexed, tags })
    }
  }

  return {
    resourceId: ref.resourceId,
    documentId: ref.documentId,
    source,
    sourceCreated,
    templateMissing,
    tagsAdded,
    imagesUploaded: images.length - imagesFailed.length,
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
