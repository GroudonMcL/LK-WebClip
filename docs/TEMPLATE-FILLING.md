# How a clip becomes a filled template

This explains how the clipper moves content from a web page into a LegendKeeper template, as the code stands at 0.5.1. It goes stage by stage, names the file and function for each step, and lists the rules that decide whether a field is filled, left empty or filled wrongly. The last section says what to send Claude when a field comes out missing or wrong.

For what each feature is for and why it was added, see [PHASE4.md](PHASE4.md). This document covers how the code does it.

## The pipeline at a glance

```
Web page
  │ 1. Capture            src/extension/capture.ts       (runs in the page)
  ▼
HTML string + metadata
  │ 2. Convert            src/clip/htmlToBlocks.ts
  │ 3. Link               src/clip/links.ts              (prepareClip in src/clip/importClip.ts)
  ▼
Clip blocks  ─────────────────────────────┐
                                          │
Template ─ 4. Read   src/lk/templates.ts  │
  │        5. Slots  src/fill/template.ts (buildSlots)
  ▼                                       ▼
Slots                         6. Candidates  src/fill/candidates.ts (extractCandidates)
  │                                       │
  └──────────────► 7. Plan  src/fill/plan.ts (planFill) ◄── 8. AI  src/fill/ai.ts, engines.ts
                     │        rules → labels → tables → images → AI → ticks → worked-out → tidy
                     ▼
                  FillPlan (shown on the review screen; your choices feed back in as overrides)
                     │ 9. Compose   src/fill/compose.ts (compose, applyComposition)
                     ▼ 10. Write    src/lk/templates.ts, src/clip/importClip.ts
                  LegendKeeper page
```

The side panel (`src/extension/sidepanel.ts`) runs all of this. `rebuildPlan()` re-runs stages 2–7 whenever anything changes: the title, the template, a setting, a choice on the review screen, or an AI answer arriving. So the plan is always rebuilt from scratch. Nothing is patched in place.

---

## 1. Capture (`src/extension/capture.ts`)

This runs inside the web page when you choose **Send to LegendKeeper**. What it captures depends on what you right-clicked:

| Kind | What is captured |
| --- | --- |
| `selection` | The highlighted DOM, with some surrounding context (`withContext`) and absolute URLs. Class names are **kept**. |
| `image` | One `<figure><img></figure>`, with alt text or a caption. |
| `link` | One `<p><a></a></p>`. |
| `article` (nothing selected) | The page's main content, chosen by **Mozilla Readability**. |

The article path has some steps that matter for templates:

- Wikipedia's `.mw-editsection` ("[edit]") is removed first.
- `markLabelElements` (`src/clip/labelElements.ts`) wraps every element whose class contains `label` or `heading` (e.g. `mon-stat-block__tidbit-label`, `pi-data-label`) in `<strong>`. The text must be 48 characters or fewer and the element must hold no block children. Readability throws class names away, so this is the only way a classed label survives as a label.
- Readability then decides what counts as content. **Anything Readability drops never reaches the template.** Sidebars, infoboxes it judges to be page furniture, and collapsed sections are all at risk.

The suggested page name is the article title, or the nearest heading for a selection. It matters later: the page name is stripped from values, and it stands in for `[Class]`-style words when labels are matched.

## 2. Convert HTML to LegendKeeper blocks (`src/clip/htmlToBlocks.ts`)

`htmlToBlocks` walks the DOM and builds LegendKeeper blocks: `paragraph`, `heading`, `bulletList`/`orderedList`, `table`, `image`, `quote`, `code` and `rule`. The rules that affect template filling:

- **Skipped entirely:** `script`, `style`, `svg`, `iframe`, `video`, `button`, `input`, hidden elements, and more (the `SKIP` set). An SVG image with no description is decoration and is dropped.
- **Headings** are shifted so the top one is level 2 (`shiftHeadings`).
- **Bold:** `<b>`/`<strong>`, label-class elements (on a selection, where classes survive), `<dt>`, `<summary>` and `<caption>` all become bold runs. **Bold is the main signal used to find labels later**, so this matters a lot.
- `<dl>`/`<dt>`/`<dd>`: each `dt` and each `dd` becomes **its own paragraph**, with the `dt` in bold. This is why a definition list later turns into "label line, then value line" pairs.
- `<br>` becomes a line break inside a paragraph, not a new paragraph.
- **Tables:** `th` cells are marked `header`, and colspan/rowspan are kept. A `<caption>` becomes a bold paragraph just before the table. A one-cell table is treated as a layout wrapper and unwrapped. A table nested inside a table is flattened to text, one paragraph per row, with `|` between cells.
- **Inline formatting** is kept as run marks: bold, italic, underline, strike, code, sub, sup and link.

Everything after this point works on these blocks, never on the HTML. **If a label and its value end up in different blocks, or bold is lost, matching behaves differently.**

## 3. Linking (`src/clip/links.ts`)

`linkClip` turns text that names an existing page into a **mention** (a page link), and web links into mentions where they point at known pages. A mention stores only the page id, so the fill code uses `withNames(nameOf, …)` to read its text back.

This has a side effect on templates. A bold label that becomes a link is no longer plain bold text. `loneLabel` still accepts a line of bold text plus mentions, but `boldSegments` needs the **first** run to be bold text. So "**[[Saving Throws]]** DEX +6" is no longer found as a bold label. It is found only if "saving throws" is a known label (see `knownSegments` below).

## 4. Reading the template (`src/lk/templates.ts`)

`readTemplate` fetches the template resource and calls `getBlocks` for every **page** tab. Map and board tabs are listed in `otherTabs` and ignored. It also takes the sidebar `properties`. The result is a `TemplateTree { docs, properties }`. It is cached by `id@updatedAt`, so editing the template in LegendKeeper makes it read again.

On an **append** (adding to an existing page), only the main tab is used (`appendTree`: the tab named "Main", else the first) and there are no sidebar properties.

## 5. Finding slots in the template (`buildSlots` in `src/fill/template.ts`)

A **slot** is a place in the template that takes a value. Every slot has:

- `label`: what the template calls it.
- `key`: `cleanLabel(label)`, which is lowercased, with brackets and trailing punctuation removed. This is what is matched.
- `kind`: `text`, `rich`, `image`, `name` or `source`.
- `target`: where in the block tree the slot sits.
- `path`, `placeholder`, and optionally `titled` and `table`.

`walkSiblings` visits the blocks of each tab in order. Layouts, columns, secrets, callouts and expands are "transparent": their children are walked too.

| Template content | Slot | Notes |
| --- | --- | --- |
| Heading `From [Source]` | `source` | Takes the following placeholder or blank paragraphs as its span. |
| Heading with `[...]` that `namesPage` (e.g. `[Spell] Name`, `[Name]`) | `name` | Filled with the page title. Never matched. |
| Heading with brackets other than one plain word (e.g. `Level [?]: [Feature Name]`) | **none** | Treated as a sample to copy. |
| Heading with nothing under it but deeper sub-headings, or a bracketed heading with nothing under it | **none** | Only a title. |
| Any other heading | `rich`, `section`, `titled` | Spans every following block until the next heading or a "stop" block (`rule`, `infobox`, `layout`, `textField`, `keyValue`, …, see `SECTION_STOP`). If that span holds a table with 2+ header cells, `table` is set. |
| Paragraph or quote that is only `[placeholders]` | `rich`, `placeholder` | Label from the bracket text: "[Overview text]" → "Overview". |
| Infobox | one slot per row | Rows are handled like properties (below). |
| `keyValue` block | one `text` slot **per row** | Label = row key without its trailing colon. |
| `textField` | one `rich` `field` slot | Label = the field's title. A **weak** title (`TEXT`, `Stats`, `Image`… see `WEAK_LABELS`) means the label comes from the placeholder brackets ("[Size, e.g. Small] [Creature Type]" → "Size, Creature Type"), or from the placeholder itself if it is short. A field with only a heading in it is a caption (or `name`). A field that is mostly words with a bracket inside is treated as a note to the reader and skipped. |
| `image` | `image` | |
| Sidebar properties | the same rules, path `Sidebar › …` | Written later with separate API calls. |

