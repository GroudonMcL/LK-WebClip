import type { Block } from '@legendkeeper/sdk/blocks'
import type { MapBase, Mapping } from '../fill/mapping.js'
import type { TemplateTree } from '../fill/template.js'

/**
 * How the side panel and the mapper tab talk: through chrome.storage.session, which both can read
 * and which is cleared when the browser closes. The panel owns the clip and does the import; the
 * mapper only changes the mapping.
 *
 * - SESSION (panel → mapper): the cards, slots and mapping, and what the mapper needs to show them.
 * - MAPPING (mapper → panel): the mapping after each change.
 * - IMPORT (mapper → panel): "import now". A panel claims it in IMPORT_CLAIM first, so that two
 *   open panels never import the same clip twice.
 * - STATUS (panel → mapper): how the import went.
 */
export const SESSION_KEY = 'mapper:session'
export const MAPPING_KEY = 'mapper:mapping'
export const IMPORT_KEY = 'mapper:import'
export const IMPORT_CLAIM_KEY = 'mapper:import-claim'
export const STATUS_KEY = 'mapper:status'
/** The panel's form for the current clip, so a panel that was closed and opened again carries on. */
export const PANEL_FORM_KEY = 'panel:form'

export interface MapperContext {
  /** The new page's name, or the page added to. */
  title: string
  /** The clipped site's host name, for saved rules. */
  site: string
  templateName: string
  mode: 'new' | 'append'
  /** The template as it applies to the destination (all of it for a new page, its main tab for an append). */
  tree: TemplateTree
  keepUnfilled: boolean
  /** The "From <Source>" heading, or undefined when the credit is off. */
  sourceHeading?: Block
  /** "Create page" or "Add to page". */
  importLabel: string
  /** What stops the import (no page name, no Source…). */
  problems: string[]
  projectName: string
  clipUrl: string
}

export interface MapperSession {
  key: string
  /** Goes up each time the panel makes the cards again; the mapper then takes the panel's mapping. */
  rev: number
  base: MapBase
  mapping: Mapping
  context: MapperContext
}

export interface MappingMessage {
  key: string
  mapping: Mapping
}

export interface ImportRequest {
  key: string
  requestId: string
}

export interface ImportStatus {
  key: string
  requestId?: string
  state: 'importing' | 'done' | 'fill-failed' | 'failed' | 'blocked'
  message: string
  url?: string
}

export async function readSession<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.session.get(key))[key] as T | undefined
}

export async function writeSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value })
}
