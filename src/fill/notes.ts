import { compareLabels, type Synonyms } from './labels.js'
import type { Slot } from './template.js'

/**
 * Notes for the AI about a template: what its fields mean and how you want them written. They are
 * given to the AI in "Labels then AI writes", the mode where it may write short values rather
 * than only copy them. Your notes are kept in the extension per template name, and a built-in
 * pack is used for a template that has none and fits it.
 */

export interface TemplateNotes {
  /** The template's name, matched without regard to case. */
  templateName: string
  text: string
}

export interface NotesPack {
  name: string
  text: string
  /** Whether the pack suits a template, judged by its fields and, failing that, its name. */
  fits(slots: Slot[], synonyms: Synonyms, templateName?: string): boolean
}

/** How many of these field names the template has. */
function countFields(slots: Slot[], synonyms: Synonyms, keys: string[]): number {
  return keys.filter((key) => slots.some((slot) => compareLabels(key, slot.key, synonyms) !== undefined)).length
}

const lines = (...text: string[]) => text.join('\n')

const STATBLOCK_FIELDS = ['armour class', 'hit points', 'speed', 'strength', 'dexterity', 'constitution', 'challenge rating']

export const DND5E_STATBLOCK: NotesPack = {
  name: 'D&D 5e stat block',
  text: lines(
    'A Dungeons & Dragons 5th edition creature stat block (2014 or 2024 rules), usually from D&D Beyond or a wiki. The examples show the format only; take every value from the clip.',
    '- Armour Class: the number, then any armour in brackets, e.g. "15 (studded leather)". 2024 stat blocks write "AC 15".',
    '- Initiative: the Dexterity modifier, then 10 plus it in brackets, e.g. "+3 (13)". 2024 stat blocks state it; for older ones it is worked out from Dexterity.',
    '- Hit Points: the average, then the dice in brackets, e.g. "78 (12d8 + 24)". 2024 stat blocks write "HP".',
    '- Speed: every speed, walking first, e.g. "30 ft., Climb 30 ft., Fly 60 ft. (hover)".',
    '- Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma: the score, then the modifier in brackets, e.g. "16 (+3)". Clips often give them as a table or a row ("STR 16 (+3)"); a 2024 table also gives a saving throw, which does not belong here.',
    '- Skills: each skill with its bonus, e.g. "Perception +5, Stealth +6".',
    '- Resistances: the damage types it resists, as listed. Not vulnerabilities.',
    '- Immunities: damage immunities, then any condition immunities after "; ", e.g. "Poison; Charmed, Poisoned". Older stat blocks list them on separate "Damage Immunities" and "Condition Immunities" lines.',
    '- Senses: special senses and passive Perception, e.g. "Darkvision 60 ft., Passive Perception 9".',
    '- Languages: as listed; "—" means none.',
    '- Challenge Rating: the rating, then the experience points in brackets, e.g. "8 (3,900 XP)". 2024 stat blocks write "CR 8 (XP 3,900; PB +3)".',
    '- Proficiency Bonus: the bonus with its sign, e.g. "+3". 2024 stat blocks give it after the challenge rating as "PB +3".',
    '- Size, Creature Type, Alignment: the italic line under the name: size, type (with any tag in brackets) and alignment, e.g. "Large Dragon (Chromatic), Lawful Evil". Never the creature\'s name.',
    '- Traits: the named entries before the first action heading ("Pack Tactics. …"). 2014 stat blocks give them no heading; 2024 ones put them under "Traits".',
    '- Actions: the entries under "Actions", starting with Multiattack when there is one.',
    '- Bonus Actions, Legendary Actions: only the entries under that heading (for Legendary Actions, with its opening paragraph). Leave them empty when the stat block has none.',
    '- Description: lore outside the stat block (habitat, behaviour, society, history), not game statistics.',
    '- Saving Throws, Vulnerabilities, Reactions, Lair Actions and Regional Effects belong in no field unless the template has one for them.',
  ),
  fits: (slots, synonyms) => countFields(slots, synonyms, STATBLOCK_FIELDS) >= 3,
}

