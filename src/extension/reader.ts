/**
 * The PDF reader: an extension page showing a PDF's pages next to a reflowed, clippable copy of its
 * text. Chrome's own PDF viewer cannot be scripted, so PDFs are opened here instead
 * (reader.html?src=<url>, or a file dropped on the page).
 *
 * Text is read page by page in the background (pdf.js), reflowed with src/pdf/reflow.ts and shown
 * as HTML; page renders and images are drawn only when they scroll into view. Clipping reuses the
 * web capture code on the reflowed HTML, so the side panel treats a PDF clip like any other.
 *
 * Corrections are kept per PDF (by its fingerprint): text styles, each page's layout, areas marked
 * on the pages, scan mode, and pages whose reflowed text was edited by hand.
 */
// The legacy build: the current one needs JavaScript newer than many Chrome versions have.
import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Capture } from '../clip/importClip.js'
import { extractPage, pageImage, type PdfImageData } from '../pdf/extract.js'
import { reflow, type PageLayout, type ReflowResult, type Region, type RegionKind, type Role } from '../pdf/reflow.js'
import { blocksToHtml } from '../pdf/render.js'
import type { PageContent } from '../pdf/types.js'
import './capture.js'
import type { CaptureRequest } from './capture.js'
import { clear, el } from './dom.js'
import { setPendingCapture } from './state.js'
import { registerReaderTab, type ReaderCaptureMessage, type ReaderCaptureReply } from './tabCapture.js'

GlobalWorkerOptions.workerSrc = 'pdf.worker.mjs'

/** Pages read before the text is first shown; the rest follow in the background. */
const FIRST_PAGES = 6
/** How often (in pages read) the text is reflowed again while the rest of the book loads. */
const REFLOW_EVERY = 20

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const titleEl = $('book-title')
const statusEl = $('status')
const main = $('main')
const pagesPane = $('pages')
const textPane = $('text')
const flow = $('flow')
const stylesPane = $('styles')
const sendButton = $<HTMLButtonElement>('send')
const stylesButton = $<HTMLButtonElement>('toggle-styles')
const markButton = $<HTMLButtonElement>('mark-area')
const fileInput = $<HTMLInputElement>('file')
const drop = $('drop')

interface Book {
  doc: PDFDocumentProxy
  task: PDFDocumentLoadingTask
  url: string
  title: string
  fingerprint: string
  pages: PageContent[]
  result?: ReflowResult
  overrides: Record<string, Role>
  /** Page layouts set by hand, areas marked on the pages, and scan mode (undefined: as detected). */
  layouts: Record<number, PageLayout>
  regions: Region[]
  scan?: boolean
  /** Pages whose text was edited by hand: their HTML, shown instead of the reflowed text. */
  edits: Record<number, string>
  images: Map<string, Promise<Blob | null>>
  /** A second copy of the PDF that only decodes images (see `imageBlob`), and the pages it has read. */
  imageDoc?: { task: PDFDocumentLoadingTask; pagesRead: number }
  bytes: Uint8Array
  loaded: boolean
}

let book: Book | undefined
let tabId: number | undefined
/** Each open bumps this, so a book still loading in the background stops when another is opened. */
let generation = 0

void start()

async function start(): Promise<void> {
  tabId = (await chrome.tabs.getCurrent())?.id
  if (tabId !== undefined) await registerReaderTab(tabId)
  chrome.runtime.onMessage.addListener(onMessage)
  wireFileOpening()
  wirePanes()
  wireMarking()

  const src = new URLSearchParams(location.search).get('src')
  if (!src) return showDrop('Open a PDF to read and clip it.')
  try {
    const data = await download(src)
    await openBook(data, src, fileName(src))
  } catch (error) {
    showDrop(error instanceof Error ? error.message : String(error), src)
  }
}

// ---------------------------------------------------------------------------------- opening

async function download(src: string): Promise<Uint8Array> {
  if (src.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    throw new FileAccessError()
  }
  // XMLHttpRequest, because fetch() cannot read file: URLs even when the extension may.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', src)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) && xhr.response
      ? resolve(new Uint8Array(xhr.response as ArrayBuffer))
      : reject(new Error(`Could not download the PDF (${xhr.status} ${xhr.statusText}).`))
    xhr.onerror = () => reject(new Error('Could not download the PDF.'))
    xhr.send()
  })
}

class FileAccessError extends Error {
  constructor() {
    super('To open PDFs saved on your computer, turn on “Allow access to file URLs” for LegendKeeper Clipper, then reload this tab.')
  }
}

function wireFileOpening(): void {
  $('open-file').addEventListener('click', () => fileInput.click())
  $('choose-file').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void openFile(file)
    fileInput.value = ''
  })
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    drop.hidden = false
    drop.classList.add('over')
  })
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) drop.classList.remove('over')
  })
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('over')
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    if (file) void openFile(file)
    else if (!book) showDrop('That is not a PDF.')
    else drop.hidden = true
  })
}

