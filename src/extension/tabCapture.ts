import type { Capture } from '../clip/importClip.js'
import type { CaptureRequest } from './capture.js'

/** Chooses what to clip from a context-menu click: a selection wins, then an image, then a link, then the article. */
export function requestFromMenu(info: Pick<chrome.contextMenus.OnClickData, 'selectionText' | 'mediaType' | 'srcUrl' | 'linkUrl'>): CaptureRequest {
  if (info.selectionText?.trim()) return { kind: 'selection', selectionText: info.selectionText }
  if (info.mediaType === 'image' && info.srcUrl) return { kind: 'image', srcUrl: info.srcUrl }
  if (info.linkUrl) return { kind: 'link', linkUrl: info.linkUrl }
  return { kind: 'article' }
}

/** Injects the capture script into the tab (or one of its frames) and runs it. */
export async function captureTab(tabId: number, frameId: number | undefined, request: CaptureRequest): Promise<Capture> {
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
