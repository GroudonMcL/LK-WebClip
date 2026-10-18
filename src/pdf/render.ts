import type { ReflowBlock, ReflowResult, Run } from './reflow.js'
import type { PageContent } from './types.js'

export interface RenderOptions {
  title: string
  /** The URL of an extracted image, or undefined to leave it out. */
  imageSrc: (page: number, id: string) => string | undefined
  /** The URL of a page's rendering for the left-hand pane. Without it only the text is shown. */
  pageImage?: (page: number) => string | undefined
}

/** Reflowed blocks as HTML: the right-hand pane, and what a selection is clipped from. */
export function blocksToHtml(blocks: ReflowBlock[], imageSrc: RenderOptions['imageSrc']): string {
  const out: string[] = []
  let page = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.page !== page) {
      page = b.page
      out.push(`<div class="page-marker" data-page="${page}">Page ${page}</div>`)
    }
    if (b.type === 'paragraph' && b.list) {
      const items: string[] = []
      while (blocks[i]?.type === 'paragraph' && (blocks[i] as { list?: boolean }).list) {
        const item = blocks[i] as Extract<ReflowBlock, { type: 'paragraph' }>
        items.push(`<li${attrs(item)}>${runsHtml(item.runs)}</li>`)
        i++
      }
      i--
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    out.push(blockHtml(b, imageSrc))
  }
  return out.join('\n')
}

function blockHtml(b: ReflowBlock, imageSrc: RenderOptions['imageSrc']): string {
  switch (b.type) {
    case 'heading': return `<h${b.level}${attrs(b)}>${esc(b.text)}</h${b.level}>`
    case 'paragraph': {
      const p = `<p${attrs(b)}>${runsHtml(b.runs)}</p>`
      return b.boxed ? `<blockquote>${p}</blockquote>` : p
    }
    case 'table': {
      const rows = b.rows.map((row, r) => {
        const tag = r === 0 && b.header ? 'th' : 'td'
        return `<tr>${row.map((cell) => `<${tag}>${runsHtml(cell)}</${tag}>`).join('')}</tr>`
      })
      return `<table${attrs(b)}>${rows.join('')}</table>`
    }
    case 'image': {
      const src = imageSrc(b.page, b.id)
      return src ? `<figure${attrs(b)}><img src="${esc(src)}" alt="" width="${b.width}" height="${b.height}"></figure>` : ''
    }
    case 'statblock': {
      const inner = blocksToHtml(b.blocks, imageSrc).replace(/<div class="page-marker"[^>]*>.*?<\/div>\n?/g, '')
      return `<section class="statblock"${attrs(b)}><button type="button" class="clip-statblock" title="Select this stat block">Select stat block</button>${inner}</section>`
    }
  }
}

function attrs(b: ReflowBlock): string {
  const boxes = b.boxes.map((x) => [x.page, x.x0, x.y0, x.x1, x.y1].map((n) => Math.round(n * 10) / 10))
  return ` data-boxes="${esc(JSON.stringify(boxes))}"`
}

