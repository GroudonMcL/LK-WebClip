# PDF reader

Chrome shows PDFs in its own viewer, which extensions cannot inject scripts into, so the clipper cannot read a PDF tab. The plan is a reader page inside the extension: right-click a PDF tab, choose **Open in LK Reader**, and the PDF opens side by side with a clean, reflowed copy of its text that you clip from as usual.

## Decisions

- **Same extension, not a second one.** The reader page uses the existing side panel, templates, linking and import.
- **Rebuild the text, don't convert the page.** Generic PDF-to-HTML converters copy the page's look, so two-column books come out scrambled. The reader uses pdf.js to read each run of text with its position and font, and rebuilds the reading order (`src/pdf/reflow.ts`).
- **Side by side.** The original page sits on the left and the reflowed text on the right, scrolled together. Hovering or clicking a paragraph highlights where it is on the page.
- **Styles are detected, then correctable.** The most used font and size is body text; larger, distinct styles become heading levels. Wrong ones can be corrected per book (`ReflowOptions.styles`).
- **The layout is detected, then correctable.** Columns, their divider and the margins are found from the text; where that goes wrong, the reader's **Layout** panel sets them by hand (`ReflowOptions.layout`). The rule is that every automatic step has a manual override, because every publisher's PDFs differ.
- **Pages are processed as you scroll**, so long books open quickly.
- **No OCR.** Scanned PDFs without a text layer are out of scope.
- **The right-click item appears only on PDF tabs**, if Chrome allows the item to be limited that way (still to be confirmed in Chrome itself).
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

- A paragraph interrupted by a full-width block (it ends in one column, a wide table follows, and it carries on next page) is split in two.
- Centred text (letters, credits) sometimes joins or splits lines oddly.
- Three-column layouts are read as one or two columns.
- Text that wraps round an illustration is read as short lines, so a paragraph beside a picture splits where a line ends with a full stop.
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

## Navigation, contents and layout (0.8.0)

Tested against a 2001 WotC hardback (print PDF, two columns, mirrored margins, chapter tabs), which showed up several things the first books did not.

**What went wrong, and the fixes**

- *Highlights sat 54pt right and below the text.* Print PDFs keep the trimmed page in a larger sheet with crop marks: the CropBox starts at (54, 54), not the origin. Text was placed in the PDF's own coordinates, not the page as shown. `extractPage` now maps everything through pdf.js's viewport transform, which also handles pages with a `/Rotate`.
- *Lines from both columns were read as table rows.* The gutter was looked for once across the whole book, but books mirror their margins: the odd pages' columns sit 20–36pt to the right of the even pages', so no strip is clear across all pages. Now each page finds its own gutter; a page that cannot (one of wide tables) takes the gutter the other pages on its side of the spine share, and failing that the whole book's. The gutter has to be nearly empty on one page, and only a clear dip across many.
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
- **Layout:** for PDFs where finding the columns fails. *Columns* (auto, one, two); the *column divider*, set by clicking on a page (kept separately for odd and even pages, since margins mirror; the dashed line on every page shows where it was found, solid where it was set); *margins to leave out* as percentages of the page, shaded on the pages, for running heads, page numbers and chapter tabs. Settings are stored per PDF with the style corrections.
- **Scans:** a page that draws text invisibly (the recognised text OCR lays over a scan) is reported in the status line and the Layout panel, since positions and fonts are then only approximate. There is still no OCR of PDFs without a text layer.
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

Ideas, roughly in order of value:

1. **Per-page overrides.** The layout is per book; a page that differs (a one-column introduction in a two-column book, a full-page table) could carry its own: a "this page" toggle in the Layout panel.
2. **Draw a region to read, or to skip.** Drag a rectangle on a page: *read this as one block* (a sidebar, a caption), *skip this* (an advert), *this is a table*. Regions would be stored with the layout and applied before the automatic rules, so a scrambled page could be put right in a few drags rather than by tuning rules.
3. **Fix a page by hand, keep it.** Edit the reflowed text in place (it is HTML already) and store the edit for that page, so a clip made later uses the corrected text.
4. **Three columns and sidebars.** Find two gutters when the text never crosses two strips; treat a boxed panel (a coloured shape with text inside, already found for quotes) as its own column.
5. **Text wrapped round art.** Lines that stop short beside an image box continue on the next line; today they look like the short last line of a paragraph.
6. **Scanned books.** When a page is flagged as scanned: join lines by a looser baseline tolerance, take headings from size alone (and all-capitals lines), and ignore font names. Offer "this PDF is a scan: use size-only heading detection" as one switch.
7. **Word-processor exports.** Let a style be "body, but a heading when bold".
8. **Search across the book**, from the contents panel's filter box.
9. **Reading-order check.** Highlight the blocks on the page in reading order (numbered boxes) so a wrong order is seen at a glance, rather than by reading the text.
10. **OCR fallback** for PDFs with no text layer at all, as an opt-in that runs page by page.

## Later

- Searching the whole book.
- Better handling of the known gaps above (interrupted paragraphs, centred text, three columns).
