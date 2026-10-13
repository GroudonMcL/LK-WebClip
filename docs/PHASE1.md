# Phase 1: LegendKeeper integration findings

Phase 1 had to show that the API supports everything the clipper needs before any extension UI gets built. `npm run poc` tested each point against the AI Test Project with `@legendkeeper/sdk` 4.1.0. **Every check passed.** The full output is in [phase1-poc-output.md](phase1-poc-output.md), and the pages it made are under **LK Web Clipper Sandbox** in the project.

## The nine checks

| # | Requirement | Result | How |
| --- | --- | --- | --- |
| 1 | Load project details | ✅ | `lk.project()` gives the project's name and id. A key reaches only its own project, so each extra project needs its own key. With one key configured, the project picker can be skipped. |
| 2 | Retrieve the resource hierarchy | ✅ | `resources.list` returns 100 resources per page. 330 resources took 4 requests and about 1.2 s. Each item includes `parentId`, aliases, tags, rank and its documents with their types, which is enough to build paths such as `Bestiary / Dragon / Adult Red Dragon`. |
| 3 | Search for a resource by name | ✅ | The local index ranks exact name, then prefix, whole word, substring, alias and tag. After that come `search.search` results that match only in page text, with the matching passage. Searching "Dragon" puts `Bestiary / Dragon` first, and "Witch Queen" finds Iggwilv by alias. |
| 4 | Create a page under a chosen parent | ✅ | `resources.create` with `parentId` and `documents: [{ type: 'page', blocks }]` creates the page and its content in **one write**. |
| 5 | Write basic formatted blocks | ✅ | Headings, paragraphs, bold, italic, underline, strikethrough, inline code, links, nested bullet lists, numbered lists, quotes, tables with header cells, code blocks and images all come back unchanged. |
| 6 | Append to an existing page | ✅ | The clipper reads the page and writes back the existing blocks plus a divider, the `From <Source>` heading and the clip, guarded by `ifMatch`. The run simulated someone editing the page between the read and the write. The API refused the stale write with 412, the clipper read the page again and retried, and both the original blocks (ids included) and the other person's edit survived. |
| 7 | Insert a genuine mention | ✅ | A `mention({ resourceId })` run is stored as a real link, and the server fills in the page's current name (`Dragon`, `World of Greyhawk`). |
| 8 | Create a Source with a dynamic backlinks collection | ✅ | A new Source page gets the **same** `Backlinks` collection as the hand-made `Sources / D&D Beyond` page (`scope: 'edges'`, `targetId = $self`). The `From <Source>` heading mentions the Source, so every clip shows up in its backlinks. The second run found "Wikipedia" already in Sources and reused it instead of creating a duplicate. |
| 9 | Upload an image and add an image block | ✅ | The clipper downloads the image, checks its real format from its first bytes, uploads it with `assets.uploadImage` and adds an `image` block that uses the asset URL. A URL that is not an image (an HTML page) becomes a link to the original instead of failing the clip. |

The run also covered several edge cases:

- **Blank pages.** A resource that has never been written to (its document type is `blank`, like most folder pages) accepts an append and becomes a page.
- **Maps, boards and timelines.** These are refused as append targets before anything is written, with a clear message.
- **Several page tabs.** Resources such as Iggwilv (Main / DM / Statblock) need the user to pick a tab. Once a tab is chosen, appending to it works.
- **Keeping the index current.** After every page the clipper creates, its local index matches a full reload, so it needs no full refresh after each import.
- **Errors in plain words.** API errors are explained in terms the user can act on (permissions, plan, conflicts, size limits, rate limits).

## Findings that shape Phase 2

1. **The extension can call the API directly.** Responses send `Access-Control-Allow-Origin: *`, and the SDK needs only `fetch`. The code in `src/lk/` has no Node dependencies, so it can run unchanged in an extension service worker. That would make the local Node service from ChatGPT's plan optional. LegendKeeper's warning about keys applies to code that runs inside web pages. An extension's service worker and its storage are separate from the pages being clipped, so for a single-user tool a key kept in `chrome.storage.local` (never in a content script) is a reasonable trade-off. If stronger protection becomes worthwhile later, the same modules can move into a local service. **Recommendation: no local service for now.**
2. **Appends are atomic by default.** The default append writes the whole page in one guarded request, so a clip is either saved completely or not at all. Requests are limited to 1 MB, so pages that large automatically switch to adding blocks one at a time with `blocks.insert`. If the page changes partway through that slower method, the clipper reports a partial append instead of hiding it.
3. **A clip costs only a few writes.** A new-page clip is one write, plus one for a new Source and two per image (the upload itself goes straight to storage). An append is one write, plus one more for each retry after a conflict. The per-key limit is 120 writes a minute, which is far more than one person clipping by hand will use.
4. **Duplicate images get duplicate library entries.** Uploading the same image twice created two assets with different ids but the same stored URL, so LegendKeeper keeps the file once but lists it twice. Phase 5 can remember source URL → asset to avoid repeats.
5. **Backlinks are computed by the app.** The API stores the collection's filter but does not return its results, so the only way to see the backlinks is to open the Source page (**Sandbox / Sources / Wikipedia**). The mentions it relies on are confirmed in the API output.
6. **Images must be uploaded.** Image blocks accept only this project's asset URLs. `data:` URLs and links to other sites are refused, so every clipped image has to be uploaded first. Some sites block downloads (Wikimedia rejected an unusual thumbnail size with 400 and rate-limited with 429), which is why the clipper falls back to a link.
7. **Key roles.** According to the API documentation (not tested here, since only an ADMIN key was available), a MEMBER key can create pages under existing parents, append, upload images and search. It cannot create top-level pages or call `tags.list` (tag search can read tags from `resources.list` instead). The proof of concept used an ADMIN key only to create the sandbox.

## Not covered by Phase 1

Phase 1 does not turn HTML into blocks (Phase 2), add automatic links or fuzzy matching (Phase 3), or convert complex tables (Phase 4). No AI model is needed for any of it, so the OpenRouter key has not been used.