export const DND5E_SPELL: NotesPack = {
  name: 'D&D 5e spell',
  text: lines(
    'A Dungeons & Dragons 5th edition spell, usually from D&D Beyond, a wiki or a rulebook. The examples show the format only; take every value from the clip.',
    '- Level: the spell level as an ordinal, or "Cantrip", e.g. "3rd". Clips write "Level 3rd", "3rd-level evocation" or (2024) "Level 3 Evocation".',
    '- School: the school of magic alone, e.g. "Evocation". Not the level, and not the classes.',
    '- Casting Time: e.g. "1 action", "1 bonus action", "1 minute", or a reaction with its trigger ("1 reaction, which you take when …"). Add "(ritual)" only when the clip says it is a ritual.',
    '- Range/Area: the range, then any area in brackets, e.g. "150 ft. (20 ft. Sphere)", "Self (15 ft. Cone)", "Touch". D&D Beyond shows the area shape as an icon; use the word if the clip has it.',
    '- Components: the letters, then any material component in brackets, e.g. "V, S, M (a tiny ball of bat guano and sulfur)". D&D Beyond puts the material after an asterisk at the end of the description; it belongs here, not in the Description.',
    '- Duration: e.g. "Instantaneous", "1 hour", "Concentration, up to 1 minute".',
    '- Description: the spell\'s full rules text, including "At Higher Levels" or "Using a Higher-Level Spell Slot" and any cantrip upgrade. Not the header line, the tags, the list of classes or the material footnote.',
    '- Spell tags, the classes that can cast it ("Available For") and the source book belong in no field unless the template has one.',
  ),
  fits: (slots, synonyms, name) => countFields(slots, synonyms, ['casting time', 'range', 'components', 'duration', 'school']) >= 3 || /\bspell\b/i.test(name ?? ''),
}

export const DND5E_MAGIC_ITEM: NotesPack = {
  name: 'D&D 5e magic item',
  text: lines(
    'A Dungeons & Dragons 5th edition magic item, usually from D&D Beyond, a wiki or a rulebook. Clips start with a line like "Wondrous item, rare (requires attunement by a wizard)" or "Weapon (longsword), very rare". The examples show the format only; take every value from the clip.',
    '- Type: the item category from that line, with any base item in brackets, e.g. "Wondrous Item", "Weapon (Longsword)", "Armor (Plate)", "Ring", "Potion", "Staff", "Wand", "Rod", "Scroll". Not the rarity.',
    '- Rarity: one of Common, Uncommon, Rare, Very Rare, Legendary, Artifact or Varies, as the clip gives it.',
    '- Attunement: what the clip says about attunement, e.g. "Requires attunement by a wizard", or "Requires attunement". Leave it empty when the clip does not mention attunement.',
    '- Description: the item\'s rules and lore text (its properties, charges, curses, tables). Not the type and rarity line, the tags or the price.',
    '- Source: the book and page the item comes from, as the clip gives it, e.g. "Dungeon Master\'s Guide, pg. 150". Not the website.',
    '- Tags, cost, weight and "Notes" lines belong in no field unless the template has one.',
  ),
  fits: (slots, synonyms, name) => countFields(slots, synonyms, ['rarity', 'attunement']) >= 2 || /magic item/i.test(name ?? ''),
}

export const DND5E_CLASS: NotesPack = {
  name: 'D&D 5e class',
  text: lines(
    'A Dungeons & Dragons 5th edition character class (2024 rules), usually clipped from D&D Beyond or a wiki. Their headings put the class\'s name where the template has a general word or [Class]: "Bard Class Details" is Class Details, "As a Level 1 Bard" is As a Level 1 Character. The examples show the format only; take every value from the clip.',
    '- Primary Ability, Hit Point Die, Saving Throw Proficiencies, Skill Proficiencies, Weapon Proficiencies, Armour Training, Starting Equipment: rows of the clip\'s "Core <class> Traits" table. Copy each value as written, e.g. "D8 per Bard level", "Choose any 3 skills", "Choose A or B: (A) … or (B) 90 GP". The clip says "Armor Training"; 2014 clips say "Hit Dice", "Saving Throws" and "Armor".',
    '- Class Details: only the introduction paragraphs after the traits table, saying what the class is like. Not the traits table, its caption or any heading.',
    '- As a Level 1 Character: only the list under "As a Level 1 <class>", without the heading.',
    '- As a Multiclass Character: only the list under "As a Multiclass <class>", without the heading.',
    '- Class Features Table: the class\'s whole level table (Level, Proficiency Bonus, Class Features and the class\'s own columns, such as spell slots). Not its caption.',
    '- [Class] Class Features: the sentence "As a <class>, you gain the following class features…", then every feature with its heading ("Level 1: Spellcasting") and paragraphs, up to the level 20 feature.',
    '- Optional class features, subclasses and spell lists belong in no field: they stay at the end of the page.',
  ),
  fits: (slots, synonyms) => countFields(slots, synonyms, ['hit point die', 'primary ability', 'saving throw proficiencies', 'skill proficiencies', 'weapon proficiencies', 'armour training', 'starting equipment']) >= 3,
}

