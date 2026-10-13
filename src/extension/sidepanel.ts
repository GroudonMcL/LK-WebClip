/**
 * The side panel: setup, the clip form (project, destination, Source), the preview and the import.
 * It talks to LegendKeeper directly; the API allows calls from extension pages, and the key never
 * reaches the web page being clipped.
 */
import type { LegendKeeper } from '@legendkeeper/sdk'
import type { Block } from '@legendkeeper/sdk/blocks'
import { describeConversion } from '../clip/links.js'
import { importClip, prepareClip, type Capture, type ClipPlan, type SourceSpec } from '../clip/importClip.js'
import { blocksToHtml } from '../clip/preview.js'
import { createClient } from '../lk/client.js'
import { describeError } from '../lk/errors.js'
import { ProjectIndex, writableDocuments, type IndexedResource } from '../lk/projectIndex.js'
import { findSources, isSource, listSources, siteName, type SourceConfig } from '../lk/sources.js'
import { clear, el, timeAgo } from './dom.js'
import { Picker } from './picker.js'
import {
  getPendingCapture, loadCachedIndex, loadRemembered, loadSettings, saveCachedIndex, saveRemembered, saveSettings,
  type PendingCapture, type ProjectSettings, type Settings,
} from './state.js'
import { captureTab } from './tabCapture.js'

const INDEX_MAX_AGE_MS = 10 * 60 * 1000
const STALE_CAPTURE_MS = 30 * 60 * 1000
const app = document.getElementById('app')!
const status = document.getElementById('index-status')!

interface Form {
  mode: 'new' | 'append'
  title: string
  parentId?: string
  targetId?: string
  targetDocumentId?: string
  sourceId?: string
  sourceMode: 'website' | 'existing' | 'new'
  websiteName: string
  /** For "This website" when a Source of that name exists: reuse it, or create another. */
  websiteReuse: boolean
  newSourceName: string
}

const state: {
  settings: Settings
  project?: ProjectSettings
  lk?: LegendKeeper
  index?: ProjectIndex
  indexLoadedAt?: string
  indexLoading: boolean
  pending?: PendingCapture
  plan?: ClipPlan
  form: Form
  busy: boolean
} = {
  settings: { projects: [], linkify: true, images: true, assetFolder: 'LK Web Clipper' },
  indexLoading: false,
  form: { mode: 'new', title: '', sourceMode: 'website', websiteName: '', websiteReuse: true, newSourceName: '' },
  busy: false,
}

const context = () => ({ index: state.index, lk: state.lk })
const sourceConfig = (): SourceConfig | undefined =>
  state.project?.sourcesRootId ? { sourcesRootId: state.project.sourcesRootId, sourceTag: state.project.sourceTag } : undefined

// --------------------------------------------------------------------------------------- start

document.getElementById('open-settings')!.addEventListener('click', () => renderSettings())
document.getElementById('refresh')!.addEventListener('click', () => void refreshIndex())

void start()

async function start(): Promise<void> {
  state.settings = await loadSettings()
  const pending = await getPendingCapture()
  // A clip left over from long ago would look like a new one; start empty instead.
  const age = pending?.capture ? Date.now() - new Date(pending.capture.capturedAt).getTime() : 0
  state.pending = age < STALE_CAPTURE_MS ? pending : undefined
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pendingCapture?.newValue) {
      state.pending = changes.pendingCapture.newValue as PendingCapture
      void onNewCapture()
    }
  })
  if (state.settings.projects.length === 0) return renderSettings()
  await selectProject(state.settings.activeProjectId ?? state.settings.projects[0]!.projectId)
  await onNewCapture()
}

async function selectProject(projectId: string): Promise<void> {
  const project = state.settings.projects.find((p) => p.projectId === projectId) ?? state.settings.projects[0]
  if (!project) return renderSettings()
  state.project = project
  state.lk = createClient(project.apiKey)
  state.settings.activeProjectId = project.projectId
  await saveSettings(state.settings)

  const cached = await loadCachedIndex(project.projectId)
  state.index = cached ? new ProjectIndex(cached.resources) : undefined
  state.indexLoadedAt = cached?.loadedAt
  updateStatus()
  if (!cached || Date.now() - new Date(cached.loadedAt).getTime() > INDEX_MAX_AGE_MS) {
    const refresh = refreshIndex()
    if (!cached) await refresh
  }
}