async function openFile(file: File): Promise<void> {
  try {
    await openBook(new Uint8Array(await file.arrayBuffer()), `file:///${encodeURIComponent(file.name)}`, file.name)
  } catch (error) {
    showDrop(error instanceof Error ? error.message : String(error))
  }
}

function showDrop(message: string, src?: string): void {
  const messageEl = $('drop-message')
  clear(messageEl, message)
  if (src?.startsWith('file:')) {
    messageEl.append(' ', el('button', { type: 'button', class: 'link', onclick: () => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }, 'Open the extension’s settings'),
      el('br'), el('span', { class: 'muted' }, 'Or drop the file here: that works without the setting.'))
  }
  drop.hidden = false
  statusEl.textContent = ''
}

async function openBook(data: Uint8Array, url: string, name: string): Promise<void> {
  const run = ++generation
  drop.hidden = true
  statusEl.textContent = 'Opening…'
  // pdf.js takes over the buffer it is given, and images need a copy of their own.
  const bytes = data.slice()
  const task = getDocument({ data, fontExtraProperties: true })
  const doc = await task.promise
  const info = (await doc.getMetadata().catch(() => undefined))?.info as { Title?: string } | undefined
  const title = info?.Title?.trim() && !/^untitled|\.(indd|docx?|pdf)$/i.test(info.Title.trim()) ? info.Title.trim() : bookName(name)
  const fingerprint = doc.fingerprints[0] ?? url
  const stored = await chrome.storage.local.get([stylesKey(fingerprint), pagesKey(fingerprint), editsKey(fingerprint)])
  const settings = (stored[pagesKey(fingerprint)] as PageSettings | undefined) ?? {}
  book?.task.destroy().catch(() => {})
  book?.imageDoc?.task.destroy().catch(() => {})
  book = {
    doc, task, bytes, url, title, fingerprint, pages: [],
    overrides: (stored[stylesKey(fingerprint)] as Record<string, Role> | undefined) ?? {},
    layouts: settings.layouts ?? {},
    regions: settings.regions ?? [],
    scan: settings.scan,
    edits: (stored[editsKey(fingerprint)] as Record<number, string> | undefined) ?? {},
    images: new Map(),
    loaded: false,
  }
  editing = undefined
  document.title = `${title} · LK Reader`
  titleEl.textContent = title
  clear(flow)
  buildPagePlaceholders(doc.numPages)
  markButton.disabled = false

  for (let n = 1; n <= doc.numPages; n++) {
    if (run !== generation) return
    const page = await doc.getPage(n)
    book.pages.push(await extractPage(page, OPS as unknown as Record<string, number>))
    sizePlaceholder(book.pages.at(-1)!)
    page.cleanup()
    statusEl.textContent = `Reading page ${n} of ${doc.numPages}…`
    if (n === Math.min(FIRST_PAGES, doc.numPages) || (n > FIRST_PAGES && n % REFLOW_EVERY === 0)) showText()
  }
  book.loaded = true
  showText()
  stylesButton.disabled = false
}

function bookName(file: string): string {
  return decodeURIComponent(file).replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled PDF'
}

function fileName(src: string): string {
  try {
    return new URL(src).pathname.split('/').pop() || src
  } catch {
    return src
  }
}

const stylesKey = (fingerprint: string) => `pdfStyles:${fingerprint}`
const pagesKey = (fingerprint: string) => `pdfPages:${fingerprint}`
const editsKey = (fingerprint: string) => `pdfEdits:${fingerprint}`

interface PageSettings {
  layouts?: Record<number, PageLayout>
  regions?: Region[]
  scan?: boolean
}

async function savePageSettings(target: Book): Promise<void> {
  const settings: PageSettings = { layouts: target.layouts, regions: target.regions, ...(target.scan === undefined ? {} : { scan: target.scan }) }
  await chrome.storage.local.set({ [pagesKey(target.fingerprint)]: settings })
}

// ---------------------------------------------------------------------------------- the text

function showText(): void {
  if (!book) return
  // Re-showing would throw away a page being edited; it happens when the edit is done.
  if (editing) return
  const current = book
  const anchor = scrollAnchor()
  current.result = reflow(current.pages, { styles: current.overrides, layouts: current.layouts, regions: current.regions, scan: current.scan })
  flow.innerHTML = blocksToHtml(current.result.blocks, () => '', { statblockButton: 'Send to LegendKeeper', wrapPages: true, pageHtml: (n) => current.edits[n] })
  for (const img of Array.from(flow.querySelectorAll<HTMLImageElement>('img[data-pdf-image]'))) imageObserver.observe(img)
  addPageTools(current)
  if (anchor) restoreAnchor(anchor)
  const total = current.doc.numPages
  statusEl.textContent = current.loaded || current.pages.length === total
    ? `${total} page${total === 1 ? '' : 's'}${current.result.scan ? ' · scan mode' : ''} · select text and right-click “Send to LegendKeeper”, or use the buttons`
    : `Reading page ${current.pages.length} of ${total}…`
  if (!stylesPane.hidden) renderStyles()
}

