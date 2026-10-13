# LK Web Clipper

A lightweight Chrome extension for [LegendKeeper](https://www.legendkeeper.com). Select something on a web page, right-click it and choose **Send to LegendKeeper**. A side panel opens where you choose where the clip goes and which Source it came from, check a preview and import it. The clip arrives as native LegendKeeper content: headings, lists, tables and images included, with a `From <Source>` heading that links the clip to its Source page.

<p>
  <img src="docs/screenshots/new-page-form.png" alt="The side panel with a stat block clipped to a new page" width="300">
  <img src="docs/screenshots/append-form.png" alt="Adding an image to an existing page" width="300">
</p>

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Prove the LegendKeeper API integration | **Done.** See [docs/PHASE1.md](docs/PHASE1.md) |
| 2 | Chrome extension: context menu, side panel, capture, preview and import | **Done.** See [docs/PHASE2.md](docs/PHASE2.md) |
| 3 | Fuzzy search, automatic links for plain text, smarter index refresh | Next |
| 4 | Complex tables, site-specific rules, Source deduplication | |
| 5 | Reliability: retries, duplicate protection, reviewing uncertain links | |

## Install

1. Get the extension: download `lk-web-clipper-<version>.zip` and unzip it, or build it yourself with `npm install && npm run build`, which writes it to `dist/extension`.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top right) and click **Load unpacked**. Choose the unzipped folder (or `dist/extension`).
3. Pin **LegendKeeper Clipper** from the extensions menu if you like. Clicking its icon opens the side panel.
4. In the side panel's Settings, paste an API key and click **Connect**. You create the key in LegendKeeper under **Project Settings → Developers → API Keys** (the project owner needs a paid plan). Add one key per project. If you add more than one, a project picker appears.
5. Check the **Sources page**. If your project has a top-level page called "Sources", it is chosen for you. New Sources are created under this page, and pages under it or tagged `Source` count as Sources.

## Use

- **Selection:** highlight text (with any images, tables and links in it), right-click and choose **Send to LegendKeeper**.
- **Image or link:** right-click it and choose **Send to LegendKeeper**.
- **Whole article:** right-click empty space on the page and choose **Send to LegendKeeper**, or click **Clip this page’s article** in the panel. From a selection, **Use the whole article instead** switches to the full article.

Then in the panel:

- **Where:** pick **New page** (give it a name and choose the page to put it under) or **Add to a page** (choose the page; if it has several tabs, pick one). Search matches page names first, then aliases and tags, then page text. Each result shows where the page sits in your tree.
- **Source:**
  - **This website** uses the site's own name (e.g. "D&D Beyond"). If a Source with that name already exists, you choose between reusing it and creating another.
  - **A Source** picks one of your existing Sources.
  - **New Source** creates one with the name you give it.

  Each new Source page gets a Backlinks collection, so it lists every page that cites it.
- **Link to my pages:** a link whose text is exactly the name or alias of one of your pages becomes a LegendKeeper link to that page. If several pages share the name, the link is left as it was and the panel tells you.
- **Import images:** copies each image into your project's asset library (folder "LK Web Clipper"). If an image can't be copied, the clip keeps a link to it instead.
- Check the **Preview** and click **Create page** or **Add to page**. When you add to a page, the clip goes at the end after a divider. Your existing content is never overwritten: if someone edits the page at the same moment, the clipper re-reads it and tries again.

The panel remembers your last destination and Source for each project, so repeated clipping is a right-click and one click.

## Where your API key is kept

The key is stored in the extension's own storage (`chrome.storage.local`). The pages you clip can't read it, and the capture script that runs in those pages never sees it. Only the side panel uses it, to talk to LegendKeeper directly. No other server is involved. The extension asks to read all sites so it can capture from any page and copy images from wherever they are hosted.

## Development

Needs Node 22.9 or later.

```sh
npm install
cp .env.example .env      # put a LegendKeeper API key in .env (for the live checks only)
npm test                  # offline unit tests (converter, link resolution, index, search)
npm run typecheck
npm run build             # the extension, into dist/extension (add -- --zip for a zip)
npm run e2e               # loads the built extension in Chromium and clips into your project
npm run phase2:import     # converts real web pages and imports them through the same pipeline
npm run poc               # the Phase 1 API proof of concept
```

The live checks write only under the page **LK Web Clipper Sandbox** and never delete anything.

```
src/lk/          LegendKeeper integration: client, project index, search, Sources, pages, images, errors
src/clip/        HTML → LegendKeeper blocks, link resolution, preview rendering, the import pipeline
src/extension/   The Chrome extension: background worker, capture script, side panel
scripts/         Build, end-to-end test and live checks
test/            Unit tests and the HTML fixture
docs/            Phase notes, the Phase 1 output and side-panel screenshots
```
