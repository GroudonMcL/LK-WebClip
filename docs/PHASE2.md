# Phase 2: the Chrome extension

Phase 2 turns the Phase 1 integration into a working clipper. You right-click content, choose **Send to LegendKeeper**, pick the destination and the Source in a side panel, check the preview and import. As agreed, there is no local server: the side panel calls LegendKeeper directly.

## What it does

| Brief requirement | How it works |
| --- | --- |
| Right-click → "Send to LegendKeeper" | One context-menu item, for selections, images, links and the page itself. It opens the side panel and captures what was clicked. |
| Selected text, images, article extraction | The capture script serialises the selection with its surroundings (a list, table, heading or bold text around a partial selection), makes every URL absolute and reads the page's metadata. With nothing selected it extracts the article with Mozilla Readability, the library behind Firefox's reader view. A right-clicked image or link is captured on its own. |
| Headings, paragraphs, links, lists (plus marks, quotes, code, tables, images) | `src/clip/htmlToBlocks.ts` converts HTML to LegendKeeper blocks. Headings are shifted so the clip's top heading is a Heading 2, beneath the `From <Source>` Heading 1. |
| Choice of project | One project per API key. The project picker appears only when there is more than one. |
| New page under a chosen parent, or append to a page | Pickers search your pages. Results show where each page sits in the tree, plus the alias, tag or text passage that matched. Appending picks the tab when a page has several, refuses maps and timelines, and adds a divider before the `From <Source>` heading. |
| Source selection | **This website** (the site's name, from its metadata, else its host), **A Source** (searching your Sources page and anything tagged `Source`) or **New Source**. A website name that matches an existing Source prompts you to reuse it or create another. New Sources get the same Backlinks collection as your hand-made ones. |
| Preview and import | The panel shows exactly what will be written, and lists which links become page links, which stay web links, the images to copy, and any warnings. The success screen links to the page in LegendKeeper. |
| Links (Phase 2 scope: "explicitly selected hyperlinks") | A link whose text is exactly the name or alias of one page becomes a LegendKeeper mention. If several pages share the name, the link is kept as it was and reported. Templates are never linked. |
| Remember recent choices | Each project remembers its last destination, tab and Source. |

## How it was tested

- **47 offline unit tests** (`npm test`) cover the converter, link resolution, the preview renderer, the index and search.
- **Real web content** (`npm run phase2:import`) went through the import pipeline into the test project: a stat-block page with awkward markup, a full Wikipedia article via Readability (65 blocks, 18-row table) and one Wikipedia section appended to a page. The API accepted all of it.
- **End to end in Chromium** (`npm run e2e`): the built extension, loaded into the pre-installed Chromium, against the real project. The test connects the key in Settings and picks the Sources page. Then it clips three ways from a local copy of the stat-block page:
  - a selection to a new page, recognising "Example Compendium" as an existing Source;
  - a right-clicked image appended to that page, with Wikipedia chosen as the Source;
  - the whole article to a new page.

  Every result is read back from the API and checked. Automation cannot click Chrome's context menu, so the test calls the same function the menu click calls; everything after that is the real UI.

The browser test caught a bug the Node tests could not. The LegendKeeper SDK calls `fetch` in a way Chrome rejects ("Illegal invocation"). Every client is now built by `createClient()`, which works around it.

Pages from these runs are under **LK Web Clipper Sandbox**, in the pages named `Phase 2 import …` and `Phase 2 E2E …`. A page named `Nesting probe (Phase 2)` holds the probe described next.

## What the API accepts (probed against the live project)

Before writing the converter, I wrote each awkward nesting to a test page to see what LegendKeeper accepts:

- **Accepted:** code, quotes, headings, images and tables inside list items. Lists, headings, images, code and quotes inside table cells. Anything inside a quote. Empty table cells. `colspan` and `rowspan`. Links in headings. Relative and `#` links (the converter makes them absolute anyway).
- **Refused, and handled by the converter:**
  - A list item that doesn't start with a paragraph: the converter adds an empty one.
  - A table inside a table cell: the inner table becomes text, and the preview says so.
  - A code run with any other formatting, links included: a link wins over code formatting.
  - `javascript:` links: dropped.
  - Images that are not project assets: they are uploaded first.

## Things to know

- **Chrome 116 or later.** The extension is loaded unpacked. It isn't in the Chrome Web Store.
- **Permissions.** It can read all sites so it can capture from any page and copy images from whichever site hosts them. Image requests carry that site's cookies, so images you can see while logged in can usually be copied too. I haven't tried a logged-in site such as D&D Beyond yet; that's a good first real-world test for you.
- **The page list** is cached and refreshed when it is more than 10 minutes old, or when you click ⟳. Pages the clipper creates are added immediately.
- **Repeated links.** Every link to the same page becomes a mention, so a Wikipedia article linking "Dragon" eight times gets eight Dragon links. Linking plain-text mentions (text that isn't already a link) is Phase 3.
- **Duplicate images.** Clipping the same image twice puts it in the asset library twice (LegendKeeper stores the file once). Phase 5 can remember what has been uploaded.
- **Partial failures.** If writing the page fails after a new Source was created or images were uploaded, those stay in the project. Nothing on an existing page is ever overwritten.
- **Top-level pages** need an Admin key. A Member key can create pages under existing ones and add to pages it can edit.

## Not tested yet

The real right-click menu and the real side panel opening, rather than the panel loaded as a tab, have only been exercised the way Chrome documents them, not by the automated test. Both are simple, standard API calls, but the first manual run in your Chrome is the real check. Please tell me if anything looks off.
