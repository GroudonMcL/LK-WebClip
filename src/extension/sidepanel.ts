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
import { appendTree, appendedTemplate, applyComposition, compose, type Composition } from '../fill/compose.js'
import { AiUnavailableError, listFreeModels, ON_DEVICE_HELP, onDeviceStatus, OnDeviceEngine, OpenRouterEngine, suggest, type AiEngine, type FreeModel } from '../fill/engines.js'
import { DEFAULT_SYNONYMS, formatSynonyms, parseSynonyms, Synonyms } from '../fill/labels.js'
import { blocksForAi, mergeRules, planFill, rulesFromChoices, type AiSuggestion, type FillMode, type FillPlan, type SlotOrigin, type SlotOverride, type SlotState } from '../fill/plan.js'
import { buildSlots, type TemplateTree } from '../fill/template.js'
import { createClient } from '../lk/client.js'
import { describeError, isNotFound } from '../lk/errors.js'
import { ProjectIndex, writableDocuments, type IndexedResource } from '../lk/projectIndex.js'
import { findSources, isSource, listSources, siteName, type SourceConfig } from '../lk/sources.js'
import { fillPage, listTemplates, TemplateCache, TemplateFillError, type TemplateContent } from '../lk/templates.js'
import { clear, el, timeAgo } from './dom.js'
import { Picker } from './picker.js'
import {
  DEFAULT_SETTINGS, getPendingCapture, loadCachedIndex, loadRemembered, loadSettings, saveCachedIndex, saveRemembered, saveSettings,
  type AiEngineChoice, type PendingCapture, type ProjectSettings, type Settings,
} from './state.js'
import { captureTab } from './tabCapture.js'

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
  fillPlan?: FillPlan
  /** Choices made on the review screen, by slot id. */
  fillOverrides: Record<string, SlotOverride>
  ai: AiState
  freeModels?: FreeModel[]
  busy: boolean
} = {
  settings: { ...DEFAULT_SETTINGS },
  indexLoading: false,
  linkChoices: {},
  templateLoading: false,
  fillOverrides: {},
  ai: { status: 'idle' },
  form: { mode: 'new', title: '', sourceMode: 'website', websiteName: '', websiteReuse: true, newSourceName: '' },
  busy: false,
}

const templateCache = new TemplateCache()
let onDevice: OnDeviceEngine | undefined
/** Review rows whose value dropdown was opened with "Change". */
const expandedSlots = new Set<string>()
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
  state.fillOverrides = {}
  state.ai = { status: 'idle' }
  expandedSlots.clear()
  if (capture) {
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
      checkbox('Link page names in the text', state.settings.linkText, 'Names and aliases of your pages written in the text become LegendKeeper links', (v) => ((state.settings.linkText = v), void saveSettings(state.settings), rebuildPlan())),
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
  const { linkify, linkText, matchCase, firstOnly } = state.settings
  const exclude = new Set(state.form.mode === 'append' && state.form.targetId ? [state.form.targetId] : [])
  state.plan = prepareClip(capture, state.index, {
    links: linkify || linkText ? { hyperlinks: linkify, text: linkText, matchCase, firstOnly, exclude, choices: state.linkChoices } : undefined,
    images: state.settings.images,
    parser: new DOMParser(),
  })
  state.fillPlan = undefined
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
      overrides: state.fillOverrides,
      nameOf: (id) => state.index?.get(id)?.name,
      derived: parseDerived(t.derived),
    })
    void maybeRunAi()
  }
  update()
}

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
      state.fillOverrides = {}
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
    field('Fill with', modes, el('p', { class: 'muted small' }, mode ? FILL_MODE_HELP[mode](aiNotes()?.from) : 'Label matching and AI are both off, so the clip goes under the template as it is.')),
    checkbox('Keep unfilled template fields', t.keepUnfilled, 'Fields nothing was found for keep the template’s placeholder; untick to remove them', (v) => {
      t.keepUnfilled = v
      void saveSettings(state.settings)
      update()
    }))
}