async function refreshIndex(): Promise<void> {
  if (!state.lk || !state.project || state.indexLoading) return
  state.indexLoading = true
  updateStatus()
  try {
    const index = await ProjectIndex.load(state.lk)
    state.index = index
    state.indexLoadedAt = new Date().toISOString()
    await persistIndex()
    // A project with a top-level "Sources" page needs no setup.
    if (!state.project.sourcesRootId) {
      const sources = index.children(null).find((r) => r.name.trim().toLowerCase() === 'sources')
      if (sources) {
        state.project.sourcesRootId = sources.id
        await saveSettings(state.settings)
      }
    }
  } catch (error) {
    showToast(describeError(error), 'error')
  } finally {
    state.indexLoading = false
    updateStatus()
    if (app.dataset.view === 'main') renderMain()
  }
}

async function persistIndex(): Promise<void> {
  if (!state.project || !state.index) return
  await saveCachedIndex(state.project.projectId, { loadedAt: state.indexLoadedAt ?? new Date().toISOString(), resources: [...state.index.byId.values()] })
}

function updateStatus(): void {
  if (!state.project) return status.replaceChildren()
  const pages = state.index ? `${state.index.pages().length} pages` : 'no page list yet'
  status.textContent = state.indexLoading ? `${state.project.projectName}: loading pages…` : `${state.project.projectName}: ${pages}, updated ${timeAgo(state.indexLoadedAt)}`
}

async function onNewCapture(): Promise<void> {
  if (!state.project) return renderSettings()
  const capture = state.pending?.capture
  if (capture) {
    const remembered = await loadRemembered(state.project.projectId)
    state.form = {
      mode: remembered?.mode ?? 'new',
      title: capture.suggestedTitle,
      parentId: remembered?.parentId,
      targetId: remembered?.targetId,
      targetDocumentId: remembered?.targetDocumentId,
      sourceId: remembered?.sourceId,
      sourceMode: remembered?.sourceMode === 'new' ? 'website' : (remembered?.sourceMode ?? 'website'),
      websiteName: siteName({ url: capture.url, ...capture.meta }),
      websiteReuse: true,
      newSourceName: '',
    }
  }
  renderMain()
}

// ---------------------------------------------------------------------------------- main view

let parentPicker: Picker
let targetPicker: Picker
let sourcePicker: Picker
let previewBox: HTMLElement
let summaryBox: HTMLElement
let importButton: HTMLButtonElement
let progressBox: HTMLElement

