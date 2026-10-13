/**
 * Runs inside the web page (an isolated content-script world) when the user clips something.
 * The extension injects this file, then calls `__lkCapture(request)`. It returns plain data only:
 * the clipped HTML with every URL made absolute, and the page's metadata.
 */
import { Readability } from '@mozilla/readability'
import type { Capture } from '../clip/importClip.js'
import { markLabelElements } from '../clip/labelElements.js'

export interface CaptureRequest {
  kind: Capture['kind']
  /** From the context menu: the right-clicked image or link, and the selected text. */
  srcUrl?: string
  linkUrl?: string
  selectionText?: string
}

const BLOCK_TAGS = /^(P|DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|NAV|H[1-6]|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|HR|DETAILS|SUMMARY|BODY|HTML|FORM|FIELDSET|ADDRESS|CENTER)$/
const INLINE_WRAPPERS = /^(A|B|STRONG|I|EM|U|S|DEL|INS|STRIKE|CODE|KBD|SAMP|SUB|SUP|CITE|MARK|SMALL|SPAN)$/

function capture(request: CaptureRequest): Capture {
  const base = {
    url: location.href,
    title: document.title,
    meta: {
      ogSiteName: metaContent('meta[property="og:site_name"]'),
      applicationName: metaContent('meta[name="application-name"]'),
      ogTitle: metaContent('meta[property="og:title"]'),
    },
    capturedAt: new Date().toISOString(),
  }

  if (request.kind === 'selection') {
    const selection = captureSelection()
    if (selection) return { ...base, kind: 'selection', ...selection }
    if (request.selectionText) {
      const p = document.createElement('p')
      p.textContent = request.selectionText
      return { ...base, kind: 'selection', html: p.outerHTML, text: request.selectionText, suggestedTitle: pageTitle() }
    }
  }

  if (request.kind === 'image' && request.srcUrl) {
    const img = Array.from(document.images).find((el) => el.currentSrc === request.srcUrl || el.src === request.srcUrl)
    const figure = img?.closest('figure')
    const caption = figure?.querySelector('figcaption')?.textContent?.trim()
    const alt = img?.alt?.trim() || caption || ''
    const html = `<figure><img src="${attr(request.srcUrl)}" alt="${attr(alt)}">${caption ? `<figcaption>${escape(caption)}</figcaption>` : ''}</figure>`
    return { ...base, kind: 'image', html, text: alt, suggestedTitle: alt || pageTitle() }
  }

  if (request.kind === 'link' && request.linkUrl) {
    const anchor = Array.from(document.links).find((el) => el.href === request.linkUrl)
    const text = anchor?.textContent?.trim() || request.linkUrl
    return { ...base, kind: 'link', html: `<p><a href="${attr(request.linkUrl)}">${escape(text)}</a></p>`, text, suggestedTitle: text }
  }

  // The page's main content, the way reader modes find it.
  const clone = document.cloneNode(true) as Document
  // Readability drops class names, so remove page furniture it would keep as text ("[edit]") first.
  for (const furniture of Array.from(clone.querySelectorAll('.mw-editsection'))) furniture.remove()
  // It also drops the classes that mark stat block and infobox labels, so make those bold first.
  markLabelElements(clone.body)
  const article = new Readability(clone, { keepClasses: false }).parse()
  if (article?.content) {
    return { ...base, kind: 'article', html: article.content, text: article.textContent ?? '', suggestedTitle: preferHeading(article.title?.trim()) || pageTitle() }
  }
  return { ...base, kind: 'article', html: absolutized(document.body).innerHTML, text: document.body.innerText, suggestedTitle: pageTitle() }
}

function captureSelection(): { html: string; text: string; suggestedTitle: string } | undefined {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const container = document.createElement('div')
  for (let i = 0; i < selection.rangeCount; i++) container.append(withContext(selection.getRangeAt(i)))
  absolutizeTree(container)
  const text = selection.toString()
  if (!text.trim() && !container.querySelector('img, table')) return undefined
  const firstHeading = container.querySelector('h1, h2, h3, h4')?.textContent?.trim()
  return { html: container.innerHTML, text, suggestedTitle: firstHeading || nearestHeading(selection.getRangeAt(0)) || pageTitle() }
}

/**
 * A range's contents lose the elements around them: selecting two items of a list gives two
 * <li> with no list, and selecting words inside a heading gives bare text. Put back the
 * enclosing list, table, heading or inline formatting so the clip keeps its meaning.
 */