**Slot ids** look like `tab0:text:infobox › armour class`, with `#2` and so on added for duplicates. They come from labels and position, never from block ids. So the same ids are found again in the page made from the template, and saved rules keep working unless a label is renamed.

> **Common reason a field never fills:** it never became a slot. Examples: a heading with odd brackets, a heading followed directly by a deeper heading, a `textField` that reads as a note, or a weak-titled field whose placeholder has no brackets and is over 40 characters. Then its `key` is empty or the slot doesn't exist.

## 6. Finding labelled values in the clip (`extractCandidates` in `src/fill/candidates.ts`)

A **candidate** is a piece of the clip with a label: `{ label, key, kind: pair | section | image, blocks, runs, text, units }`.

`units` records exactly which parts of the clip the candidate uses: `b3` (top-level block 3), `b3.r1` (a table row), `b3.c2` (a table column) or `b3.s0` (a segment of a paragraph). Two candidates that share a unit can never both be used, and used units are left out of the "unused content" at the end.

The search uses two lists of labels:

- **`knownLabels`:** every slot key, plus all of its synonyms, plus saved-rule labels for this site. These may start a line with no bold and no colon.
- **`vocabulary`:** every synonym in Settings with **two or more words** ("Saving Throws"). These are recognised only at the start of a line of 160 characters or fewer.

Patterns, in the order they are tried for each top-level block:

1. **Heading** → a `section` holding everything up to the next heading of the same or higher level. It records its `level`.
2. **Image** → an `image` candidate. Images inside tables or lists become image candidates with no units (`nestedImages`).
3. **Table:**
   - A header row over exactly one data row, with every header cell `th` → one `pair` per column (`STR` / `18 (+4)`, units `b3.c0` and so on).
   - Otherwise → one `pair` per row, with the first cell as the label and the remaining cells joined by spaces as the value. A first cell that is only numbers or punctuation is skipped, as is one longer than 48 characters.
   - The whole table also becomes a "table candidate" in the plan (`tableCandidates` in `plan.ts`). It is labelled by its caption: a bold label line just before it.
4. **Lone label line** (`loneLabel`): a paragraph of 48 characters or fewer that is a known label, or is all bold (mentions allowed), has 6 words or fewer and doesn't end in `. ! ?`. It gives:
   - a `pair` with the next line, if that line is a non-label paragraph of 80 characters or fewer ("STR" / "8 (-1)"), and
   - a `section` running to the next heading or lone label.
5. **Paragraph segments.** The first of these that matches is used:
   - **`boldSegments`:** the paragraph *starts* with bold text. Each bold run (6 words or fewer) that starts the paragraph or follows a space begins a new segment. "**AC** 15 **Initiative** +2" gives two pairs.
   - **`knownSegments`:** the paragraph starts with a known (or vocabulary) label followed by a space or colon. It is split again at later known labels that start with a capital and follow a value, but not straight after a comma or semicolon, so "Saving Throws DEX +6, INT +4" stays one value.
   - **`colonSegment`:** `Label: value`, where the label is 48 characters or fewer and 6 words or fewer.

   A bold label ending in `.` ("**Multiattack.** …") is marked `entry`. It is a named entry inside a section, not a field label. A bold opening followed by more than 120 characters of lowercase prose ("**Tiamat** is a…") is not a label.

The pair's value runs keep links and formatting. For rich fields, the pair's `blocks` hold the whole entry, label included.

