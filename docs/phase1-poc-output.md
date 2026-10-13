# Phase 1 proof of concept — output of the latest run

Run 2026-10-13 13:01 UTC against project "AI Test Project" with `npm run poc`. 11/11 steps passed, using 26 read and 18 write requests.

Everything it made is under **LK Web Clipper Sandbox / Phase 1 run 2026-10-13 13:01** in LegendKeeper (Sources under **LK Web Clipper Sandbox / Sources**).

## ✅ 1. Load project details

```
1 API key(s) configured → the project picker can be skipped
Project: "AI Test Project" (cmv2bmxgs00oi42od6almgppg), public: false, created 2026-10-10T11:39:00.470Z
tags.list (an ADMIN-only operation) succeeded → the key acts as ADMIN. 34 distinct tags.
```

## ✅ 2. Retrieve the resource hierarchy

```
333 resources in 4 page(s) of resources.list, 1155 ms, tree depth 7
Document types: page 329, time 3, blank 16, map 5
14 resources have more than one page tab (e.g. "Iggwilv": DM/Main/Statblock; "Natasha": DM/Main; "Natalie": DM/Main)
Top level: AI Test Project, Bestiary, D&D Wiki, World of Greyhawk, LK Companion Sandbox, Sources, LK Web Clipper Sandbox
Example path: Bestiary / Dragon / Adult Red Dragon
✓ the index holds the project tree
```

## ✅ 3. Search for a resource by name

```
"Dragon" → 8 hits in 544 ms:
    [ExactName] Bestiary / Dragon
    [NamePrefix] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 12:59 / Dragon research (append target, atomic)
    [NamePrefix] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 13:00 / Dragon research (append target, atomic)
    [NameWord] Bestiary / Dragon / Adult Red Dragon
    [NameWord] Bestiary / Dragon / Red Dragon Wyrmling
    [NameWord] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 12:59 / Red Dragon of Wales (new page clip)
    [NameWord] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 13:00 / Red Dragon of Wales (new page clip)
    [NameWord] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 10:19 / Clip test — Red Dragon notes (new page)
"Greyhawk" → 8 hits in 334 ms:
    [NameWord] World of Greyhawk
    [Content] D&D Wiki / Gods / Iuz  (Wickedness. Iuz is variously called "the Old One" and "Old W)
    [Content] World of Greyhawk / Entities / NPCs / Iggwilv / Tasha  (original Gynarchy of Hardby  (2) , and a direct descendant o)
    [Content] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 10:20  (content: paged, 100 at a time) and build paths PA)","World o)
    [Content] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 10:19  (Game Terms / Exploration / Vision and Light / Blindsight (co)
    [Content] LK Web Clipper Sandbox / Phase 1 run 2026-10-13 10:24  (Clip test — Dragon research (existing page) (name_word)","D&)
    [Content] World of Greyhawk / Entities / NPCs / Iggwilv / Story - Vile Roots  (often sought out by adventurers to help divine their finding)
    [Content] D&D Wiki / Gods / Iuz / The Soul Husks of the Old One  (Iggwilv From Visions of GREYHAWK  By Samuel D. Weiss  Hidden)
"Witch Queen" → 3 hits in 493 ms:
    [Alias] World of Greyhawk / Entities / NPCs / Iggwilv  (Witch Queen of Perrenland)
    [Content] World of Greyhawk / Entities / NPCs / Iggwilv / Story - Vile Roots  (asked for nothing yet offered what no other being cared or d)
    [Content] D&D Wiki / Gods / Iuz  (cambion child of the demon prince Graz'zt and Iggwilv, the s)
✓ an exact name match ranks first
✓ aliases are searchable
```

## ✅ Sandbox setup

```
Using the existing sandbox page "LK Web Clipper Sandbox" (pctbsovdvii7nbozlyjljhcp)
Using the existing sandbox Sources page (cje5i3fg)
Created the run page "Phase 1 run 2026-10-13 13:01" (mrgr21x4)
```

