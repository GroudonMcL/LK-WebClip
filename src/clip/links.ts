import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { normalizeName, type IndexedResource, type ProjectIndex } from '../lk/projectIndex.js'
import { mapBlocks } from './htmlToBlocks.js'

/**
 * Connects a clip to the rest of the wiki, in two passes over its text:
 *
 * 1. Hyperlinks. A link whose text names a page (by name, then alias, ignoring case, then without
 *    a plural or possessive ending) becomes a LegendKeeper mention of that page. Other links stay.
 * 2. Plain text. Page names and aliases written in the text become mentions. Matching works on
 *    whole words, prefers the longest name ("Red Dragon" over "Dragon"), is case-sensitive by
 *    default (the way your aliases suggest LegendKeeper's own auto-linker works), and leaves
 *    code, headings, existing links and mentions alone.
 *
 * LegendKeeper's editor shows a mention as its page's name, whatever the clip said. So by default
 * (`exactNames`) only text written exactly as a page's name is linked, and the clip's words never
 * change; aliases, plurals and other capitalisations stay as they are.
 *
 * Text that names several pages is never linked by guesswork: it is reported as ambiguous, and
 * the user can pick a page for it. Every proposed link is a "term" the user can switch off.
 */

export interface LinkOptions {
  /** Pass 1: turn hyperlinks into mentions. */
  hyperlinks: boolean
  /** Pass 2: link page names in plain text. */
  text: boolean
  /** Pass 2 matches names with their exact capitalisation (a lowercase name may still start a sentence). */
  matchCase: boolean
  /** Link only the first mention of each page in the clip; later web links to it stay web links. */
  firstOnly: boolean
  /**
   * Link only text written exactly as a page's name (same words and capitals), so the clip's
   * wording is kept: LegendKeeper shows a mention as the page's name. Off: aliases, plurals and,
   * without `matchCase`, other capitalisations are linked too.
   */
  exactNames?: boolean
  /** Pages never linked to, such as the page the clip is being added to. */
  exclude?: ReadonlySet<string>
  /** The user's decisions, by term key: a page id to link to, or null to leave the term unlinked. */
  choices?: Readonly<Record<string, string | null>>
}

export const DEFAULT_LINK_OPTIONS: LinkOptions = { hyperlinks: true, text: true, matchCase: true, firstOnly: true, exactNames: true }

export interface LinkTerm {
  /** Stable id for choices: which pass found it, and the text, normalised. */
  key: string
  pass: 'hyperlink' | 'text'
  /** The text as it first appears in the clip. */
  text: string
  /** The pages it could mean, best first. More than one means the text is ambiguous. */
  candidates: IndexedResource[]
  /** The page it was linked to, or null when it was left unlinked. */
  linkedTo: string | null
  /** How it was decided: automatically, by the user, or not at all because it is ambiguous. */
  status: 'linked' | 'chosen' | 'off' | 'ambiguous'
  /** Occurrences in the clip, and how many of them became mentions. */
  found: number
  linked: number
}

export interface LinkResult {
  blocks: Block[]
  terms: LinkTerm[]
}

export function linkClip(blocks: Block[], index: ProjectIndex, options: LinkOptions = DEFAULT_LINK_OPTIONS): LinkResult {
  const terms = new Map<string, LinkTerm>()
  const linkedPages = new Set<string>()
  const exclude = options.exclude ?? new Set<string>()
  const matcher = options.text ? PhraseMatcher.for(index, options.matchCase, options.exactNames ?? false) : undefined

  const term = (pass: LinkTerm['pass'], text: string, candidates: IndexedResource[]): LinkTerm => {
    const key = `${pass}:${normalizeName(text)}`
    let entry = terms.get(key)
    if (!entry) {
      const choice = options.choices?.[key]
      const usable = candidates.filter((c) => !exclude.has(c.id))
      let linkedTo: string | null = null
      let status: LinkTerm['status']
      if (choice === null) status = 'off'
      else if (choice !== undefined && usable.some((c) => c.id === choice)) ((linkedTo = choice), (status = 'chosen'))
      else if (usable.length === 1) ((linkedTo = usable[0]!.id), (status = 'linked'))
      else status = 'ambiguous'
      entry = { key, pass, text, candidates: usable, linkedTo, status, found: 0, linked: 0 }
      terms.set(key, entry)
    }
    entry.found++
    return entry
  }

  const linkRuns = (runs: Run[]): Run[] => {
    let out = options.hyperlinks ? resolveHyperlinks(runs, index, options, term, linkedPages) : runs
    if (matcher) out = linkPlainText(out, matcher, options, exclude, term, linkedPages)
    return out
  }

  const linked = mapBlocks(blocks, (block) => {
    if (!('content' in block) || !Array.isArray(block.content)) return block
    if (block.kind === 'heading') {
      // Headings keep their text; only explicit hyperlinks in them are resolved.
      return options.hyperlinks ? ({ ...block, content: resolveHyperlinks(block.content as Run[], index, options, term, linkedPages) } as Block) : block
    }
    return { ...block, content: linkRuns(block.content as Run[]) } as Block
  })

  // Terms whose candidates were all excluded are not worth showing.
  return { blocks: linked, terms: [...terms.values()].filter((t) => t.candidates.length > 0) }
}

