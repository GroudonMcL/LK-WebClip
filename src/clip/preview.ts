import type { Block, Run } from '@legendkeeper/sdk/blocks'

/**
 * Renders blocks as HTML for the side panel's preview. It shows what will be written, not what
 * the page looked like: mentions appear as LegendKeeper links, and images not yet uploaded show
 * their original URL.
 */
export function blocksToHtml(blocks: Block[], { nameOf = (id: string) => id }: { nameOf?: (resourceId: string) => string | undefined } = {}): string {
  return blocks.map((block) => blockHtml(block, nameOf)).join('')
}

function blockHtml(block: Block, nameOf: (id: string) => string | undefined): string {
  const children = () => ('children' in block && Array.isArray(block.children) ? (block.children as Block[]).map((c) => blockHtml(c, nameOf)).join('') : '')
  switch (block.kind) {
    case 'paragraph':
      return `<p>${runsHtml(block.content, nameOf) || '<br>'}</p>`
    case 'heading':
      return `<h${block.level}>${runsHtml(block.content, nameOf)}</h${block.level}>`
    case 'quote':
      return `<blockquote>${children()}</blockquote>`
    case 'code':
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`
    case 'rule':
      return '<hr>'
    case 'bulletList':
      return `<ul>${children()}</ul>`
    case 'orderedList':
      return `<ol${block.start ? ` start="${block.start}"` : ''}>${children()}</ol>`
    case 'listItem':
      return `<li>${children()}</li>`
    case 'table':
      return `<table>${children()}</table>`
    case 'tableRow':
      return `<tr>${children()}</tr>`
    case 'tableCell': {
      const tag = block.header ? 'th' : 'td'
      const span = `${block.colspan ? ` colspan="${block.colspan}"` : ''}${block.rowspan ? ` rowspan="${block.rowspan}"` : ''}`
      return `<${tag}${span}>${children()}</${tag}>`
    }
    case 'image':
      return `<figure class="lk-image"><img src="${escapeAttr(block.url)}" alt="${escapeAttr(block.alt ?? '')}" loading="lazy">${block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : ''}</figure>`
    case 'resourceCollection':
      return `<div class="lk-collection">${escapeHtml(block.title ?? 'Collection')}</div>`
    case 'infobox': {
      const rows = (block.rows as unknown as Block[]).map((row) => blockHtml(row, nameOf)).join('')
      const side = block.layout === 'wrapLeft' ? ' left' : block.layout === 'wrapRight' || !block.layout ? ' right' : ''
      return `<aside class="lk-infobox${side}">${rows}</aside>`
    }
    case 'keyValue': {
      const rows = block.rows.map((row) => `<tr><th>${escapeHtml(row.key)}</th><td>${runsHtml(row.content as Run[] | undefined, nameOf) || escapeHtml(row.text ?? '')}</td></tr>`).join('')
      return `<div class="lk-field">${titleHtml(block)}<table class="lk-kv">${rows}</table></div>`
    }
    case 'textField':
      return `<div class="lk-field">${titleHtml(block)}${children()}</div>`
    case 'layout':
      return `<div class="lk-layout">${children()}</div>`
    case 'layoutColumn':
      return `<div class="lk-column">${children()}</div>`
    case 'secret':
      return `<div class="lk-secret">${children()}</div>`
    case 'callout':
      return `<div class="lk-callout">${children()}</div>`
    case 'unsupported':
      return `<div class="lk-other">${escapeHtml((block as { title?: string }).title ?? 'LegendKeeper field')}</div>`
    default:
      return `<div class="lk-other">[${escapeHtml(block.kind)}]</div>`
  }
}

function titleHtml(block: { title?: string; isTitleHidden?: boolean }): string {
  return block.title && !block.isTitleHidden ? `<div class="lk-field-title">${escapeHtml(block.title)}</div>` : ''
}

function runsHtml(runs: Run[] | undefined, nameOf: (id: string) => string | undefined): string {
  return (runs ?? [])
    .map((run) => {
      if ('break' in run) return '<br>'
      if ('mention' in run) {
        const label = run.mention.text ?? run.mention.name ?? nameOf(run.mention.resourceId) ?? run.mention.resourceId
        return `<span class="lk-mention" title="LegendKeeper page: ${escapeAttr(nameOf(run.mention.resourceId) ?? run.mention.resourceId)}">${escapeHtml(label)}</span>`
      }
      let html = escapeHtml(run.text)
      if (run.code) html = `<code>${html}</code>`
      if (run.bold) html = `<strong>${html}</strong>`
      if (run.italic) html = `<em>${html}</em>`
      if (run.underline) html = `<u>${html}</u>`
      if (run.strike) html = `<s>${html}</s>`
      if (run.sub) html = `<sub>${html}</sub>`
      if (run.sup) html = `<sup>${html}</sup>`
      if (run.link) html = `<a href="${escapeAttr(run.link)}" target="_blank" rel="noopener noreferrer">${html}</a>`
      return html
    })
    .join('')
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