## ✅ 8. Create a Source resource with a dynamic backlinks collection

```
Site name for https://en.wikipedia.org/wiki/Flag_of_Wales with og:site_name "Wikipedia" → "Wikipedia"
Site name for https://www.dndbeyond.com/monsters/16990-adult-red-dragon without metadata → "Dndbeyond"
"Wikipedia" already exists in Sources → reused LK Web Clipper Sandbox / Sources / Wikipedia (the extension will prompt here)
✓ the Source page holds a backlinks (edges) collection
Duplicate detection against the project's own Sources page: "D&D Beyond" → Sources / D&D Beyond
```

## ✅ 9. Upload an image and create an image block

```
Asset folder "LK Web Clipper": wrm2cy1qaxxnwxukqix3mdsh
Uploaded https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Flag_of_Wales.svg/330px-Flag_of_Wales.svg.png → asset pd1tjn0hz7y4ak7mwidfmu72
Asset url: https://assets.legendkeeper.com/cmv2bmxgs00oi42od6almgppg_60c66a39-4c1d-4488-8f8e-309b76bc661a.png
✓ a non-image URL falls back to a link instead of failing the clip ("not a PNG, JPEG, GIF or WebP image (the host called it text/html; charset=UTF-8)")
```

## ✅ 5–7. Create a new page under a chosen parent, with formatted blocks and genuine mentions

```
Created LK Web Clipper Sandbox / Phase 1 run 2026-10-13 13:01 / Red Dragon of Wales (new page clip)
Top-level blocks: heading, heading, paragraph, paragraph, heading, bulletList, orderedList, quote, table, code, image, paragraph
✓ the page opens with Heading 1 "From Wikipedia"
Mentions as stored (the server fills in each name): Wikipedia → y9msli0k, Dragon → f1478516dae6632c51151365, World of Greyhawk → aaphw0hr
✓ the Source name in the heading is a mention of the Source page
✓ the body mentions the existing "Dragon" page and the server resolves it
✓ heading survived the round trip
✓ bulletList survived the round trip
✓ listItem survived the round trip
✓ orderedList survived the round trip
✓ quote survived the round trip
✓ table survived the round trip
✓ tableCell (header) survived the round trip
✓ code survived the round trip
✓ image survived the round trip
✓ the nested list survived the round trip
✓ inline marks survived the round trip: bold, italic, underline, strike, code, link
```

## ✅ 6. Append formatted content to an existing page (atomic write, with a simulated concurrent edit)

```
Existing page LK Web Clipper Sandbox / Phase 1 run 2026-10-13 13:01 / Dragon research (append target, atomic) holds: heading, paragraph, bulletList
Simulated a concurrent edit between the clipper’s read and its write
Strategy replace, 2 attempt(s). Page now: heading, paragraph, bulletList, paragraph, rule, heading, paragraph
✓ the stale write was refused with 412 and retried on a fresh read
✓ the original blocks are unchanged, ids included
✓ the concurrent edit was kept, not overwritten
✓ the clip starts with a divider and the "From <Source>" heading
✓ a second clip (insert strategy) adds its own divider and heading below the first
```

## ✅ Append targets: blank documents, maps and multi-tab resources

```
New resource with no content: document type "blank"
✓ appending to a blank document works and converts it to a page
✓ a map is refused before any write: ""Map page (not appendable)" is a map document, so clipped text cannot be appended to it. Pick a page tab instead."
✓ two page tabs need a choice: ""Two-tab page (choose a tab)" has 2 page tabs (Main, DM). Choose one."
✓ appending to the chosen tab works
```

## ✅ Errors are reported in words the user can act on

```
✓ an invalid request reads: "LegendKeeper refused the content: name: String must contain at least 1 character(s) (request f0e8aa22-c980-4ee2-b1d9-22017c94ac23)"
```

## ✅ Index stays current without a full reload

```
✓ the incrementally updated index (339) matches a full reload (339)
```
