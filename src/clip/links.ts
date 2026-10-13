import type { Block, Run } from '@legendkeeper/sdk/blocks'
import { normalizeName, type IndexedResource, type ProjectIndex } from '../lk/projectIndex.js'
import { mapBlocks } from './htmlToBlocks.js'

export interface LinkConversion {
  text: string
  href: string
  resource: IndexedResource
}

export interface AmbiguousLink {
  text: string
  href: string
  candidates: IndexedResource[]
}

export interface LinkResolution {
  blocks: Block[]
  converted: LinkConversion[]
  ambiguous: AmbiguousLink[]
}

/**
 * Turns hyperlinks whose text names exactly one page of the project into genuine LegendKeeper
 * mentions. Text that names several pages (a shared name or alias) keeps its original link and
 * is reported, so the user can see it instead of a wrong guess. Links whose text names no page
 * stay external links.
 *
 * Phase 3 extends this with fuzzy matching and links for unlinked mentions in plain text.
 */
export function resolveLinks(blocks: Block[], index: ProjectIndex, { exclude = new Set<string>() }: { exclude?: Set<string> } = {}): LinkResolution {
  const converted: LinkConversion[] = []
  const ambiguous: AmbiguousLink[] = []

  const resolved = mapBlocks(blocks, (block) => {
    if (block.kind === 'code' || !('content' in block) || !Array.isArray(block.content)) return block
    return { ...block, content: resolveRuns(block.content as Run[]) } as Block
  })

  function resolveRuns(runs: Run[]): Run[] {
    const out: Run[] = []
    for (let i = 0; i < runs.length; ) {
      const run = runs[i]!
      if (!('text' in run) || !run.link) {
        out.push(run)
        i++
        continue
      }
      // One link can span several runs ("<a><b>Red</b> Dragon</a>"); match on the whole label.
      let j = i
      let text = ''
      while (j < runs.length) {
        const next = runs[j]!
        if (!('text' in next) || next.link !== run.link) break
        text += next.text
        j++
      }
      const label = text.trim()
      const candidates = label ? index.findByName(label).filter((resource) => !exclude.has(resource.id)) : []
      if (candidates.length === 1) {
        const resource = candidates[0]!
        converted.push({ text: label, href: run.link, resource })
        if (text.startsWith(' ')) out.push({ text: ' ' })
        out.push({ mention: { resourceId: resource.id, ...(label !== resource.name ? { text: label } : {}) } })
        if (text.endsWith(' ') && label) out.push({ text: ' ' })
      } else {
        if (candidates.length > 1) ambiguous.push({ text: label, href: run.link, candidates })
        out.push(...runs.slice(i, j))
      }
      i = j
    }
    return out
  }

  return { blocks: resolved, converted, ambiguous }
}

/** For the preview: how a converted link's label relates to the page it now points at. */
export function describeConversion(conversion: LinkConversion): string {
  return normalizeName(conversion.text) === normalizeName(conversion.resource.name)
    ? conversion.resource.name
    : `${conversion.text} → ${conversion.resource.name}`
}