/** The first block in view, so re-showing the text (as more pages load) keeps the reader's place. */
function scrollAnchor(): { page: number; y: number; offset: number } | undefined {
  const top = textPane.getBoundingClientRect().top
  const first = Array.from(flow.querySelectorAll<HTMLElement>('[data-boxes]')).find((e) => e.getBoundingClientRect().bottom > top)
  if (!first || textPane.scrollTop === 0) return undefined
  const [box] = boxesOf(first)
  return box ? { page: box[0], y: box[2], offset: first.getBoundingClientRect().top - top } : undefined
}

function restoreAnchor(anchor: { page: number; y: number; offset: number }): void {
  const target = Array.from(flow.querySelectorAll<HTMLElement>('[data-boxes]')).find((e) => {
    const [box] = boxesOf(e)
    return box && (box[0] > anchor.page || (box[0] === anchor.page && box[2] >= anchor.y - 1))
  })
  if (target) textPane.scrollTop += target.getBoundingClientRect().top - textPane.getBoundingClientRect().top - anchor.offset
}

type BoxTuple = [page: number, x0: number, y0: number, x1: number, y1: number]

function boxesOf(e: HTMLElement): BoxTuple[] {
  try {
    return JSON.parse(e.dataset.boxes ?? '[]') as BoxTuple[]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------- images

const imageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const img = entry.target as HTMLImageElement
    imageObserver.unobserve(img)
    void imageBlob(img.dataset.pdfImage ?? '').then((blob) => {
      if (blob) img.src = URL.createObjectURL(blob)
    })
  }
}, { root: textPane, rootMargin: '800px' })

/** Pages the image copy reads before it is replaced, which frees the images it holds. */
const IMAGE_DOC_PAGES = 16

/**
 * An image as WebP (small, and keeps transparency), decoded once and kept.
 *
 * pdf.js only hands over an image's pixels the first time it reads a page, and the main copy has
 * read (and freed) every page already. So images come from a second copy of the PDF, replaced every
 * few pages so it doesn't keep every image it has decoded.
 */
function imageBlob(key: string): Promise<Blob | null> {
  const current = book
  if (!current) return Promise.resolve(null)
  let blob = current.images.get(key)
  if (!blob) {
    const [page, ...rest] = key.split(':')
    const id = rest.join(':')
    // Where it was drawn when the page was first read.
    const placed = current.pages.find((p) => p.number === Number(page))?.images.filter((i) => i.id === id).at(-1)
    blob = imageQueue = imageQueue.then(async () => {
      if (!placed) return null
      if (!current.imageDoc || current.imageDoc.pagesRead >= IMAGE_DOC_PAGES) {
        current.imageDoc?.task.destroy().catch(() => {})
        current.imageDoc = { task: getDocument({ data: current.bytes.slice() }), pagesRead: 0 }
      }
      current.imageDoc.pagesRead++
      const doc = await current.imageDoc.task.promise
      const data = await pageImage(await doc.getPage(Number(page)), OPS as unknown as Record<string, number>, placed)
      return data ? toBlob(data) : null
    }).catch(() => null)
    current.images.set(key, blob)
  }
  return blob
}

/** Images are decoded one at a time, so replacing the image copy never cuts one off. */
let imageQueue: Promise<Blob | null> = Promise.resolve(null)

function toBlob(img: PdfImageData): Promise<Blob | null> {
  const canvas = new OffscreenCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0)
  else if (img.data) {
    const rgba = new Uint8ClampedArray(img.width * img.height * 4)
    const { data, width, height } = img
    if (img.kind === 3) rgba.set(data.subarray(0, rgba.length))
    else if (img.kind === 2) for (let i = 0, j = 0; i < width * height; i++, j += 3) rgba.set([data[j] ?? 0, data[j + 1] ?? 0, data[j + 2] ?? 0, 255], i * 4)
    else {
      const rowBytes = (width + 7) >> 3
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const v = ((data[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1 ? 255 : 0
        rgba.set([v, v, v, 255], (y * width + x) * 4)
      }
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
  } else return Promise.resolve(null)
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// ---------------------------------------------------------------------------------- the pages

const rendered = new Map<number, { canvas: HTMLCanvasElement; task?: { cancel(): void } }>()

const pageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const n = Number((entry.target as HTMLElement).dataset.page)
    if (entry.isIntersecting) void renderPage(n, entry.target as HTMLElement)
    else unrenderPage(n)
  }
}, { root: pagesPane, rootMargin: '1200px 0px' })

