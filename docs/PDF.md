# PDF reader

Chrome shows PDFs in its own viewer, which extensions cannot inject scripts into, so the clipper cannot read a PDF tab. The plan is a reader page inside the extension: right-click a PDF tab, choose **Open in LK Reader**, and the PDF opens side by side with a clean, reflowed copy of its text that you clip from as usual.

## Decisions

- **Same extension, not a second one.** The reader page uses the existing side panel, templates, linking and import.
- **Rebuild the text, don't convert the page.** Generic PDF-to-HTML converters copy the page's look, so two-column books come out scrambled. The reader uses pdf.js to read each run of text with its position and font, and rebuilds the reading order (`src/pdf/reflow.ts`).
- **Side by side.** The original page sits on the left and the reflowed text on the right, scrolled together. Hovering or clicking a paragraph highlights where it is on the page.
- **Styles are detected, then correctable.** The most used font and size is body text; larger, distinct styles become heading levels. Wrong ones can be corrected per book (`ReflowOptions.styles`).
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

## Later

- Searching the whole book.
- Better handling of the known gaps above (interrupted paragraphs, centred text, three columns).
