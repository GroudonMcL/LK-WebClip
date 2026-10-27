# PDF reader

Chrome shows PDFs in its own viewer, which extensions cannot inject scripts into, so the clipper cannot read a PDF tab. The plan is a reader page inside the extension: right-click a PDF tab, choose **Open in LK Reader**, and the PDF opens side by side with a clean, reflowed copy of its text that you clip from as usual.

## Decisions

- **Same extension, not a second one.** The reader page uses the existing side panel, templates, linking and import.
- **Rebuild the text, don't convert the page.** Generic PDF-to-HTML converters copy the page's look, so two-column books come out scrambled. The reader uses pdf.js to read each run of text with its position and font, and rebuilds the reading order (`src/pdf/reflow.ts`).
- **Side by side.** The original page sits on the left and the reflowed text on the right, scrolled together. Hovering or clicking a paragraph highlights where it is on the page.
- **Styles are detected, then correctable.** The most used font and size is body text; larger, distinct styles become heading levels. Wrong ones can be corrected per book (`ReflowOptions.styles`).
- **The layout is detected, then correctable.** Columns, their divider and the margins are found from the text; where that goes wrong, the reader's **Layout** panel sets them by hand (`ReflowOptions.layout`). The rule is that every automatic step has a manual override, because every publisher's PDFs differ.
- **Pages are processed as you scroll**, so long books open quickly.
- **No OCR.** Scanned PDFs without a text layer are out of scope. Scans that already have an OCR text layer are read in scan mode (below).
- **Corrections belong to the PDF, not the reader.** Text styles, page layouts, marked areas, scan mode and edited pages are all kept per PDF (by its fingerprint), so reopening the book brings them back.
- **The right-click item appears only on PDF tabs.** Chrome does limit it that way (confirmed in Chrome).
- **Local files** (`file:///…`) need **Allow access to file URLs** turned on for the extension in `chrome://extensions`. Dragging a PDF onto the reader page works without it.

## Prototype (done)

`npm run pdf:reflow -- <file.pdf> [out-dir] [--pages 3-9] [--styles overrides.json] [--json]` writes a side-by-side `index.html` plus the extracted images, and `styles.json` with the detected styles (edit a role and pass the file back with `--styles` to correct it). The page renders on the left need poppler's `pdftoppm`.

What it handles, tested against a 21-page DMsGuild adventure:

- Two columns, with titles, wide tables and images that span both; a heading that sits just above a full-width block.
- Paragraphs that continue into the next column or onto the next page, including list items; words hyphenated across lines.
- Headings, including small caps headings (put in title case) and headings over two lines.
- Drop caps joined back to their word; page numbers removed; text drawn twice (outlines) read once.
- Boxed text (on a coloured panel) as a quote; bullet lists; bold and italic.
- Tables from aligned rows, including wrapped cells, header rows, contents lists, and ability scores set too close together.
- Stat blocks: a heading followed by "Armor Class" is grouped with everything up to the next heading that isn't Actions, Reactions, etc. Each one gets a **Select stat block** button.
- Images: illustrations and maps come out as PNGs with transparency. Page backgrounds, decorations repeated on many pages, knockout layers drawn under the art, and panels with text on top are left out.

Known gaps:

- A paragraph cut off by a full-width block carries on after it only when it stopped mid-sentence and goes on in lower case (0.9.0); one that goes on with a name or "I" stays split.
- Centred text (letters, credits) sometimes joins or splits lines oddly. Marking it **Read as one block** fixes it.
- Every publisher's fonts differ, so other books may need style corrections.

## The reader (done, 0.6.0)

`reader.html` in the extension (`src/extension/reader.ts`).

