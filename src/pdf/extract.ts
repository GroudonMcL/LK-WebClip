import type { PDFPageProxy } from 'pdfjs-dist'
import type { Box, PageContent, PdfImage, PdfShape, PdfText } from './types.js'

/**
 * Reads one PDF page with pdf.js into positioned text, filled shapes and images.
 *
 * Coordinates are PDF points with the origin at the top left of the page as it is shown (y grows
 * downwards), so they line up with the rendered page. That is pdf.js's viewport at scale 1, which
 * also takes care of pages whose CropBox does not start at the origin (common in print PDFs, where
 * the trimmed page sits inside a larger sheet with crop marks) and of pages with a /Rotate.
 * pdf.js must be opened with `fontExtraProperties: true`, or the real font names (which tell
 * headings, body text and stat blocks apart) are not available.
 *
 * `ops` is pdf.js's OPS table. It is passed in so the same code runs with the browser build in the
 * extension and the legacy build in Node.
 */
export async function extractPage(page: PDFPageProxy, ops: Record<string, number>): Promise<PageContent> {
  const viewport = page.getViewport({ scale: 1 })
  const width = viewport.width
  const height = viewport.height
  // User space (the PDF's own coordinates) to the shown page, top-down.
  const toPage = viewport.transform as Matrix
  const operators = await page.getOperatorList()
  const content = await page.getTextContent()

  const fontNames = new Map<string, string>()
  const fontName = (id: string): string => {
    let name = fontNames.get(id)
    if (name === undefined) {
      try {
        const font = page.commonObjs.get(id) as { name?: string } | undefined
        name = (font?.name ?? id).replace(/^[A-Z]{6}\+/, '')
      } catch {
        name = id
      }
      fontNames.set(id, name)
    }
    return name
  }

  const text: PdfText[] = []
  for (const item of content.items) {
    if (!('str' in item) || item.str === '') continue
    const [a, b, c, d, e, f] = multiply(toPage, item.transform as Matrix)
    const size = Math.hypot(c, d)
    // Text that is not upright as shown (spines, decorative labels) is left out: it is never part
    // of the reading flow. Upright text has a positive a and, as the page's y runs downwards, a
    // negative d.
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d >= 0 || size < 1) continue
    const font = fontName(item.fontName)
    text.push({
      str: item.str,
      x: e,
      y: f,
      w: item.width,
      size,
      font,
      bold: /bold|black|heavy|semibold|demi/i.test(font),
      italic: /italic|oblique/i.test(font),
    })
  }

  const { images, shapes, hiddenText } = placeDrawing(operators, ops, toPage)
  return { number: page.pageNumber, width, height, text, shapes, images, ...(hiddenText ? { hiddenText } : {}) }
}

/**
 * Walks the drawing operators, tracking the transform, to place images and filled shapes in page
 * coordinates. Also notes text drawn invisibly (rendering mode 3 or 7): the recognised text layer
 * that OCR puts over a scanned page.
 */
function placeDrawing(operators: { fnArray: number[]; argsArray: unknown[] }, ops: Record<string, number>, toPage: Matrix): { images: PdfImage[]; shapes: PdfShape[]; hiddenText: boolean } {
  const names = new Map(Object.entries(ops).map(([k, v]) => [v, k]))
  const images: PdfImage[] = []
  const shapes: PdfShape[] = []
  let ctm: Matrix = toPage
  const stack: Matrix[] = []
  let fill = '#000000'
  const fillStack: string[] = []
  let hiddenText = false
  operators.fnArray.forEach((fn, i) => {
    const args = operators.argsArray[i] as unknown[]
    switch (names.get(fn)) {
      case 'save': stack.push(ctm); fillStack.push(fill); break
      case 'restore': ctm = stack.pop() ?? ctm; fill = fillStack.pop() ?? fill; break
      case 'transform': ctm = multiply(ctm, args as Matrix); break
      case 'paintFormXObjectBegin': {
        stack.push(ctm); fillStack.push(fill)
        const m = args[0] as Matrix | null
        if (m) ctm = multiply(ctm, m)
        break
      }
      case 'paintFormXObjectEnd': ctm = stack.pop() ?? ctm; fill = fillStack.pop() ?? fill; break
      case 'setFillRGBColor': fill = String(args[0]); break
      case 'setFillGray': case 'setFillCMYKColor': case 'setFillColorN': fill = 'other'; break
      case 'setTextRenderingMode': if (args[0] === 3 || args[0] === 7) hiddenText = true; break
      case 'paintImageXObject': case 'paintImageXObjectRepeat': {
        const [id, pw, ph] = args as [string, number, number]
        const box = transformBox(ctm, [0, 0, 1, 1])
        images.push({ id, width: pw, height: ph, ...box })
        break
      }
      case 'constructPath': {
        // [paint op, path data, [minX, minY, maxX, maxY]] in the current transform.
        const [op, , minMax] = args as [number, unknown, number[] | null]
        const paint = names.get(op)
        if (!minMax || !paint || !/fill/i.test(paint)) break
        const box = transformBox(ctm, minMax as [number, number, number, number])
        if (box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1) break
        shapes.push({ ...box, fill })
        break
      }
    }
  })

  return { images, shapes, hiddenText }
}

type Matrix = [number, number, number, number, number, number]

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function transformBox(m: Matrix, [x0, y0, x1, y1]: [number, number, number, number]) {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
    xs.push(m[0] * x + m[2] * y + m[4])
    ys.push(m[1] * x + m[3] * y + m[5])
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** An image's pixels as pdf.js decoded them: an ImageBitmap in browsers, raw bytes in Node. */
export interface PdfImageData {
  width: number
  height: number
  /** 1: 1 bit per pixel grey, 2: RGB, 3: RGBA. */
  kind?: number
  data?: Uint8ClampedArray | Uint8Array
  bitmap?: ImageBitmap
}

/**
 * Decodes one of a page's images. pdf.js names images afresh each time it reads a page, so the image
 * is found again by where it is drawn (the last one drawn there, as `pickImages` keeps).
 */
export async function pageImage(page: PDFPageProxy, ops: Record<string, number>, image: Box): Promise<PdfImageData | null> {
  const operators = await page.getOperatorList()
  const toPage = page.getViewport({ scale: 1 }).transform as Matrix
  const near = (a: number, b: number) => Math.abs(a - b) < 1
  const found = placeDrawing(operators, ops, toPage).images.filter((i) => near(i.x0, image.x0) && near(i.y0, image.y0) && near(i.x1, image.x1) && near(i.y1, image.y1)).at(-1)
  if (!found) return null
  // Images shared between pages live in the document's common objects.
  const objs = found.id.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise((resolve) => {
    try {
      objs.get(found.id, (data: unknown) => resolve((data as PdfImageData | undefined) ?? null))
    } catch {
      resolve(null)
    }
  })
}