> **Common reasons a value is never found:** the label isn't bold and isn't a known label or synonym. The label and value were merged into one long paragraph, or split across blocks in an unexpected way. The label text is longer than 48 characters or more than 6 words. The value line is longer than 80 characters, for the "label line, then value line" pattern. A link at the start of the line replaced the bold.

## 7. The plan: deciding what goes where (`planFill` in `src/fill/plan.ts`)

This is the heart of the process. Its inputs (`FillInput`) are the template tree, the clip blocks, the page title, the site host, synonyms, saved rules, the mode, the AI suggestions so far, your overrides on the review screen, worked-out rules, the template name and the notes.

### What can go in what (`fits`)

- A `text` slot (a row) takes a `pair`, or a `section` of 3 paragraphs or fewer and 200 characters or fewer.
- A `rich` slot takes a `section` or a `pair`.
- An `image` slot takes an `image`.

### Label tiers (`compareLabels`, `namedMatch` in `src/fill/labels.ts`)

These are tried strictest first:

| Tier | Meaning | Example |
| --- | --- | --- |
| Rule | A saved rule for this site and template | Challenge → CR on dndbeyond.com |
| Exact | Same cleaned key | `armour class` = `armour class` |
| Synonym | Same synonym group (Settings → Templates) | AC ↔ Armour Class |
| Loose | Plural or possessive, including a synonym's plural | Resistance ↔ Resistances |
| Typo | Edit distance of 1, slot key of 6+ letters | Charisma ↔ Charsima |
| Named | The page name stands for one word or `[placeholder]` | "Bard Class Details" ↔ "Class Details" |

### Order of steps

1. **Your choices (overrides).** A candidate you picked, or text you typed, fills the slot first.
2. **Rules and labels, tier by tier.** For each tier, every open slot is paired with every free candidate that fits and matches at that tier. Slots whose smallest match is smallest go first, so a section nested inside a bigger one goes to its own field. Then:
   - A row prefers a `pair` and a rich field prefers a `section` when both share the label.
   - **Ties are never guessed.** If more than one distinct candidate matches, or the same candidate matches another slot equally well, the slot is marked **`ambiguous`** and left for you.
   - A section already held by another slot can give up a part to a slot that matches that part by label (`softOwner`/`takeFromSections`). The section keeps the rest. If it is left with nothing, it becomes empty.
3. **Template tables.** A slot with `table` columns takes the clip table that shares 2+ column headings, and at least a third of them (`bestTable`). Rows above the matching header row are cut.
4. **Images.** Image slots take the clip's free, non-SVG images **in order**. No labels are involved.
5. **AI** (modes other than `labels`, once suggestions have arrived). This only touches slots that are still empty and that you haven't chosen for. See stage 8.
6. **Ticks.** A value is filled but **unticked** (`status: 'off'`) when it is AI-made-up (`ai-written`) or has a `warning`. Its units are freed again.
7. **Worked-out fields** (`src/fill/derived.ts`). For example, `Initiative = {Dexterity modifier} ({10 + Dexterity modifier})`. A rule fills a `text` slot that is empty, or that holds an unticked AI answer. It also *completes* a clip value that is only the start of the result ("+3" → "+3 (13)").
8. **Name slots** take the title.
9. **Tidying sections.** A section that gave parts away also drops captions of tables used elsewhere, and headings whose content all went elsewhere (`goneBlocks`).
10. **Extra rows.** When 2+ rows of one template key-value list came from the same clip table, that table's other unused rows are added at the end of the list (shown with a tick box).
11. **Fills and leftovers.** `valueFor` turns each filled slot into a `SlotFill`:
    - a row gets `runs`, the value only;
    - a rich field gets `blocks`, with sub-heading depth kept relative to the template heading;
    - an image slot gets a URL.

    Blocks that only repeat the page name are marked used. Everything unused becomes `leftovers` (`leftoverBlocks`), which can split paragraphs and tables at the unit level.

