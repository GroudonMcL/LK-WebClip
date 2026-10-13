import type { LegendKeeper } from '@legendkeeper/sdk'
import { image, link, p, type Block } from '@legendkeeper/sdk/blocks'

export type ImageContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Identifies the image formats LegendKeeper accepts from their first bytes, ignoring what the server claimed. */
export function sniffImageType(bytes: Uint8Array): ImageContentType | undefined {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

export interface FetchedImage {
  data: Uint8Array
  contentType: ImageContentType
}

export async function fetchImage(url: string, { referer, fetchImpl = fetch }: { referer?: string; fetchImpl?: typeof fetch } = {}): Promise<FetchedImage> {
  const response = await fetchImpl(url, { headers: referer ? { Referer: referer } : {}, redirect: 'follow' })
  if (!response.ok) throw new Error(`the image host answered ${response.status} ${response.statusText}`.trim())
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error(`the image is ${(data.byteLength / 1e6).toFixed(1)} MB, over the 20 MB limit`)
  const contentType = sniffImageType(data)
  if (!contentType) {
    throw new Error(`not a PNG, JPEG, GIF or WebP image (the host called it ${response.headers.get('content-type') ?? 'nothing'})`)
  }
  return { data, contentType }
}

export type ImageImport =
  | { ok: true; assetId: string; url: string; block: Block }
  | { ok: false; reason: string; block: Block }

/**
 * Copies a web image into the project's asset library and returns an image block for it.
 * Image blocks accept only the project's own asset URLs, so this upload is unavoidable. When it
 * fails the clip keeps a link to the original instead of silently dropping the image.
 */
export async function importImage(
  lk: LegendKeeper,
  sourceUrl: string,
  { name, alt, folderId, referer, fetchImpl }: { name: string; alt?: string; folderId?: string; referer?: string; fetchImpl?: typeof fetch },
): Promise<ImageImport> {
  try {
    const fetched = await fetchImage(sourceUrl, { referer, fetchImpl })
    const asset = await lk.assets.uploadImage({
      data: fetched.data,
      contentType: fetched.contentType,
      name,
      description: `Clipped from ${sourceUrl}`,
      ...(folderId ? { folderId } : {}),
    })
    if (!asset.url) throw new Error('the upload returned no asset url')
    return { ok: true, assetId: asset.id, url: asset.url, block: image(asset.url, alt ?? name) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason, block: p('Image not imported (', reason, '): ', link(sourceUrl, alt || sourceUrl)) }
  }
}

/** Finds the clipper's asset folder at the library root, creating it the first time. */
export async function ensureAssetFolder(lk: LegendKeeper, name: string): Promise<string> {
  for await (const asset of await lk.assets.list({ limit: 100 })) {
    if (asset.type === 'FOLDER' && asset.name === name) return asset.id
  }
  return (await lk.assets.createFolder({ name })).id
}