function renderMain(): void {
  app.dataset.view = 'main'
  const capture = state.pending?.capture
  if (state.pending?.error) {
    clear(app, captureEmpty(state.pending.error))
    return
  }
  if (!capture) {
    clear(app, captureEmpty())
    return
  }
  if (!state.index) {
    clear(app, el('p', { class: 'muted' }, 'Loading your pages…'))
    return
  }

  parentPicker = new Picker(context, {
    placeholder: 'Search for the parent page…',
    contentSearch: true,
    onChange: (resource) => ((state.form.parentId = resource?.id), update()),
  })
  targetPicker = new Picker(context, {
    placeholder: 'Search for the page to add to…',
    contentSearch: true,
    filter: (r) => writableDocuments(r).length > 0,
    onChange: (resource) => {
      state.form.targetId = resource?.id
      state.form.targetDocumentId = resource ? writableDocuments(resource)[0]?.id : undefined
      renderTabChoice()
      update()
    },
  })
  sourcePicker = new Picker(context, {
    placeholder: 'Search your Sources…',
    filter: (r) => (sourceConfig() ? isSource(state.index!, r, sourceConfig()!) : false),
    emptyList: () => (sourceConfig() ? listSources(state.index!, sourceConfig()!) : []),
    onChange: (resource) => ((state.form.sourceId = resource?.id), update()),
  })

  const form = state.form
  const projects = state.settings.projects
  const tabChoice = el('div', { id: 'tab-choice' })
  previewBox = el('div', { class: 'preview' })
  summaryBox = el('div', { class: 'summary' })
  progressBox = el('div', { class: 'progress', hidden: true })
  importButton = el('button', { class: 'primary', type: 'button', onclick: () => void runImport() }, 'Import')

  const titleInput = el('input', { type: 'text', value: form.title, placeholder: 'Name of the new page', oninput: (e: Event) => ((form.title = (e.target as HTMLInputElement).value), update()) })
  const websiteInput = el('input', { type: 'text', value: form.websiteName, oninput: (e: Event) => ((form.websiteName = (e.target as HTMLInputElement).value), update()) })
  const newSourceInput = el('input', { type: 'text', value: form.newSourceName, placeholder: 'e.g. Monster Manual', oninput: (e: Event) => ((form.newSourceName = (e.target as HTMLInputElement).value), update()) })

  clear(
    app,
    captureCard(capture),
    projects.length > 1 &&
      field('Project', el('select', { onchange: (e: Event) => void selectProject((e.target as HTMLSelectElement).value).then(onNewCapture) },
        ...projects.map((p) => el('option', { value: p.projectId, selected: p.projectId === state.project?.projectId }, p.projectName)))),
    field('Where', segmented('mode', [['new', 'New page'], ['append', 'Add to a page']], form.mode, (v) => ((form.mode = v as Form['mode']), renderMain()))),
    form.mode === 'new'
      ? el('div', { class: 'group' }, field('Page name', titleInput), field('Put it under', parentPicker.element))
      : el('div', { class: 'group' }, field('Add to', targetPicker.element), tabChoice),
    field(
      'Source',
      segmented('source', [['website', 'This website'], ['existing', 'A Source'], ['new', 'New Source']], form.sourceMode, (v) => ((form.sourceMode = v as Form['sourceMode']), renderMain())),
      form.sourceMode === 'website' ? el('div', {}, websiteInput, el('div', { id: 'website-notice' })) : null,
      form.sourceMode === 'existing' ? sourcePicker.element : null,
      form.sourceMode === 'new' ? newSourceInput : null,
      !sourceConfig() ? el('p', { class: 'warning' }, 'Choose your Sources page in ', el('button', { type: 'button', class: 'link', onclick: () => renderSettings() }, 'settings'), ' to use Sources.') : null,
    ),
    el(
      'div',
      { class: 'options' },
      checkbox('Link to my pages', state.settings.linkify, 'Links whose text names one of your pages become LegendKeeper links', (v) => ((state.settings.linkify = v), void saveSettings(state.settings), rebuildPlan())),
      checkbox('Import images', state.settings.images, 'Copy images into your project', (v) => ((state.settings.images = v), void saveSettings(state.settings), rebuildPlan())),
    ),
    summaryBox,
    el('div', { class: 'actions' }, importButton),
    progressBox,
    el('h2', { class: 'preview-title' }, 'Preview'),
    previewBox,
  )

  void restorePickers().then(() => {
    renderTabChoice()
    rebuildPlan()
  })
}

/** Puts back the pages chosen so far (or last time, for a new clip). */
async function restorePickers(): Promise<void> {
  if (!state.index) return
  const form = state.form
  const get = (id?: string) => (id ? state.index!.get(id) : undefined)
  parentPicker.set(get(form.parentId), { silent: true })
  targetPicker.set(get(form.targetId), { silent: true })
  if (targetPicker.value && !writableDocuments(targetPicker.value).some((d) => d.id === form.targetDocumentId)) {
    form.targetDocumentId = writableDocuments(targetPicker.value)[0]?.id
  }
  const source = get(form.sourceId)
  sourcePicker.set(source && sourceConfig() && isSource(state.index, source, sourceConfig()!) ? source : undefined, { silent: true })
}

function renderTabChoice(): void {
  const box = document.getElementById('tab-choice')
  if (!box) return
  const target = targetPicker?.value
  const docs = target ? writableDocuments(target) : []
  if (docs.length < 2) return clear(box)
  clear(
    box,
    field('Tab', el('select', { onchange: (e: Event) => ((state.form.targetDocumentId = (e.target as HTMLSelectElement).value), update()) },
      ...docs.map((d) => el('option', { value: d.id, selected: d.id === state.form.targetDocumentId }, d.name || 'Main')))),
  )
}

function rebuildPlan(): void {
  const capture = state.pending?.capture
  if (!capture || !state.index) return
  state.plan = prepareClip(capture, state.index, { linkify: state.settings.linkify, images: state.settings.images, parser: new DOMParser() })
  update()
}

/** The Source the import will use, as far as can be known before importing. */
function chosenSource(): { spec?: SourceSpec; label: string; problem?: string; existing?: IndexedResource[] } {
  const form = state.form
  const config = sourceConfig()
  if (form.sourceMode === 'existing') {
    const source = sourcePicker?.value
    return source ? { spec: { kind: 'existing', resourceId: source.id }, label: source.name } : { label: 'Source', problem: 'Choose a Source.' }
  }
  const name = (form.sourceMode === 'website' ? form.websiteName : form.newSourceName).trim()
  if (!name) return { label: 'Source', problem: 'Name the Source.' }
  if (!config) return { label: name, problem: 'Choose your Sources page in settings first.' }
  const existing = state.index ? findSources(state.index, name, config) : []
  if (form.sourceMode === 'website' && existing.length > 0 && form.websiteReuse) {
    return { spec: { kind: 'existing', resourceId: existing[0]!.id }, label: existing[0]!.name, existing }
  }
  return { spec: { kind: 'new', name }, label: name, existing }
}