The `FillPlan` holds each `SlotState`: `status` (`filled`, `empty`, `ambiguous` or `off`), `origin` (`rule`, `label`, `synonym`, `similar`, `ai`, `ai-written`, `ai-wrote`, `derived`, `manual`, `typed` or `title`), `text`, `options`, `contenders`, `warning` and `note`. **The review screen shows exactly this.** The origin badge tells you which step put the value there.

### Labels and headings for each block (`labelBlocks`)

For every top-level clip block, the plan records the field labels found in it and the nearest heading or label line it sits `under`. The AI prompt uses these, and so does the AI checking below.

## 8. The AI step (`src/fill/ai.ts`, `src/fill/engines.ts`, `src/fill/notes.ts`)

### Modes

| Mode | What happens |
| --- | --- |
| `labels` | No AI. |
| `labels-ai` | Labels first. The AI then *picks* clip blocks or copies short values for the empty slots. |
| `labels-ai-write` | The same, but the AI may *write* short values (rows, and short text fields named by their placeholder, see `isWritable`) in the template's style. |
| `ai` | Labels are skipped (step 2). The AI is asked about every fillable slot. |

### Building the job (`slotsForAi`, `blocksForAi`, `buildAiJob`)

- **Slots asked about:** empty slots in the label modes, every slot in `ai` mode. Slots you chose, and worked-out slots, are never asked about.
- **Blocks shown:** blocks not used by labels (all blocks in `ai` mode), without title blocks. **Blocks whose clip label matches no asked slot are hidden.**
- **Each block** is shown as `[n] (kind, labelled "X", under "Y") text`, cut to 600 characters. The prompt as a whole is cut to the engine's `maxChars` minus the notes. On-device, that is about 60% of the context window × 4 characters; for OpenRouter, 24,000. The status line says "The clip was shortened" when this happens. **Blocks past the cut are never seen by the AI.**
- **Each field** is shown as `sN: "label" (path) — kind. A heading in the template. Template example: "placeholder"`.
- **Notes:** your saved notes for the template name, or else the first built-in pack that fits (`BUILT_IN_PACKS`: stat block, spell, magic item, subclass, class, deity, realm, character, place). They are sent in every AI mode.
- **The answer** is JSON with `{ sN: { blocks: number[], value: string } }`. It is constrained by a schema where the engine supports one.

### Checking the answer (`parseAiAnswer`, `suggestionsToCandidates`, and in `plan.ts`)

- JSON that can't be read is retried once, then the label results are used. Unknown block numbers are dropped. **A block goes to the first slot that names it**, in field order.
- Block answers become a candidate with the original blocks, minus any line that is only the page name. Value answers are checked against the clip text:
  - found in the clip → `:value`;
  - not found, and the slot may be written → `:wrote`;
  - otherwise → `:written` (made up; unticked).
- Before a value is accepted it is cleaned:
  - `unshortened`: a written value that drops part of a clip line is replaced by the whole line;
  - `copiedFrom`: a repeated value takes a free block, preferring the one labelled for this field;
  - `snapped`: a picked block that carries a matching label loses the label, exactly as label matching would have done.
- `aiWarning` leaves an answer **unticked, with a reason**, when:
  1. the clip labels the block as something else;
  2. a titled slot gets content that is under a different heading, or under no heading in a clip that has headings;
  3. an untitled slot gets content under a heading that names *another* field;
  4. a one-line row gets more than 200 characters or more than one line.
- Written values are also checked (`checkWritten`, `fromNotes`). Every number and every capitalised word must be in the clip, or in the field's own label or placeholder. Five words in a row copied from the notes, but not in the clip, are flagged.
- A label match always beats the AI: the AI only ever fills slots that are still empty.

The panel's **What the AI was asked and answered** link shows the exact prompt, the system prompt and the raw answer.

