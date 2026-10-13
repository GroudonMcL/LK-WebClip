# Phase 4: filling templates

Phase 4 builds the Template Filling Design (all five of its build steps, T1–T5), with your answers to its open questions:

| Open question | Your answer, as built |
| --- | --- |
| Templates for existing pages too? | Yes. **Add to a page** with a template fills in the template’s main tab and adds it below the existing content, after a divider. The page’s sidebar is not changed. |
| The “From &lt;Source&gt;” credit | It can now be switched off: **Add a “From &lt;Source&gt;” heading** in the panel’s Source section, for any clip, with or without a template. Off means no heading and no Source. |
| Unfilled fields | **Keep unfilled template fields** in the panel. On keeps the template’s placeholder; off removes the row, field or section. |
| Child pages of templates | Ignored for now: they are not copied (`includeChildren` stays off). Nested templates such as Class Template / Subclass Template can still be chosen themselves. |
| On-device AI | Built, with OpenRouter (free models only) as the second engine. |

Everything is off until you tick **Settings → Templates → Enable template filling**. With it off, the panel works exactly as in Phase 3.

## How it works

1. **Templates.** They come from the page list LegendKeeper already sends (no extra request), and they were already kept out of search and linking in Phase 3. When you pick one, its tabs and sidebar are read once and cached by id and last-edit time, so a template you change in LegendKeeper is re-read.
2. **Slots.** The clipper lists each place in the template that takes a value:
   - **Key-value rows** (in the page, an infobox or the sidebar).
   - **Text fields**, named by their title. A field titled only “TEXT” is named by its placeholder, e.g. “Size, Creature Type, Alignment”.
   - **Headings**, with the paragraphs under them.
   - **Placeholder paragraphs and quotes**, such as “[Overview text]”.
   - **Images**.
   - Two kinds are filled automatically:
     - **Name headings**, such as “[Spell] Name”, take the page name.
     - **“From [Source]” headings** take the Source link.
3. **Candidates.** The clip, after conversion and linking, is searched for labelled values:
   - **Headings**, or a label on its own line: a section.
   - **“STR” then “8 (-1)”**: a label line followed by its value.
   - **Bold labels** (“**AC** 15 **Initiative** +2”), split at each one.
   - **“Label: value”**.
   - **Table rows**, and a header row over one data row.
   - **Images**.
   - **D&D Beyond’s plain-text labels** (“Armor Class 15 (leather armor, shield)”): found because the template uses that label, or a synonym of it.
4. **Matching.** Each field is matched strictest first:
   1. Your saved rule for that website.
   2. The exact label.
   3. A synonym.
   4. A plural or possessive form.
   5. A one-letter typo for labels of 6+ letters.
   - Two equally good values are never guessed: the field is flagged and you choose.
   - A value used in one field can’t be used in another.
   - A section loses only the parts you put somewhere else.
5. **AI** (if chosen). The clip’s unused blocks are numbered and sent with the empty fields. The model answers with block numbers, or a short value copied from the clip. Then the clipper checks the answer:
   - Malformed JSON is retried once, then label results are used.
   - Block numbers outside the clip are dropped, and each block goes in one field only.
   - Labels always win over the AI.
   - A value that isn’t in the clip, or a section answered with typed text instead of block numbers, is flagged **AI-written** and left unticked.
6. **Review.** The **Template fields** list shows each value and where it came from, with a tick box and **Change**. Fields nothing was found for are listed together. Your manual choices can be remembered per website, and **Settings → Templates → Saved rules** lists them; a rule whose field is no longer in the template is marked and skipped. The preview shows the filled page.
7. **Writing.**
   - **New page:**
     1. Create the Source if it’s new.
     2. Upload only the images that end up in the page.
     3. Create the page with `createFromTemplate`.
     4. Fill each page tab with one `replaceBlocks`, guarded by the version just read.
     5. Update sidebar properties with their own calls.
     - If filling fails after the page was made, the panel says **Page created, but filling failed** and offers **Try filling again** or **Delete the new page**. It never makes a second copy.
   - **Add to a page:** a divider, the filled main tab, then the credit and unused content, written in one guarded write like any append.
   - **The credit and unused content:**
     - They go at the end of the main tab, after a divider.
     - If the template has its own “From [Source]” heading with only placeholder text under it (your God Template), they go there instead, so the credit isn’t doubled.
     - The clip’s own name line (“Goblin”) is dropped, since it only repeats the page name.

## AI engines

