/**
 * Prototype for the PDF reader: reflows a PDF into clean HTML and writes a side-by-side page
 * (original page on the left, reflowed text on the right) for checking the result.
 *
 *   npm run pdf:reflow -- <file.pdf> [out-dir] [--pages 3-9] [--styles overrides.json] [--layout layout.json] [--json]
 *
 * Writes <out-dir>/index.html with the reflowed text and extracted images. The page renders on the
 * left need poppler's `pdftoppm`; without it only the reflowed text is shown. `--json` also writes
 * the raw extraction (pages.json) for debugging the reflow rules.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPage, pageImage, type PdfImageData } from '../src/pdf/extract.js'
import { reflow, pickImages, type ReflowOptions } from '../src/pdf/reflow.js'
import { renderReader } from '../src/pdf/render.js'
import type { PageContent } from '../src/pdf/types.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [value] = args.splice(i, 2).slice(1)
  return value
}
const json = args.includes('--json') ? (args.splice(args.indexOf('--json'), 1), true) : false
const range = flag('--pages')
const styles = flag('--styles')
const layout = flag('--layout')
const [file, outArg] = args
if (!file) {
  console.error('Usage: npm run pdf:reflow -- <file.pdf> [out-dir] [--pages 3-9] [--styles overrides.json] [--layout layout.json] [--json]')
  process.exit(1)
}
const out = outArg ?? `dist/pdf-reflow/${basename(file, '.pdf')}`
await mkdir(join(out, 'img'), { recursive: true })

const doc = await getDocument({ data: new Uint8Array(await readFile(file)), fontExtraProperties: true, disableFontFace: true, verbosity: 0 }).promise
const [first, last] = range ? range.split('-').map(Number) : [1, doc.numPages]
const pages: PageContent[] = []
const pdfPages = new Map<number, Awaited<ReturnType<typeof doc.getPage>>>()
for (let n = first ?? 1; n <= (last ?? first ?? doc.numPages); n++) {
  const page = await doc.getPage(n)
  pdfPages.set(n, page)
  pages.push(await extractPage(page, OPS as unknown as Record<string, number>))
}
if (json) await writeFile(join(out, 'pages.json'), JSON.stringify(pages))

// Images: keep the illustrations, drop page backgrounds and repeated decorations.
const imageFiles = new Map<string, string>()
for (const image of pickImages(pages)) {
  const page = pdfPages.get(image.page)
  if (!page) continue
  const data = await pageImage(page, OPS as unknown as Record<string, number>, image)
  if (!data?.data) continue
  const name = `img/p${image.page}-${image.id.replace(/\W/g, '_')}.png`
  await writeFile(join(out, name), encodePng({ ...data, data: data.data }))
  imageFiles.set(`${image.page}:${image.id}`, name)
}

// --layout takes the reader's Layout as JSON: {"columns": 2, "divider": {"odd": 0.48}, "margins": {"right": 0.1}}.
const options: ReflowOptions = {
  ...(styles ? { styles: JSON.parse(await readFile(styles, 'utf8')) } : {}),
  ...(layout ? { layout: JSON.parse(await readFile(layout, 'utf8')) } : {}),
}
const result = reflow(pages, options)
if (result.scanned.length) console.warn(`${result.scanned.length} page(s) carry invisible (OCR) text: the layout is only approximate.`)

let pageImages: Map<number, string> | undefined
try {
  execFileSync('pdftoppm', ['-r', '72', '-jpeg', '-f', String(first), '-l', String(last), file, join(out, 'page')])
  const digits = String(doc.numPages).length
  pageImages = new Map(pages.map((p) => [p.number, `page-${String(p.number).padStart(digits, '0')}.jpg`]))
} catch {
  console.warn('pdftoppm not found: the page renders are left out.')
}

await writeFile(join(out, 'index.html'), renderReader(result, pages, {
  title: basename(file, '.pdf'),
  imageSrc: (page, id) => imageFiles.get(`${page}:${id}`),
  pageImage: pageImages ? (n) => pageImages.get(n) : undefined,
}))
await writeFile(join(out, 'styles.json'), JSON.stringify(result.styles, null, 2))
console.log(`Reflowed ${pages.length} pages into ${join(out, 'index.html')}`)
console.log(`Detected text styles (edit and pass with --styles to correct them): ${join(out, 'styles.json')}`)

/** Minimal PNG encoder for pdf.js image data (1 bpp grey, RGB or RGBA). */
function encodePng(img: PdfImageData & { data: Uint8ClampedArray | Uint8Array }): Buffer {
  const { width, height, kind, data } = img
  const rgba = Buffer.alloc(width * height * 4)
  if (kind === 3) rgba.set(data.subarray(0, rgba.length))
  else if (kind === 2) for (let i = 0, j = 0; i < width * height; i++, j += 3) rgba.set([data[j] ?? 0, data[j + 1] ?? 0, data[j + 2] ?? 0, 255], i * 4)
  else {
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = ((data[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1 ? 255 : 0
      rgba.set([v, v, v, 255], (y * width + x) * 4)
    }
  }
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