## 9. Composing the page (`src/fill/compose.ts`)

`compose(tree, plan, { sourceHeading, keepUnfilled })`:

- **Unfilled slots** (empty, ambiguous or unticked): with **Keep unfilled template fields** on, the template's placeholder stays. With it off, the row, field, section or image is removed. An infobox or text field left with nothing is removed too.
- **The credit ("From <Source>"):**
  - If the main tab has a `From [Source]` heading, the credit goes there, and the **unused content** goes under it if only placeholder text was there.
  - Otherwise the credit goes at the top of the main tab, and the unused content goes at the end, after a divider.
- `applyComposition` runs `fillTree`, which rebuilds each tab with the edits:
  - a row's content is replaced;
  - a field's children are replaced;
  - a section's heading is kept and its span replaced, with sub-headings moved below the heading's level;
  - a quote placeholder stays a quote.

  It then adds the head and tail, tidies doubled dividers, and replaces `[Class]` (from the template name "X Template") with the page name **in headings only**.
- Images are swapped for uploaded asset URLs (`mapImages`). An image that couldn't be copied leaves an image slot as it was.

## 10. Writing (`src/clip/importClip.ts`, `src/lk/templates.ts`)

- **New page:**
  1. Create the Source if it is new.
  2. Upload only the images used.
  3. `createFromTemplate`.
  4. Re-read the new page, rebuild its slots and apply the composition (slot ids match because they come from labels).
  5. One `replaceBlocks` per tab, guarded by the version just read.
  6. Sidebar row and property updates as separate calls (`PropertyOp`).
  7. Add tags (stat block tags from `src/fill/tags.ts`, if on).
- **Append:** a divider, then the filled main tab (`appendedTemplate`), written in one guarded `replaceBlocks`. Sidebars are never touched on append.
- `composition.fills` keys that don't exist in the new page are reported as `missing`. This can happen if the template changed between reading it and creating the page.

---

## Where to change things

| You want to… | Look at |
| --- | --- |
| Capture more or less of a page, or keep a site's infobox | `capture.ts` (Readability, `markLabelElements`), `labelElements.ts` |
| Change how HTML structure becomes blocks (dl, tables, bold) | `htmlToBlocks.ts` `convertNode`, `convertTable` |
| Make a template element count as a field, or stop it counting | `template.ts` `walkSiblings`, `slotsForProperty`, `WEAK_LABELS`/`isPlaceholderText` in `labels.ts` |
| Recognise a new label pattern in clips | `candidates.ts` `extractCandidates` and the segment functions; the constants `MAX_LABEL_WORDS`, `MAX_LABEL_CHARS`, `SHORT_VALUE_CHARS`, `VOCABULARY_LINE_CHARS` |
| Change how labels are compared | `labels.ts` `compareLabels`, `namedMatch`, `DEFAULT_SYNONYMS` (bump `SYNONYMS_VERSION`) |
| Change matching priority, tie handling, what fits where | `plan.ts` `plan()` steps 1–4, `fits`, `matchTier` |
| Change what the AI sees or is told | `ai.ts` `SYSTEM_PROMPT`, `WRITE_SYSTEM_PROMPT`, `job()`; `plan.ts` `blocksForAi`; `notes.ts` packs |
| Change which AI answers are trusted | `plan.ts` `aiWarning`, `checkWritten`, `fromNotes`, `snapped`, `suggestionsToCandidates` |
| Change what happens to unfilled fields or leftovers | `compose.ts` `compose`, `template.ts` `fillTree`/`rebuild` |
| Site-specific fixes | Nothing site-specific exists yet (Phase 5). Today's options are synonyms, saved rules and notes, or a code rule |

Tests: `test/fill.test.ts` uses real template fixtures (`test/fixtures/templates/*.json`) and saved clips (`test/fixtures/*.html`). `npm run eval:ai` scores AI fills across saved clips.

---

## What to send Claude when fields come out missing or wrong