function update(): void {
  if (app.dataset.view !== 'main' || !state.plan || !state.index) return
  const form = state.form
  const plan = state.plan
  const source = chosenSource()

  const notice = document.getElementById('website-notice')
  if (notice) {
    const existing = form.sourceMode === 'website' ? (source.existing ?? []) : []
    clear(
      notice,
      existing.length > 0
        ? el('div', { class: 'notice' },
            el('p', {}, el('strong', {}, existing[0]!.name), ' already exists in your Sources (', state.index.path(existing[0]!.id), ').'),
            radio('website-reuse', 'Use the existing Source', form.websiteReuse, () => ((form.websiteReuse = true), update())),
            radio('website-reuse', 'Create another Source with this name', !form.websiteReuse, () => ((form.websiteReuse = false), update())))
        : form.sourceMode === 'website' && form.websiteName.trim() && sourceConfig()
          ? el('p', { class: 'muted small' }, `A new Source page "${form.websiteName.trim()}" will be created under ${state.index.path(sourceConfig()!.sourcesRootId)}.`)
          : null,
    )
  }

  // Problems that block the import.
  const problems: string[] = []
  if (plan.blocks.length === 0) problems.push('There is nothing to import in this clip.')
  if (form.mode === 'new' && !form.title.trim()) problems.push('Name the new page.')
  if (form.mode === 'append' && (!targetPicker.value || !form.targetDocumentId)) problems.push('Choose the page to add to.')
  if (source.problem) problems.push(source.problem)

  const notes: (string | Node)[] = []
  if (form.mode === 'new') {
    notes.push(parentPicker.value ? `New page under ${state.index.path(parentPicker.value.id)}` : 'New page at the top level of the project (needs an ADMIN key)')
  } else if (targetPicker.value) {
    const tab = targetPicker.value.documents.find((d) => d.id === form.targetDocumentId)
    notes.push(`Adds to the end of ${state.index.path(targetPicker.value.id)}${tab && writableDocuments(targetPicker.value).length > 1 ? ` (${tab.name} tab)` : ''}, after a divider`)
  }
  if (plan.converted.length) notes.push(`${plan.converted.length} link${plan.converted.length === 1 ? '' : 's'} → your pages: ${unique(plan.converted.map(describeConversion)).join(', ')}`)
  if (plan.ambiguous.length) notes.push(`Kept as web links (more than one page has the name): ${unique(plan.ambiguous.map((a) => a.text)).join(', ')}`)
  if (plan.images.length) notes.push(`${plan.images.length} image${plan.images.length === 1 ? '' : 's'} will be copied into your project`)
  notes.push(...plan.warnings)

  clear(summaryBox, ...problems.map((p) => el('p', { class: 'problem' }, p)), el('ul', {}, ...notes.map((n) => el('li', {}, n))))
  importButton.disabled = problems.length > 0 || state.busy
  importButton.textContent = form.mode === 'new' ? 'Create page' : 'Add to page'

  const heading: Block[] = [
    ...(form.mode === 'append' ? [{ kind: 'rule' } as Block] : []),
    { kind: 'heading', level: 1, content: [{ text: 'From ' }, { mention: { resourceId: '_source', text: source.label } }] },
  ]
  previewBox.innerHTML = blocksToHtml([...heading, ...plan.blocks], { nameOf: (id) => state.index?.get(id)?.name })
}

