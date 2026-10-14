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
   - **Add to a page:** a divider, the credit, the filled main tab, then the unused content, written in one guarded write like any append.
   - **The credit and unused content:**
     - The credit goes at the top of the main tab (0.5.0; it used to go at the end). The unused content goes at the end, after a divider.
     - If the template has its own “From [Source]” heading (your God and Location templates), the credit goes there instead, so it isn’t doubled; the unused content goes under it too when only placeholder text sits under it.
     - The clip’s own name line (“Goblin”) is dropped, since it only repeats the page name.

## Keeping the AI honest

Your first on-device run (D&D Beyond's Assassin into the Statblock Template) made three mistakes:

- **The name went into a field.** "Assassin" ended up above "Medium Humanoid (Any Race), Any Non-Good Alignment" in the size, type and alignment field.
- **Something went in the wrong field.** "Saving Throws DEX +6, INT +4" was put under Legendary Actions.
- **Initiative stayed empty.** The stat block doesn't state it.

Rather than patch those three, 0.4.1 changes how every AI answer is handled. The AI decides where things might go; the clip's own structure decides whether it can.

1. **More labels are recognised, so less looks like loose text.**
   - **Label classes count as bold.** Many sites mark labels with a class rather than bold (D&D Beyond's `…-label`, a wiki's `pi-data-label`). Those labels are now read as bold.
   - **The synonym list doubles as a vocabulary.** Its multi-word labels ("Saving Throws", "Proficiency Bonus") are recognised at the start of a short line, even when the template has no field for them.
   - **A label inside a list stays in its value.** "Saving Throws DEX +6, INT +4" is no longer split into DEX and INT values. This mattered live: your project's "Saving Throws" page turned the label into a link, so it was no longer bold.
2. **The model is told what the clip says.**
   - Each block is shown with its label and heading: `[18] (paragraph, labelled "Saving Throws")`, `(paragraph, under "Traits")`.
   - Template headings are marked as headings.
   - The instructions now cover labels and headings, say never to include the page name, and say that empty is a good answer.
   - **Lines that can't be right are left out.** A line labelled for something none of the asked fields could be isn't shown at all; the Assassin's AI now sees one line instead of three.
3. **Every answer is checked against the clip** before it is ticked. An answer that fails is shown unticked, with the reason, on the review screen:
   - **A labelled value goes only in a field with that label**, or a synonym of it, or one of your saved rules. "The clip labels this “Saving Throws”, not “Legendary Actions”."
   - **A template heading takes only content under a heading like it.** "In the clip this is under “Actions”…" and "The clip has no “Bonus Actions” heading for this."
   - **No field takes content from under a heading that names another field.** The paragraph under "Description" isn't the creature's type.
   - **A one-line field takes one short line.**
   - **A value that isn't in the clip is AI-written**, as before.
   - Tick any of these to use it anyway.
4. **Answers are cleaned up the way labels would have done it.**
   - **The page name is removed** from any value: as a separate block, as the first line of a paragraph, or typed into the answer.
   - **The label comes off a labelled pick.** When the AI picks "Armor Class 15 (studded leather)" for Armour Class, the field gets "15 (studded leather)". Picking a section's heading and entries gives just its entries. This only removes the label: it never adds a block the AI didn't pick.
   - **The model's two answers are cross-checked.** It can answer with block numbers and a copied value. When they disagree (block 10, the "CON" label, but the value "16 (+3)" for Dexterity), the one the clip agrees with is used.
   - **Repeated values each get their own block.** CON and INT both "10 (+0)" now fill both fields.
5. **Worked-out fields.**
   - **Settings → Templates → Worked-out fields** holds one rule per line. The default is `Initiative = Dexterity modifier`.
   - A rule fills a field only when nothing else did, or when the AI's answer for it was left unticked.
   - It is ticked, with an **Worked out** badge and where it came from ("From Dexterity: 16 (+3)").
   - `modifier` takes the signed number in "16 (+3)", or works it out from a lone score; `number` takes the first number; nothing after the field name takes the whole value.
6. **What the AI was asked and answered.** This link under the AI status line shows the full prompt and the raw answer, so a bad fill can be reported exactly.

### How this is measured

`npm run eval:ai` fills saved clips (the Goblin and the Assassin) with a free OpenRouter model, in both "Labels then AI" and "AI" modes, and scores every field against what a person would put there. A score is **right**, **missed**, **caught** (wrong, but left unticked) or **wrong** (would go into the page). Results on 13 October 2026:

| Model | Before these changes | After |
| --- | --- | --- |
| liquid/lfm-2.5-2.6b (2.6 billion parameters, close to Gemini Nano's size), two runs, 88 scored fields each | 40 wrong, 1 caught | 3 wrong, 1 caught |
| dots-3-note-preview (the default free model), one run | 0 wrong, 4 missed | not re-run |

Most of the small model's "before" errors were labels kept in values ("Armor Class 15…"), in "AI" mode.

Of the three left "after":
- **The Description paragraph in the size, type and alignment field.** The "another field's heading" rule was added for this; a replay test covers it. The model couldn't be re-run the same day because the free daily limit was used up.
- **The Goblin's type line in Description.** Nothing in the clip's structure rules this out.
- **A partial pick of Actions**, two of three entries; the third stays in the unused content.

In "Labels then AI", the mode you used, those runs had 85 of 88 fields right, 1 wrong (the Description one), 1 missed and 1 caught.

When a fill goes wrong, the clip becomes a fixture, the bad answer becomes a replay test in `test/fill.test.ts`, and the clip becomes a case in `scripts/eval-ai.ts`. Then the fix is measured across every saved clip, not just the one that failed. Gemini Nano itself still can't be run here (it only runs inside Chrome), so the small OpenRouter model stands in for it.

## Labels then AI writes (0.4.2)

The three earlier modes only let the AI *pick* parts of the clip. **Labels then AI writes** gives it more scope where that helps, with a firm limit on what it may add.

**What it may do**
- **Labels first:** label matching runs as in the other modes.
- **Short fields:** for the fields left, the AI may write a short value in the template's style. That covers one-line rows and short text fields named by their placeholder, such as "Size, Creature Type, Alignment". Writing includes rewording, reordering, combining (damage and condition immunities in one field) and working out simple values the notes explain.
- **Long sections** (Traits, Actions, Description, a placeholder for paragraphs) still take the clip's own paragraphs, so links and formatting survive.

**Notes about the template**
- **Built-in pack:** a template that fits the D&D 5e stat block pack (three or more of AC, HP, Speed, ability scores, CR) uses it automatically.
- **Your own notes:** **Settings → Templates → AI notes for templates** lists every template in the project, plus any you have notes for. It shows the built-in notes where they apply and lets you write your own for any template, new ones included. Your notes replace the built-in ones; **Remove your notes** goes back.
- **Where they're kept:** in the extension, by template name.
- **Size:** they share the model's space with the clip, so keep them short.

**Checks on what it writes.** A written value is marked **Written by AI**. It is ticked only when:
- **Every number in it is in the clip**, so "12" in Immunities is flagged.
- **Every capitalised word (a name, a type) is in the clip** or the field's own label. The notes' examples don't count: in testing, a small model copied the pack's Assassin example into a Zombie, and this rule catches that. The examples are now marked as format-only and use a creature unlikely to be clipped.
- **It doesn't shorten one of the clip's lines.** If every word comes from one line and some of that line is missing ("Medium Humanoid, Any Non-Good Alignment"), the clip's line is used instead.
- **Square brackets are dropped.** They only mark template placeholders, so "[Small] [Humanoid]…" loses them.

All the earlier checks (labels, headings, page name) still apply. On Chrome's built-in AI, each mode has its own session, and each clip is asked in a fresh copy of it, so earlier clips never colour an answer.

**Measured with `npm run eval:ai`** on three saved clips: the Goblin, the Assassin, and a fan-wiki Zombie with lowercase values and an ability table.

| Model | Labels then AI | Labels then AI writes | AI |
| --- | --- | --- | --- |
| dots-3-note-preview (default free model), one run | 65/65 right | 65/65 right | 65/65 right |
| liquid/lfm-2.5-2.6b (Nano-sized), two runs, final rules | 0 wrong, 1 caught, 1 missed of 130 | 0 wrong, 2 caught, 1 missed of 130 | not re-run |

On the small model, writing first made 3 wrong fills, then 2, before the rules above were added; each rule came from one of those mistakes. Gemini Nano itself can still only be tested in your Chrome.

## Changes in 0.5.0

**Initiative as “+1 (11)”.** Worked-out rules can now combine fields and text: the default is `Initiative = {Dexterity modifier} ({10 + Dexterity modifier})`. In braces go a field’s name and the part to take (`modifier`, `number`, or nothing for the whole value), and `10 + …` adds to it. A rule also completes a value the clip only starts: “Initiative +1” becomes “+1 (11)”, and the clip’s line still counts as used. Saved settings still holding the old default rule are updated; a rule you changed is left alone.

**The credit at the top.** See *Writing* above.

**Stat block tags.** For a template the stat block notes fit, the review screen shows **Tags to add**:
- **Where they come from:** the filled “Size, Creature Type, Alignment” line and Challenge Rating. For example “Small Fey (Goblinoid), Typically Chaotic Neutral” and “1/4 (50 XP)” give Small, Fey, Chaotic Neutral and CR 1/4.
- **What is left out:** words in brackets and “Typically”. A size pair (“Medium or Small”) gives both sizes.
- **Spelling:** words are capitalised, but a tag the project already has keeps its spelling, because LegendKeeper tags match exactly.
- **Where they go:** they are added to the template’s tags on a new page, or to the page’s tags on an append.
- **Changing them:** edit or clear them on the review screen, or turn the feature off in **Settings → Templates**.

**Links keep the clip’s words.** Pages the clipper wrote kept the clip’s wording in each link: LegendKeeper’s API stores and returns it. Your Aartuk Elder and Assassin pages, though, showed each link in the page text as the page’s name: “advantage on attack rolls” became “Advantage and Disadvantage on Attack Rolls”. Links in the infobox kept their wording (“Climb” for Climbing).

So by default the clipper now links only text written exactly as a page’s name, capitals included:
- “Attack Rolls” is linked;
- “attack roll”, “attack rolls” and the alias “Weapon Attack” stay plain text;
- a web link whose text isn’t an exact name stays a web link.

**Settings → Linking → Link only exact page names** turns this off, and brings back alias, plural and (with case matching off) any-case linking.

**Notes for every template and every AI mode.** Built-in notes now cover each template in the AI Test Project: stat block, spell, magic item, class, subclass, deity, realm (Large Location), place (Other Location) and character. Each pack:
- says what each of the template’s fields holds;
- says where that usually is in a D&D Beyond or wiki clip;
- gives its format (with examples marked as format only);
- says what belongs in no field.

A template gets the first pack its fields fit, or failing that, the one its name suggests.

The notes now go to the AI in every mode. In the picking modes, the AI is told to copy values as the clip has them.

**Suggest notes with AI.** In **Settings → Templates → AI notes for templates**, the AI drafts notes from:
- the template’s fields;
- its current notes;
- the clip open in the panel, as an example (it is told not to use that clip’s facts).

The draft goes in the box. It is saved only with **Save these notes**, and **Discard** goes back.

**Fixed: a feature heading taken for the page name.** In the Subclass Template, “Level [?]: [Feature Name]” was treated as the page-name field, so it would have been overwritten with the subclass’s name. Only a heading like “[Spell] Name”, “[Magic Item] Name” or “[Name]” now stands for the page name.

**Template fixture updated.** Your Statblock Template now has a Proficiency Bonus row, so a stat block’s proficiency bonus fills it instead of joining the unused content.

**How 0.5.0 was checked**
- **Unit tests:** 153 pass.
- **End-to-end test:** passes. It covers the credit at the top, the tags, “+2 (12)”, links that keep the clip’s words, notes in both AI modes, and a suggested-notes draft that is discarded without being saved.
- **Live template runs:** passed with the free AI model before the day’s OpenRouter limit ran out. That includes the Assassin page, whose links now keep “advantage on attack rolls” as written.
- **Not measured yet:** `npm run eval:ai` with the notes in every mode. The free daily limit was used up, so its numbers above are still from 0.4.2. Run `npm run eval:ai` and `npm run eval:ai -- --no-notes` to compare.

## Class templates (0.5.1)

You clipped D&D Beyond’s Bard into your Class Template with “Labels then AI writes”, and built **My Bard** to show the page you wanted. Comparing the two showed these problems:

- **Headings with the page’s name.** D&D Beyond names the class where your template has a general word or “[Class]”: “Bard Class Details”, “As a Level 1 Bard”, “Bard Class Features”. Labels never matched them, and the AI placed the parts badly. For example, “Becoming a Bard…” and its headings went into “As a Level 1 Character”, and the class features went into the level table’s field.
- **“[Class] Class Features” wasn’t a field.** Headings with brackets were all skipped.
- **The level table had nowhere to go.** No rule matched a table placeholder by its columns.
- **The instruction box was treated as a field.** “(For the above Tag Index tag the [Class] name…)” became a field, and the AI wrote the first line of my class notes into it.

What changed, all as general rules rather than Bard-specific ones:
- **Page name stands in.** In a clip’s heading or label, the page’s name may stand for one word of the template’s label, for a “[placeholder]”, or for nothing. So “Bard Class Details” fills Class Details, “As a Level 1 Bard” fills As a Level 1 Character, and “Bard Class Features” fills “[Class] Class Features”. Other words must match exactly.
- **Bracketed headings.** A template heading whose brackets are a single word (“[Class] Class Features”) is a field. A heading with other brackets (“Level [?]: [Feature Name]”) is still a sample. A heading with nothing under it but sub-headings (“Becoming a [Class]”) only titles them.
- **“[Class]” in headings becomes the page’s name** when the template is called “Class Template”: “Core Bard Traits”, “Becoming a Bard”, “Bard Class Features”. Paragraphs keep their brackets, so notes to the reader are unchanged.
- **Notes to the reader aren’t fields.** A text box that is mostly words with a bracket inside, rather than mostly brackets, is left alone.
- **Sections nested in a bigger section go to their own fields.** “Bard Class Details” spans everything after it, but the lists, the table and the class features go to their own fields. What’s left drops the captions of tables used elsewhere and headings whose content all went elsewhere. Only the introduction paragraphs stay in Class Details.
- **Table placeholders match by columns.** A table in the template takes the clip table sharing at least two of its column headings (and a third of them): Level, Proficiency Bonus, Class Features. Rows above the matching heading row, such as “——Spell Slots per Spell Level——”, are left out, and the table’s caption goes with it.
- **Rows the template lacks.** When a clip table fills two or more rows of a template list, its other rows are added at the end of that list (“Tool Proficiencies: Choose 3 Musical Instruments”). The review screen shows them with a tick box, and unticked rows go with the unused content.
- **Sub-headings keep their depth.** “Level 1: Bardic Inspiration” sat two levels under “Bard Class Features” in the clip, so it stays two levels under the template’s heading (a heading 4 under a heading 2).
- **AI values copied from the notes are flagged.** A written AI value that repeats five words of the template’s notes which the clip doesn’t have is left unticked: “This is from the template’s AI notes, not the clip.”
- **Better class notes.** The built-in class notes now explain the D&D Beyond layout field by field.

With labels alone, the Bard now fills every field of the Class Template, with nothing left over. That’s checked by unit tests on a saved copy of the page and live in your project (`npm run phase4:templates`). It is also a case in `npm run eval:ai`.

One deliberate difference from My Bard: “Becoming a [Class]” becomes “Becoming a Bard”, like the template’s other “[Class]” headings.

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

- **153 unit tests** (`npm test`; 140 in 0.4.2, 111 in 0.4.0), run on your real templates (saved as fixtures from the AI Test Project) and the D&D Beyond Goblin stat block. They cover:
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