export const DND5E_SUBCLASS: NotesPack = {
  name: 'D&D 5e subclass',
  text: lines(
    'A Dungeons & Dragons 5th edition subclass (such as a Fighter\'s Battle Master), usually from D&D Beyond or a wiki. The examples show the format only; take every value from the clip.',
    '- Descriptive Text: the short line under the subclass name that sums it up, often in italics, e.g. "Master Sophisticated Battle Techniques".',
    '- Class description: the introduction to the subclass: who follows it and how, before the first feature.',
    '- Class Feature: the first feature\'s text (its heading reads like "Level 3: Combat Superiority"). Later features stay for the end of the page.',
    '- Never use the page name, the parent class\'s description or the class\'s own features.',
  ),
  fits: (slots, synonyms, name) => /subclass/i.test(name ?? '') || countFields(slots, synonyms, ['descriptive text', 'class feature', 'class description']) >= 2,
}

export const DEITY: NotesPack = {
  name: 'Deity',
  text: lines(
    'A god or other deity, usually from a wiki (Forgotten Realms Wiki, Wikipedia) or a sourcebook. Infoboxes on wikis hold most of the short fields. The examples show the format only; take every value from the clip.',
    '- Alignment: e.g. "Lawful Evil", or as the clip gives it (2014 books abbreviate: "LE").',
    '- Portfolio: what the god rules over, e.g. "Chromatic dragons, conquest, greed".',
    '- Domain Name and Location: the god\'s realm and the plane it is on, e.g. "Azharul, Avernus". Not the cleric domains.',
    '- Allies, Foes: other deities or powers, as listed.',
    '- Pantheon: e.g. "Draconic pantheon", "Faerûnian pantheon".',
    '- Weapon: the god\'s favoured weapon, e.g. "Heavy pick".',
    '- Holy symbol description: what the symbol looks like, e.g. "A five-headed dragon".',
    '- Manifesto, Dogma, or Quote: the god\'s dogma or a short quotation about or by the god. One quotation or one dogma paragraph.',
    '- Overview: the main description of the god (appearance, personality, worship), before the history.',
    '- Image: the god\'s picture or holy symbol image.',
    '- Cleric domains, worshippers, temples and history beyond the overview belong in no field unless the template has one.',
  ),
  fits: (slots, synonyms, name) => countFields(slots, synonyms, ['portfolio', 'pantheon', 'holy symbol', 'dogma', 'domain']) >= 2 || /\b(god|deity)\b/i.test(name ?? ''),
}

export const LARGE_LOCATION: NotesPack = {
  name: 'Realm or region',
  text: lines(
    'A country, kingdom, city or region in a fantasy setting, usually from a wiki or a gazetteer. Wiki infoboxes hold most of the short fields. The examples show the format only; take every value from the clip.',
    '- Government: the kind of rule, e.g. "Monarchy", "Theocracy", "Council of nobles".',
    '- Capital: the capital\'s name.',
    '- Major Towns, Provinces: names, separated by commas, with any population in brackets as the clip gives it.',
    '- Resources: what the land produces or trades, e.g. "Timber, iron, wheat".',
    '- Coinage: the coins, e.g. "Gold crown, silver noble, copper common".',
    '- Population: the number, with any breakdown by people in brackets, e.g. "61,000 (human 79%, halfling 9%)".',
    '- Languages, Religions: as listed, separated by commas.',
    '- Allies, Enemies: other realms or groups, as listed.',
    '- Alignment: the realm\'s usual alignment, e.g. "Lawful Good", "LN".',
    '- Ruler: title, name, people, class and level, e.g. "King; Belvor IV, human, Fighter 12". Keep what the clip gives.',
    '- Overview: what the place is like now (geography, people, culture), before the history.',
    '- History: past events, in the order the clip gives them.',
  ),
  fits: (slots, synonyms) => countFields(slots, synonyms, ['government', 'capital', 'population', 'ruler', 'provinces', 'coinage', 'religions', 'major towns']) >= 3,
}

