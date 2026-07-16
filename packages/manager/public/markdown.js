// Safe, dependency-free Markdown subset for Agent responses.
// All source text is escaped before markup is added.
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(value) {
  try {
    const url = new URL(value, "https://pihub.invalid");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? escapeHtml(value) : null;
  } catch {
    return null;
  }
}

function renderInline(source) {
  let text = escapeHtml(source);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safe = safeHref(href.replace(/&amp;/g, "&"));
    return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return text;
}

function renderList(lines, start, ordered) {
  const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/;
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    items.push(`<li>${renderInline(match[1])}</li>`);
    index += 1;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
}

/** Render the supported Agent Markdown subset into safe HTML. */
export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```([^\s`]*)\s*$/);
    if (fence) {
      const language = fence[1].replace(/[^a-zA-Z0-9_-]/g, "");
      index += 1;
      const code = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index += 1;
      const className = language ? ` class="language-${language}"` : "";
      blocks.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}${closed && code.length ? "\n" : ""}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const list = renderList(lines, index, true);
      blocks.push(list.html);
      index = list.next;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const list = renderList(lines, index, false);
      blocks.push(list.html);
      index = list.next;
      continue;
    }
    if (line.startsWith("> ")) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push(`<blockquote><p>${renderInline(quote.join("\n"))}</p></blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s+|```|\d+\.\s+|[-*+]\s+|> )/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }

  return blocks.join("\n");
}
