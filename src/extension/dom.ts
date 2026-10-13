type Child = Node | string | false | null | undefined
type Props = Record<string, string | number | boolean | EventListener | undefined> & { class?: string }

/** A tiny element builder: el('button', { class: 'primary', onclick: go }, 'Import'). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener)
    else if (key === 'class') node.className = String(value)
    else if (key in node && typeof value !== 'string') (node as unknown as Record<string, unknown>)[key] = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== false && child !== null && child !== undefined) node.append(child)
  return node
}

export function clear(node: Element, ...children: Child[]): void {
  node.replaceChildren(...children.filter((c): c is Node | string => c !== false && c !== null && c !== undefined))
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} days ago`
}
