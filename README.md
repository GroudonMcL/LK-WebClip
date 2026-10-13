# LK Web Clipper

A lightweight Chrome web clipper for [LegendKeeper](https://www.legendkeeper.com): select content on a webpage, right-click **Send to LegendKeeper**, choose where it goes and which Source it came from, and it lands in your campaign wiki as native, linked LegendKeeper content.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Prove the LegendKeeper API integration | **Done**. See [docs/PHASE1.md](docs/PHASE1.md) |
| 2 | Chrome extension: context menu, side panel, capture, preview and import | Next |
| 3 | Cached resource index, fuzzy search, automatic linking | |
| 4 | Tables, images, source-name detection, Source deduplication | |
| 5 | Reliability: retries, conflicts, duplicate protection, remembered defaults | |

## Layout

```
src/lk/            LegendKeeper integration. Uses only fetch and the SDK, so it runs in Node or an extension service worker.
  client.ts        API keys → project connections (one key per project)
  projectIndex.ts  In-memory resource tree: paths, aliases, tags, writable documents
  search.ts        Ranked search: exact name → prefix → word → alias → tag → page content
  sources.ts       Source pages with a Backlinks collection, the "From <Source>" heading, website names
  pages.ts         Create a clip page; append a clip with versioned, conflict-safe writes
  images.ts        Fetch a web image, check it, upload it as a project asset, fall back to a link
  errors.ts        API errors explained in plain words
scripts/poc.ts     Phase 1 proof of concept, run against a real project
test/              Offline unit tests
docs/              Phase 1 findings and the latest proof-of-concept output
```

## Running

Needs Node 22.9 or later.

```sh
npm install
cp .env.example .env      # then put your LegendKeeper API key in .env
npm test                  # offline unit tests
npm run typecheck
npm run poc               # writes test pages under "LK Web Clipper Sandbox" in your project
```

An API key comes from **Project Settings → Developers → API Keys** in LegendKeeper. The project owner needs a paid plan. The proof of concept creates its sandbox page at the top level, which needs an **ADMIN** key. The finished clipper will work with a MEMBER key that can edit the pages you clip into.

`npm run poc` never deletes anything. Each run adds a `Phase 1 run <time>` page under the sandbox so you can look at the result in LegendKeeper. It also uploads one image to an asset folder called `LK Web Clipper`.
