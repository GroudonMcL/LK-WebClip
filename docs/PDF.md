# PDF reader

Chrome shows PDFs in its own viewer, which extensions cannot inject scripts into, so the clipper cannot read a PDF tab. The plan is a reader page inside the extension: right-click a PDF tab, choose **Open in LK Reader**, and the PDF opens side by side with a clean, reflowed copy of its text that you clip from as usual.

## Decisions

- **Same extension, not a second one.** The reader page uses the existing side panel, templates, linking and import.
- **Rebuild the text, don't convert the page.** Generic PDF-to-HTML converters copy the page's look, so two-column books come out scrambled. The reader uses pdf.js to read each run of text with its position and font, and rebuilds the reading order (`src/pdf/reflow.ts`).
- **Side by side.** The original page sits on the left and the reflowed text on the right, scrolled together. Hovering or clicking a paragraph highlights where it is on the page.
- **Styles are detected, then correctable.** The most used font and size is body text; larger, distinct styles become heading levels. Wrong ones can be corrected per book (`ReflowOptions.styles`).
- **Pages are processed as you scroll**, so long books open quickly.
- **No OCR.** Scanned PDFs without a text layer are out of scope. Scans that already have an OCR text layer are read in scan mode (below).
- **Corrections belong to the PDF, not the reader.** Text styles, page layouts, marked areas, scan mode and edited pages are all kept per PDF (by its fingerprint), so reopening the book brings them back.
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

- A paragraph interrupted by a full-width block (it ends in one column, a wide table follows, and it carries on next page) is split in two. The same happens to a paragraph that carries on to the next page past a sidebar.
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

## Later

- Searching the whole book.
- Keeping a paragraph together across a full-width block or a sidebar.