function withContext(range: Range): Node {
  const fragment = range.cloneContents()
  let ancestor: Node | null = range.commonAncestorContainer
  if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentNode
  const el = ancestor as Element | null
  if (!el) return fragment

  const tops = Array.from(fragment.childNodes).filter((n) => n.nodeType === Node.ELEMENT_NODE) as Element[]
  if (tops.length > 0 && tops.every((t) => t.tagName === 'LI')) {
    const list = el.closest('ul, ol')
    if (list) return wrap(list, fragment)
  }
  if (tops.length > 0 && tops.every((t) => /^(TR|TBODY|THEAD|TFOOT)$/.test(t.tagName))) {
    const table = el.closest('table')
    if (table) return wrap(table, fragment)
  }
  if (tops.some((t) => BLOCK_TAGS.test(t.tagName))) return fragment

  // Only inline content was selected: rebuild the inline formatting and the block it sits in.
  let node: Node = fragment
  let current: Element | null = el
  while (current && !BLOCK_TAGS.test(current.tagName)) {
    if (INLINE_WRAPPERS.test(current.tagName)) node = wrap(current, node)
    current = current.parentElement
  }
  if (current && /^(H[1-6]|PRE|BLOCKQUOTE|LI|TD|TH|DT|FIGCAPTION)$/.test(current.tagName)) {
    if (current.tagName === 'LI') {
      const list = current.closest('ul, ol')
      return list ? wrap(list, wrap(current, node)) : node
    }
    return wrap(/^(TD|TH)$/.test(current.tagName) ? document.createElement('p') : current, node)
  }
  return node
}

function wrap(template: Element, child: Node): Element {
  const shell = template.cloneNode(false) as Element
  for (const name of Array.from(shell.getAttributeNames())) {
    if (!['href', 'start', 'colspan', 'rowspan', 'style'].includes(name)) shell.removeAttribute(name)
  }
  shell.append(child)
  return shell
}

/** Rewrites links and image sources to absolute URLs, while the clone still knows the page's base URL. */
function absolutizeTree(root: Element): void {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = resolve(a.getAttribute('href'))
    if (href) a.setAttribute('href', href)
  }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    for (const name of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
      const value = img.getAttribute(name)
      if (value && !value.startsWith('data:')) img.setAttribute(name, resolve(value) ?? value)
    }
    for (const name of ['srcset', 'data-srcset']) {
      const value = img.getAttribute(name)
      if (value) {
        img.setAttribute(name, value.split(',').map((part) => {
          const [url, size] = part.trim().split(/\s+/)
          return [resolve(url ?? '') ?? url, size].filter(Boolean).join(' ')
        }).join(', '))
      }
    }
  }
}

function absolutized(root: Element): Element {
  const clone = root.cloneNode(true) as Element
  absolutizeTree(clone)
  return clone
}

function resolve(url: string | null): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url, document.baseURI).href
  } catch {
    return undefined
  }
}

/** The last h1–h3 that comes before the selection: usually the section it belongs to. */
function nearestHeading(range: Range): string | undefined {
  let best: Element | undefined
  for (const heading of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    if (range.comparePoint(heading, 0) <= 0 || heading.contains(range.startContainer)) best = heading
    else break
  }
  return best?.textContent?.replace(/\s+/g, ' ').trim() || undefined
}

/** The page title without the site name: "Adult Red Dragon - Monsters - D&D Beyond" → "Adult Red Dragon". */
function pageTitle(): string {
  const title = (metaContent('meta[property="og:title"]') ?? document.title).trim()
  return preferHeading(title) || title.split(/\s+[-|–—·:]\s+/)[0]?.trim() || title
}

/** Titles often carry breadcrumbs ("Adult Red Dragon - Monsters"); the page's own <h1> usually doesn't. */
function preferHeading(title: string | undefined): string | undefined {
  const h1 = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()
  if (title && h1 && h1.length >= 3 && title.toLowerCase().startsWith(h1.toLowerCase())) return h1
  return title
}

function metaContent(selector: string): string | undefined {
  return document.querySelector(selector)?.getAttribute('content')?.trim() || undefined
}

function attr(text: string): string {
  return escape(text).replace(/"/g, '&quot;')
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

;(globalThis as unknown as { __lkCapture: typeof capture }).__lkCapture = capture