function runsHtml(runs: Run[]): string {
  return runs.map((r) => {
    let html = esc(r.text)
    if (r.italic) html = `<em>${html}</em>`
    if (r.bold) html = `<strong>${html}</strong>`
    return html
  }).join('')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A standalone side-by-side page: original pages left, reflowed text right, kept in step. */
export function renderReader(result: ReflowResult, pages: PageContent[], options: RenderOptions): string {
  const left = options.pageImage
    ? pages.map((p) => {
        const src = options.pageImage?.(p.number)
        return src ? `<div class="page" data-page="${p.number}" data-w="${p.width}" data-h="${p.height}" style="aspect-ratio:${p.width}/${p.height}"><img src="${esc(src)}" alt="Page ${p.number}"></div>` : ''
      }).join('\n')
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(options.title)}</title>
<style>
:root{--bg:#f6f3ee;--fg:#1d1b18;--muted:#6b645a;--panel:#fff;--line:#ddd5c8;--accent:#8a2a1e;--hl:rgba(255,196,0,.35)}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--fg:#ece7df;--muted:#a39b8f;--panel:#24221f;--line:#3a362f;--accent:#e08a74;--hl:rgba(255,196,0,.3)}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px/1.55 Georgia,serif}
main{display:grid;grid-template-columns:${left ? '1fr 1fr' : '1fr'};height:100vh}
.pane{overflow:auto;padding:16px}
#pages{border-right:1px solid var(--line)}
.page{position:relative;margin:0 auto 16px;max-width:760px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.page img{display:block;width:100%;height:100%}
.hl{position:absolute;background:var(--hl);outline:1px solid #e0a800;pointer-events:none}
#text{max-width:760px}
#text>*{max-width:68ch}
.page-marker{font:600 12px/1 system-ui,sans-serif;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-top:1px solid var(--line);padding-top:8px;margin:28px 0 8px}
h1,h2,h3,h4{font-family:system-ui,sans-serif;color:var(--accent);line-height:1.25;margin:1.2em 0 .4em}
h1{font-size:1.9em}h2{font-size:1.45em}h3{font-size:1.2em}h4{font-size:1.05em}
blockquote{margin:1em 0;padding:.6em 1em;background:color-mix(in srgb,var(--accent) 10%,var(--panel));border-left:3px solid var(--accent)}
blockquote p{margin:0}
table{border-collapse:collapse;margin:1em 0;font:13px/1.4 system-ui,sans-serif}
td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--panel)}
figure{margin:1em 0}figure img{max-width:100%;height:auto;background:#fff;border-radius:4px}
.statblock{position:relative;border:2px solid var(--accent);border-radius:6px;padding:4px 14px 8px;margin:1.2em 0;background:var(--panel)}
.statblock p{margin:.35em 0}
.clip-statblock{position:absolute;top:8px;right:8px;font:600 12px system-ui,sans-serif;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:4px;padding:4px 8px;cursor:pointer}
[data-boxes]:hover{background:color-mix(in srgb,var(--hl) 50%,transparent)}
@media (max-width:800px){main{grid-template-columns:1fr}#pages{display:none}}
</style></head><body>
<main>${left ? `<div id="pages" class="pane">${left}</div>` : ''}<div id="text" class="pane">${blocksToHtml(result.blocks, options.imageSrc)}</div></main>
<script>
const pagesPane=document.getElementById('pages'),textPane=document.getElementById('text');
function pageEl(n){return pagesPane&&pagesPane.querySelector('.page[data-page="'+n+'"]')}
function clearHl(){pagesPane&&pagesPane.querySelectorAll('.hl').forEach(e=>e.remove())}
function highlight(el,scroll){clearHl();if(!pagesPane)return;let first=null;
 for(const [p,x0,y0,x1,y1] of JSON.parse(el.dataset.boxes)){const pg=pageEl(p);if(!pg)continue;const w=+pg.dataset.w,h=+pg.dataset.h;
  const d=document.createElement('div');d.className='hl';Object.assign(d.style,{left:(x0/w*100)+'%',top:(y0/h*100)+'%',width:((x1-x0)/w*100)+'%',height:((y1-y0)/h*100)+'%'});pg.appendChild(d);first=first||d}
 if(scroll&&first)first.scrollIntoView({block:'center',behavior:'smooth'})}
textPane.addEventListener('mouseover',e=>{const el=e.target.closest('[data-boxes]');if(el&&!el.classList.contains('statblock'))highlight(el,false)});
textPane.addEventListener('click',e=>{const b=e.target.closest('.clip-statblock');if(b){const r=document.createRange();r.selectNodeContents(b.parentElement);r.setStartAfter(b);const s=getSelection();s.removeAllRanges();s.addRange(r);return}
 const el=e.target.closest('[data-boxes]');if(el)highlight(el,true)});
let syncing=0;textPane.addEventListener('scroll',()=>{if(!pagesPane||syncing)return;const top=textPane.getBoundingClientRect().top;
 const el=[...textPane.querySelectorAll('[data-boxes]')].find(e=>e.getBoundingClientRect().bottom>top+40);if(!el)return;
 const [p,,y0]=JSON.parse(el.dataset.boxes)[0];const pg=pageEl(p);if(!pg)return;const target=pg.offsetTop+y0/(+pg.dataset.h)*pg.offsetHeight-60;
 if(Math.abs(pagesPane.scrollTop-target)>pagesPane.clientHeight/2){syncing=1;pagesPane.scrollTo({top:target});setTimeout(()=>syncing=0,50)}});
</script></body></html>`
}
