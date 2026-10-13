import type { Capture } from '../clip/importClip.js'
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
}

export interface Settings {
  projects: ProjectSettings[]
  activeProjectId?: string
  /** Turn links whose text names a page into LegendKeeper links. */
  linkify: boolean
  images: boolean
  assetFolder: string
}

export const DEFAULT_SETTINGS: Settings = { projects: [], linkify: true, images: true, assetFolder: 'LK Web Clipper' }

/** The last choices for a project, so repeated clipping needs only a right-click and Import. */
export interface Remembered {
  mode: 'new' | 'append'
  parentId?: string
  targetId?: string
  targetDocumentId?: string
  sourceMode: 'website' | 'existing' | 'new'
  sourceId?: string
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
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) }
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