function buildPagePlaceholders(count: number): void {
  pageObserver.disconnect()
  for (const r of rendered.values()) r.task?.cancel()
  rendered.clear()
  clear(pagesPane)
  for (let n = 1; n <= count; n++) {
    const div = el('div', { class: 'page', 'data-page': String(n), style: 'aspect-ratio: 612 / 792', title: `Page ${n}: click to find it in the text` }, el('span', { class: 'page-number' }, String(n)))
    pagesPane.append(div)
    pageObserver.observe(div)
  }
}

function sizePlaceholder(page: PageContent): void {
  const div = pagesPane.querySelector<HTMLElement>(`.page[data-page="${page.number}"]`)
  if (!div) return
  div.style.aspectRatio = `${page.width} / ${page.height}`
  div.dataset.w = String(page.width)
  div.dataset.h = String(page.height)
  drawRegions(page.number)
  // Pages after the ones read so far are guessed to be the same size.
  for (let n = page.number + 1; n <= page.number + 3; n++) {
    const next = pagesPane.querySelector<HTMLElement>(`.page[data-page="${n}"]`)
    if (next && !next.dataset.w) next.style.aspectRatio = `${page.width} / ${page.height}`
  }
}

async function renderPage(n: number, div: HTMLElement): Promise<void> {
  if (!book || rendered.has(n)) return
  const doc = book.doc
  const canvas = el('canvas')
  const entry: { canvas: HTMLCanvasElement; task?: { cancel(): void } } = { canvas }
  rendered.set(n, entry)
  const page = await doc.getPage(n)
  if (rendered.get(n) !== entry || book?.doc !== doc) return
  const base = page.getViewport({ scale: 1 })
  div.style.aspectRatio = `${base.width} / ${base.height}`
  div.dataset.w = String(base.width)
  div.dataset.h = String(base.height)
  const scale = (div.clientWidth * devicePixelRatio) / base.width
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport })
  entry.task = task
  div.prepend(canvas)
  await task.promise.catch(() => {})
}

function unrenderPage(n: number): void {
  const entry = rendered.get(n)
  if (!entry) return
  entry.task?.cancel()
  entry.canvas.remove()
  rendered.delete(n)
}

// ---------------------------------------------------------------------------------- highlighting and keeping in step

function wirePanes(): void {
  flow.addEventListener('mouseover', (e) => {
    const block = (e.target as Element).closest<HTMLElement>('[data-boxes]')
    if (block && !block.classList.contains('statblock')) highlight(block, false)
  })
  flow.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLElement>('.clip-statblock')
    if (button) return sendStatblock(button.parentElement!)
    const block = (e.target as Element).closest<HTMLElement>('[data-boxes]')
    if (block && getSelection()?.isCollapsed) highlight(block, true)
  })
  pagesPane.addEventListener('click', (e) => {
    const page = (e.target as Element).closest<HTMLElement>('.page')
    if (!page || marking || (e.target as Element).closest('.region-menu, .region')) return
    const rect = page.getBoundingClientRect()
    const n = Number(page.dataset.page)
    const y = ((e.clientY - rect.top) / rect.height) * Number(page.dataset.h ?? 792)
    const blocks = Array.from(flow.querySelectorAll<HTMLElement>('[data-boxes]'))
    const target = blocks.find((b) => boxesOf(b).some(([p, , y0, , y1]) => p === n && y >= y0 - 4 && y <= y1 + 4))
      ?? blocks.find((b) => boxesOf(b).some(([p]) => p >= n))
    if (target) {
      syncing = true
      target.scrollIntoView({ block: 'center' })
      highlight(target, false)
      setTimeout(() => (syncing = false), 100)
    }
  })
  textPane.addEventListener('scroll', followText, { passive: true })
  document.addEventListener('selectionchange', () => {
    sendButton.disabled = !selectionInFlow()
  })
  sendButton.addEventListener('click', () => {
    if (!selectionInFlow()) return
    send({ kind: 'selection' })
  })
  stylesButton.addEventListener('click', () => {
    stylesPane.hidden = !stylesPane.hidden
    main.classList.toggle('with-styles', !stylesPane.hidden)
    if (!stylesPane.hidden) renderStyles()
  })
}

function highlight(block: HTMLElement, scroll: boolean): void {
  for (const old of Array.from(pagesPane.querySelectorAll('.hl'))) old.remove()
  let first: HTMLElement | undefined
  for (const [p, x0, y0, x1, y1] of boxesOf(block)) {
    const page = pagesPane.querySelector<HTMLElement>(`.page[data-page="${p}"]`)
    if (!page) continue
    const w = Number(page.dataset.w ?? 612)
    const h = Number(page.dataset.h ?? 792)
    const box = el('div', { class: 'hl', style: `left:${(x0 / w) * 100}%;top:${(y0 / h) * 100}%;width:${((x1 - x0) / w) * 100}%;height:${((y1 - y0) / h) * 100}%` })
    page.append(box)
    first ??= box
  }
  if (scroll && first) {
    syncing = true
    first.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setTimeout(() => (syncing = false), 600)
  }
}