- **Opening:** **Open in LK Reader** on the right-click menu of PDF tabs, and **Open PDF in LK Reader** on links to PDFs (both limited to `.pdf` URLs). **Send to LegendKeeper** on a PDF tab opens the reader as well, in case Chrome doesn't show the first item in its viewer. The side panel has **Open a PDF in LK Reader**, and the reader takes dropped files and has a file picker. `file:///` URLs need **Allow access to file URLs**; without it the reader explains how to turn it on and offers the drop zone.
- **Loading:** text is read page by page in the background. The reflowed text appears after the first 6 pages and is reflowed again every 20 pages and at the end, keeping your place. Page renders (left) are drawn only near the scroll position and dropped when far away. Images are decoded when they scroll into view.
- **Images:** pdf.js names images afresh each time it reads a page and only hands over an image's pixels the first time, so images are found again by position. They come from a second copy of the PDF, which is replaced every 16 pages so it doesn't hold every decoded image. They're shown and clipped as WebP (small, keeps transparency).
- **Clipping:** the web capture code runs on the reflowed HTML, so a PDF clip is an ordinary clip to the side panel. Extensions can't inject scripts into their own pages, so a clip from a reader tab (the context menu, or **Use the whole article instead**) is asked of the page by message. Each reader tab registers itself in session storage for this.
- **Text styles:** **Headings** lists every font and size with an example, and its role (Heading 1–4, Text, Leave out). Corrections are saved per PDF (by its fingerprint) in local storage.
- **pdf.js:** the extension uses pdf.js's legacy build: the current build relies on JavaScript newer than many Chrome versions have.

`npm run reader:check -- book.pdf` loads the built extension in Chromium and checks the reader end to end without a LegendKeeper project.

## Layouts, marked areas, edits and scan mode (done, 0.8.0)

Corrections for pages the reflow gets wrong, and for scanned books.

