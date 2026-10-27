/** A box in PDF points, origin at the top left of the page. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One run of text as pdf.js reports it. `y` is the baseline. */
export interface PdfText {
  str: string
  x: number
  y: number
  w: number
  size: number
  /** The font's name without its subset prefix, e.g. "CrimsonText-Bold". */
  font: string
  bold: boolean
  italic: boolean
}

/** A filled area: a boxed-text background, a table stripe, a rule. */
export interface PdfShape extends Box {
  fill: string
}

/** Where an image is drawn. `id` names it in pdf.js's page objects; `width`/`height` are its pixels. */
export interface PdfImage extends Box {
  id: string
  width: number
  height: number
}

export interface PageContent {
  number: number
  /** The size of the page as shown (its CropBox, turned by its /Rotate), in points. */
  width: number
  height: number
  text: PdfText[]
  shapes: PdfShape[]
  images: PdfImage[]
  /** Some text is drawn invisibly: the recognised text that OCR lays over a scanned page. */
  hiddenText?: boolean
}