// ----------------------------------------------------------------------------- pass 1: links

type TermFn = (pass: LinkTerm['pass'], text: string, candidates: IndexedResource[]) => LinkTerm

function resolveHyperlinks(runs: Run[], index: ProjectIndex, options: LinkOptions, term: TermFn, linkedPages: Set<string>): Run[] {
  const exclude = options.exclude ?? new Set<string>()
  const out: Run[] = []
  for (let i = 0; i < runs.length; ) {
    const run = runs[i]!
    if (!('text' in run) || !run.link) {
      out.push(run)
      i++
      continue
    }
    // One link can span several runs ("<a><b>Red</b> Dragon</a>"): match on the whole label.
    let j = i
    let text = ''
    while (j < runs.length) {
      const next = runs[j]!
      if (!('text' in next) || next.link !== run.link) break
      text += next.text
      j++
    }
    const label = text.trim()
    const candidates = label ? hyperlinkCandidates(label, index, options.exactNames).filter((c) => !exclude.has(c.id)) : []
    const entry = candidates.length > 0 ? term('hyperlink', label, candidates) : undefined
    // With "first mention only", a repeated link to an already-linked page keeps its web address.
    if (entry?.linkedTo && !(options.firstOnly && linkedPages.has(entry.linkedTo))) {
      entry.linked++
      linkedPages.add(entry.linkedTo)
      if (text.startsWith(' ')) out.push({ text: ' ' })
      out.push(mentionRun(entry.linkedTo, label, index))
      if (text.endsWith(' ')) out.push({ text: ' ' })
    } else {
      out.push(...runs.slice(i, j))
    }
    i = j
  }
  return out
}

/**
 * The pages a link's text could mean, trying ever looser readings and stopping at the first that
 * finds any: exact name, exact alias, either ignoring case, then without "'s" or a plural ending.
 * With `exactNames`, only the exact name.
 */
export function hyperlinkCandidates(label: string, index: ProjectIndex, exactNames = false): IndexedResource[] {
  const clean = tidy(label)
  const pages = index.pages()
  if (exactNames) return pages.filter((r) => tidy(r.name) === clean)
  const readings: ((r: IndexedResource) => boolean)[] = [
    (r) => tidy(r.name) === clean,
    (r) => r.aliases.some((a) => tidy(a) === clean),
    (r) => normalizeName(r.name) === normalizeName(clean),
    (r) => r.aliases.some((a) => normalizeName(a) === normalizeName(clean)),
  ]
  for (const reading of readings) {
    const found = pages.filter(reading)
    if (found.length > 0) return found
  }
  for (const variant of singularForms(clean)) {
    const found = index.findByName(variant)
    if (found.length > 0) return found
  }
  return []
}