async function runImport(): Promise<void> {
  const { plan, lk, index, project } = state
  const capture = state.pending?.capture
  const source = chosenSource()
  const config = sourceConfig()
  if (!plan || !lk || !index || !project || !capture || !source.spec || state.busy) return
  if (source.spec.kind === 'new' && !config) return

  state.busy = true
  importButton.disabled = true
  progressBox.hidden = false
  progressBox.className = 'progress'
  progressBox.textContent = 'Starting…'
  try {
    const form = state.form
    const result = await importClip(lk, index, plan, {
      destination: form.mode === 'new'
        ? { mode: 'new', parentId: parentPicker.value?.id, title: form.title.trim() }
        : { mode: 'append', target: { resourceId: targetPicker.value!.id, documentId: form.targetDocumentId! } },
      source: source.spec,
      sourceConfig: config ?? { sourcesRootId: '' },
      assetFolderName: state.settings.assetFolder,
      onProgress: (message) => (progressBox.textContent = message),
      // With the extension's host permission, image requests can carry the site's cookies, like the page's own.
      fetchImpl: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    })
    await saveRemembered(project.projectId, {
      mode: form.mode,
      parentId: form.parentId,
      targetId: form.targetId,
      targetDocumentId: form.targetDocumentId,
      sourceMode: form.sourceMode === 'new' ? 'existing' : form.sourceMode,
      sourceId: result.source.id,
    })
    await persistIndex()
    renderDone(result.url, form.mode === 'new' ? form.title.trim() : targetPicker.value!.name, form.mode, result.sourceCreated ? result.source.name : undefined, result.imagesFailed)
  } catch (error) {
    progressBox.className = 'progress error'
    progressBox.textContent = describeError(error)
    importButton.disabled = false
  } finally {
    state.busy = false
  }
}

function renderDone(url: string, title: string, mode: 'new' | 'append', newSource: string | undefined, failed: { src: string; reason: string }[]): void {
  app.dataset.view = 'done'
  clear(
    app,
    el('div', { class: 'done' },
      el('h2', {}, mode === 'new' ? 'Page created' : 'Added to the page'),
      el('p', {}, el('strong', {}, title)),
      newSource ? el('p', { class: 'muted' }, `New Source "${newSource}" created.`) : null,
      failed.length ? el('p', { class: 'warning' }, `${failed.length} image(s) could not be copied and were kept as links: ${failed.map((f) => f.reason).join('; ')}`) : null,
      el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener', class: 'button primary' }, 'Open in LegendKeeper')),
      el('button', { type: 'button', class: 'link', onclick: () => renderMain() }, 'Back to this clip'),
    ),
  )
}

function captureEmpty(error?: string): HTMLElement {
  return el('div', { class: 'empty-state' },
    error ? el('p', { class: 'problem' }, error) : null,
    el('p', {}, 'Select something on a web page, right-click it and choose ', el('strong', {}, 'Send to LegendKeeper'), '.'),
    el('p', { class: 'muted' }, 'Right-click an image or a link to clip just that.'),
    el('button', { type: 'button', onclick: () => void clipActiveTab('article') }, 'Clip this page’s article'),
  )
}

function captureCard(capture: Capture): HTMLElement {
  const kinds: Record<Capture['kind'], string> = { selection: 'Selection', image: 'Image', link: 'Link', article: 'Article' }
  return el('div', { class: 'capture' },
    el('div', { class: 'capture-head' },
      el('span', { class: 'badge' }, kinds[capture.kind]),
      el('a', { href: capture.url, target: '_blank', rel: 'noopener', class: 'capture-title', title: capture.url }, capture.title || capture.url)),
    el('div', { class: 'capture-actions' },
      capture.kind !== 'article' ? el('button', { type: 'button', class: 'link', onclick: () => void clipActiveTab('article', state.pending?.tabId) }, 'Use the whole article instead') : null),
  )
}

async function clipActiveTab(kind: 'article', tabId?: number): Promise<void> {
  try {
    const id = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
    if (id === undefined) throw new Error('No tab to clip.')
    const capture = await captureTab(id, undefined, { kind })
    state.pending = { id: crypto.randomUUID(), tabId: id, capture }
  } catch (error) {
    state.pending = { id: crypto.randomUUID(), error: error instanceof Error ? error.message : String(error) }
  }
  await onNewCapture()
}

// ------------------------------------------------------------------------------ settings view