- **On-device (Chrome’s built-in AI)**:
  - Gemini Nano through the Prompt API, which runs in the side panel (not in the background worker, where the API isn’t available).
  - **Settings → Set up on-device AI** checks `LanguageModel.availability()` and explains the result.
  - Its first `create()`, started by that click, downloads the model with a progress bar.
  - Sessions use temperature 0.2 and topK 3, a system prompt, and a JSON schema (`responseConstraint`) built from the fields. One session is kept while the panel is open.
  - The clip is cut to fit the model’s context window, and a prompt that is still too big is retried at half the size.
- **OpenRouter**:
  - Off until chosen, with a one-time warning that clips leave your computer. You paste your own key.
  - Only free models (ids ending in `:free`) are listed or accepted; models that support a JSON schema come first and get one.
  - A missing or busy model is retried once with the next free model.
  - A rate limit (429) or credit error (402) is explained in plain words and never retried.
  - It needs no new permission: the extension can already reach every site, to copy images.

## How it was tested

- **111 unit tests** (`npm test`), 34 of them new, run on your real templates (saved as fixtures from the AI Test Project) and the D&D Beyond Goblin stat block. They cover:
  - slot finding;
  - every candidate pattern;
  - matching, ties, your choices, saved rules and AI checks;
  - removing unfilled fields;
  - credit placement;
  - append copies;
  - the AI job and answer checks;
  - the OpenRouter engine’s free-only rule, model fallback and rate-limit handling.
- **Live, against your project** (`npm run phase4:templates`). Four pages under **LK Web Clipper Sandbox / Phase 4 templates …**:
  - **Goblin → Statblock Template, labels only, unfilled fields removed.** Labels filled 15 of 22 fields: AC through the synonym “Armor Class”, STR→Strength, Challenge→Challenge Rating, and Traits and Actions as sections. The empty Bonus Actions, Legendary Actions and Description fields were removed. The template’s tags (Creature, Statblock) were copied.
  - **Goblin → Statblock Template, labels then AI (OpenRouter, free model, about 20 s).** The AI put “Small Humanoid (Goblinoid), Neutral Evil” in the “Size, Creature Type, Alignment” field and left fields the clip doesn’t answer empty.
  - **Goblin appended to an existing page with the credit off.** The existing note is untouched, then a divider and the filled infobox, with no “From” heading.
  - **Wikipedia’s Tiamat article → God Template, labels then AI.** Portfolio came from the article’s infobox, the portrait went into the sidebar image, and the AI chose the quote and overview paragraphs. The template’s own “From [Source]” heading now links the Wikipedia Source, with the rest of the article under it in place of “[Source text]”.
- **End to end in Chromium** (`npm run e2e`), through the real panel:
  1. Turn on templates and on-device AI in Settings.
  2. Clip the Goblin into the Statblock Template with “Labels then AI”.
  3. Check the AI’s field and the synonym match in the review.
  4. Move “Shortbow” into Legendary Actions by hand and remember it.
  5. Create the page, then add the same clip to an existing page with the credit off.
  6. Check the page in LegendKeeper and the saved rule in Settings.
  - **This Chromium has no built-in model,** so the test gives the panel a stand-in with the Prompt API’s shape. It checks the panel’s on-device wiring, not Gemini Nano itself.

## Things to know

- **Not yet tested on Gemini Nano itself.** The cloud machine has no Chrome built-in model, so speed and answer quality on your computer are not measured yet. Please try **Set up on-device AI** and a few clips. If it’s slow or picks badly, the design’s plan was to time ten clips before suggesting “Labels then AI” by default.
- **Free OpenRouter models are slow** (20–120 s in testing) and limited (20 a minute, 50 a day without credit). Label results are always shown while the AI works, and are used if it fails.
- **Labels must be right.** Your Statblock Template already says “Legendary Actions” (the design’s note about “Legendary Resistances” is fixed). If a template’s label differs from the website’s, add a synonym line in Settings or pick the value once and tick **Remember**.
- **Sidebar fields on existing pages** are never changed. Only the main tab is added.
- **Links inside values** are kept, so a stat block’s “Darkvision” or “Stealth” still link to your glossary pages inside the infobox.
- **Unchanged from the design:** the panel remembers the last template per Source (or per website before it has a Source), and the Template choice starts at “None (clip as usual)”.

## Also changed

- **Wikipedia “[edit]” links** are removed before Readability runs, so they no longer appear as text after each heading.
- **SVG images with no description** (D&D Beyond’s stat block dividers) are treated as decoration and left out, since LegendKeeper can’t take SVG uploads anyway.
- **The preview** now draws infoboxes, key-value rows, text fields and layouts.

## Next

Phase 5 is the old Phase 4: complex tables, rules for the sites you clip most, and Source deduplication. Phase 6 is reliability.
