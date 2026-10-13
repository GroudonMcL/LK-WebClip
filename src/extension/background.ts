/**
 * The extension's service worker: owns the "Send to LegendKeeper" context-menu item. A click opens
 * the side panel and captures the clicked content; the side panel does everything else.
 */
import { setPendingCapture } from './state.js'
import { captureTab, requestFromMenu } from './tabCapture.js'

const MENU_ID = 'lk-send'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Send to LegendKeeper', contexts: ['selection', 'image', 'link', 'page'] })
})

// The toolbar button opens the panel too, for setup or for clipping a whole article.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return
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