function renderSettings(): void {
  app.dataset.view = 'settings'
  const keyInput = el('input', { type: 'password', placeholder: 'lk_…', autocomplete: 'off', spellcheck: false })
  const message = el('p', { class: 'small' })
  const connect = async () => {
    const apiKey = keyInput.value.trim()
    if (!apiKey) return
    message.className = 'small muted'
    message.textContent = 'Checking the key…'
    try {
      const project = await createClient(apiKey, { maxRetries: 1 }).project()
      state.settings.projects = state.settings.projects.filter((p) => p.projectId !== project.id)
      state.settings.projects.push({ apiKey, projectId: project.id, projectName: project.name ?? project.id, sourceTag: 'Source' })
      state.settings.activeProjectId ??= project.id
      await saveSettings(state.settings)
      if (!state.project || state.project.projectId === project.id) await selectProject(project.id)
      renderSettings()
    } catch (error) {
      message.className = 'small problem'
      message.textContent = describeError(error)
    }
  }

  const project = state.project
  const sourcesPicker = new Picker(context, {
    placeholder: 'Search for your Sources page…',
    onChange: async (resource) => {
      if (!project) return
      project.sourcesRootId = resource?.id
      await saveSettings(state.settings)
    },
  })
  if (project?.sourcesRootId && state.index) sourcesPicker.set(state.index.get(project.sourcesRootId), { silent: true })

  clear(
    app,
    el('h2', {}, 'Settings'),
    el('section', {},
      el('h3', {}, 'Projects'),
      state.settings.projects.length === 0 ? el('p', { class: 'muted' }, 'Add an API key to connect a LegendKeeper project.') : null,
      el('ul', { class: 'projects' }, ...state.settings.projects.map((p) => el('li', {},
        el('span', {}, el('strong', {}, p.projectName), ` (key ${p.apiKey.slice(0, 7)}…)`),
        el('button', { type: 'button', class: 'link', onclick: async () => {
          if (!confirm(`Remove ${p.projectName} from the clipper? Nothing in LegendKeeper changes.`)) return
          state.settings.projects = state.settings.projects.filter((x) => x.projectId !== p.projectId)
          if (state.settings.activeProjectId === p.projectId) state.settings.activeProjectId = state.settings.projects[0]?.projectId
          await saveSettings(state.settings)
          state.project = undefined
          state.index = undefined
          if (state.settings.activeProjectId) await selectProject(state.settings.activeProjectId)
          renderSettings()
        } }, 'Remove')))),
      field('Add a project’s API key', el('div', { class: 'row' }, keyInput, el('button', { type: 'button', onclick: () => void connect() }, 'Connect')), message),
      el('p', { class: 'muted small' }, 'Create a key in LegendKeeper under Project Settings → Developers → API Keys. One key per project. A Member key can add to existing pages; creating top-level pages needs an Admin key.'),
    ),
    project && el('section', {},
      el('h3', {}, `Sources in ${project.projectName}`),
      field('Sources page', sourcesPicker.element, el('p', { class: 'muted small' }, 'Pages under it count as Sources, and new Sources are created there.')),
      field('Source tag', el('input', { type: 'text', value: project.sourceTag, oninput: async (e: Event) => {
        project.sourceTag = (e.target as HTMLInputElement).value.trim()
        await saveSettings(state.settings)
      } }), el('p', { class: 'muted small' }, 'Pages with this tag also count as Sources, wherever they are.')),
    ),
    el('section', {},
      el('h3', {}, 'Clipping'),
      field('Image folder', el('input', { type: 'text', value: state.settings.assetFolder, oninput: async (e: Event) => {
        state.settings.assetFolder = (e.target as HTMLInputElement).value.trim() || 'LK Web Clipper'
        await saveSettings(state.settings)
      } }), el('p', { class: 'muted small' }, 'The folder in your LegendKeeper asset library that clipped images go into.')),
    ),
    state.settings.projects.length > 0 ? el('button', { type: 'button', class: 'primary', onclick: () => void onNewCapture() }, 'Done') : null,
  )
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && void connect())
}

// -------------------------------------------------------------------------------- form parts

function field(label: string, ...controls: (Node | null | false | undefined)[]): HTMLElement {
  return el('div', { class: 'field' }, el('label', {}, label), ...controls)
}

function segmented(name: string, options: [string, string][], value: string, onChange: (value: string) => void): HTMLElement {
  return el('div', { class: 'segmented', role: 'radiogroup' },
    ...options.map(([v, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', 'data-name': name, 'data-value': v, onclick: () => onChange(v) }, label)))
}

function checkbox(label: string, checked: boolean, title: string, onChange: (checked: boolean) => void): HTMLElement {
  return el('label', { class: 'check', title }, el('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label)
}

function radio(name: string, label: string, checked: boolean, onChange: () => void): HTMLElement {
  return el('label', { class: 'check' }, el('input', { type: 'radio', name, checked, onchange: onChange }), label)
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

function showToast(message: string, kind: 'error' | 'info' = 'info'): void {
  const toast = el('div', { class: `toast ${kind}` }, message)
  document.body.append(toast)
  setTimeout(() => toast.remove(), 6000)
}