- **Three columns and sidebars** (`src/pdf/reflow.ts`): gutters are found across the whole book first, as before, but anywhere from 12% to 88% of the page width, so a book can have two (three columns) or one off the middle (a sidebar). A page that doesn't keep to the book's gutters, such as a three-column page in a two-column book (most of its lines cross the book's gutter), is measured on its own: strips no line crosses, between columns that hold at least four lines, mostly lines that fill the column (a table's columns don't), and fewer lines crossing the strip than sit beside it. A column narrower than 0.6 of the widest is a **sidebar**: it is read after the rest of the page, and the main text never runs on into it. A line across every gutter splits the page into bands as before; a line across only some (a heading over two of three columns) is read in the column it starts in.
- **Per-page layout:** each page marker in the text has a layout menu showing what was found (“Auto: 3 columns, sidebar”), with **One column**, **Two columns**, **Three columns** and **Text and sidebar** to override it. A set layout places its gutters in the emptiest strips near where they should be (`ReflowOptions.layouts`).
- **Marking areas:** **Mark area** in the toolbar, then drag a rectangle on a page and choose **Read as one block** (one paragraph, or one heading if it is all heading text: for letters, credits, captions), **Leave out** (credits, page furniture, a map's labels) or **Read as a table** (rows by baseline, columns wherever no text sits from top to bottom, a row with an empty first cell carries on the row above, a bold first row is the header). Text is assigned by where its middle is, and the area marked last wins where they overlap. The area's text is taken out before columns are found and put back where the area sits in the reading order. Areas are drawn on the page (blue, green, hatched grey) with **×** to remove them (`ReflowOptions.regions`, in PDF points). **Esc** leaves marking.
- **Editing a page's text:** **Edit text** on a page marker makes that page's reflowed text editable in place; **Save** (Ctrl+Enter) or **Cancel** (Esc). The edit is kept as HTML, cleaned to what the reflowed text uses (headings, paragraphs, lists, tables, quotes, bold, italic, images, stat blocks), with each block's position on the page kept so highlighting still works. It replaces that page's reflowed text from then on, whatever layout, areas or styles are set later; the marker says **Edited**, and **Undo edit** goes back to the reflowed text. Clips take the edited text. A paragraph that starts on the page before belongs to that page.
- **Scan mode** for scanned books with an OCR text layer, where every word has the same (often invisible) font and its own slightly different size and baseline: rows are measured from their average baseline with more room (half the text size), a line's size and baseline are its words' medians, styles are text sizes alone (`*@18`), sizes within a tenth of each other are one heading level, and indents and alignment are judged more loosely. It turns itself on when most text is in an OCR font (GlyphLessFont and the like) or neighbouring words on a line sit at slightly different heights or sizes (more than 30% of at least 20 pairs), which typeset text never does. **Headings → Scanned book** turns it on or off; the status line says when it is on (`ReflowOptions.scan`).
- `npm run pdf:reflow` takes `--page-settings settings.json` (`{ layouts, regions, scan }`, as the reader keeps them) and `--scan` / `--no-scan`, and prints each page's columns.
- `test/fixtures/layouts.pdf` and `scanned.pdf` (made by `test/fixtures/make-layouts-pdf.py`) are read with pdf.js in the unit tests, and `npm run reader:check -- test/fixtures/layouts.pdf` drives the layout menu, marking, editing (and reopening) and scan mode in the browser.

## Navigation, contents and layout (done, 0.9.0)

Developed alongside 0.8.0 and merged in 0.9.0. Tested against a 2001 WotC hardback (print PDF, two columns, mirrored margins, chapter tabs), which showed up several things the first books did not.

**What went wrong, and the fixes**

- *Highlights sat 54pt right and below the text.* Print PDFs keep the trimmed page in a larger sheet with crop marks: the CropBox starts at (54, 54), not the origin. Text was placed in the PDF's own coordinates, not the page as shown. `extractPage` now maps everything through pdf.js's viewport transform, which also handles pages with a `/Rotate`.
- *Lines from both columns were read as table rows.* The gutter was looked for once across the whole book, but books mirror their margins: the odd pages' columns sit 20–36pt to the right of the even pages', so no strip is clear across all pages. Gutters are now looked for across the pages on each side of the spine first, then the whole book, then on the page itself (see 0.8.0 above for pages laid out differently). Across many pages the gutter only has to be a clear dip (at most a third of the typical cover), as titles, wide tables and contents leaders cross it.
- *A letter in every table cell ("C", "H", "A"…).* The chapter name runs down the page's edge one upright letter at a time, one letter per line of text, so every row gained a cell. Single letters outside the text area (where lines of text start and end) are dropped before lines are joined; otherwise a 24pt letter 22pt from a heading joins on to it.
- *"161" as a heading.* Page numbers set in a display face near the bottom edge are dropped when they sit on a line of their own.
- *A big heading joined across the gutter.* "CHARACTER" (28pt, left column) and "PACKAGES" (18pt, right column) were close enough to join. A segment crossing the gutter is split at a gap between its runs that sits over the gutter.
- *Body lines beside a wide table swallowed by it, and a table's first header line left out.* Rows join a table from above and below until nothing changes, but never a row with a piece as long as a line of text.
- *Hanging indents* ("Advancement: … " with its later lines set in) carry on, and a table's title set in another style just under both columns is read right before its table.
- *Text wrapped round a picture, with the picture's name printed on it, read as a table* (and the picture itself left out, taken for a panel with text on it). A picture's box holds the clear space round the art, so the wrapped lines start inside it. Text counts as being *on* a picture only across its middle; a caption there is a line of its own, and rows whose gap holds the picture are never table rows.
- Ornament fonts (rules drawn with glyphs: "IndecisionLines", "…Pi") default to Leave out.

**The reader**

- **Page navigation:** ◀ ▶ and a page number box in the bar; ← and → when the focus is not in a field. The number follows the pages pane as it scrolls; going to a page scrolls both panes.
- **Contents:** every heading found, with its page, and a filter box. Clicking one scrolls the text to it and highlights it on the page. It is the quickest way to see which text styles still need correcting under **Headings**.
- **Layout:** for PDFs where finding the columns fails, for the whole book (a page's own layout menu wins over it). *Columns* (auto, one, two); the *column divider*, set by clicking on a page (kept separately for odd and even pages, since margins mirror; the dashed lines on every page show where the columns were found to divide, a solid one where it was set); *margins to leave out* as percentages of the page, shaded on the pages, for running heads, page numbers and chapter tabs. Settings are stored per PDF with the style corrections.
- **Scans:** a page that draws text invisibly (the recognised text OCR lays over a scan) is reported in the status line and the Layout panel, since positions and fonts are then only approximate. When half the pages do, scan mode turns itself on. There is still no OCR of PDFs without a text layer.
- `npm run pdf:reflow -- book.pdf --layout layout.json` takes the same layout as JSON, for tuning without the browser.

## Working with PDFs of different quality

What the reflow can rely on depends on how the PDF was made:

| Kind | What the text layer gives | What goes wrong | What helps |
|---|---|---|---|
| Born digital, from a layout program (most publishers since ~2000) | Exact positions, real font names, sizes | Only layout quirks: crop boxes, mirrored margins, tabs, text wrapped round art, three columns, sidebars | The automatic rules, with the Layout and Headings panels for the quirks |
| Born digital, exported from a word processor | Exact positions, but fewer distinct fonts (headings are the body face in bold) | Headings not told from text; bold lead-ins taken for headings | Headings panel; a "bold body text at this size is a heading" rule would help |
| Scanned with OCR (older books, DriveThruRPG scans) | Approximate positions, one generic font, sizes vary line to line, text invisible | Styles meaningless so no headings; baselines jitter so lines split or merge; columns found, but tables and hanging indents unreliable | Layout panel for the columns and margins; Headings by hand; a looser baseline tolerance when the page is flagged as scanned |
| Scanned without OCR | Nothing | Nothing to reflow | OCR would be needed (Tesseract in the browser is possible but slow and large) |
| Image-heavy (maps, handouts) | Little text | Pictures left out as backgrounds, or panels taken for pictures | Clip the page as an image instead |

Ideas, roughly in order of value, and where they stand:

1. ~~**Per-page overrides.**~~ Done in 0.8.0: the layout menu on each page marker.
2. ~~**Draw a region to read, or to skip.**~~ Done in 0.8.0: **Mark area**.
3. ~~**Fix a page by hand, keep it.**~~ Done in 0.8.0: **Edit text**.
4. ~~**Three columns and sidebars.**~~ Done in 0.8.0; boxed panels read as their own unit in 0.9.0.
5. ~~**Text wrapped round art.**~~ Done in 0.9.0.
6. ~~**Scanned books.**~~ Done in 0.8.0 (scan mode); lines in capitals as headings in 0.9.0.
7. ~~**Word-processor exports.**~~ Done in 0.9.0.
8. ~~**Search across the book.**~~ Done in 0.9.0, in the Contents panel.
9. ~~**Reading-order check.**~~ Done in 0.9.0, in the Layout panel.
10. **OCR fallback** for PDFs with no text layer at all, as an opt-in that runs page by page. Not started: Tesseract in the browser needs its WebAssembly engine and a language model (about 15 MB for English) in the extension, or downloaded on first use, and takes seconds a page. Worth it only if image-only PDFs turn up often.

## Reading fixes, search and reading order (done, 0.9.0)

The rest of the ideas above, and the known gaps that could be fixed.

- **Text wrapped round a picture** (`continues` in `src/pdf/reflow.ts`): a line that stops short with a kept picture beside it on the right, or starts after one on the left, counts as a full line, so a sentence ending there no longer ends the paragraph. A picture met while a paragraph is open is put after the paragraph rather than splitting it.
- **A paragraph cut off by a table, a picture or a marked area across the page, or by a sidebar**, carries on after it: the paragraph is kept when it stopped mid-sentence, and the first line of text after the interruption (on the same side of any sidebar) joins it when it starts in lower case and lines up as a next column's line would. The paragraph keeps its place before the table. Anything else (a heading, a list, a new paragraph) lets it go.
- **Coloured panels** (boxed text, a sidebar on a tint, a stat block on a panel) are read as a unit, like a marked area: the outermost tinted shape (not white or black, at least 80pt wide and three lines high, under 40% of the page) whose text stays inside it, holding at least two lines but not most of the page. Its text is taken out before the page's columns are found and read where the panel sits, in its own columns if it has them (two lines make a column in a panel). Its paragraphs stay boxed.
- **Lines in capitals** are headings in scan mode (one level below the smallest found by size), when short, with a word of four letters or more and no closing comma or full stop: "THE SUNKEN TEMPLE", not "STR DEX CON".
- **Word-processor exports:** a heading style now only takes lines set mostly in it, so marking bold body text as a heading leaves bold lead-ins ("**Note.** …") as text. Where a book has fewer than two heading sizes, a bold style in the body face and size is a heading by itself when at least three of its lines, and 60% of them, are short lines wholly in it that don't end a sentence.
- **Search:** the Contents panel's box also searches the whole text once three letters are typed: up to 200 places, each with the words around it and its page, every match marked in the text (CSS custom highlights, so the text and what is clipped are untouched). Enter goes to the first.
- **Reading order:** **Layout → Show the reading order on the pages** numbers each block on the pages in reading order, with an outline round each run of its lines, so a wrong order shows at a glance.

## Later

- OCR for PDFs with no text layer (above).