export const LOCATION: NotesPack = {
  name: 'Place',
  text: lines(
    'A place in a fantasy setting (a building, dungeon, site, landmark or small settlement), usually from a wiki, an adventure or a gazetteer. Take every value from the clip.',
    '- Overview: what the place is and is like now: where it is, what it looks like, who lives or works there, what can be found there. Usually the opening paragraphs.',
    '- History: past events, under a heading like "History" or "Background" in the clip. Leave it empty when the clip has no history.',
    '- Room-by-room keys, encounter details, statistics and adventure hooks belong in no field unless the template has one.',
  ),
  fits: (slots, synonyms, name) => /location|place|site/i.test(name ?? '') || (countFields(slots, synonyms, ['overview', 'history']) >= 2 && slots.filter((s) => s.kind === 'text').length === 0),
}

export const CHARACTER: NotesPack = {
  name: 'Character',
  text: lines(
    'A person in a fantasy setting (a non-player character), usually from a wiki, an adventure or a sourcebook. Wiki infoboxes hold most of the short fields. Take every value from the clip.',
    '- Species: the character\'s people, e.g. "Half-elf", "Human (Tethyrian)". Older clips call it "Race".',
    '- Gender, Age: as the clip gives them; Age may be a number, a description ("elderly") or a birth year.',
    '- Titles: titles and epithets, separated by commas, e.g. "Lord Protector of Waterdeep, the Blackstaff".',
    '- Professions: what the character does, e.g. "Wizard, innkeeper". Not their class levels.',
    '- Friends, Enemies: people or groups, separated by commas (wikis may say "Allies" and "Foes").',
    '- Class: game class and level, e.g. "Wizard 18" or "Fighter (Battle Master) 5".',
    '- Quote, Source: one short quotation by or about the character, then who said it.',
    '- DESCRIPTION: appearance and personality.',
    '- Background: history and life story, in the order the clip gives it.',
    '- Notes: anything else worth keeping about the character, such as relationships or possessions, when the clip has a section for it. Otherwise leave it empty.',
    '- Game statistics belong in no field unless the template has one.',
  ),
  fits: (slots, synonyms, name) => countFields(slots, synonyms, ['species', 'gender', 'age', 'titles', 'professions', 'friends', 'enemies']) >= 3 || /\b(character|npc|person)\b/i.test(name ?? ''),
}

/** Most specific first: the first that fits a template is used. */
export const BUILT_IN_PACKS: NotesPack[] = [DND5E_STATBLOCK, DND5E_SPELL, DND5E_MAGIC_ITEM, DND5E_SUBCLASS, DND5E_CLASS, DEITY, LARGE_LOCATION, CHARACTER, LOCATION]

export interface ChosenNotes {
  text: string
  /** "yours", or the built-in pack's name. */
  from: string
}

export function savedNotes(saved: TemplateNotes[], templateName: string): TemplateNotes | undefined {
  const name = templateName.trim().toLowerCase()
  return saved.find((n) => n.templateName.trim().toLowerCase() === name)
}

export function builtInPackFor(slots: Slot[], synonyms: Synonyms, templateName?: string): NotesPack | undefined {
  return BUILT_IN_PACKS.find((pack) => pack.fits(slots, synonyms, templateName))
}

/** Your notes for the template, or else the built-in pack that fits it. */
export function notesFor(templateName: string, slots: Slot[], saved: TemplateNotes[], synonyms: Synonyms): ChosenNotes | undefined {
  const yours = savedNotes(saved, templateName)
  if (yours?.text.trim()) return { text: yours.text.trim(), from: 'yours' }
  const pack = builtInPackFor(slots, synonyms, templateName)
  return pack ? { text: pack.text, from: pack.name } : undefined
}

/** Saves (or, with empty text, removes) your notes for a template. */
export function withNotes(saved: TemplateNotes[], templateName: string, text: string): TemplateNotes[] {
  const others = saved.filter((n) => n !== savedNotes(saved, templateName))
  return text.trim() ? [...others, { templateName, text }] : others
}
