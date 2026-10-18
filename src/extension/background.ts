/**
 * The extension's service worker: owns the "Send to LegendKeeper" context-menu item. A click opens
 * the side panel and captures the clicked content; the side panel does everything else.
 */
import { setPendingCapture } from './state.js'
import { captureTab, isPdfUrl, openReader, PDF_URL_PATTERNS, requestFromMenu } from './tabCapture.js'

const MENU_ID = 'lk-send'
const OPEN_PDF_ID = 'lk-open-pdf'
const OPEN_PDF_LINK_ID = 'lk-open-pdf-link'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Send to LegendKeeper', contexts: ['selection', 'image', 'link', 'page'] })
  // Only on PDFs: in Chrome's viewer, and on links to them.
  chrome.contextMenus.create({ id: OPEN_PDF_ID, title: 'Open in LK Reader', contexts: ['page', 'frame', 'selection'], documentUrlPatterns: PDF_URL_PATTERNS })
  chrome.contextMenus.create({ id: OPEN_PDF_LINK_ID, title: 'Open PDF in LK Reader', contexts: ['link'], targetUrlPatterns: PDF_URL_PATTERNS })
})

// The toolbar button opens the panel too, for setup or for clipping a whole article.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === OPEN_PDF_ID) return void openReader(info.frameUrl ?? info.pageUrl, tab?.id)
  if (info.menuItemId === OPEN_PDF_LINK_ID) return void openReader(info.linkUrl, tab?.id)
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return
  // A PDF in Chrome's viewer can't be read: open it in the reader, where it can be clipped.
  const pdf = isPdfUrl(info.frameUrl) ? info.frameUrl : isPdfUrl(info.pageUrl) ? info.pageUrl : undefined
  if (pdf) return void openReader(pdf, tab.id)
  // sidePanel.open must run inside the click's user gesture, so before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
  void captureFromMenu(info, tab.id)
})

export async function captureFromMenu(info: Pick<chrome.contextMenus.OnClickData, 'selectionText' | 'mediaType' | 'srcUrl' | 'linkUrl' | 'frameId'>, tabId: number): Promise<void> {
  const id = crypto.randomUUID()
  try {
    const capture = await captureTab(tabId, info.frameId, requestFromMenu(info))
    await setPendingCapture({ id, tabId, capture })
  } catch (error) {
    await setPendingCapture({ id, tabId, error: error instanceof Error ? error.message : String(error) })
  }
}

// Lets the automated end-to-end test run the same path as a menu click (a test cannot open Chrome's context menu).
;(globalThis as unknown as { __lkTest: unknown }).__lkTest = { captureFromMenu }
