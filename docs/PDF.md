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

## Next

1. Reader page in the extension: pdf.js renders pages on the left (canvas) and the reflowed text on the right, using `extractPage` and `reflow` directly.
2. Right-click **Open in LK Reader** on PDF tabs, plus drag-and-drop and a file picker.
3. Clipping from the reader: a selection or a stat block goes to the side panel like a web clip, and images go to the asset library as `data:` images.
4. Style corrections in the reader's UI, saved per book.
