# Phase 3: finding pages and linking clips to them

Phase 3 connects clips to the rest of your wiki. Search tolerates typos, page names written in the clip become LegendKeeper links, names that fit several pages are handed to you instead of guessed, and the page list stays current without you having to think about it.

## What changed

| Brief item | What it does now |
| --- | --- |
| Fuzzy search on names and aliases | Typos are forgiven: one for words of 4–6 letters, two for longer ones ("grayhawk" → World of Greyhawk, "iggwilf" → Iggwilv, "tiamta" → Tiamat). Words can come in any order ("dragon red" → Red Dragon). Results are ranked: exact name, name starting with the query, a word starting with it, name containing it, all words present, a close spelling, then aliases (exact before close), tags, and text matches from LegendKeeper's own search. |
| Search tags | Tags are matched, exact ones first. `#god` lists every page tagged God. |
| Paths in results | Every result shows where the page sits, e.g. `World of Greyhawk / Entities / NPCs / Iggwilv`. |
| Link unlinked mentions | Names and aliases written in the clip become mentions. The rules follow the brief: whole words only ("Dragon" never matches inside "Dragonborn" or "Dragon-kin"); the longest name wins ("Red Dragon" over "Dragon"); headings, code, existing links and mentions are left alone; names of one or two letters, or only digits, are skipped. Possessives work ("Greyhawk's" links Greyhawk and keeps the "'s"), and formatting around a link is kept. |
| Resolve existing hyperlinks | Each link's text is read ever more loosely: exact name, exact alias, either ignoring case, then without a plural or possessive ending ("Red Dragons", "Greyhawk's"). A page name beats another page's alias. |
| Detect ambiguous matches | A name that fits several pages (Natasha and Natalie share the alias "Natasha the Dark") is never guessed. It is shown at the top of **Links to your pages** with a menu of the candidate pages, and stays unlinked until you pick one. |
| Reversible | Every proposed link is listed with a checkbox before import, and the preview shows exactly what will be linked. Both passes can be turned off for a clip. |
| Refresh the index | The page list reloads in the background after 10 minutes (checked when the panel opens, every minute while it is open, and when it comes back into view). It also reloads at once when a search finds a page the list lacks. If a chosen page is deleted, the clipper says so and reloads the list. A refresh updates the form in place, so nothing you typed or chose is lost. |

## Two judgement calls (both are settings)

1. **Matching capitalisation is on by default.** I couldn't find LegendKeeper documentation on how its auto-linker treats case. Your project suggests it matches exactly: Attack Rolls carries aliases `attack roll`, `Attack Roll` and `Attack rolls`, and Short Rest has `Short Rests`. That is what you'd do for a case-sensitive linker with no plural handling. So a page named "King" links "King" but not "king", and you control other spellings with aliases, as you already do. One exception: a lowercase alias may start a sentence ("Attack roll twice." still links). Turn it off in **Settings → Linking** to match any capitalisation.
2. **Only the first mention of each page is linked by default.** In the Tiamat article, linking every mention gave 17 "Dragon" links. With the default, the first mention becomes a link and later ones stay as they were: plain text stays text, and a web link keeps its web address. Turn it off in Settings to link every mention. From a secondhand report, that seems to be what LegendKeeper's auto-linker does.

## How it was tested

- **77 unit tests** (`npm test`), 30 of them new. They cover every linking rule above with a small project that includes your real trouble cases (a shared alias, two pages named "King", lowercase and capitalised aliases, possessives and hyphenated names), plus fuzzy search ranking and stale-list detection.
- **Real pages against your project** (`npm run phase2:import`). The stat-block clip linked Adult Red Dragon, Dragon, Armor Class, Hit Points, Speed (to Movement, through an alias), Resistance, saving throw, actions, Initiative, Challenge (to Challenge Rating) and Damage, and flagged "Natasha the Dark" as ambiguous. The Tiamat article linked Dragon, Alignment, Darkness, Material, Gods, Campaign, Cover, saving throw, Actions, Dice, Dead and Arcana.
- **End to end in Chromium** (`npm run e2e`), through the real side panel:
  - pick Natasha for "Natasha the Dark";
  - untick Initiative;
  - check that the page in LegendKeeper has Natasha linked, Initiative as plain text, and other names linked;
  - reload the page list mid-form and check nothing was lost;
  - find the page to add to by searching "Adult Red Dragn actions", which has a typo.

  The new pages are under **LK Web Clipper Sandbox / Extension E2E …** and **Phase 2 import …**.

## Things to know

- **Common words.** Glossary pages with common-word names (Actions, Cover, Dead, Campaign, Material) will be linked wherever those words appear capitalised. With case matching on, mostly that means headings, which are skipped, and the start of sentences. Untick any you don't want in the links list, or rename the page or remove an alias in LegendKeeper.
- **Plurals in plain text** match only through aliases, as in LegendKeeper. Plurals and possessives in *web link* text are handled automatically, because a link is a strong hint that the text names something.
- **Large projects.** The matcher is built once per page-list version and checks each word of a clip against every name at once, so it doesn't slow down as your project grows. A full page-list reload costs one request per 100 pages.

## Next

Phase 4: complex tables, rules for the sites you clip most, and Source deduplication.
