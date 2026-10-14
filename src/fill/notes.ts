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
  /** Whether the pack suits a template, judged by its fields. */
  fits(slots: Slot[], synonyms: Synonyms): boolean
}

const STATBLOCK_FIELDS = ['armour class', 'hit points', 'speed', 'strength', 'dexterity', 'constitution', 'challenge rating']

export const DND5E_STATBLOCK: NotesPack = {
  name: 'D&D 5e stat block',
  text: [
    'A Dungeons & Dragons 5th edition creature stat block. The examples below show the format only; take every value from the clip.',
    '- Armour Class: the number, then any armour in brackets, e.g. "15 (studded leather)".',
    '- Hit Points: the average, then the dice in brackets, e.g. "78 (12d8 + 24)".',
    '- Initiative: the Dexterity modifier with its sign, such as "+3". A 2024 stat block may state it as "+3 (13)"; then copy that.',
    '- Strength to Charisma: the score, then the modifier in brackets, e.g. "16 (+3)".',
    '- Size, Creature Type, Alignment: size, type (with any tag in brackets) and alignment, e.g. "Large Dragon (Chromatic), Lawful Evil". Never the creature\'s name.',
    '- Resistances, Immunities: damage types, as listed. Immunities may also list condition immunities after the damage types, separated by "; ".',
    '- Senses: the senses and passive Perception, e.g. "Darkvision 60 ft., Passive Perception 9".',
    '- Challenge Rating: the rating, then the experience points in brackets, e.g. "8 (3,900 XP)".',
    '- Traits, Actions, Bonus Actions, Legendary Actions: only the entries the stat block lists under that heading. Leave them empty when it has none.',
    '- Saving Throws and Proficiency Bonus belong in no field unless the template has one for them.',
  ].join('\n'),
  fits: (slots, synonyms) => slots.filter((slot) => STATBLOCK_FIELDS.some((key) => compareLabels(key, slot.key, synonyms) !== undefined)).length >= 3,
}

export const BUILT_IN_PACKS: NotesPack[] = [DND5E_STATBLOCK]

export interface ChosenNotes {
  text: string
  /** "yours", or the built-in pack's name. */
  from: string
}

export function savedNotes(saved: TemplateNotes[], templateName: string): TemplateNotes | undefined {
  const name = templateName.trim().toLowerCase()
  return saved.find((n) => n.templateName.trim().toLowerCase() === name)
}

export function builtInPackFor(slots: Slot[], synonyms: Synonyms): NotesPack | undefined {
  return BUILT_IN_PACKS.find((pack) => pack.fits(slots, synonyms))
}

/** Your notes for the template, or else the built-in pack that fits it. */
export function notesFor(templateName: string, slots: Slot[], saved: TemplateNotes[], synonyms: Synonyms): ChosenNotes | undefined {
  const yours = savedNotes(saved, templateName)
  if (yours?.text.trim()) return { text: yours.text.trim(), from: 'yours' }
  const pack = builtInPackFor(slots, synonyms)
  return pack ? { text: pack.text, from: pack.name } : undefined
}

/** Saves (or, with empty text, removes) your notes for a template. */
export function withNotes(saved: TemplateNotes[], templateName: string, text: string): TemplateNotes[] {
  const others = saved.filter((n) => n !== savedNotes(saved, templateName))
  return text.trim() ? [...others, { templateName, text }] : others
}
