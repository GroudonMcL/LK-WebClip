/**
 * The mapper's pane sizes: drag a divider (or focus it and press the arrow keys) to make the clip,
 * preview, unused tray or the template's sidebar wider or taller; double-click it to go back to the
 * default. The template's sidebar can also be hidden. Sizes are kept in this browser's
 * localStorage, so the mapper opens the way it was left.
 */

const STORAGE_KEY = 'lk-mapper-layout'

export interface MapperLayout {
  /** Widths and heights in pixels; unset means the default. */
  clip?: number
  preview?: number
  tray?: number
  sidebar?: number
  sidebarHidden?: boolean
}

type Gutter = 'clip' | 'preview' | 'tray' | 'sidebar'

const STEP = 24
const MIN = { clip: 180, preview: 200, tray: 60, sidebar: 120 }
/** What the template column (or, for the sidebar, the template's page) keeps at least. */
const KEEP = { wire: 320, page: 200, rows: 160 }

let layout: MapperLayout = load()

function load(): MapperLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as MapperLayout) : {}
  } catch {
    return {}
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Not kept, but the mapper works the same.
  }
}

export function sidebarHidden(): boolean {
  return !!layout.sidebarHidden
}

export function setSidebarHidden(hidden: boolean): void {
  layout = { ...layout, sidebarHidden: hidden }
  save()
}

/**
 * Applies the saved sizes and wires up the dividers. `grid` holds the clip, template, preview and
 * tray; the sidebar's divider is drawn inside `wire` by the wireframe, so its events are caught here
 * by delegation.
 */
export function initLayout(grid: HTMLElement, wire: HTMLElement): void {
  apply(grid, wire)
  let drag: { gutter: Gutter; pointer: number; x: number; y: number; size: number } | undefined

  document.addEventListener('pointerdown', (e) => {
    const gutter = gutterOf(e.target)
    if (!gutter || e.button !== 0) return
    e.preventDefault()
    const name = gutter.dataset.gutter as Gutter
    drag = { gutter: name, pointer: e.pointerId, x: e.clientX, y: e.clientY, size: current(name, grid, wire) }
    gutter.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing', gutter.dataset.gutter === 'tray' ? 'resizing-rows' : 'resizing-cols')
  })
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return
    // The clip grows as its divider moves right; the preview and sidebar as theirs move left; the tray as its divider moves up.
    const by = drag.gutter === 'clip' ? e.clientX - drag.x : drag.gutter === 'tray' ? drag.y - e.clientY : drag.x - e.clientX
    set(drag.gutter, drag.size + by, grid, wire)
  })
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return
    drag = undefined
    document.body.classList.remove('resizing', 'resizing-rows', 'resizing-cols')
    save()
  }
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)

  document.addEventListener('dblclick', (e) => {
    const gutter = gutterOf(e.target)
    if (!gutter) return
    const { [gutter.dataset.gutter as Gutter]: _reset, ...rest } = layout
    layout = rest
    apply(grid, wire)
    save()
  })

  document.addEventListener('keydown', (e) => {
    const gutter = gutterOf(e.target)
    if (!gutter) return
    const name = gutter.dataset.gutter as Gutter
    const rows = name === 'tray'
    const keys: Record<string, number> = rows ? { ArrowUp: STEP, ArrowDown: -STEP } : name === 'clip' ? { ArrowRight: STEP, ArrowLeft: -STEP } : { ArrowLeft: STEP, ArrowRight: -STEP }
    const by = keys[e.key]
    if (!by) return
    e.preventDefault()
    set(name, current(name, grid, wire) + by, grid, wire)
    save()
  })

  // The window got smaller: keep the saved sizes within it.
  window.addEventListener('resize', () => apply(grid, wire))
}

function gutterOf(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element ? ((target.closest('[data-gutter]') as HTMLElement | null) ?? undefined) : undefined
}

/** The pane's size now, as drawn. */
function current(gutter: Gutter, grid: HTMLElement, wire: HTMLElement): number {
  const box = (selector: string, root: ParentNode) => root.querySelector(selector)?.getBoundingClientRect()
  if (gutter === 'clip') return box('#m-clip', grid)?.width ?? MIN.clip
  if (gutter === 'preview') return box('#m-preview', grid)?.width ?? MIN.preview
  if (gutter === 'tray') return box('#m-tray', grid)?.height ?? MIN.tray
  return box('.wf-sidebar', wire)?.width ?? MIN.sidebar
}

function set(gutter: Gutter, size: number, grid: HTMLElement, wire: HTMLElement): void {
  layout = { ...layout, [gutter]: Math.round(size) }
  apply(grid, wire)
}

/** Writes the sizes as CSS variables, each kept within what the window leaves for it. */
function apply(grid: HTMLElement, wire: HTMLElement): void {
  const width = grid.clientWidth
  const height = grid.clientHeight
  const clamp = (value: number | undefined, min: number, max: number) => (value === undefined ? undefined : Math.max(min, Math.min(Math.max(min, max), value)))
  const clip = clamp(layout.clip, MIN.clip, width - (layout.preview ?? MIN.preview) - KEEP.wire - 60)
  const preview = clamp(layout.preview, MIN.preview, width - (clip ?? MIN.clip) - KEEP.wire - 60)
  const tray = clamp(layout.tray, MIN.tray, height - KEEP.rows)
  const layoutBox = wire.querySelector('.wf-layout')
  const sidebar = clamp(layout.sidebar, MIN.sidebar, (layoutBox?.clientWidth ?? wire.clientWidth) - KEEP.page)
  const px = (value: number | undefined) => (value === undefined ? '' : `${value}px`)
  grid.style.setProperty('--clip-w', px(clip))
  grid.style.setProperty('--preview-w', px(preview))
  grid.style.setProperty('--tray-h', px(tray))
  grid.classList.toggle('tray-sized', tray !== undefined)
  wire.style.setProperty('--sidebar-w', px(sidebar))
  for (const [name, value] of [['clip', clip], ['preview', preview], ['tray', tray], ['sidebar', sidebar]] as const) {
    for (const gutter of document.querySelectorAll(`[data-gutter="${name}"]`)) gutter.setAttribute('aria-valuenow', String(value ?? Math.round(current(name, grid, wire))))
  }
}
