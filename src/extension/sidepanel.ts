/**
 * The side panel: setup, the clip form (project, destination, Source), the preview and the import.
 * It talks to LegendKeeper directly; the API allows calls from extension pages, and the key never
 * reaches the web page being clipped.
 */
import type { LegendKeeper } from '@legendkeeper/sdk'
import type { Block } from '@legendkeeper/sdk/blocks'
import { describeTerm, type LinkTerm } from '../clip/links.js'
import { importClip, prepareClip, type Capture, type ClipPlan, type SourceSpec } from '../clip/importClip.js'
import { blocksToHtml } from '../clip/preview.js'
import { slotsForAi, SYSTEM_PROMPT } from '../fill/ai.js'
import { DEFAULT_DERIVED, parseDerived } from '../fill/derived.js'
import { builtInPackFor, notesFor, savedNotes, withNotes } from '../fill/notes.js'
import { suggestNotes } from '../fill/notesAi.js'
import { appendTree, appendedTemplate, applyComposition, compose, type Composition } from '../fill/compose.js'
import { AiUnavailableError, listFreeModels, ON_DEVICE_HELP, onDeviceStatus, OnDeviceEngine, OpenRouterEngine, suggest, type AiEngine, type FreeModel } from '../fill/engines.js'
import { cleanLabel, DEFAULT_SYNONYMS, formatSynonyms, parseSynonyms, Synonyms } from '../fill/labels.js'
import { blocksForAi, mergeRules, planFill, type AiSuggestion, type FillMode, type FillPlan, type SavedRule } from '../fill/plan.js'
import { applyMapping, buildMapBase, carryOver, FILLABLE, initialMapping, mappedPlan, rulesFromMapping, summarize, type MapBase, type Mapping } from '../fill/mapping.js'
import { buildSlots, mentionsIn, type Slot, type TemplateTree } from '../fill/template.js'
import { parseTags, statblockTags, withProjectSpelling } from '../fill/tags.js'
import { createClient } from '../lk/client.js'
import { describeError, isNotFound } from '../lk/errors.js'
import { ProjectIndex, writableDocuments, type IndexedResource } from '../lk/projectIndex.js'
import { findSources, isSource, listSources, siteName, type SourceConfig } from '../lk/sources.js'
import { fillPage, listTemplates, TemplateCache, TemplateFillError, type TemplateContent } from '../lk/templates.js'
import { clear, debounce, el, timeAgo } from './dom.js'
import {
  IMPORT_CLAIM_KEY, IMPORT_KEY, MAPPING_KEY, PANEL_FORM_KEY, readSession, SESSION_KEY, STATUS_KEY, writeSession,
  type ImportRequest, type ImportStatus, type MapperContext, type MapperSession, type MappingMessage,
} from './mapperState.js'
import { Picker } from './picker.js'
import {
  DEFAULT_SETTINGS, getPendingCapture, loadCachedIndex, loadRemembered, loadSettings, saveCachedIndex, saveRemembered, saveSettings,
  type AiEngineChoice, type PendingCapture, type ProjectSettings, type Settings,
} from './state.js'
import { captureTab, isPdfUrl, openReader } from './tabCapture.js'

const INDEX_MAX_AGE_MS = 10 * 60 * 1000
/** Refreshes asked for by search (pages the list lacks) are at most this frequent. */
const MIN_REFRESH_GAP_MS = 60 * 1000
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
  /** The template to fill, when template filling is switched on. */
  templateId?: string
}

interface AiState {
  /** What the suggestions were made for: capture, template version and destination. */
  key?: string
  status: 'idle' | 'running' | 'done' | 'error'
  message?: string
  suggestions?: Map<string, AiSuggestion>
  /** What the AI was asked and answered, shown on request so a bad answer can be understood. */
  system?: string
  prompt?: string
  raw?: string
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
  /** The user's link decisions for the current clip, by term key (see LinkTerm). */
  linkChoices: Record<string, string | null>
  /** The chosen template's content, once read. */
  template?: TemplateContent
  templateLoading: boolean
  /** What label matching (and the AI) found for the template. */
  fillPlan?: FillPlan
  /** The mapper's cards and slots for the fill plan, and the user's mapping of them. */
  mapBase?: MapBase
  mapping?: Mapping
  /** The fill plan with the mapping applied: what the preview and the import use. */
  mapped?: FillPlan
  /** A mapping saved in the session by an earlier panel, for when this one was closed and opened again. */
  restoredMapping?: MappingMessage
  /** The tags to add, as edited on the review screen; undefined uses the suggested ones. */
  tagsText?: string
  /** "Add rows the template lacks" was unticked on the review screen. */
  noExtraRows?: boolean
  ai: AiState
  freeModels?: FreeModel[]
  busy: boolean
} = {
  settings: { ...DEFAULT_SETTINGS },
  indexLoading: false,
  linkChoices: {},
  templateLoading: false,
  ai: { status: 'idle' },
  form: { mode: 'new', title: '', sourceMode: 'website', websiteName: '', websiteReuse: true, newSourceName: '' },
  busy: false,
}

const templateCache = new TemplateCache()
let onDevice: OnDeviceEngine | undefined
/** This panel, among any others open, for claiming an import the mapper asked for. */
const panelId = crypto.randomUUID()
addEventListener('pagehide', () => onDevice?.destroy())

const context = () => ({ index: state.index, lk: state.lk, onMissing: () => void refreshIndex({ ifOlderThan: MIN_REFRESH_GAP_MS }) })
const sourceConfig = (): SourceConfig | undefined =>
  state.project?.sourcesRootId ? { sourcesRootId: state.project.sourcesRootId, sourceTag: state.project.sourceTag } : undefined

// --------------------------------------------------------------------------------------- start

document.getElementById('open-settings')!.addEventListener('click', () => renderSettings())
document.getElementById('refresh')!.addEventListener('click', () => void refreshIndex())
// Keep the page list fresh while the panel is open, and when it comes back into view.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshIndex({ ifOlderThan: INDEX_MAX_AGE_MS })
})
setInterval(() => {
  updateStatus()
  if (document.visibilityState === 'visible') void refreshIndex({ ifOlderThan: INDEX_MAX_AGE_MS })
}, 60 * 1000)

void start()

async function start(): Promise<void> {
  state.settings = await loadSettings()
  const pending = await getPendingCapture()
  // A clip left over from long ago would look like a new one; start empty instead.
  const age = pending?.capture ? Date.now() - new Date(pending.capture.capturedAt).getTime() : 0
  state.pending = age < STALE_CAPTURE_MS ? pending : undefined
  if (state.settings.templates.enabled) state.restoredMapping = await readSession<MappingMessage>(MAPPING_KEY)
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pendingCapture?.newValue) {
      state.pending = changes.pendingCapture.newValue as PendingCapture
      void onNewCapture()
    }
    const mapping = changes[MAPPING_KEY]?.newValue as MappingMessage | undefined
    if (mapping && mapping.key === state.mapBase?.key && JSON.stringify(mapping.mapping) !== JSON.stringify(state.mapping)) {
      state.mapping = mapping.mapping
      if (published) published.mapping = state.mapping
      applyTheMapping()
      update()
    }
    const request = changes[IMPORT_KEY]?.newValue as ImportRequest | undefined
    if (request) void onImportRequest(request)
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

