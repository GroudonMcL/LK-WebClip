/**
 * Many sites mark the labels of stat blocks and infoboxes with a class rather than bold text
 * (D&D Beyond's "mon-stat-block__tidbit-label", a wiki's "pi-data-label"). Such a label is
 * treated as bold, so "Saving Throws DEX +6" is read as the label "Saving Throws" and its value,
 * like any other bold label.
 */

const LABEL_CLASS = /(^|[\s_-])(label|heading)([\s_-]|$)/i
const MAX_LABEL_CHARS = 48

export function isLabelElement(el: Element): boolean {
  if (!LABEL_CLASS.test(el.getAttribute('class') ?? '')) return false
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= MAX_LABEL_CHARS && !el.querySelector('img, table, ul, ol, p, h1, h2, h3, h4, h5, h6')
}

/**
 * Wraps such labels in <strong>. Used before Readability, which drops class names; the converter
 * reads the classes itself when they are kept (a selection).
 */
export function markLabelElements(root: ParentNode & Node): void {
  const doc = root.ownerDocument ?? (root as unknown as Document)
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    if (!isLabelElement(el) || el.closest('strong, b')) continue
    const strong = doc.createElement('strong')
    strong.append(...Array.from(el.childNodes))
    el.append(strong)
  }
}

/**
 * A stat block's outermost element: D&D Beyond's "mon-stat-block" and "mon-stat-block-2024", a
 * wiki's "stat-block" or "statblock". Its parts ("mon-stat-block__header") are not.
 */
const STAT_BLOCK_CLASS = /^(?:[\w-]*[-_])?stat-?block(?:-\d+)?$/i

export function isStatBlockElement(el: Element): boolean {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/)
  if (!classes.some((c) => STAT_BLOCK_CLASS.test(c))) return false
  // Only the outermost one: a stat block inside another is part of it.
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if ((parent.getAttribute('class') ?? '').split(/\s+/).some((c) => STAT_BLOCK_CLASS.test(c))) return false
  }
  return true
}

/**
 * Puts a divider after each stat block, so the creature's description that follows it on the page
 * isn't read as more of its last section ("Legendary Actions"). Used before Readability, which
 * drops class names; the converter adds the divider itself when they are kept (a selection).
 */
export function markStatBlockEnds(root: ParentNode & Node): void {
  const doc = root.ownerDocument ?? (root as unknown as Document)
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    if (isStatBlockElement(el) && el.nextSibling?.nodeName !== 'HR') el.after(doc.createElement('hr'))
  }
}