let syncing = false

/** Scrolling the text brings its page into view on the left. */
function followText(): void {
  if (syncing) return
  const top = textPane.getBoundingClientRect().top
  const block = Array.from(flow.querySelectorAll<HTMLElement>('[data-boxes]')).find((e) => e.getBoundingClientRect().bottom > top + 40)
  const [box] = block ? boxesOf(block) : []
  if (!box) return
  const page = pagesPane.querySelector<HTMLElement>(`.page[data-page="${box[0]}"]`)
  if (!page) return
  const target = page.offsetTop + (box[2] / Number(page.dataset.h ?? 792)) * page.offsetHeight - 80
  if (Math.abs(pagesPane.scrollTop - target) > pagesPane.clientHeight / 2) pagesPane.scrollTop = target
}

// ---------------------------------------------------------------------------------- page layouts and editing

const LAYOUTS: [PageLayout, string][] = [['auto', 'Auto'], ['one', 'One column'], ['two', 'Two columns'], ['three', 'Three columns'], ['sidebar', 'Text and sidebar']]

/** The page being edited, if any. */
let editing: { page: number; div: HTMLElement } | undefined

/** Each page marker gets the page's layout and an Edit button (or, once edited, Undo edit). */
function addPageTools(current: Book): void {
  for (const marker of Array.from(flow.querySelectorAll<HTMLElement>('.page-marker'))) {
    const n = Number(marker.dataset.page)
    const found = current.result?.layouts.find((l) => l.page === n)
    const detected = found ? `${found.columns === 1 ? 'one column' : `${found.columns} columns`}${found.sidebar ? ', sidebar' : ''}` : ''
    const select = el('select', { class: 'page-layout', 'aria-label': `Layout of page ${n}`, title: 'How this page’s columns are read' },
      ...LAYOUTS.map(([value, label]) => el('option', { value, selected: (current.layouts[n] ?? 'auto') === value }, value === 'auto' && detected ? `Auto: ${detected}` : label)))
    select.addEventListener('change', () => void setLayout(current, n, select.value as PageLayout))
    const edited = current.edits[n] !== undefined
    marker.append(el('span', { class: 'page-tools' },
      select,
      edited ? el('span', { class: 'edited', title: 'This page shows your edited text, whatever its layout' }, 'Edited') : null,
      el('button', { type: 'button', class: 'link', onclick: () => (edited ? void undoEdit(current, n) : startEdit(n)) }, edited ? 'Undo edit' : 'Edit text')))
  }
}

async function setLayout(target: Book, page: number, layout: PageLayout): Promise<void> {
  const layouts = { ...target.layouts }
  if (layout === 'auto') delete layouts[page]
  else layouts[page] = layout
  target.layouts = layouts
  await savePageSettings(target)
  if (book === target) showText()
}

function startEdit(page: number): void {
  if (editing) finishEdit(false)
  const div = flow.querySelector<HTMLElement>(`.page-text[data-page="${page}"]`)
  const marker = flow.querySelector<HTMLElement>(`.page-marker[data-page="${page}"]`)
  if (!div || !marker) return
  editing = { page, div }
  for (const button of Array.from(div.querySelectorAll<HTMLElement>('.clip-statblock'))) button.contentEditable = 'false'
  div.contentEditable = 'true'
  div.classList.add('editing')
  marker.querySelector('.page-tools')?.replaceWith(el('span', { class: 'page-tools' },
    el('span', { class: 'muted' }, 'Editing: Ctrl+Enter saves, Esc cancels'),
    el('button', { type: 'button', class: 'primary small', onclick: () => finishEdit(true) }, 'Save'),
    el('button', { type: 'button', class: 'small', onclick: () => finishEdit(false) }, 'Cancel')))
  div.focus()
}

function finishEdit(save: boolean): void {
  const current = book
  const edit = editing
  if (!edit || !current) return
  editing = undefined
  if (save) {
    current.edits = { ...current.edits, [edit.page]: cleanEdit(edit.div) }
    void chrome.storage.local.set({ [editsKey(current.fingerprint)]: current.edits })
  }
  showText()
}

async function undoEdit(target: Book, page: number): Promise<void> {
  const edits = { ...target.edits }
  delete edits[page]
  target.edits = edits
  await chrome.storage.local.set({ [editsKey(target.fingerprint)]: edits })
  if (book === target) showText()
}

const KEEP = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'STRONG', 'EM', 'B', 'I', 'BR', 'FIGURE', 'IMG', 'SECTION', 'BUTTON'])
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'svg'])
const KEEP_ATTRS: Record<string, string[]> = { IMG: ['data-pdf-image', 'width', 'height', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], SECTION: ['class'], BUTTON: ['class', 'type', 'title'] }