/** "Greyhawk's" → Greyhawk; "Red Dragons" → Red Dragon; "Liches" → Lich; "Harpies" → Harpy. */
export function singularForms(text: string): string[] {
  const forms = new Set<string>()
  const possessive = text.replace(/['’]s?$/i, '')
  if (possessive !== text) forms.add(possessive)
  for (const base of [text, possessive]) {
    if (/ies$/i.test(base)) forms.add(base.replace(/ies$/i, 'y'))
    if (/(ch|sh|s|x|z)es$/i.test(base)) forms.add(base.replace(/es$/i, ''))
    if (/[^s'’]s$/i.test(base)) forms.add(base.replace(/s$/i, ''))
  }
  forms.delete(text)
  return [...forms].filter((f) => f.length >= 3)
}

// ------------------------------------------------------------------------- pass 2: plain text

function linkPlainText(runs: Run[], matcher: PhraseMatcher, options: LinkOptions, exclude: ReadonlySet<string>, term: TermFn, linkedPages: Set<string>): Run[] {
  const out: Run[] = []
  let segment: Extract<Run, { text: string }>[] = []
  const flush = () => {
    if (segment.length > 0) out.push(...linkSegment(segment, matcher, options, exclude, term, linkedPages))
    segment = []
  }
  for (const run of runs) {
    // Links, code, mentions and line breaks bound the stretches of plain text that get scanned.
    if ('text' in run && !run.link && !run.code) segment.push(run)
    else {
      flush()
      out.push(run)
    }
  }
  flush()
  return out
}

function linkSegment(
  runs: Extract<Run, { text: string }>[],
  matcher: PhraseMatcher,
  options: LinkOptions,
  exclude: ReadonlySet<string>,
  term: TermFn,
  linkedPages: Set<string>,
): Run[] {
  const text = runs.map((r) => r.text).join('')
  const tokens = tokenize(text)
  const matches: { start: number; end: number; resourceId: string; label: string }[] = []
  for (let i = 0; i < tokens.length; ) {
    const match = matcher.longestAt(tokens, i, text)
    if (!match) {
      i++
      continue
    }
    const start = tokens[i]!.start
    const end = tokens[match.end - 1]!.end
    const label = text.slice(start, end)
    const candidates = match.resources.filter((r) => !exclude.has(r.id))
    if (candidates.length > 0) {
      const entry = term('text', label, candidates)
      const target = entry.linkedTo
      if (target && !(options.firstOnly && linkedPages.has(target))) {
        entry.linked++
        linkedPages.add(target)
        matches.push({ start, end, resourceId: target, label })
      }
    }
    i = match.end
  }
  if (matches.length === 0) return runs

  // Rebuild the runs, cutting each one at the match boundaries and keeping its marks. A match
  // can span runs ("**Red** Dragon"); its mention is emitted once, where it starts.
  const out: Run[] = []
  let offset = 0
  let m = 0
  const emitted = new Set<number>()
  for (const run of runs) {
    const runStart = offset
    const runEnd = offset + run.text.length
    let cursor = runStart
    while (cursor < runEnd) {
      const match = matches[m]
      if (match && cursor >= match.start) {
        if (!emitted.has(m)) {
          out.push(mentionRun(match.resourceId, match.label, matcher.index))
          emitted.add(m)
        }
        if (match.end <= runEnd) {
          cursor = match.end
          m++
        } else cursor = runEnd
        continue
      }
      const stop = match ? Math.min(runEnd, match.start) : runEnd
      if (stop > cursor) out.push({ ...run, text: run.text.slice(cursor - runStart, stop - runStart) })
      cursor = stop
    }
    offset = runEnd
  }
  return out
}

function mentionRun(resourceId: string, label: string, index: ProjectIndex): Run {
  const name = index.get(resourceId)?.name
  return { mention: { resourceId, ...(label !== name ? { text: label } : {}) } }
}

// ------------------------------------------------------------------------------ the matcher

export interface Token {
  /** Comparable form: curly apostrophes straightened, and lowercased when case is ignored. */
  key: string
  start: number
  end: number
}

/** Words and single punctuation marks. "Greyhawk's" is Greyhawk + ' + s, so the name still matches. */
export function tokenize(text: string, { lower = false }: { lower?: boolean } = {}): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)) {
    const raw = match[0].normalize('NFKC').replace(/[‘’ʼ]/g, "'")
    tokens.push({ key: lower ? raw.toLowerCase() : raw, start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

interface TrieNode {
  next: Map<string, TrieNode>
  /** Pages whose name ends here, and pages whose alias ends here. Names win over aliases. */
  names: IndexedResource[]
  aliases: IndexedResource[]
}

/** A word trie of every page name and alias, for finding the longest name at each word of a text. */
export class PhraseMatcher {
  private static cache = new WeakMap<ProjectIndex, Map<string, { version: number; matcher: PhraseMatcher }>>()
  private readonly root: TrieNode = node()

  static for(index: ProjectIndex, matchCase: boolean, exactNames = false): PhraseMatcher {
    const key = `${matchCase}:${exactNames}`
    let byOption = PhraseMatcher.cache.get(index)
    if (!byOption) PhraseMatcher.cache.set(index, (byOption = new Map()))
    const cached = byOption.get(key)
    if (cached && cached.version === index.version) return cached.matcher
    const matcher = new PhraseMatcher(index, matchCase, exactNames)
    byOption.set(key, { version: index.version, matcher })
    return matcher
  }

  constructor(
    readonly index: ProjectIndex,
    private matchCase: boolean,
    /** Names only, with their exact capitals: no aliases, and no lowercase first letter. */
    private readonly exactNames = false,
  ) {
    if (exactNames) this.matchCase = true
    for (const resource of index.pages()) {
      this.add(resource.name, resource, 'names')
      if (!exactNames) for (const alias of resource.aliases) this.add(alias, resource, 'aliases')
    }
  }

  private add(phrase: string, resource: IndexedResource, kind: 'names' | 'aliases'): void {
    const tokens = tokenize(phrase, { lower: !this.matchCase })
    if (!linkable(tokens)) return
    let at = this.root
    for (const token of tokens) {
      let next = at.next.get(token.key)
      if (!next) at.next.set(token.key, (next = node()))
      at = next
    }
    if (!at[kind].includes(resource)) at[kind].push(resource)
  }

  /**
   * The longest page name or alias starting at token `i`, as the index just past it and the pages
   * it names. Tokens of a name must be separated only by spaces in the text, as in the name.
   */
  longestAt(tokens: Token[], i: number, text: string): { end: number; resources: IndexedResource[] } | undefined {
    const first = tokens[i]!
    const firstKeys = this.exactNames ? [first.key] : this.matchCase ? unique([first.key, lowerFirst(first.key)]) : [first.key.toLowerCase()]
    let best: { end: number; resources: IndexedResource[] } | undefined
    for (const firstKey of firstKeys) {
      let at = this.root.next.get(firstKey)
      let j = i + 1
      while (at) {
        const found = at.names.length > 0 ? at.names : at.aliases
        if (found.length > 0 && (!best || j > best.end)) best = { end: j, resources: found }
        const next = tokens[j]
        if (!next || !/^[ \t\u00a0]*$/.test(text.slice(tokens[j - 1]!.end, next.start))) break
        at = at.next.get(this.matchCase ? next.key : next.key.toLowerCase())
        j++
      }
    }
    if (best && (joinedBefore(tokens, i) || joinedAfter(tokens, best.end))) return undefined
    return best
  }
}

/** True when token i is glued to a word before it by a hyphen or apostrophe: "anti-Iuz", "O'Brien". */
function joinedBefore(tokens: Token[], i: number): boolean {
  const mark = tokens[i - 1]
  const word = tokens[i - 2]
  return !!mark && !!word && (mark.key === '-' || mark.key === "'") && mark.end === tokens[i]!.start && word.end === mark.start && /\p{L}/u.test(word.key)
}

/** True when the match is glued to a following word by a hyphen: "Dragon-kin". A possessive ('s) is fine. */
function joinedAfter(tokens: Token[], end: number): boolean {
  const mark = tokens[end]
  const word = tokens[end + 1]
  return !!mark && !!word && mark.key === '-' && mark.start === tokens[end - 1]!.end && word.start === mark.end && /\p{L}/u.test(word.key)
}

function node(): TrieNode {
  return { next: new Map(), names: [], aliases: [] }
}

/** Names too short or too generic to find in running text: one or two characters, or only digits and punctuation. */
function linkable(tokens: Token[]): boolean {
  if (tokens.length === 0) return false
  if (!tokens.some((t) => /\p{L}/u.test(t.key))) return false
  if (tokens.length === 1 && tokens[0]!.key.length < 3) return false
  return true
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

function tidy(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

/** For the preview: "Greyhawk → World of Greyhawk", or just the page name when they match. */
export function describeTerm(term: LinkTerm, index: ProjectIndex): string {
  const target = term.linkedTo ? index.get(term.linkedTo)?.name : undefined
  if (!target) return term.text
  return normalizeName(term.text) === normalizeName(target) ? target : `${term.text} → ${target}`
}
