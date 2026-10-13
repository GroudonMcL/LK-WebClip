import type { LegendKeeper } from '@legendkeeper/sdk'
import type { IndexedResource, ProjectIndex } from '../lk/projectIndex.js'
import { MatchTier, rankLocal, searchResources, type SearchHit } from '../lk/search.js'
import { clear, debounce, el } from './dom.js'

export interface PickerOptions {
  placeholder: string
  /** Which pages can be picked (e.g. only Sources, or only pages with a text tab). */
  filter?: (resource: IndexedResource) => boolean
  /** Shown when the box is empty, e.g. every Source. */
  emptyList?: () => IndexedResource[]
  /** Also search page text through the API (slower; used for destinations). */
  contentSearch?: boolean
  onChange: (resource: IndexedResource | undefined) => void
}

const TIER_LABEL: Partial<Record<MatchTier, string>> = { [MatchTier.Alias]: 'alias', [MatchTier.Tag]: 'tag', [MatchTier.Content]: 'text' }

/**
 * A search box over the project's pages. Name matches from the local index appear as you type;
 * matches in page text follow from the API a moment later.
 */
export class Picker {
  readonly element: HTMLElement
  value: IndexedResource | undefined
  private readonly input: HTMLInputElement
  private readonly list: HTMLUListElement
  private readonly chosen: HTMLElement
  private hits: SearchHit[] = []
  private active = 0
  private query = 0

  constructor(
    private readonly context: () => { index?: ProjectIndex; lk?: LegendKeeper },
    private readonly options: PickerOptions,
  ) {
    this.input = el('input', { type: 'search', placeholder: options.placeholder, autocomplete: 'off', spellcheck: false })
    this.list = el('ul', { class: 'picker-results', role: 'listbox', hidden: true })
    this.chosen = el('div', { class: 'picker-chosen', hidden: true })
    this.element = el('div', { class: 'picker' }, this.chosen, this.input, this.list)

    const remote = debounce(() => void this.searchRemote(), 300)
    this.input.addEventListener('input', () => {
      this.searchLocal()
      if (options.contentSearch && this.input.value.trim().length >= 3) remote()
    })
    this.input.addEventListener('focus', () => this.searchLocal())
    this.input.addEventListener('blur', () => setTimeout(() => (this.list.hidden = true), 150))
    this.input.addEventListener('keydown', (event) => this.onKey(event))
  }

  set(resource: IndexedResource | undefined, { silent = false } = {}): void {
    this.value = resource
    const index = this.context().index
    if (resource) {
      const path = index ? index.ancestors(resource.id).map((r) => r.name).join(' / ') : ''
      clear(
        this.chosen,
        el('div', { class: 'picker-chosen-text' }, el('strong', {}, resource.name), path ? el('span', { class: 'path' }, path) : null),
        el('button', { type: 'button', class: 'link', onclick: () => this.change() }, 'Change'),
      )
    }
    this.chosen.hidden = !resource
    this.input.hidden = !!resource
    this.list.hidden = true
    if (!silent) this.options.onChange(resource)
  }

  focus(): void {
    if (!this.input.hidden) this.input.focus()
  }

  private change(): void {
    this.set(undefined)
    this.input.value = ''
    this.input.focus()
  }

  private allowed(resource: IndexedResource): boolean {
    return this.options.filter ? this.options.filter(resource) : true
  }

  private searchLocal(): void {
    const { index } = this.context()
    if (!index) return
    const q = this.input.value.trim()
    if (!q) {
      const list = this.options.emptyList?.() ?? []
      this.show(list.slice(0, 50).map((resource) => ({ resource, path: index.path(resource.id), tier: MatchTier.ExactName })))
      return
    }
    this.query++
    this.show(rankLocal(index, q, 60).filter((hit) => this.allowed(hit.resource)).slice(0, 12))
  }

  private async searchRemote(): Promise<void> {
    const { index, lk } = this.context()
    const q = this.input.value.trim()
    if (!index || !lk || !q) return
    const query = ++this.query
    try {
      const hits = (await searchResources(lk, index, q, 40)).filter((hit) => this.allowed(hit.resource)).slice(0, 15)
      if (query === this.query && this.input.value.trim() === q) this.show(hits)
    } catch {
      // Name matches are already shown; text matches are a bonus.
    }
  }

  private show(hits: SearchHit[]): void {
    this.hits = hits
    this.active = 0
    if (hits.length === 0) {
      clear(this.list, this.input.value.trim() ? el('li', { class: 'empty' }, 'No matching pages') : null)
      this.list.hidden = !this.input.value.trim()
      return
    }
    clear(this.list, ...hits.map((hit, i) => this.row(hit, i)))
    this.list.hidden = false
  }

  private row(hit: SearchHit, i: number): HTMLLIElement {
    const parent = hit.path.split(' / ').slice(0, -1).join(' / ')
    const label = TIER_LABEL[hit.tier]
    return el(
      'li',
      { role: 'option', class: i === this.active ? 'active' : '', onmousedown: (e: Event) => (e.preventDefault(), this.set(hit.resource)) },
      el('div', { class: 'name' }, hit.resource.name, label ? el('span', { class: 'tier' }, `${label}${hit.matched ? `: ${hit.matched.slice(0, 40)}` : ''}`) : null),
      parent ? el('div', { class: 'path' }, parent) : null,
    )
  }

  private onKey(event: KeyboardEvent): void {
    if (this.list.hidden || this.hits.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      this.active = (this.active + (event.key === 'ArrowDown' ? 1 : this.hits.length - 1)) % this.hits.length
      Array.from(this.list.children).forEach((li, i) => li.classList.toggle('active', i === this.active))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = this.hits[this.active]
      if (hit) this.set(hit.resource)
    } else if (event.key === 'Escape') {
      this.list.hidden = true
    }
  }
}