/**
 * An edited page's HTML, kept to what the reflowed text uses: headings, paragraphs, lists, tables,
 * quotes, bold and italic, images and stat blocks. Where each block sits on the page stays, so
 * highlighting still works; the editor's own markup (styles, spans, divs for new lines) goes.
 */
function cleanEdit(div: HTMLElement): string {
  const root = div.cloneNode(true) as HTMLElement
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      walk(child)
      const tag = child.tagName
      if (DROP.has(tag)) {
        child.remove()
        continue
      }
      const keep = KEEP.has(tag) && (tag !== 'SECTION' || child.classList.contains('statblock')) && (tag !== 'BUTTON' || child.classList.contains('clip-statblock'))
      if (tag === 'DIV') {
        // Chrome starts a new line in an editable area with a div.
        const p = document.createElement('p')
        for (const attr of Array.from(child.attributes)) if (attr.name === 'data-boxes') p.setAttribute(attr.name, attr.value)
        p.append(...Array.from(child.childNodes))
        child.replaceWith(p)
        continue
      }
      if (!keep) {
        child.replaceWith(...Array.from(child.childNodes))
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        if (attr.name !== 'data-boxes' && !(KEEP_ATTRS[tag] ?? []).includes(attr.name)) child.removeAttribute(attr.name)
      }
      if (tag === 'SECTION') child.className = 'statblock'
      if (tag === 'BUTTON') child.className = 'clip-statblock'
    }
  }
  walk(root)
  // Paragraphs emptied by the edit go.
  for (const p of Array.from(root.querySelectorAll('p, h1, h2, h3, h4, li'))) {
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove()
  }
  return root.innerHTML.trim()
}

// ---------------------------------------------------------------------------------- marking areas

const REGION_LABELS: Record<RegionKind, string> = { block: 'One block', skip: 'Left out', table: 'Table' }

let marking = false

function setMarking(on: boolean): void {
  marking = on
  markButton.classList.toggle('active', on)
  markButton.setAttribute('aria-pressed', String(on))
  pagesPane.classList.toggle('marking', on)
  if (!on) for (const old of Array.from(pagesPane.querySelectorAll('.drawing, .region-menu'))) old.remove()
}

/** Where a pointer event is on a page, in PDF points. */
function pagePoint(page: HTMLElement, e: PointerEvent): { x: number; y: number } {
  const rect = page.getBoundingClientRect()
  const w = Number(page.dataset.w ?? 612)
  const h = Number(page.dataset.h ?? 792)
  return {
    x: Math.min(Math.max(((e.clientX - rect.left) / rect.width) * w, 0), w),
    y: Math.min(Math.max(((e.clientY - rect.top) / rect.height) * h, 0), h),
  }
}

function placeBox(node: HTMLElement, page: HTMLElement, box: { x0: number; y0: number; x1: number; y1: number }): void {
  const w = Number(page.dataset.w ?? 612)
  const h = Number(page.dataset.h ?? 792)
  Object.assign(node.style, { left: `${(box.x0 / w) * 100}%`, top: `${(box.y0 / h) * 100}%`, width: `${((box.x1 - box.x0) / w) * 100}%`, height: `${((box.y1 - box.y0) / h) * 100}%` })
}

function wireMarking(): void {
  markButton.addEventListener('click', () => setMarking(!marking))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && marking) setMarking(false)
    if (editing && e.key === 'Escape') finishEdit(false)
    if (editing && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      finishEdit(true)
    }
  })
  let drag: { page: HTMLElement; start: { x: number; y: number }; box: HTMLElement } | undefined
  pagesPane.addEventListener('pointerdown', (e) => {
    if (!marking || e.button !== 0 || (e.target as Element).closest('.region-menu, .region button')) return
    const page = (e.target as Element).closest<HTMLElement>('.page')
    if (!page) return
    e.preventDefault()
    for (const old of Array.from(pagesPane.querySelectorAll('.drawing, .region-menu'))) old.remove()
    const box = el('div', { class: 'drawing' })
    page.append(box)
    drag = { page, start: pagePoint(page, e), box }
    placeBox(box, page, { x0: drag.start.x, y0: drag.start.y, x1: drag.start.x, y1: drag.start.y })
    pagesPane.setPointerCapture(e.pointerId)
  })
  pagesPane.addEventListener('pointermove', (e) => {
    if (!drag) return
    const p = pagePoint(drag.page, e)
    placeBox(drag.box, drag.page, { x0: Math.min(p.x, drag.start.x), y0: Math.min(p.y, drag.start.y), x1: Math.max(p.x, drag.start.x), y1: Math.max(p.y, drag.start.y) })
  })
  pagesPane.addEventListener('pointerup', (e) => {
    if (!drag) return
    const { page, start, box } = drag
    drag = undefined
    const p = pagePoint(page, e)
    const area = { x0: Math.min(p.x, start.x), y0: Math.min(p.y, start.y), x1: Math.max(p.x, start.x), y1: Math.max(p.y, start.y) }
    if (area.x1 - area.x0 < 6 || area.y1 - area.y0 < 6) {
      box.remove()
      return
    }
    askRegionKind(page, box, { page: Number(page.dataset.page), kind: 'block', ...area })
  })
}

