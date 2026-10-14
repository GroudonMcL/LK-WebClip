import type { Capture } from '../clip/importClip.js'
import { DEFAULT_DERIVED } from '../fill/derived.js'
import { DEFAULT_SYNONYMS, SYNONYMS_VERSION } from '../fill/labels.js'
import type { TemplateNotes } from '../fill/notes.js'
import type { FillMode, SavedRule } from '../fill/plan.js'
import type { IndexedResource } from '../lk/projectIndex.js'

/**
 * Everything the extension remembers. The API keys live in chrome.storage.local, which only the
 * extension's own pages and worker can read; web pages and the capture script never see them.
 */

export interface ProjectSettings {
  apiKey: string
  projectId: string
  projectName: string
  /** The page whose descendants are Sources. Found automatically when the project has a top-level "Sources" page. */
  sourcesRootId?: string
  /** A tag that also marks a page as a Source. */
  sourceTag: string
  /** Template rules taught on the review screen: on this site, this clip label goes in this slot. */
  rules?: SavedRule[]
}

export type AiEngineChoice = 'off' | 'on-device' | 'openrouter'

export interface TemplateSettings {
  /** Shows the Template choice in the panel. Off: the panel works exactly as before. */
  enabled: boolean
  /** Fill slots by matching labels (no AI). */
  labels: boolean
  ai: AiEngineChoice
  /** The last "Fill with" choice. */
  fillMode: FillMode
  /** Keep the template's placeholder in fields nothing was found for; otherwise remove those fields. */
  keepUnfilled: boolean
  /** Synonym groups for label matching. */
  synonyms: string[][]
  /** Which version of the default synonyms the list has seen, so new defaults can be added once. */
  synonymsVersion: number
  /** Worked-out fields, one rule per line ("Initiative = Dexterity modifier"). */
  derived: string
  /** Your notes for the AI about each template, for "Labels then AI writes". */
  notes: TemplateNotes[]
  openRouterKey: string
  /** A free model id (ending in ":free"). */
  openRouterModel: string
  /** The one-time warning that OpenRouter sends clips to a third party has been shown. */
  openRouterWarned: boolean
}

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  enabled: false,
  labels: true,
  ai: 'off',
  fillMode: 'labels',
  keepUnfilled: true,
  synonyms: DEFAULT_SYNONYMS,
  synonymsVersion: SYNONYMS_VERSION,
  derived: DEFAULT_DERIVED,
  notes: [],
  openRouterKey: '',
  openRouterModel: '',
  openRouterWarned: false,
}

export interface Settings {
  projects: ProjectSettings[]
  activeProjectId?: string
  /** Turn web links whose text names a page into LegendKeeper links. */
  linkify: boolean
  /** Link page names and aliases written in the text. */
  linkText: boolean
  /** Match names with their exact capitalisation. */
  matchCase: boolean
  /** Link only the first mention of each page in a clip. */
  firstOnly: boolean
  images: boolean
  assetFolder: string
  /** Start each clip with a "From <Source>" heading that links to the Source page. */
  sourceHeading: boolean
  templates: TemplateSettings
}

export const DEFAULT_SETTINGS: Settings = {
  projects: [],
  linkify: true,
  linkText: true,
  matchCase: true,
  firstOnly: true,
  images: true,
  assetFolder: 'LK Web Clipper',
  sourceHeading: true,
  templates: DEFAULT_TEMPLATE_SETTINGS,
}

/** The last choices for a project, so repeated clipping needs only a right-click and Import. */
export interface Remembered {
  mode: 'new' | 'append'
  parentId?: string
  targetId?: string
  targetDocumentId?: string
  sourceMode: 'website' | 'existing' | 'new'
  sourceId?: string
  /** The last template used with each Source (by Source id, or "site:<name>" for a website not yet a Source). */
  templateBySource?: Record<string, string>
}

export interface CachedIndex {
  loadedAt: string
  resources: IndexedResource[]
}

/** The latest capture, handed from the background worker to the side panel. */
export interface PendingCapture {
  id: string
  tabId?: number
  capture?: Capture
  error?: string
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings')
  const stored = settings as Partial<Settings> | undefined
  const templates = { ...DEFAULT_TEMPLATE_SETTINGS, ...stored?.templates }
  if (stored?.templates && (stored.templates.synonymsVersion ?? 1) < SYNONYMS_VERSION) {
    templates.synonyms = withNewDefaults(templates.synonyms)
    templates.synonymsVersion = SYNONYMS_VERSION
  }
  return { ...DEFAULT_SETTINGS, ...stored, templates }
}

/**
 * Adds default synonym groups that came with an update to a saved list, unless the list already
 * mentions one of their labels (you may have changed or removed that group on purpose).
 */
export function withNewDefaults(groups: string[][]): string[][] {
  const known = new Set(groups.flat().map((label) => label.toLowerCase()))
  return [...groups, ...DEFAULT_SYNONYMS.filter((group) => !group.some((label) => known.has(label.toLowerCase())))]
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings })
}

export async function loadRemembered(projectId: string): Promise<Remembered | undefined> {
  const key = `remembered:${projectId}`
  return (await chrome.storage.local.get(key))[key] as Remembered | undefined
}

export async function saveRemembered(projectId: string, remembered: Remembered): Promise<void> {
  await chrome.storage.local.set({ [`remembered:${projectId}`]: remembered })
}

export async function loadCachedIndex(projectId: string): Promise<CachedIndex | undefined> {
  const key = `index:${projectId}`
  return (await chrome.storage.local.get(key))[key] as CachedIndex | undefined
}

export async function saveCachedIndex(projectId: string, cached: CachedIndex): Promise<void> {
  await chrome.storage.local.set({ [`index:${projectId}`]: cached })
}

export async function setPendingCapture(pending: PendingCapture): Promise<void> {
  await chrome.storage.session.set({ pendingCapture: pending })
}

export async function getPendingCapture(): Promise<PendingCapture | undefined> {
  return (await chrome.storage.session.get('pendingCapture')).pendingCapture as PendingCapture | undefined
}
