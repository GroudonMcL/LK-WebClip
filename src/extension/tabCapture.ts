import type { Capture } from '../clip/importClip.js'
import type { CaptureRequest } from './capture.js'

/** Chooses what to clip from a context-menu click: a selection wins, then an image, then a link, then the article. */
export function requestFromMenu(info: Pick<chrome.contextMenus.OnClickData, 'selectionText' | 'mediaType' | 'srcUrl' | 'linkUrl'>): CaptureRequest {
  if (info.selectionText?.trim()) return { kind: 'selection', selectionText: info.selectionText }
  if (info.mediaType === 'image' && info.srcUrl) return { kind: 'image', srcUrl: info.srcUrl }
  if (info.linkUrl) return { kind: 'link', linkUrl: info.linkUrl }
  return { kind: 'article' }
}

/** Injects the capture script into the tab (or one of its frames) and runs it. A reader tab is asked directly. */
export async function captureTab(tabId: number, frameId: number | undefined, request: CaptureRequest): Promise<Capture> {
  if (await isReaderTab(tabId)) return captureReader(tabId, request)
  const target = { tabId, ...(frameId ? { frameIds: [frameId] } : {}) }
  try {
    await chrome.scripting.executeScript({ target, files: ['capture.js'] })
    const [result] = await chrome.scripting.executeScript({
      target,
      func: (req: CaptureRequest) => (globalThis as unknown as { __lkCapture(r: CaptureRequest): Capture }).__lkCapture(req),
      args: [request],
    })
    if (!result?.result) throw new Error('the page returned nothing')
    return result.result as Capture
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(message)) {
      throw new Error('Chrome does not let extensions read this page (browser pages, the Web Store and some PDFs). Try a normal web page.')
    }
    throw new Error(`Could not read the page: ${message}`)
  }
}

// ---------------------------------------------------------------------------------- PDF reader

/** Chrome's PDF viewer cannot be scripted, so PDFs open in the extension's reader page instead. */
export function isPdfUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** Match patterns for the "Open in LK Reader" menu items. */
export const PDF_URL_PATTERNS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://*/*.PDF?*', 'file:///*.pdf', 'file:///*.PDF']

export function readerUrl(src?: string): string {
  return chrome.runtime.getURL('reader.html') + (src ? `?src=${encodeURIComponent(src)}` : '')
}

/** Opens the reader next to the given tab, for a PDF's URL (or empty, to drop a file on). */
export async function openReader(src?: string, besideTabId?: number): Promise<void> {
  const beside = besideTabId === undefined ? undefined : await chrome.tabs.get(besideTabId).catch(() => undefined)
  await chrome.tabs.create({ url: readerUrl(src), ...(beside ? { index: beside.index + 1, windowId: beside.windowId } : {}) })
}

const READER_TABS = 'readerTabs'

/** Each reader page registers its tab, so a clip from that tab is asked of the page rather than injected. */
export async function registerReaderTab(tabId: number): Promise<void> {
  const tabs = ((await chrome.storage.session.get(READER_TABS))[READER_TABS] as number[] | undefined) ?? []
  if (!tabs.includes(tabId)) await chrome.storage.session.set({ [READER_TABS]: [...tabs, tabId] })
}

async function isReaderTab(tabId: number): Promise<boolean> {
  const tabs = ((await chrome.storage.session.get(READER_TABS))[READER_TABS] as number[] | undefined) ?? []
  if (!tabs.includes(tabId)) return false
  // The tab may have moved on to another page since.
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  return !tab?.url || tab.url.startsWith(chrome.runtime.getURL('reader.html'))
}

export interface ReaderCaptureMessage {
  type: 'lk-reader-capture'
  tabId: number
  request: CaptureRequest
}

export type ReaderCaptureReply = { capture: Capture } | { error: string }

async function captureReader(tabId: number, request: CaptureRequest): Promise<Capture> {
  const message: ReaderCaptureMessage = { type: 'lk-reader-capture', tabId, request }
  const reply = (await chrome.runtime.sendMessage(message).catch(() => undefined)) as ReaderCaptureReply | undefined
  if (!reply) throw new Error('The PDF reader did not answer. Reload its tab and try again.')
  if ('error' in reply) throw new Error(reply.error)
  return reply.capture
}