/** The menu under a newly drawn area: what its text is. */
function askRegionKind(page: HTMLElement, box: HTMLElement, region: Region): void {
  const choose = (kind: RegionKind) => () => {
    menu.remove()
    box.remove()
    if (book) void addRegion(book, { ...region, kind })
  }
  const menu = el('div', { class: 'region-menu', role: 'menu' },
    el('button', { type: 'button', onclick: choose('block') }, 'Read as one block'),
    el('button', { type: 'button', onclick: choose('skip') }, 'Leave out'),
    el('button', { type: 'button', onclick: choose('table') }, 'Read as a table'),
    el('button', { type: 'button', class: 'link', onclick: () => { menu.remove(); box.remove() } }, 'Cancel'))
  const h = Number(page.dataset.h ?? 792)
  menu.style.left = box.style.left
  menu.style.top = `${(region.y1 / h) * 100}%`
  page.append(menu)
}

async function addRegion(target: Book, region: Region): Promise<void> {
  target.regions = [...target.regions, region]
  await savePageSettings(target)
  drawRegions(region.page)
  if (book === target) showText()
}

async function removeRegion(target: Book, region: Region): Promise<void> {
  target.regions = target.regions.filter((r) => r !== region)
  await savePageSettings(target)
  drawRegions(region.page)
  if (book === target) showText()
}

/** Shows the areas marked on a page (or every page), each with a button to remove it. */
function drawRegions(only?: number): void {
  const current = book
  if (!current) return
  for (const page of Array.from(pagesPane.querySelectorAll<HTMLElement>('.page'))) {
    const n = Number(page.dataset.page)
    if (only !== undefined && n !== only) continue
    for (const old of Array.from(page.querySelectorAll('.region'))) old.remove()
    for (const region of current.regions.filter((r) => r.page === n)) {
      const box = el('div', { class: `region region-${region.kind}`, title: REGION_LABELS[region.kind] },
        el('span', { class: 'region-label' }, REGION_LABELS[region.kind],
          el('button', { type: 'button', title: 'Remove this area', 'aria-label': `Remove the “${REGION_LABELS[region.kind]}” area`, onclick: (e: Event) => { e.stopPropagation(); void removeRegion(current, region) } }, '×')))
      placeBox(box, page, region)
      page.append(box)
    }
  }
}

// ---------------------------------------------------------------------------------- text styles