const FILL_MODE_HELP: Record<FillMode, (notesFrom?: string) => string> = {
  labels: () => 'Fields whose label is in the clip. No AI.',
  ai: () => 'The AI picks a part of the clip for every field.',
  'labels-ai': () => 'Labels first; the AI picks parts of the clip for the fields left.',
  'labels-ai-write': (from) => `Labels first; the AI fills the fields left and may write short ones in the template’s style, using only the clip’s facts. ${
    from === 'yours' ? 'Your notes for this template guide it.' : from ? `The built-in “${from}” notes guide it.` : 'Add notes for this template in Settings to guide it.'}`,
}

/** The notes the AI gets about the chosen template in "Labels then AI writes". */
function aiNotes(): { text: string; from: string } | undefined {
  if (!state.template) return undefined
  const t = state.settings.templates
  return notesFor(state.template.name, buildSlots(state.template.tree), t.notes, new Synonyms(t.synonyms))
}

function aiKey(): string {
  const notes = effectiveMode() === 'labels-ai-write' ? aiNotes()?.text : ''
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
  const slots = slotsForAi(plan, mode, state.fillOverrides)
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
    const result = await suggest(engine, { slots, clip: state.plan.blocks, blockIndexes, title: state.form.title.trim() || capture.suggestedTitle, nameOf: (id) => state.index?.get(id)?.name, labels: plan.blockLabels, write: mode === 'labels-ai-write' ? { notes: aiNotes()?.text } : undefined })
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

const ORIGINS: Record<SlotOrigin, string> = {
  rule: 'Saved rule', label: 'Label', synonym: 'Synonym', similar: 'Similar label', ai: 'AI', 'ai-written': 'AI-written', 'ai-wrote': 'Written by AI', derived: 'Worked out', manual: 'Your choice', typed: 'Typed', title: 'Page name',
}

/** The review screen: each field, what was found for it, and controls to change it. */
function renderTemplateFields(): void {
  const plan = state.fillPlan
  const capture = state.pending?.capture
  if (!plan || !capture) return clear(templateBox)
  const site = siteHost(capture.url)
  const fields = plan.slots.filter((s) => ['text', 'rich', 'image'].includes(s.slot.kind))
  // Paths only tell apart fields that share a label.
  const repeated = new Set(fields.map((s) => s.slot.key).filter((key, i, all) => key && all.indexOf(key) !== i))
  const setOverride = (id: string, change: Partial<SlotOverride>) => {
    state.fillOverrides[id] = { ...state.fillOverrides[id], ...change }
    rebuildPlan()
  }
  const row = (s: SlotState): HTMLElement => {
    const override = state.fillOverrides[s.slot.id] ?? {}
    const choice = override.choice ?? s.candidate?.id ?? (s.status === 'ambiguous' ? '' : 'empty')
    const options = [...s.contenders, ...s.options.filter((o) => !s.contenders.includes(o))]
    if (s.candidate && !options.includes(s.candidate)) options.unshift(s.candidate)
    const select = el('select', { 'aria-label': `Value for ${s.slot.label}`, onchange: (e: Event) => setOverride(s.slot.id, { choice: (e.target as HTMLSelectElement).value || undefined, off: undefined }) },
      s.status === 'ambiguous' ? el('option', { value: '', selected: choice === '' }, `Choose (${s.contenders.length} labels fit)…`) : null,
      el('option', { value: 'empty', selected: choice === 'empty' }, 'Leave empty'),
      el('option', { value: 'typed', selected: choice === 'typed' }, 'Type a value…'),
      ...options.slice(0, 40).map((c) => el('option', { value: c.id, selected: c.id === choice }, `${c.label === 'AI' ? 'AI' : `“${c.label}”`}: ${c.text.replace(/\s+/g, ' ').slice(0, 60)}`)))
    const ticked = s.status === 'filled'
    // The dropdown shows when a choice is needed or was made; otherwise behind "Change".
    const open = expandedSlots.has(s.slot.id) || s.status === 'ambiguous' || s.status === 'empty' || override.choice !== undefined
    const change = el('button', { type: 'button', class: 'link small', onclick: () => {
      expandedSlots.add(s.slot.id)
      change.replaceWith(select)
      select.focus()
    } }, 'Change')
    return el('li', { class: s.status === 'ambiguous' ? 'ambiguous' : s.status === 'off' ? 'off' : '', 'data-slot': s.slot.label },
      el('div', { class: 'slot-head' },
        s.status === 'filled' || s.status === 'off'
          ? el('input', { type: 'checkbox', checked: ticked, title: 'Use this value', 'aria-label': `Use the value for ${s.slot.label}`, onchange: (e: Event) => setOverride(s.slot.id, { off: !(e.target as HTMLInputElement).checked }) })
          : null,
        el('span', { class: 'slot-label' }, s.slot.label),
        s.origin ? el('span', { class: `origin ${s.origin}` }, ORIGINS[s.origin]) : null,
        s.status === 'ambiguous' ? el('span', { class: 'muted small' }, 'several labels fit') : null,
        open ? null : change),
      repeated.has(s.slot.key) ? el('span', { class: 'slot-path' }, s.slot.path) : null,
      s.text ? el('div', { class: 'slot-value' }, s.text.slice(0, 300)) : null,
      s.warning ? el('div', { class: 'slot-warning small' }, `${s.warning} Tick it to use it anyway.`) : null,
      s.note ? el('div', { class: 'muted small' }, s.note) : null,
      open ? select : null,
      choice === 'typed'
        ? el('input', { type: 'text', value: override.text ?? '', placeholder: s.slot.placeholder || 'Value', 'aria-label': `Typed value for ${s.slot.label}`, onchange: (e: Event) => setOverride(s.slot.id, { choice: 'typed', text: (e.target as HTMLInputElement).value }) })
        : null,
      s.origin === 'manual' && s.candidate?.key && s.slot.key && site
        ? checkbox(`Remember for ${site}: “${s.candidate.label}” goes in “${s.slot.label}”`, !!override.remember, 'Saved as a rule for this site and template', (v) => setOverride(s.slot.id, { remember: v }))
        : null)
  }
  const filled = fields.filter((s) => s.status !== 'empty')
  const empty = fields.filter((s) => s.status === 'empty')
  const order = { ambiguous: 0, filled: 1, off: 2, empty: 3 } as const
  filled.sort((a, b) => order[a.status] - order[b.status])
  const unused = plan.leftovers.length
  clear(templateBox,
    el('details', { open: true },
      el('summary', {}, `Template fields: ${fields.filter((s) => s.status === 'filled').length} of ${fields.length} filled`),
      el('ul', {}, ...filled.map(row)),
      empty.length
        ? el('details', {},
            el('summary', { class: 'empty-slots' }, `Not filled (${empty.length}): ${empty.map((s) => s.slot.label).join(', ')}`),
            el('ul', {}, ...empty.map(row)))
        : null,
      el('p', { class: 'muted small' }, unused
        ? `${unused} part${unused === 1 ? '' : 's'} of the clip didn’t fit a field and go${unused === 1 ? 'es' : ''} at the end${state.settings.sourceHeading ? ', under the “From” heading' : ''}.`
        : 'Everything in the clip went into a field.')))
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

  // Problems that block the import.
  const tree = templateTree()
  const fillPlan = tree ? state.fillPlan : undefined
  const notes0: string[] = []
  const problems: string[] = []
  if (plan.blocks.length === 0 && !fillPlan) problems.push('There is nothing to import in this clip.')
  if (form.templateId && state.settings.templates.enabled && !tree) problems.push(state.templateLoading ? 'Reading the template…' : 'The template could not be read. Choose it again.')
  if (fillPlan?.slots.some((s) => s.status === 'ambiguous')) notes0.push('Some fields match several labels: choose one for each below, or leave them empty.')
  if (form.mode === 'new' && !form.title.trim()) problems.push('Name the new page.')
  if (form.mode === 'append' && (!targetPicker.value || !form.targetDocumentId)) problems.push('Choose the page to add to.')
  if (source.problem) problems.push(source.problem)

  const notes: (string | Node)[] = [...notes0]
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
  if (fillPlan) renderTemplateFields()
  else clear(templateBox)
  importButton.disabled = problems.length > 0 || state.busy
  importButton.textContent = form.mode === 'new' ? 'Create page' : 'Add to page'

  const heading: Block | undefined = state.settings.sourceHeading
    ? { kind: 'heading', level: 1, content: [{ text: 'From ' }, { mention: { resourceId: '_source', text: source.label } }] }
    : undefined
  const blocks = tree && fillPlan
    ? templatePreview(tree, fillPlan, heading)
    : [...(form.mode === 'append' ? [{ kind: 'rule' } as Block] : []), ...(heading ? [heading] : []), ...plan.blocks]
  previewBox.innerHTML = blocksToHtml(blocks, { nameOf: (id) => state.index?.get(id)?.name })
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

async function runImport(): Promise<void> {
  const { plan, lk, index, project } = state
  const capture = state.pending?.capture
  const source = chosenSource()
  const config = sourceConfig()
  if (!plan || !lk || !index || !project || !capture || state.busy) return
  if (state.settings.sourceHeading && (!source.spec || (source.spec.kind === 'new' && !config))) return
  const tree = templateTree()
  const fillPlan = tree ? state.fillPlan : undefined
  const template = tree && fillPlan && state.template ? { content: state.template, plan: fillPlan, keepUnfilled: state.settings.templates.keepUnfilled } : undefined

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
      template,
      sourceConfig: config ?? { sourcesRootId: '' },
      assetFolderName: state.settings.assetFolder,
      onProgress: (message) => (progressBox.textContent = message),
      // With the extension's host permission, image requests can carry the site's cookies, like the page's own.
      fetchImpl: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    })
    await rememberAfterImport(result.source?.id)
    await persistIndex()
    const warnings = result.templateMissing.length ? [`${result.templateMissing.length} field(s) were not found in the new page (the template may have changed) and were skipped.`] : []
    renderDone(result.url, form.mode === 'new' ? form.title.trim() : targetPicker.value!.name, form.mode, result.sourceCreated ? result.source?.name : undefined, result.imagesFailed, warnings)
  } catch (error) {
    if (error instanceof TemplateFillError) {
      await persistIndex()
      return renderFillFailed(error as TemplateFillError & { composition: Composition; url: string })
    }
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
  if (state.fillPlan && state.template && templateTree()) {
    const added = rulesFromChoices(state.fillPlan, state.fillOverrides, { site: siteHost(capture.url), templateId: state.template.id, templateName: state.template.name })
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
      el('h3', {}, 'Linking'),
      checkbox('Match capitalisation', state.settings.matchCase, 'Like LegendKeeper: a page named "King" links "King" but not "king". Add aliases for other spellings.', async (v) => {
        state.settings.matchCase = v
        await saveSettings(state.settings)
      }),
      el('p', { class: 'muted small' }, 'A page named “King” links “King” but not “king”. Add aliases in LegendKeeper for other spellings and plurals; a lowercase alias still matches at the start of a sentence.'),
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
 * Settings: your notes for the AI about each template, used by "Labels then AI writes". A
 * template without notes uses the built-in pack that fits it, if any, which you can edit into
 * your own.
 */
function templateNotesEditor(): HTMLElement {
  const t = state.settings.templates
  const inProject = state.index ? listTemplates(state.index).map((x) => x.resource) : []
  const names = [...new Set([...inProject.map((r) => r.name), ...t.notes.map((n) => n.templateName)])]
  notesTemplate = notesTemplate && names.includes(notesTemplate) ? notesTemplate : state.template?.name ?? names[0]
  const status = el('p', { class: 'muted small' })
  const remove = el('button', { type: 'button', class: 'link small', hidden: true }, 'Remove your notes')
  const text = el('textarea', { spellcheck: true, 'aria-label': 'Notes for the AI' })
  let pack: { name: string; text: string } | undefined

  const show = async () => {
    const name = notesTemplate
    if (!name) return
    const saved = savedNotes(t.notes, name)
    remove.hidden = !saved
    pack = undefined
    const resource = inProject.find((r) => r.name === name)
    if (resource && state.lk) {
      try {
        const content = await templateCache.get(state.lk, resource)
        pack = builtInPackFor(buildSlots(content.tree), new Synonyms(t.synonyms))
      } catch {
        // Without the template, only your own notes can be shown.
      }
    }
    if (notesTemplate !== name) return
    text.value = saved?.text ?? pack?.text ?? ''
    status.textContent = saved
      ? `Your notes for ${name}.${pack ? ` Remove them to use the built-in “${pack.name}” notes again.` : ''}`
      : pack
        ? `Using the built-in “${pack.name}” notes. Edit them to make your own.`
        : `No notes for ${name} yet. Write what its fields mean and how you want them written.`
  }
  text.addEventListener('change', () => {
    if (!notesTemplate) return
    // Built-in notes left as they are aren't saved as yours.
    t.notes = withNotes(t.notes, notesTemplate, pack && text.value.trim() === pack.text.trim() ? '' : text.value)
    void saveSettings(state.settings)
    void show()
  })
  remove.addEventListener('click', () => {
    if (!notesTemplate) return
    t.notes = withNotes(t.notes, notesTemplate, '')
    void saveSettings(state.settings)
    void show()
  })
  const select = el('select', { 'aria-label': 'Template', onchange: (e: Event) => {
    notesTemplate = (e.target as HTMLSelectElement).value
    void show()
  } }, ...names.map((name) => el('option', { value: name, selected: name === notesTemplate },
    `${name}${savedNotes(t.notes, name) ? ' (your notes)' : ''}${inProject.some((r) => r.name === name) ? '' : ' (not in this project)'}`)))
  void show()
  return field('AI notes for templates',
    el('p', { class: 'muted small' }, 'Used by “Labels then AI writes”: what each field means and how you want it written, e.g. “Initiative: the Dexterity modifier, such as +3”. Keep them short; they share the AI’s space with the clip.'),
    names.length ? select : el('p', { class: 'muted small' }, 'This project has no templates.'),
    names.length ? text : null, status, remove)
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
  const rulesList = el('ul', { class: 'settings-list' }, ...rules.map((rule, i) => {
    const loaded = state.template?.id === rule.templateId ? state.template : undefined
    const stale = loaded && !buildSlots(loaded.tree).some((slot) => slot.key === rule.slotKey)
    return el('li', {},
      el('span', {}, el('strong', {}, rule.site), ` · ${rule.templateName}: “${rule.candidateLabel}” → “${rule.slotLabel}”`, stale ? el('span', { class: 'problem' }, ' (that field is no longer in the template; skipped)') : null),
      el('button', { type: 'button', class: 'link', onclick: () => {
        project!.rules = rules.filter((_, j) => j !== i)
        save()
        renderSettings()
      } }, 'Delete'))
  }))

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
        el('p', { class: 'muted small' }, 'Fills a field the clip doesn’t state from another field, one per line: “Initiative = Dexterity modifier”. End with “modifier” for the signed number in “16 (+3)”, “number” for the first number, or nothing for the whole value. Used only when nothing else fills the field.'),
        el('button', { type: 'button', class: 'link small', onclick: () => {
          t.derived = DEFAULT_DERIVED
          save()
          derived.value = t.derived
        } }, 'Reset to the defaults')),
      notesEditor,
      field(`Saved rules${project ? ` in ${project.projectName}` : ''}`,
        rules.length ? rulesList : el('p', { class: 'muted small' }, 'None yet. When you pick a different value for a field on the review screen, you can remember it for that website.')),
    ) : null)
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