Claude can't see your browser or your LegendKeeper project, so the aim is to give it the same three inputs the code had (the page HTML, the template and the settings) plus what you expected. With those, the problem can be reproduced as a test in `test/fill.test.ts`, which is how earlier fixes were made.

### Essential

1. **The web page URL**, and how you clipped it: a selection, or the whole page with nothing selected.
2. **The captured HTML.** This matters most, because Readability and the site's markup decide nearly everything. Either:
   - save the page (Ctrl+S, "Webpage, HTML only") and attach it, or, for a selection, copy the relevant element's `outerHTML` from DevTools; or
   - say it is public and stable, and Claude can fetch it. Logged-in pages such as D&D Beyond content you own can't be fetched.
3. **The template's JSON.** Ideally use the same shape as `test/fixtures/templates/*.json` (`npm run phase4:templates` and `scripts/` show how these were saved). If you can't export it, at least give the template's name, each field (block type, title, placeholder text), and which tab or sidebar it is in.
4. **The fill mode** (Labels only / Labels then AI / Labels then AI writes / AI), and the AI engine and model if one was used.
5. **For each wrong field, what it got and what it should have got**, with its badge on the review screen (Label, Synonym, Similar label, AI, AI-written, Written by AI, Worked out, Saved rule). For example: *"Speed: empty, should be '30 ft., climb 30 ft.'"* or *"Size, Creature Type, Alignment got the Description paragraph (AI)"*. The badge tells Claude which stage to look at.

### Very helpful

6. **A screenshot of the review screen** (the Template fields list), including the "fields nothing was found for" group, and any warnings shown on unticked fields.
7. **The AI exchange.** Expand **What the AI was asked and answered** and copy all of it. It shows which blocks the AI saw (and so which ones labels had already used or hidden), how they were labelled, and the raw answer.
8. **Your non-default settings:** the synonym list, worked-out field rules, any custom AI notes for this template, Keep unfilled fields, Link only exact page names, and any saved rules for this site.
9. **The resulting LegendKeeper page,** or a screenshot of it, if the problem shows only after writing (a field removed, content in the wrong place, the credit doubled).

### A message you can copy

```
Template filling bug in LK Web Clipper.

Page: <URL>  (clipped as: whole page / selection of …)
Template: <name>, fixture or export attached: <file>
Mode: <Labels then AI>, engine: <OpenRouter dots-3-note-preview:free>
Settings changed from default: <synonyms / rules / notes / keep unfilled …>

Wrong fields:
- <Field>: got "<…>" [badge: Label], expected "<…>"
- <Field>: empty, expected "<…>" (it is in the clip as "<…>")

Attached: page HTML, review-screen screenshot, AI exchange text.

Please reproduce it as a test in test/fill.test.ts with the clip saved under
test/fixtures/, find which stage goes wrong (capture, conversion, slots,
candidates, matching, AI check, compose), and fix it as a general rule
rather than a special case for this site.
```

### Diagnosing it yourself first

Use this to narrow down the stage:

- **Field missing from the review list entirely** → it isn't a slot (stage 5). Check its heading or brackets or title against the slot table.
- **Listed but empty, and the value is plainly in the clip** → the clip value wasn't found as a labelled candidate (stage 6: bold, line length, label not known), or the labels don't match (add a synonym, or pick it once and tick **Remember**).
- **Listed as needing a choice** → a tie (stage 7). Choose, and remember it.
- **Wrong value with a Label or Synonym badge** → matching found an equal or looser label first. Look at the synonym groups, or two clip parts with the same label.
- **Wrong value with an AI badge** → read the AI exchange. Was the right block hidden, cut off, or labelled misleadingly?
- **Value right in the review but wrong on the page** → compose or write (stages 9–10).
- **Content missing everywhere, including the unused content at the end** → capture or conversion (stages 1–2). Readability probably dropped it. Try clipping a selection instead.
