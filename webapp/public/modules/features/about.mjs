import { API } from '../api-client.mjs';
import { esc } from '../core.mjs';
import { state } from '../state.mjs';
import { icon } from '../icons.mjs';
import { render } from '../nav.mjs';

/*
 * Acknowledgements.
 *
 * The item catalogue derives from the Kenshi Wiki under CC BY-SA 3.0, which
 * requires attribution wherever the derived work is used. That obligation was
 * being met by a single footer line pointing at a file in the install folder —
 * true, but a file most users will never open. This page puts the real notices
 * in the app: game-data attribution, the format-documentation provenance, the
 * MIT licence, every third-party dependency, and the trademark disclaimer.
 *
 * It renders `ACKNOWLEDGEMENTS.md` fetched from the server (routes/api/about.js)
 * rather than a copy of the text living here, because a second copy is one that
 * goes stale, and a stale attribution is a broken one. Save-independent: this
 * page reads nothing about the player's world, so it shows no save picker.
 */

/**
 * Markdown, the subset ACKNOWLEDGEMENTS.md actually uses: ATX headings, blank
 * line-separated paragraphs, `- ` lists, `> ` quotes, `[text](url)`, `<url>`
 * autolinks, `` `code` ``, `**strong**` and `*em*`.
 *
 * Written here rather than pulled in as a dependency: the codec is
 * deliberately dependency-free and `express` is the only runtime package
 * (AGENTS.md §4), and a whole CommonMark implementation to render one static
 * document is not the trade this project makes.
 *
 * **Everything is escaped BEFORE any markup is produced.** `esc()` runs on the
 * raw line first, so a `<` in the source can never open a tag; the patterns
 * below then match on already-escaped text and emit their own tags. That
 * ordering is the whole safety argument — do not "optimise" it by escaping
 * afterwards.
 */
function inline(text) {
  return esc(text)
    // `code` first: a span of code must not have its contents re-marked as
    // emphasis. The pattern excludes backticks, so it cannot swallow the rest.
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => link(href, label))
    // Autolinks. `&lt;` because the source `<` is already escaped by now.
    .replace(/&lt;(https?:\/\/[^\s>]+)&gt;/g, (m, href) => link(href, href))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/**
 * Only http(s) and only in a new tab. A relative link in the markdown (it
 * names repo paths like `webapp/LICENSE`) points at a file this server does
 * not serve, so it renders as code rather than as a link that 404s.
 */
function link(href, label) {
  if (!/^https?:\/\//.test(href)) return `<code>${esc(label)}</code>`;
  return `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
}

/**
 * Blocks are accumulated as RAW text and only run through `inline()` when the
 * block closes, never line by line. The document is hard-wrapped at 80
 * columns, so its emphasis and links routinely straddle a line break —
 * "**not affiliated with or endorsed by\nLo-Fi Games Ltd**" is one span in two
 * source lines. Marking up each line on its own showed those asterisks to the
 * user verbatim, in the trademark disclaimer of all places.
 */
function markdown(src) {
  const out = [];
  let list = null; // raw text of each <li>
  let quote = null; // raw text of each paragraph inside the <blockquote>
  let para = null; // raw lines of the open <p>

  const closeList = () => {
    if (list) out.push(`<ul class="stack">${list.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
    list = null;
  };
  const closeQuote = () => {
    if (quote) out.push(`<blockquote>${quote.filter(Boolean).map((t) => `<p>${inline(t)}</p>`).join('')}</blockquote>`);
    quote = null;
  };
  const closePara = () => { if (para) out.push(`<p>${inline(para.join(' '))}</p>`); para = null; };
  const closeAll = () => { closeList(); closeQuote(); closePara(); };

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      // The page's own <h2> is the title, so a document `#` becomes an <h3>
      // and the rest follow — the card keeps a valid heading outline.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level} class="group-label">${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*$/.test(line)) { closeAll(); continue; }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      closeQuote(); closePara();
      list = list || [];
      list.push(item[1]);
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      closeList(); closePara();
      quote = quote || [];
      // A bare `>` is a paragraph break inside the quote; anything else
      // continues the paragraph it is wrapped from.
      if (!quoted[1].trim()) { quote.push(''); continue; }
      if (!quote.length) quote.push('');
      const i = quote.length - 1;
      quote[i] = quote[i] ? `${quote[i]} ${quoted[1].trim()}` : quoted[1].trim();
      continue;
    }
    // An indented continuation line belongs to the list item above it, which
    // is what makes this document's wrapped bullets read as one item each
    // rather than a bullet followed by a paragraph.
    if (list && /^\s+/.test(raw)) {
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    closeList(); closeQuote();
    para = para || [];
    para.push(line);
  }
  closeAll();
  return out.join('');
}

/** Version, runtime and dependencies — what a bug report needs quoted. */
function buildBlock(a) {
  const deps = Object.entries(a.dependencies || {});
  return `<div class="pills">
    <span class="pill" title="Editor version"><span class="pill-key">version</span><span class="pill-val">${esc(a.version)}</span></span>
    <span class="pill" title="Node.js runtime"><span class="pill-key">node</span><span class="pill-val">${esc(a.node)}</span></span>
    ${deps.map(([name, range]) => `<span class="pill" title="Runtime dependency">
      <span class="pill-key">${esc(name)}</span><span class="pill-val">${esc(range)}</span></span>`).join('')}
  </div>`;
}

export function renderAbout() {
  const a = state.about;
  const body = !a ? '<p class="hint">Loading the notices…</p>'
    : a.error ? `<p class="hint note-warn">Could not read ACKNOWLEDGEMENTS.md: ${esc(a.error)}</p>`
      : `${buildBlock(a)}${markdown(a.markdown)}
        <p class="hint">Read from <code>${esc(a.source)}</code> — the same file the installer shows, not a copy.</p>`;

  return `<section class="panel" id="about-panel">
      <div class="panel-head"><h2>${icon('identity', 'Acknowledgements')} Acknowledgements</h2>
        <span class="muted">attribution, licences and notices</span></div>
      ${body}
    </section>`;
}

/**
 * Fetched on first view rather than at boot: it is one static document nobody
 * needs until they open this tab, and boot() is already the app's slowest
 * moment. Cached on `state.about` afterwards, so switching back is instant.
 */
let loading = false;

export function wireAbout() {
  if (!document.getElementById('about-panel')) return;
  // `loading` as well as the cache check: the render() the response triggers
  // re-runs this, and so does any other re-render while the request is still
  // in flight — neither should fire a second fetch for one static document.
  if (state.about || loading) return;
  loading = true;
  API.about()
    .then((data) => { state.about = data; })
    .catch((err) => { state.about = { error: err.message || 'request failed' }; })
    .finally(() => { loading = false; render(); });
}