async function refreshIndex({ ifOlderThan }: { ifOlderThan?: number } = {}): Promise<void> {
  if (!state.lk || !state.project || state.indexLoading) return
  if (ifOlderThan !== undefined && state.indexLoadedAt && Date.now() - new Date(state.indexLoadedAt).getTime() < ifOlderThan) return
  const hadIndex = !!state.index
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
    // A first load draws the form; later refreshes update it in place, so nothing typed is lost.
    if (app.dataset.view === 'main') {
      if (!hadIndex || !state.plan) renderMain()
      else {
        syncPickers()
        rebuildPlan()
      }
    }
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
  state.linkChoices = {}
  state.tagsText = undefined
  state.noExtraRows = undefined
  state.ai = { status: 'idle' }
  state.mapBase = undefined
  state.mapping = undefined
  // Only with template filling on: the mapper tab may be in front, and a panel opened again should carry on.
  const savedForm = state.settings.templates.enabled ? await readSession<{ captureId: string; form: Form; linkChoices: Record<string, string | null> }>(PANEL_FORM_KEY) : undefined
  if (capture && savedForm && savedForm.captureId === state.pending?.id) {
    // This panel was closed and opened again on the same clip: carry on where it was.
    state.form = savedForm.form
    state.linkChoices = savedForm.linkChoices
  } else if (capture) {
    const remembered = await loadRemembered(state.project.projectId)
    const website = siteName({ url: capture.url, ...capture.meta })
    // The template last used with this Source (or this website, before it was a Source).
    const templateId = remembered?.templateBySource?.[remembered.sourceMode === 'existing' && remembered.sourceId ? remembered.sourceId : `site:${website}`]
      ?? remembered?.templateBySource?.[`site:${website}`]
    state.form = {
      mode: remembered?.mode ?? 'new',
      title: capture.suggestedTitle,
      parentId: remembered?.parentId,
      targetId: remembered?.targetId,
      targetDocumentId: remembered?.targetDocumentId,
      sourceId: remembered?.sourceId,
      sourceMode: remembered?.sourceMode === 'new' ? 'website' : (remembered?.sourceMode ?? 'website'),
      websiteName: website,
      websiteReuse: true,
      newSourceName: '',
      templateId: templateId && state.index?.get(templateId) && state.index.isTemplate(templateId) ? templateId : undefined,
    }
  }
  renderMain()
  void loadChosenTemplate()
}

// ---------------------------------------------------------------------------------- main view

let parentPicker: Picker
let targetPicker: Picker
let sourcePicker: Picker
let previewBox: HTMLElement
let summaryBox: HTMLElement
let linksBox: HTMLElement
let templateBox: HTMLElement
let aiBox: HTMLElement
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
      rebuildPlan() // The page being added to is never linked to itself.
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
  linksBox = el('div', { class: 'links' })
  templateBox = el('div', { class: 'template-fields' })
  aiBox = el('div', { class: 'template-ai', hidden: true })
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
    templateGroup(),
    field(
      'Source',
      checkbox('Add a “From <Source>” heading', state.settings.sourceHeading, 'Credit the clip with a heading that links to its Source page', (v) => {
        state.settings.sourceHeading = v
        void saveSettings(state.settings)
        renderMain()
      }),
      state.settings.sourceHeading
        ? segmented('source', [['website', 'This website'], ['existing', 'A Source'], ['new', 'New Source']], form.sourceMode, (v) => ((form.sourceMode = v as Form['sourceMode']), renderMain()))
        : null,
      state.settings.sourceHeading && form.sourceMode === 'website' ? el('div', {}, websiteInput, el('div', { id: 'website-notice' })) : null,
      state.settings.sourceHeading && form.sourceMode === 'existing' ? sourcePicker.element : null,
      state.settings.sourceHeading && form.sourceMode === 'new' ? newSourceInput : null,
      state.settings.sourceHeading && !sourceConfig() ? el('p', { class: 'warning' }, 'Choose your Sources page in ', el('button', { type: 'button', class: 'link', onclick: () => renderSettings() }, 'settings'), ' to use Sources.') : null,
    ),
    el(
      'div',
      { class: 'options' },
      checkbox('Turn web links into page links', state.settings.linkify, 'A link whose text names one of your pages becomes a LegendKeeper link to it', (v) => ((state.settings.linkify = v), void saveSettings(state.settings), rebuildPlan())),
      checkbox('Link page names in the text', state.settings.linkText, 'Names of your pages written in the text become LegendKeeper links', (v) => ((state.settings.linkText = v), void saveSettings(state.settings), rebuildPlan())),
      checkbox('Import images', state.settings.images, 'Copy images into your project', (v) => ((state.settings.images = v), void saveSettings(state.settings), rebuildPlan())),
    ),
    summaryBox,
    aiBox,
    templateBox,
    linksBox,
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

/** After the page list reloads: point the pickers at the fresh entries, and drop any page that was deleted. */
function syncPickers(): void {
  if (!state.index) return
  const form = state.form
  const gone: string[] = []
  for (const [picker, key] of [[parentPicker, 'parentId'], [targetPicker, 'targetId'], [sourcePicker, 'sourceId']] as const) {
    const id = form[key]
    if (!id || !picker) continue
    const fresh = state.index.get(id)
    if (!fresh) {
      gone.push(picker.value?.name ?? 'a chosen page')
      form[key] = undefined
    }
    picker.set(fresh, { silent: true })
  }
  if (gone.length) showToast(`${gone.join(', ')} no longer exists in LegendKeeper. Choose again.`, 'error')
  renderTabChoice()
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
  const { linkify, linkText, matchCase, firstOnly, exactNames } = state.settings
  const exclude = new Set(state.form.mode === 'append' && state.form.targetId ? [state.form.targetId] : [])
  state.plan = prepareClip(capture, state.index, {
    links: linkify || linkText ? { hyperlinks: linkify, text: linkText, matchCase, firstOnly, exactNames, exclude, choices: state.linkChoices } : undefined,
    images: state.settings.images,
    parser: new DOMParser(),
  })
  state.fillPlan = undefined
  state.mapped = undefined
  const tree = templateTree()
  if (tree && state.template) {
    const t = state.settings.templates
    const mode = effectiveMode()
    state.fillPlan = planFill({
      tree,
      templateId: state.template.id,
      clip: state.plan.blocks,
      title: state.form.title.trim() || capture.suggestedTitle,
      site: siteHost(capture.url),
      synonyms: new Synonyms(t.synonyms),
      rules: state.project?.rules ?? [],
      // With label matching off and no AI, the template is created and the clip goes at the end.
      mode: mode ?? 'ai',
      ai: mode && mode !== 'labels' && state.ai.key === aiKey() ? state.ai.suggestions : undefined,
      overrides: {},
      nameOf: (id) => state.index?.get(id)?.name,
      derived: parseDerived(t.derived),
      templateName: state.template.name,
      notes: aiNotes()?.text,
      extraRows: !state.noExtraRows,
    })
    buildMapper(tree)
    void maybeRunAi()
  }
  update()
}

// ------------------------------------------------------------------------------------ mapper

/** Makes the mapper's cards and slots for the new fill plan, keeping the user's changes to the mapping. */
function buildMapper(tree: TemplateTree): void {
  const capture = state.pending?.capture
  if (!state.fillPlan || !state.template || !state.plan || !capture) return
  const key = [state.pending?.id, state.template.id, state.template.updatedAt, state.form.mode].join('|')
  const names: Record<string, string> = {}
  for (const id of mentionsIn([...state.plan.blocks, ...tree.docs.flatMap((d) => d.blocks)])) {
    const name = state.index?.get(id)?.name
    if (name) names[id] = name
  }
  const base = buildMapBase(state.fillPlan, state.plan.blocks, { key, names, synonyms: state.settings.templates.synonyms, title: state.form.title.trim() || capture.suggestedTitle })
  const previous = state.mapBase?.key === key ? state.mapping : state.restoredMapping?.key === key ? state.restoredMapping.mapping : undefined
  state.mapBase = base
  state.mapping = previous ? carryOver(previous, base) : initialMapping(base)
  baseRev++
  applyTheMapping()
  publishMapper()
}

function applyTheMapping(): void {
  if (!state.fillPlan || !state.mapBase || !state.mapping) return
  state.mapped = mappedPlan(state.fillPlan, state.mapBase, state.mapping)
}

/** The fill plan as the mapper left it. */
function filled(): FillPlan | undefined {
  return state.mapped ?? state.fillPlan
}

/** What the mapper tab needs besides the cards: the template, the page name, the credit, what blocks the import. */
function mapperContext(): MapperContext | undefined {
  const capture = state.pending?.capture
  const tree = templateTree()
  if (!capture || !tree || !state.template || !state.project) return undefined
  const source = chosenSource()
  return {
    title: state.form.mode === 'new' ? state.form.title.trim() || capture.suggestedTitle : (targetPicker?.value?.name ?? ''),
    site: siteHost(capture.url),
    templateName: state.template.name,
    mode: state.form.mode,
    tree,
    keepUnfilled: state.settings.templates.keepUnfilled,
    ...(state.settings.sourceHeading ? { sourceHeading: sourceHeadingPreview(source.label) } : {}),
    importLabel: state.form.mode === 'new' ? 'Create page' : 'Add to page',
    problems: importProblems(),
    projectName: state.project.projectName,
    clipUrl: capture.url,
  }
}