function renderStyles(): void {
  if (!book?.result) return
  const current = book
  const styles = current.result!.styles.filter((s) => s.chars > 0)
  const roles: [Role, string][] = [['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['body', 'Text'], ['ignore', 'Leave out']]
  const scan = el('input', { type: 'checkbox', checked: current.result!.scan })
  scan.addEventListener('change', () => void setScan(current, scan.checked))
  clear(stylesPane,
    el('label', { class: 'scan-mode' }, scan,
      el('span', {}, el('strong', {}, 'Scanned book'), current.scan === undefined && current.result!.scan ? ' (detected)' : '',
        el('br'), el('span', { class: 'muted' }, 'For a scan with OCR text: headings are found from their size alone, and uneven lines are joined.'))),
    el('h2', {}, 'Text styles'),
    el('p', { class: 'muted' }, current.result!.scan
      ? 'Each text size in this PDF, largest first. If a heading came out as text (or the other way round), change it here. Corrections are remembered for this PDF.'
      : 'Each font and size in this PDF, largest first. If a heading came out as text (or the other way round), change it here. Corrections are remembered for this PDF.'),
    ...styles.map((s) => {
      const select = el('select', { 'aria-label': `Role of ${s.key}` }, ...roles.map(([value, label]) => el('option', { value, selected: s.role === value }, label)))
      select.addEventListener('change', () => void setRole(current, s.key, select.value as Role))
      return el('div', { class: `style${s.auto ? '' : ' changed'}` },
        el('span', { class: 'style-example', title: s.example, style: `font-size:${Math.min(Math.max(s.size, 9), 22)}px` }, s.example || '(no text)'),
        select,
        el('span', { class: 'style-key' }, `${s.font} · ${s.size}pt · ${s.chars.toLocaleString()} characters`))
    }),
    Object.keys(current.overrides).length ? el('button', { type: 'button', onclick: () => void resetRoles(current) }, 'Undo all corrections') : null,
  )
}

async function setRole(target: Book, key: string, role: Role): Promise<void> {
  target.overrides = { ...target.overrides, [key]: role }
  await chrome.storage.local.set({ [stylesKey(target.fingerprint)]: target.overrides })
  if (book === target) showText()
}

async function setScan(target: Book, on: boolean): Promise<void> {
  target.scan = on
  await savePageSettings(target)
  if (book === target) showText()
}

async function resetRoles(target: Book): Promise<void> {
  target.overrides = {}
  await chrome.storage.local.remove(stylesKey(target.fingerprint))
  if (book === target) showText()
}

// ---------------------------------------------------------------------------------- clipping

function selectionInFlow(): boolean {
  const selection = getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  return flow.contains(selection.getRangeAt(0).commonAncestorContainer)
}

function sendStatblock(section: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(section)
  const button = section.querySelector('.clip-statblock')
  if (button) range.setStartAfter(button)
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  send({ kind: 'selection' })
}

/** Sends a clip from a button: opens the side panel (which needs this click) and hands it the capture. */
function send(request: CaptureRequest): void {
  if (tabId === undefined) return
  const id = tabId
  chrome.sidePanel.open({ tabId: id }).catch(() => {})
  void capture(request)
    .then((c) => setPendingCapture({ id: crypto.randomUUID(), tabId: id, capture: c }))
    .catch((error) => setPendingCapture({ id: crypto.randomUUID(), tabId: id, error: error instanceof Error ? error.message : String(error) }))
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, reply: (r: ReaderCaptureReply) => void): boolean | undefined {
  const m = message as ReaderCaptureMessage
  if (m?.type !== 'lk-reader-capture' || m.tabId !== tabId) return undefined
  capture(m.request)
    .then((c) => reply({ capture: c }))
    .catch((error) => reply({ error: error instanceof Error ? error.message : String(error) }))
  return true
}

/**
 * Captures from the reflowed text with the web capture code: the selection (a right-clicked image
 * selects its figure), or for a whole-page clip, the PDF page in view. Images go along as WebP
 * data URLs, which the importer uploads like any web image.
 */
async function capture(request: CaptureRequest): Promise<Capture> {
  if (!book?.result) throw new Error('The PDF is still opening.')
  const selection = getSelection()!
  const saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined
  let kind: Capture['kind'] = 'selection'
  if (request.kind === 'image' && request.srcUrl) {
    const figure = Array.from(flow.querySelectorAll('img')).find((img) => img.src === request.srcUrl)?.closest('figure')
    if (figure) select(figure)
    kind = 'image'
  } else if (request.kind !== 'selection' || !selectionInFlow()) {
    if (!selectPageInView()) throw new Error('Nothing to clip on this page yet.')
    kind = 'article'
  }
  try {
    const raw = (globalThis as unknown as { __lkCapture(r: CaptureRequest): Capture }).__lkCapture({ kind: 'selection', selectionText: request.selectionText })
    const html = await finishHtml(raw.html)
    return {
      ...raw,
      kind,
      html,
      url: book.url,
      title: book.title,
      // The book is the "website": "From The Forgotten Tomb of Acererak".
      meta: { ogSiteName: book.title },
      suggestedTitle: raw.suggestedTitle && raw.suggestedTitle !== document.title ? raw.suggestedTitle : book.title,
    }
  } finally {
    if (kind !== 'selection') {
      selection.removeAllRanges()
      if (saved) selection.addRange(saved)
    }
  }
}

function select(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Selects the text of the PDF page at the top of the text pane, from its marker to the next. */
function selectPageInView(): boolean {
  const top = textPane.getBoundingClientRect().top
  const markers = Array.from(flow.querySelectorAll<HTMLElement>('.page-marker'))
  const current = [...markers].reverse().find((m) => m.getBoundingClientRect().top <= top + 60) ?? markers[0]
  if (!current) return false
  const range = document.createRange()
  range.setStartAfter(current)
  const next = markers[markers.indexOf(current) + 1]
  if (next) range.setEndBefore(next)
  else range.setEndAfter(flow.lastChild!)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/** Puts the images in as data URLs and removes the reader's own markup. */
async function finishHtml(html: string): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = html
  const root = template.content
  for (const node of Array.from(root.querySelectorAll('.clip-statblock, .page-marker'))) node.remove()
  for (const node of Array.from(root.querySelectorAll('.page-text'))) node.replaceWith(...Array.from(node.childNodes))
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const key = img.dataset.pdfImage
    const blob = key ? await imageBlob(key) : null
    if (blob) img.setAttribute('src', await blobToDataUrl(blob))
    else img.remove()
    img.removeAttribute('data-pdf-image')
  }
  for (const node of Array.from(root.querySelectorAll('[data-boxes]'))) node.removeAttribute('data-boxes')
  const div = document.createElement('div')
  div.append(root)
  return div.innerHTML
}