/** Hands the cards, slots and mapping to the mapper tab (if it was opened for this clip). */
const publishMapper = debounce(() => void writeMapperSession(), 250)
let mapperKey: string | undefined
let baseRev = 0
/** What was last handed over, so a change that came from the mapper isn't sent back to it. */
let published: { rev: number; mapping?: Mapping; context: string } | undefined

async function writeMapperSession(force = false): Promise<boolean> {
  const context = mapperContext()
  if (!state.mapBase || !state.mapping || !context) return false
  if (!force && mapperKey !== state.mapBase.key) return false
  const contextJson = JSON.stringify(context)
  if (!force && published?.rev === baseRev && published.mapping === state.mapping && published.context === contextJson) return true
  const session: MapperSession = { key: state.mapBase.key, rev: baseRev, base: state.mapBase, mapping: state.mapping, context }
  try {
    await writeSession(SESSION_KEY, session)
    if (published?.rev !== baseRev || force) await writeSession(MAPPING_KEY, { key: session.key, mapping: session.mapping } satisfies MappingMessage)
    published = { rev: baseRev, mapping: state.mapping, context: contextJson }
    mapperKey = session.key
    return true
  } catch (error) {
    showToast(`The mapper can’t open this clip: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return false
  }
}

/** Opens the mapper in its own tab, or brings back the one already open. */
async function openMapper(): Promise<void> {
  if (!(await writeMapperSession(true))) return
  const url = chrome.runtime.getURL('mapper.html')
  const open = (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB], documentUrls: [url] })).find((c) => c.tabId >= 0)
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true })
    await chrome.windows.update(open.windowId, { focused: true })
    return
  }
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true })
  await chrome.tabs.create({ url, ...(current ? { index: current.index + 1, openerTabId: current.id } : {}) })
}

/** The mapper's Import button. A panel claims the request first, so it is imported once even with two panels open. */
async function onImportRequest(request: ImportRequest): Promise<void> {
  if (!state.mapBase || request.key !== state.mapBase.key || app.dataset.view !== 'main') return
  const claim = await readSession<{ requestId: string; by: string }>(IMPORT_CLAIM_KEY)
  if (claim?.requestId === request.requestId) return
  await writeSession(IMPORT_CLAIM_KEY, { requestId: request.requestId, by: panelId })
  await new Promise((done) => setTimeout(done, 60))
  if ((await readSession<{ requestId: string; by: string }>(IMPORT_CLAIM_KEY))?.by !== panelId) return
  const problems = importProblems()
  if (problems.length > 0 || state.busy) {
    return reportImport({ key: request.key, requestId: request.requestId, state: 'blocked', message: state.busy ? 'The side panel is already importing.' : problems.join(' ') })
  }
  await runImport(request.requestId)
}

function reportImport(status: ImportStatus): void {
  void writeSession(STATUS_KEY, status).catch(() => {})
}

/** Remembers the form for this clip in the session, so a panel opened again carries on. */
const saveForm = debounce(() => {
  if (state.pending?.id && state.settings.templates.enabled) void writeSession(PANEL_FORM_KEY, { captureId: state.pending.id, form: state.form, linkChoices: state.linkChoices }).catch(() => {})
}, 300)

// ------------------------------------------------------------------------------- templates

/** The template the clip fills, as it applies to the destination: all of it for a new page, its main tab for an append. */
function templateTree(): TemplateTree | undefined {
  if (!state.settings.templates.enabled || !state.form.templateId || !state.template || state.template.id !== state.form.templateId) return undefined
  return state.form.mode === 'new' ? state.template.tree : appendTree(state.template.tree)
}

/** The "Fill with" choice, adjusted to what is switched on; undefined when nothing can fill slots. */
function effectiveMode(): FillMode | undefined {
  const t = state.settings.templates
  const labels = t.labels
  const ai = t.ai !== 'off'
  if (t.fillMode === 'labels' && labels) return 'labels'
  if (t.fillMode === 'ai' && ai) return 'ai'
  if (t.fillMode === 'labels-ai' && labels && ai) return 'labels-ai'
  if (t.fillMode === 'labels-ai-write' && labels && ai) return 'labels-ai-write'
  return labels ? 'labels' : ai ? 'ai' : undefined
}

function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function loadChosenTemplate(): Promise<void> {
  const id = state.form.templateId
  if (!state.settings.templates.enabled || !id || !state.lk || !state.index) return
  if (state.template?.id === id && state.template.updatedAt === (state.index.get(id)?.updatedAt ?? null)) return rebuildPlan()
  const resource = state.index.get(id)
  if (!resource) {
    state.form.templateId = undefined
    showToast('That template no longer exists. Choose another.', 'error')
    return renderMain()
  }
  state.templateLoading = true
  update()
  try {
    const content = await templateCache.get(state.lk, resource)
    if (state.form.templateId !== id) return
    state.template = content
  } catch (error) {
    showToast(describeError(error), 'error')
    if (isNotFound(error)) {
      state.form.templateId = undefined
      void refreshIndex()
      renderMain()
    }
  } finally {
    state.templateLoading = false
    rebuildPlan()
  }
}

function templateGroup(): HTMLElement | null {
  const t = state.settings.templates
  if (!t.enabled || !state.index) return null
  const form = state.form
  const templates = listTemplates(state.index)
  const select = el('select', {
    onchange: (e: Event) => {
      form.templateId = (e.target as HTMLSelectElement).value || undefined
      state.tagsText = undefined
      state.ai = { status: 'idle' }
      renderMain()
      void loadChosenTemplate()
    },
  },
  el('option', { value: '', selected: !form.templateId }, 'None (clip as usual)'),
  ...templates.map((tpl) => el('option', { value: tpl.resource.id, selected: tpl.resource.id === form.templateId }, tpl.path)))
  if (!form.templateId) return el('div', { class: 'group' }, field('Template', select))

  const reasons: Record<FillMode, string | undefined> = {
    labels: t.labels ? undefined : 'Label matching is off in Settings',
    ai: t.ai === 'off' ? 'Turn on AI assist in Settings' : undefined,
    'labels-ai': !t.labels ? 'Label matching is off in Settings' : t.ai === 'off' ? 'Turn on AI assist in Settings' : undefined,
    'labels-ai-write': !t.labels ? 'Label matching is off in Settings' : t.ai === 'off' ? 'Turn on AI assist in Settings' : undefined,
  }
  const mode = effectiveMode()
  const modes = el('div', { class: 'segmented', role: 'radiogroup' },
    ...(([['labels', 'Labels'], ['ai', 'AI'], ['labels-ai', 'Labels then AI'], ['labels-ai-write', 'Labels then AI writes']] as [FillMode, string][]).map(([value, label]) =>
      el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(value === mode), class: value === mode ? 'on' : '', 'data-name': 'fill', 'data-value': value,
        disabled: !!reasons[value], title: reasons[value] ?? '',
        onclick: () => {
          t.fillMode = value
          void saveSettings(state.settings)
          renderMain()
        },
      }, label))))
  const note = form.mode === 'new'
    ? 'Creates the page from this template and fills it in. Child pages of the template are not copied.'
    : 'Adds the template’s main tab, filled in, to the end of the page after a divider. The page’s sidebar is not changed.'
  return el('div', { class: 'group' },
    field('Template', select, el('p', { class: 'muted small' }, state.templateLoading ? 'Reading the template…' : note)),
    field('Fill with', modes, el('p', { class: 'muted small' }, mode ? `${FILL_MODE_HELP[mode]()}${mode === 'labels' ? '' : ` ${notesHelp(aiNotes()?.from)}`}` : 'Label matching and AI are both off, so the clip goes under the template as it is.')),
    checkbox('Keep unfilled template fields', t.keepUnfilled, 'Fields nothing was found for keep the template’s placeholder; untick to remove them', (v) => {
      t.keepUnfilled = v
      void saveSettings(state.settings)
      update()
    }))
}

function notesHelp(from: string | undefined): string {
  return from === 'yours' ? 'Your notes for this template guide it.' : from ? `The built-in “${from}” notes guide it.` : 'Add notes for this template in Settings to guide it.'
}

const FILL_MODE_HELP: Record<FillMode, () => string> = {
  labels: () => 'Fields whose label is in the clip. No AI.',
  ai: () => 'The AI picks a part of the clip for every field.',
  'labels-ai': () => 'Labels first; the AI picks parts of the clip for the fields left.',
  'labels-ai-write': () => 'Labels first; the AI fills the fields left and may write short ones in the template’s style, using only the clip’s facts.',
}

/** The notes the AI gets about the chosen template. */
function aiNotes(): { text: string; from: string } | undefined {
  if (!state.template) return undefined
  const t = state.settings.templates
  return notesFor(state.template.name, buildSlots(state.template.tree), t.notes, new Synonyms(t.synonyms))
}

function aiKey(): string {
  const notes = aiNotes()?.text ?? ''
  return [state.pending?.id, state.template?.id, state.template?.updatedAt, state.form.mode, effectiveMode(), notes].join('|')
}

async function aiEngine(): Promise<AiEngine> {
  const t = state.settings.templates
  if (t.ai === 'on-device') return (onDevice ??= new OnDeviceEngine())
  if (t.ai === 'openrouter') {
    if (!t.openRouterKey) throw new AiUnavailableError('Add your OpenRouter key in Settings → Templates.')
    state.freeModels ??= await listFreeModels().catch(() => [])
    const model = t.openRouterModel || state.freeModels[0]?.id
    if (!model) throw new AiUnavailableError('No free OpenRouter model is available right now.')
    return new OpenRouterEngine({ apiKey: t.openRouterKey, model, fallbacks: state.freeModels })
  }
  throw new AiUnavailableError('AI assist is off.')
}

/** Asks the AI about the slots labels left empty, once per clip, template and destination. */
async function maybeRunAi({ again = false } = {}): Promise<void> {
  const mode = effectiveMode()
  const plan = state.fillPlan
  const capture = state.pending?.capture
  if (!mode || mode === 'labels' || !plan || !capture || !state.plan) return renderAi()
  const key = aiKey()
  if (state.ai.key === key && !again) return renderAi()
  // Fields you changed in the mapper are yours: the AI leaves them alone.
  const slots = slotsForAi(plan, mode, Object.fromEntries((state.mapping?.touched ?? []).map((id) => [id, { choice: 'mapper' }])))
  const blockIndexes = blocksForAi(plan, slots, mode, state.plan.blocks.length, new Synonyms(state.settings.templates.synonyms))
  if (slots.length === 0 || blockIndexes.length === 0) {
    state.ai = { key, status: 'done', message: slots.length === 0 ? 'Labels filled every field; the AI wasn’t needed.' : 'Everything in the clip is used; nothing left for the AI.' }
    return renderAi()
  }
  state.ai = { key, status: 'running', message: 'Asking the AI…' }
  renderAi()
  const started = Date.now()
  try {
    const engine = await aiEngine()
    state.ai.message = `Asking ${engine.name} about ${slots.length} field${slots.length === 1 ? '' : 's'}…`
    renderAi()
    const result = await suggest(engine, { slots, clip: state.plan.blocks, blockIndexes, title: state.form.title.trim() || capture.suggestedTitle, nameOf: (id) => state.index?.get(id)?.name, labels: plan.blockLabels, notes: aiNotes()?.text, write: mode === 'labels-ai-write' ? {} : undefined })
    if (state.ai.key !== key) return
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    state.ai = {
      key,
      status: 'done',
      suggestions: result.suggestions,
      prompt: result.job?.prompt,
      system: result.job?.system,
      raw: result.raw,
      message: `${engine.name} suggested ${result.suggestions.size} of ${slots.length} field${slots.length === 1 ? '' : 's'} in ${seconds} s.${result.truncated ? ' The clip was shortened to fit the model.' : ''}`,
    }
    rebuildPlan()
  } catch (error) {
    if (state.ai.key !== key) return
    state.ai = { key, status: 'error', message: `${error instanceof Error ? error.message : String(error)} Label results are used.` }
    renderAi()
  }
}

function renderAi(): void {
  if (!aiBox) return
  const mode = effectiveMode()
  if (!templateTree() || !mode || mode === 'labels' || state.ai.status === 'idle') {
    aiBox.hidden = true
    return
  }
  aiBox.hidden = false
  clear(aiBox,
    el('p', { class: `small ${state.ai.status === 'error' ? 'problem' : 'muted'}` }, state.ai.message ?? ''),
    state.ai.status !== 'running' ? el('button', { type: 'button', class: 'link small', onclick: () => void maybeRunAi({ again: true }) }, 'Ask the AI again') : null,
    state.ai.prompt
      ? el('details', { class: 'ai-exchange' },
          el('summary', { class: 'small' }, 'What the AI was asked and answered'),
          el('pre', {}, `${state.ai.system ?? SYSTEM_PROMPT}\n\n${state.ai.prompt}`),
          el('pre', {}, state.ai.raw ?? ''))
      : null)
}

/** The template's fields in brief, and the button that opens the mapper to change them. */
function renderTemplateSummary(): void {
  const plan = filled()
  if (!plan || !state.mapBase || !state.mapping) return clear(templateBox)
  const counts = summarize(applyMapping(state.mapBase, state.mapping))
  const fields = plan.slots.filter((s) => FILLABLE.has(s.slot.kind))
  const ties = fields.filter((s) => s.status === 'ambiguous').map((s) => s.slot.label)
  const unticked = fields.filter((s) => s.status === 'off').map((s) => s.slot.label)
  const changed = state.mapping.touched.length
  clear(templateBox,
    el('div', { class: 'map-summary' },
      el('div', { class: 'map-counts', 'aria-label': 'Template fields' },
        el('span', { class: 'count filled' }, el('strong', {}, String(counts.filled)), ' filled'),
        el('span', { class: 'count empty' }, el('strong', {}, String(counts.empty + counts.toChoose)), ' empty'),
        el('span', { class: 'count unused' }, el('strong', {}, String(counts.unused)), ' unused')),
      el('button', { type: 'button', class: 'open-mapper', onclick: () => void openMapper() }, 'Open mapper'),
      ties.length ? el('p', { class: 'small warning' }, `Several clip values fit ${ties.join(', ')}. Pick one in the mapper, or leave ${ties.length === 1 ? 'it' : 'them'} empty.`) : null,
      unticked.length ? el('p', { class: 'small muted' }, `The AI’s answer for ${unticked.join(', ')} doesn’t match the clip, so it isn’t used. The mapper shows it if you want it anyway.`) : null,
      el('p', { class: 'muted small' },
        changed ? `You changed ${changed} field${changed === 1 ? '' : 's'} in the mapper. ` : 'Label matching filled these. ',
        counts.unused ? `Unused parts of the clip go at the end, after a divider.` : 'Everything in the clip went into a field.')),
    extraRowsField(plan),
    tagsField())
}

/** Rows of a clip table added to a template list that lacks them ("Tool Proficiencies"). */
function extraRowsField(plan: FillPlan): HTMLElement | null {
  if (plan.extraRows.length === 0 && !state.noExtraRows) return null
  const names = plan.extraRows.map((r) => `${r.label}: ${r.text}`).join('; ')
  return checkbox(state.noExtraRows ? 'Add the clip table’s rows the template doesn’t have' : `Also add to the list: ${names}`, !state.noExtraRows,
    'The template’s list has no row for these, but they are in the same table of the clip as rows it filled', (v) => {
      state.noExtraRows = !v
      rebuildPlan()
    })
}

/** Tags worked out from a stat block's fields, spelled as the project already spells them. */
function suggestedTags(): string[] {
  const t = state.settings.templates
  const plan = filled()
  if (!t.tagStatblocks || !plan || !state.index) return []
  const existing = [...state.index.byId.values()].flatMap((r) => r.tags)
  return withProjectSpelling(statblockTags(plan, new Synonyms(t.synonyms)), existing)
}

/** The tags the import adds to the page. */
function pageTags(): string[] {
  return state.tagsText !== undefined ? parseTags(state.tagsText) : suggestedTags()
}

function tagsField(): HTMLElement | null {
  if (state.tagsText === undefined && suggestedTags().length === 0) return null
  const input = el('input', { type: 'text', value: pageTags().join(', '), 'aria-label': 'Tags to add', onchange: (e: Event) => {
    state.tagsText = (e.target as HTMLInputElement).value
    update()
  } })
  return field('Tags to add', input, el('p', { class: 'muted small' },
    `From the creature’s size, type, alignment and challenge rating. They join ${state.form.mode === 'new' ? 'the template’s tags' : 'the page’s own tags'}. Separate tags with commas; clear the box to add none.`,
    state.tagsText !== undefined ? el('button', { type: 'button', class: 'link small', onclick: () => ((state.tagsText = undefined), update()) }, ' Use the suggested tags') : null))
}

/** The preview of a template clip: the filled main tab (or what an append adds). */
function templatePreview(tree: TemplateTree, plan: FillPlan, heading: Block | undefined): Block[] {
  const composition: Composition = compose(tree, plan, { sourceHeading: heading, keepUnfilled: state.settings.templates.keepUnfilled })
  if (state.form.mode === 'append') return appendedTemplate(tree, composition)
  return applyComposition(tree, composition).docs[composition.mainDoc] ?? []
}

/** The Source the import will use, as far as can be known before importing. */
function chosenSource(): { spec?: SourceSpec; label: string; problem?: string; existing?: IndexedResource[] } {
  const form = state.form
  const config = sourceConfig()
  if (!state.settings.sourceHeading) return { label: '' }
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

  const tree = templateTree()
  const fillPlan = tree ? filled() : undefined
  const problems = importProblems()

  const notes: (string | Node)[] = []
  if (form.mode === 'new') {
    notes.push(parentPicker.value ? `New page under ${state.index.path(parentPicker.value.id)}` : 'New page at the top level of the project (needs an ADMIN key)')
  } else if (targetPicker.value) {
    const tab = targetPicker.value.documents.find((d) => d.id === form.targetDocumentId)
    notes.push(`Adds to the end of ${state.index.path(targetPicker.value.id)}${tab && writableDocuments(targetPicker.value).length > 1 ? ` (${tab.name} tab)` : ''}, after a divider`)
  }
  if (tree && state.template) {
    notes.push(`${form.mode === 'new' ? 'Made from' : 'Fills in'} ${state.template.name}${state.template.tree.docs.length > 1 && form.mode === 'new' ? ` (${state.template.tree.docs.length} tabs; the preview shows the main one)` : ''}`)
    if (state.template.otherTabs.length && form.mode === 'new') notes.push(`The template’s other tabs (${state.template.otherTabs.join(', ')}) are copied as they are`)
  }
  if (plan.images.length) notes.push(`${plan.images.length} image${plan.images.length === 1 ? '' : 's'} in the clip; those that end up in the page are copied into your project`)
  notes.push(...plan.warnings)

  clear(summaryBox, ...problems.map((p) => el('p', { class: 'problem' }, p)), el('ul', {}, ...notes.map((n) => el('li', {}, n))))
  renderLinks(plan.terms)
  renderAi()
  if (fillPlan) renderTemplateSummary()
  else clear(templateBox)
  importButton.disabled = problems.length > 0 || state.busy
  importButton.textContent = form.mode === 'new' ? 'Create page' : 'Add to page'

  const heading: Block | undefined = state.settings.sourceHeading ? sourceHeadingPreview(source.label) : undefined
  const blocks = tree && fillPlan
    ? templatePreview(tree, fillPlan, heading)
    : [...(form.mode === 'append' ? [{ kind: 'rule' } as Block] : []), ...(heading ? [heading] : []), ...plan.blocks]
  previewBox.innerHTML = blocksToHtml(blocks, { nameOf: (id) => state.index?.get(id)?.name })
  saveForm()
  publishMapper()
}

/** What stops the import: shown in the panel, and in the mapper next to its Import button. */
function importProblems(): string[] {
  const form = state.form
  const plan = state.plan
  const tree = templateTree()
  const problems: string[] = []
  if (!plan) return ['The clip is still being read.']
  if (plan.blocks.length === 0 && !(tree && state.fillPlan)) problems.push('There is nothing to import in this clip.')
  if (form.templateId && state.settings.templates.enabled && !tree) problems.push(state.templateLoading ? 'Reading the template…' : 'The template could not be read. Choose it again.')
  if (form.mode === 'new' && !form.title.trim()) problems.push('Name the new page.')
  if (form.mode === 'append' && (!targetPicker?.value || !form.targetDocumentId)) problems.push('Choose the page to add to.')
  const source = chosenSource()
  if (source.problem) problems.push(source.problem)
  return problems
}

/** The "From <Source>" heading as the preview shows it, before the Source exists. */
function sourceHeadingPreview(label: string): Block {
  return { kind: 'heading', level: 1, content: [{ text: 'From ' }, { mention: { resourceId: '_source', text: label } }] }
}

/**
 * The proposed links, so each can be checked before importing: switched off, or, when a name
 * fits several pages, pointed at the right one. Names that need a decision come first.
 */
function renderLinks(terms: LinkTerm[]): void {
  const index = state.index
  if (!index || terms.length === 0) return clear(linksBox)
  const order = { ambiguous: 0, linked: 1, chosen: 1, off: 2 } as const
  const sorted = [...terms].sort((a, b) => order[a.status] - order[b.status] || a.text.localeCompare(b.text))
  const linkedCount = terms.filter((t) => t.linkedTo).length
  const choose = (term: LinkTerm, value: string | null | undefined) => {
    if (value === undefined) delete state.linkChoices[term.key]
    else state.linkChoices[term.key] = value
    rebuildPlan()
  }
  const count = (term: LinkTerm) =>
    term.linkedTo && term.found > 1 ? (term.linked === term.found ? ` ×${term.found}` : ` (first of ${term.found} mentions)`) : ''
  const rows = sorted.map((term) => {
    const where = term.pass === 'hyperlink' ? el('span', { class: 'tier' }, 'web link') : null
    if (term.candidates.length === 1) {
      const page = term.candidates[0]!
      return el('li', { class: term.linkedTo ? '' : 'off' },
        el('label', { class: 'check', title: index.path(page.id) },
          el('input', { type: 'checkbox', checked: !!term.linkedTo, onchange: (e: Event) => choose(term, (e.target as HTMLInputElement).checked ? undefined : null) }),
          el('span', {}, describeTerm({ ...term, linkedTo: page.id }, index), count(term), ' ', where)))
    }
    return el('li', { class: term.status === 'ambiguous' ? 'ambiguous' : '' },
      el('div', {}, el('strong', {}, term.text), ' ', where, term.status === 'ambiguous' ? el('span', { class: 'muted small' }, ` matches ${term.candidates.length} pages`) : count(term)),
      el('select', { onchange: (e: Event) => choose(term, (e.target as HTMLSelectElement).value || null) },
        el('option', { value: '', selected: !term.linkedTo }, term.status === 'ambiguous' ? 'Leave unlinked (choose a page…)' : 'Leave unlinked'),
        ...term.candidates.map((c) => el('option', { value: c.id, selected: term.linkedTo === c.id }, index.path(c.id)))))
  })
  clear(linksBox, el('details', { open: true },
    el('summary', {}, `Links to your pages: ${linkedCount} of ${terms.length}`),
    el('ul', {}, ...rows)))
}

async function runImport(requestId?: string): Promise<void> {
  const { plan, lk, index, project } = state
  const capture = state.pending?.capture
  const source = chosenSource()
  const config = sourceConfig()
  if (!plan || !lk || !index || !project || !capture || state.busy) return
  if (state.settings.sourceHeading && (!source.spec || (source.spec.kind === 'new' && !config))) return
  const tree = templateTree()
  const fillPlan = tree ? filled() : undefined
  // The mapper tab hears how it went, whichever button started it.
  const key = state.mapBase?.key
  const report = (status: Omit<ImportStatus, 'key' | 'requestId'>) => key && fillPlan && reportImport({ key, ...(requestId ? { requestId } : {}), ...status })
  const template = tree && fillPlan && state.template ? { content: state.template, plan: fillPlan, keepUnfilled: state.settings.templates.keepUnfilled, tags: pageTags() } : undefined

  state.busy = true
  importButton.disabled = true
  progressBox.hidden = false
  progressBox.className = 'progress'
  progressBox.textContent = 'Starting…'
  report({ state: 'importing', message: 'Starting…' })
  try {
    const form = state.form
    const result = await importClip(lk, index, plan, {
      destination: form.mode === 'new'
        ? { mode: 'new', parentId: parentPicker.value?.id, title: form.title.trim() }
        : { mode: 'append', target: { resourceId: targetPicker.value!.id, documentId: form.targetDocumentId! } },
      source: source.spec,
      template,
      sourceConfig: config ?? { sourcesRootId: '' },
      assetFolderName: state.settings.assetFolder,
      onProgress: (message) => {
        progressBox.textContent = message
        report({ state: 'importing', message })
      },
      // With the extension's host permission, image requests can carry the site's cookies, like the page's own.
      fetchImpl: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    })
    await rememberAfterImport(result.source?.id)
    await persistIndex()
    const warnings = result.templateMissing.length ? [`${result.templateMissing.length} field(s) were not found in the new page (the template may have changed) and were skipped.`] : []
    const title = form.mode === 'new' ? form.title.trim() : targetPicker.value!.name
    report({ state: 'done', message: `${form.mode === 'new' ? 'Created' : 'Added to'} “${title}”.${warnings.length ? ` ${warnings.join(' ')}` : ''}`, url: result.url })
    renderDone(result.url, title, form.mode, result.sourceCreated ? result.source?.name : undefined, result.imagesFailed, warnings)
  } catch (error) {
    if (error instanceof TemplateFillError) {
      await persistIndex()
      const failed = error as TemplateFillError & { composition: Composition; url: string }
      report({ state: 'fill-failed', message: `“${failed.resource.name}” was created from the template, but filling it failed: ${describeError(failed.cause)} In the side panel, choose Try filling again or Delete the new page.`, url: failed.url })
      return renderFillFailed(failed)
    }
    report({ state: 'failed', message: describeError(error) })
    progressBox.className = 'progress error'
    progressBox.textContent = describeError(error)
    importButton.disabled = false
    // A page chosen here was deleted in LegendKeeper meanwhile: reload the list so the form shows it.
    if (isNotFound(error)) void refreshIndex()
  } finally {
    state.busy = false
  }
}

/** Remembers the destination, Source and template for next time, and saves rules the user asked for. */
async function rememberAfterImport(sourceId: string | undefined): Promise<void> {
  const project = state.project
  const capture = state.pending?.capture
  if (!project || !capture) return
  const form = state.form
  const previous = await loadRemembered(project.projectId)
  const templateBySource = { ...previous?.templateBySource }
  if (state.settings.templates.enabled) {
    for (const key of [sourceId, `site:${form.websiteName.trim()}`]) {
      if (!key) continue
      if (form.templateId) templateBySource[key] = form.templateId
      else delete templateBySource[key]
    }
  }
  await saveRemembered(project.projectId, {
    mode: form.mode,
    parentId: form.parentId,
    targetId: form.targetId,
    targetDocumentId: form.targetDocumentId,
    sourceMode: form.sourceMode === 'new' ? 'existing' : form.sourceMode,
    sourceId: sourceId ?? previous?.sourceId,
    templateBySource,
  })
  if (state.mapBase && state.mapping && state.template && templateTree()) {
    const added = rulesFromMapping(state.mapBase, state.mapping, { site: siteHost(capture.url), templateId: state.template.id, templateName: state.template.name })
    if (added.length) {
      project.rules = mergeRules(project.rules ?? [], added)
      await saveSettings(state.settings)
    }
  }
}

/** The page was made from the template but filling it failed: never make a second copy. */
function renderFillFailed(error: TemplateFillError & { composition: Composition; url: string }): void {
  const lk = state.lk
  const message = el('p', { class: 'problem' }, describeError(error.cause))
  app.dataset.view = 'done'
  clear(app, el('div', { class: 'done' },
    el('h2', {}, 'Page created, but filling failed'),
    el('p', {}, el('strong', {}, error.resource.name), ' was created from the template, but the values could not be written into it.'),
    message,
    el('p', {}, el('a', { href: error.url, target: '_blank', rel: 'noopener', class: 'button' }, 'Open the page')),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', onclick: async () => {
        if (!lk) return
        message.className = 'muted'
        message.textContent = 'Trying again…'
        try {
          await fillPage(lk, error.resource.id, error.composition)
          await rememberAfterImport(undefined)
          renderDone(error.url, error.resource.name, 'new', undefined, [], [])
        } catch (again) {
          message.className = 'problem'
          message.textContent = describeError(again)
        }
      } }, 'Try filling again'),
      el('button', { type: 'button', onclick: async () => {
        if (!lk || !confirm(`Delete "${error.resource.name}" from LegendKeeper? Nothing else is touched.`)) return
        try {
          await lk.resources.delete({ resourceId: error.resource.id })
          state.index?.byId.delete(error.resource.id)
          await persistIndex()
          renderMain()
        } catch (failed) {
          message.className = 'problem'
          message.textContent = describeError(failed)
        }
      } }, 'Delete the new page')),
    el('button', { type: 'button', class: 'link', onclick: () => renderMain() }, 'Back to this clip')))
}

function renderDone(url: string, title: string, mode: 'new' | 'append', newSource: string | undefined, failed: { src: string; reason: string }[], warnings: string[] = []): void {
  app.dataset.view = 'done'
  clear(
    app,
    el('div', { class: 'done' },
      el('h2', {}, mode === 'new' ? 'Page created' : 'Added to the page'),
      el('p', {}, el('strong', {}, title)),
      newSource ? el('p', { class: 'muted' }, `New Source "${newSource}" created.`) : null,
      failed.length ? el('p', { class: 'warning' }, `${failed.length} image(s) could not be copied and were kept as links: ${failed.map((f) => f.reason).join('; ')}`) : null,
      ...warnings.map((w) => el('p', { class: 'warning' }, w)),
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
    el('p', { class: 'muted' }, 'PDFs open in the LK Reader, where you can clip them like a web page.'),
    el('button', { type: 'button', onclick: () => void openPdfReader() }, 'Open a PDF in LK Reader'),
  )
}

/** Opens the reader on the PDF in the active tab, or empty to choose a file. */
async function openPdfReader(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await openReader(isPdfUrl(tab?.url) ? tab?.url : undefined, tab?.id)
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
      el('h3', {}, 'Linking'),
      checkbox('Link only exact page names', state.settings.exactNames, 'Keeps the clip’s words: only text written exactly as a page’s name becomes a link', async (v) => {
        state.settings.exactNames = v
        await saveSettings(state.settings)
        renderSettings()
      }),
      el('p', { class: 'muted small' }, 'LegendKeeper shows a page link as the page’s name. So with this on, “attack roll” stays “attack roll” rather than becoming a link that reads “Attack Rolls”. Off: aliases, plurals and possessives are linked too, and LegendKeeper will show them as the page’s name.'),
      state.settings.exactNames ? null : checkbox('Match capitalisation', state.settings.matchCase, 'Like LegendKeeper: a page named "King" links "King" but not "king". Add aliases for other spellings.', async (v) => {
        state.settings.matchCase = v
        await saveSettings(state.settings)
      }),
      state.settings.exactNames ? null : el('p', { class: 'muted small' }, 'A page named “King” links “King” but not “king”. Add aliases in LegendKeeper for other spellings and plurals; a lowercase alias still matches at the start of a sentence.'),
      checkbox('Link only the first mention of each page', state.settings.firstOnly, 'Later mentions of the same page stay plain text', async (v) => {
        state.settings.firstOnly = v
        await saveSettings(state.settings)
      }),
      el('p', { class: 'muted small' }, 'Otherwise every mention becomes a link, as LegendKeeper’s own auto-linker does.'),
    ),
    el('section', {},
      el('h3', {}, 'Clipping'),
      field('Image folder', el('input', { type: 'text', value: state.settings.assetFolder, oninput: async (e: Event) => {
        state.settings.assetFolder = (e.target as HTMLInputElement).value.trim() || 'LK Web Clipper'
        await saveSettings(state.settings)
      } }), el('p', { class: 'muted small' }, 'The folder in your LegendKeeper asset library that clipped images go into.')),
    ),
    templateSettings(),
    state.settings.projects.length > 0 ? el('button', { type: 'button', class: 'primary', onclick: () => void onNewCapture() }, 'Done') : null,
  )
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && void connect())
}

/** The template whose AI notes Settings shows; kept while the panel is open. */
let notesTemplate: string | undefined

/**
 * Settings: your notes for the AI about each template, used in every AI mode. A template without
 * notes uses the built-in pack that fits it, if any, which you can edit into your own. "Suggest
 * notes with AI" drafts notes from the template's fields and the clip open in the panel; the draft
 * is saved only when you save it.
 */
function templateNotesEditor(): HTMLElement {
  const t = state.settings.templates
  const inProject = state.index ? listTemplates(state.index).map((x) => x.resource) : []
  const names = [...new Set([...inProject.map((r) => r.name), ...t.notes.map((n) => n.templateName)])]
  notesTemplate = notesTemplate && names.includes(notesTemplate) ? notesTemplate : state.template?.name ?? names[0]
  const status = el('p', { class: 'muted small' })
  const remove = el('button', { type: 'button', class: 'link small', hidden: true }, 'Remove your notes')
  const text = el('textarea', { spellcheck: true, 'aria-label': 'Notes for the AI' })
  const suggestButton = el('button', { type: 'button', class: 'small' }, 'Suggest notes with AI')
  const saveDraft = el('button', { type: 'button', class: 'small primary', hidden: true }, 'Save these notes')
  const discardDraft = el('button', { type: 'button', class: 'link small', hidden: true }, 'Discard')
  let pack: { name: string; text: string } | undefined
  /** An AI draft is in the box and not saved yet. */
  let draft = false

  const slotsOf = async (name: string) => {
    const resource = inProject.find((r) => r.name === name)
    if (!resource || !state.lk) return undefined
    return buildSlots((await templateCache.get(state.lk, resource)).tree)
  }
  const setDraft = (on: boolean) => {
    draft = on
    saveDraft.hidden = !on
    discardDraft.hidden = !on
  }

  const show = async () => {
    const name = notesTemplate
    if (!name) return
    setDraft(false)
    const saved = savedNotes(t.notes, name)
    remove.hidden = !saved
    pack = undefined
    try {
      const slots = await slotsOf(name)
      if (slots) pack = builtInPackFor(slots, new Synonyms(t.synonyms), name)
    } catch {
      // Without the template, only your own notes can be shown.
    }
    if (notesTemplate !== name) return
    text.value = saved?.text ?? pack?.text ?? ''
    status.textContent = saved
      ? `Your notes for ${name}.${pack ? ` Remove them to use the built-in “${pack.name}” notes again.` : ''}`
      : pack
        ? `Using the built-in “${pack.name}” notes. Edit them to make your own.`
        : `No notes for ${name} yet. Write what its fields mean and how you want them written, or let the AI suggest some.`
  }
  const saveText = () => {
    if (!notesTemplate) return
    // Built-in notes left as they are aren't saved as yours.
    t.notes = withNotes(t.notes, notesTemplate, pack && text.value.trim() === pack.text.trim() ? '' : text.value)
    void saveSettings(state.settings)
    void show()
  }
  text.addEventListener('change', () => {
    // A draft is saved only with its button.
    if (!draft) saveText()
  })
  saveDraft.addEventListener('click', saveText)
  discardDraft.addEventListener('click', () => void show())
  remove.addEventListener('click', () => {
    if (!notesTemplate) return
    t.notes = withNotes(t.notes, notesTemplate, '')
    void saveSettings(state.settings)
    void show()
  })
  suggestButton.addEventListener('click', async () => {
    const name = notesTemplate
    if (!name) return
    if (t.ai === 'off') {
      status.textContent = 'Turn on AI assist above to have the AI suggest notes.'
      return
    }
    suggestButton.disabled = true
    status.textContent = 'Asking the AI for notes…'
    try {
      const slots = await slotsOf(name)
      if (!slots) throw new Error(`${name} is not in this project, so its fields can’t be read.`)
      const capture = state.pending?.capture
      const clip = capture && state.plan?.blocks.length ? { blocks: state.plan.blocks, title: state.form.title.trim() || capture.suggestedTitle } : undefined
      const engine = await aiEngine()
      const result = await suggestNotes(engine, { templateName: name, slots, current: text.value, clip, nameOf: (id) => state.index?.get(id)?.name })
      if (notesTemplate !== name) return
      text.value = result.notes
      setDraft(true)
      status.textContent = `${engine.name} suggested these notes${clip ? `, using “${clip.title}” as an example clip` : ''}. They aren’t saved yet: check them (the AI can be wrong), edit them, then save or discard them.`
    } catch (error) {
      status.textContent = `The AI couldn’t suggest notes: ${describeError(error)}`
    } finally {
      suggestButton.disabled = false
    }
  })
  const select = el('select', { 'aria-label': 'Template', onchange: (e: Event) => {
    notesTemplate = (e.target as HTMLSelectElement).value
    void show()
  } }, ...names.map((name) => el('option', { value: name, selected: name === notesTemplate },
    `${name}${savedNotes(t.notes, name) ? ' (your notes)' : ''}${inProject.some((r) => r.name === name) ? '' : ' (not in this project)'}`)))
  void show()
  return field('AI notes for templates',
    el('p', { class: 'muted small' }, 'They tell the AI what each field means and how you want it written, e.g. “Initiative: the Dexterity modifier, such as +3”, in every AI mode. Keep them short; they share the AI’s space with the clip. “Suggest notes with AI” drafts notes from the template’s fields and the clip open in the panel.'),
    names.length ? select : el('p', { class: 'muted small' }, 'This project has no templates.'),
    names.length ? text : null,
    names.length ? el('div', { class: 'row' }, suggestButton, saveDraft, discardDraft) : null,
    status, remove)
}

function templateSettings(): HTMLElement {
  const t = state.settings.templates
  const save = () => void saveSettings(state.settings)
  const project = state.project
  const aiDetails = el('div', { class: 'group' })

  const renderAiDetails = () => {
    if (t.ai === 'on-device') {
      const status = el('p', { class: 'small muted' }, 'Checking Chrome’s built-in AI…')
      const bar = el('progress', { max: 1, value: 0, hidden: true })
      const button = el('button', { type: 'button', hidden: true, onclick: async () => {
        button.disabled = true
        bar.hidden = false
        status.textContent = 'Setting up… Chrome downloads the model once; this can take a while.'
        try {
          onDevice ??= new OnDeviceEngine()
          await onDevice.prepare((fraction) => {
            bar.value = fraction
            status.textContent = `Downloading the model: ${Math.round(fraction * 100)}%`
          })
          status.textContent = ON_DEVICE_HELP.available
          button.hidden = true
          bar.hidden = true
        } catch (error) {
          status.className = 'small problem'
          status.textContent = error instanceof Error ? error.message : String(error)
          button.disabled = false
        }
      } }, 'Set up on-device AI')
      clear(aiDetails, status, bar, button, el('p', { class: 'muted small' }, 'Uses Gemini Nano inside Chrome. Clips never leave your computer. To check your computer, open chrome://on-device-internals.'))
      void onDeviceStatus().then((current) => {
        status.textContent = ON_DEVICE_HELP[current]
        status.className = `small ${current === 'available' ? '' : current === 'unavailable' || current === 'unsupported' ? 'problem' : 'muted'}`
        button.hidden = !(current === 'downloadable' || current === 'downloading')
      })
    } else if (t.ai === 'openrouter') {
      const models = el('select', { onchange: (e: Event) => ((t.openRouterModel = (e.target as HTMLSelectElement).value), save()) },
        el('option', { value: t.openRouterModel }, t.openRouterModel || 'Loading free models…'))
      const loadModels = async () => {
        try {
          state.freeModels = await listFreeModels()
          clear(models, ...state.freeModels.map((m) => el('option', { value: m.id, selected: m.id === (t.openRouterModel || state.freeModels![0]!.id) }, `${m.name}${m.structured ? ' (JSON schema)' : ''}`)))
          if (!t.openRouterModel && state.freeModels[0]) {
            t.openRouterModel = state.freeModels[0].id
            save()
          }
        } catch (error) {
          clear(models, el('option', { value: t.openRouterModel }, t.openRouterModel || 'Could not load the model list'))
          showToast(describeError(error), 'error')
        }
      }
      void loadModels()
      clear(aiDetails,
        field('OpenRouter key', el('input', { type: 'password', value: t.openRouterKey, placeholder: 'sk-or-…', autocomplete: 'off', oninput: (e: Event) => ((t.openRouterKey = (e.target as HTMLInputElement).value.trim()), save()) })),
        field('Free model', models, el('p', { class: 'muted small' }, 'Only free models (ids ending in “:free”) are offered or used. If the chosen one is busy or gone, the next free model is tried once.')),
        el('p', { class: 'warning small' }, 'With OpenRouter, the clip’s text is sent to OpenRouter and the model’s provider. Free providers’ data policies differ; see each model’s page on openrouter.ai.'))
    } else clear(aiDetails)
  }
  renderAiDetails()

  const aiSelect = el('select', { onchange: (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as AiEngineChoice
    if (value === 'openrouter' && !t.openRouterWarned) {
      if (!confirm('OpenRouter sends the text of your clips to OpenRouter and to the AI model’s provider, outside your computer. Use it?')) {
        ;(e.target as HTMLSelectElement).value = t.ai
        return
      }
      t.openRouterWarned = true
    }
    t.ai = value
    save()
    renderAiDetails()
  } },
  ...([['off', 'Off'], ['on-device', 'On-device (Chrome’s built-in AI)'], ['openrouter', 'OpenRouter (free models)']] as [AiEngineChoice, string][]).map(([value, label]) =>
    el('option', { value, selected: t.ai === value }, label)))

  const synonyms = el('textarea', { spellcheck: false, 'aria-label': 'Synonyms', onchange: (e: Event) => {
    t.synonyms = parseSynonyms((e.target as HTMLTextAreaElement).value)
    save()
  } })
  synonyms.value = formatSynonyms(t.synonyms)

  const derived = el('textarea', { spellcheck: false, 'aria-label': 'Worked-out fields', class: 'short', onchange: (e: Event) => {
    t.derived = (e.target as HTMLTextAreaElement).value
    save()
  } })
  derived.value = t.derived

  const notesEditor = templateNotesEditor()

  const rules = project?.rules ?? []
  const rulesList = savedRulesEditor(rules, save)

  return el('section', {},
    el('h3', {}, 'Templates'),
    checkbox('Enable template filling', t.enabled, 'Shows a Template choice in the panel', (v) => ((t.enabled = v), save(), renderSettings())),
    el('p', { class: 'muted small' }, 'Pick one of your LegendKeeper templates for a clip, and the clipper fills in its fields from the clip. Off: the panel works exactly as before.'),
    t.enabled ? el('div', { class: 'group' },
      checkbox('Label matching', t.labels, 'Fill fields whose label appears in the clip. No AI.', (v) => ((t.labels = v), save())),
      field('AI assist', aiSelect, el('p', { class: 'muted small' }, 'Fills the fields labels couldn’t. The AI only picks parts of the clip; you review everything before importing.')),
      aiDetails,
      field('Synonyms', synonyms,
        el('p', { class: 'muted small' }, 'One group per line: labels that mean the same, separated by commas.'),
        el('button', { type: 'button', class: 'link small', onclick: () => {
          t.synonyms = DEFAULT_SYNONYMS
          save()
          synonyms.value = formatSynonyms(t.synonyms)
        } }, 'Reset to the defaults')),
      field('Worked-out fields', derived,
        el('p', { class: 'muted small' }, 'Fills a field the clip doesn’t state from other fields, one per line, e.g. “Initiative = {Dexterity modifier} ({10 + Dexterity modifier})”. In braces: a field’s name, then “modifier” for the signed number in “16 (+3)”, “number” for the first number, or nothing for the whole value; “10 + …” adds to it. Text outside braces is written as it is. Used when nothing else fills the field, or to complete a value the clip only starts (“+3” → “+3 (13)”).'),
        el('button', { type: 'button', class: 'link small', onclick: () => {
          t.derived = DEFAULT_DERIVED
          save()
          derived.value = t.derived
        } }, 'Reset to the defaults')),
      checkbox('Tag stat block pages', t.tagStatblocks, 'Adds the creature’s size, type, alignment and challenge rating as tags', (v) => ((t.tagStatblocks = v), save())),
      el('p', { class: 'muted small' }, 'For templates with stat block fields (Armour Class, Hit Points, ability scores…): “Medium Humanoid (Any Race), Any Non-Good Alignment” and CR 8 give the tags Medium, Humanoid, Any Non-Good Alignment and CR 8. You can change them on the review screen.'),
      notesEditor,
      field(`Saved rules${project ? ` in ${project.projectName}` : ''}`,
        rules.length ? rulesList : el('p', { class: 'muted small' }, 'None yet. When you drag a labelled part of the clip into a field in the mapper, you can remember it for that website.'),
        rules.length ? el('p', { class: 'muted small' }, 'On that website, a clip value with this label goes in this field of the template, before any other label matching. Change the website, the clip’s label or the field here.') : null),
    ) : null)
}

/**
 * Saved rules, editable: the website, the clip's label and the template field. Each template is read
 * (from the cache when it can be) to offer its fields and to mark rules whose field it no longer has.
 */
function savedRulesEditor(rules: SavedRule[], save: () => void): HTMLElement {
  const project = state.project!
  const list = el('ul', { class: 'settings-list rules' })
  const slotsByTemplate = new Map<string, Promise<Slot[] | undefined>>()
  const slotsOf = (templateId: string): Promise<Slot[] | undefined> => {
    let entry = slotsByTemplate.get(templateId)
    if (!entry) {
      const resource = state.index?.get(templateId)
      entry = resource && state.lk && state.index?.isTemplate(templateId)
        ? templateCache.get(state.lk, resource).then((content) => buildSlots(content.tree).filter((s) => s.key && FILLABLE.has(s.kind)), () => undefined)
        : Promise.resolve(undefined)
      slotsByTemplate.set(templateId, entry)
    }
    return entry
  }
  const changed = () => {
    project.rules = rules
    save()
  }
  rules.forEach((rule, i) => {
    const notice = el('span', { class: 'muted small' })
    const slotSelect = el('select', { 'aria-label': 'Template field', onchange: (e: Event) => {
      const option = (e.target as HTMLSelectElement).selectedOptions[0]
      if (!option) return
      rule.slotKey = option.value
      rule.slotLabel = option.dataset.label ?? option.textContent ?? option.value
      changed()
      notice.textContent = ''
      notice.className = 'muted small'
    } }, el('option', { value: rule.slotKey, 'data-label': rule.slotLabel, selected: true }, rule.slotLabel))
    const site = el('input', { type: 'text', value: rule.site, 'aria-label': 'Website', onchange: (e: Event) => {
      rule.site = (e.target as HTMLInputElement).value.trim().toLowerCase().replace(/^www\./, '')
      changed()
    } })
    const label = el('input', { type: 'text', value: rule.candidateLabel, 'aria-label': 'Label in the clip', onchange: (e: Event) => {
      const value = (e.target as HTMLInputElement).value.trim()
      if (!value) return
      rule.candidateLabel = value
      rule.candidateKey = cleanLabel(value)
      changed()
    } })
    list.append(el('li', {},
      el('div', { class: 'rule-head' }, el('strong', {}, rule.templateName), notice,
        el('button', { type: 'button', class: 'link', onclick: () => {
          rules.splice(i, 1)
          changed()
          renderSettings()
        } }, 'Delete')),
      el('div', { class: 'rule-row' }, field('On', site), field('Clip label', label), field('Goes in', slotSelect))))
    void slotsOf(rule.templateId).then((slots) => {
      if (!slots) {
        notice.textContent = state.index && !state.index.get(rule.templateId) ? ' The template no longer exists; skipped.' : ''
        notice.className = 'problem small'
        return
      }
      const seen = new Set<string>()
      const options = slots.filter((s) => !seen.has(s.key) && seen.add(s.key))
      if (!options.some((s) => s.key === rule.slotKey)) {
        notice.textContent = ` “${rule.slotLabel}” is no longer in the template; skipped. Choose another field or delete it.`
        notice.className = 'problem small'
      }
      clear(slotSelect,
        ...(options.some((s) => s.key === rule.slotKey) ? [] : [el('option', { value: rule.slotKey, 'data-label': rule.slotLabel, selected: true }, `${rule.slotLabel} (missing)`)]),
        ...options.map((s) => el('option', { value: s.key, 'data-label': s.label, selected: s.key === rule.slotKey }, s.label)))
    })
  })
  return list
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
