import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

test("Agent Markdown renders headings, lists, inline code, and fenced code", () => {
  const html = renderMarkdown("# Plan\n\n1. Ejecuta `npm test`\n2. Publica\n\n```js\nconst ok = true;\n```");

  assert.match(html, /<h1>Plan<\/h1>/);
  assert.match(html, /<ol><li>Ejecuta <code>npm test<\/code><\/li><li>Publica<\/li><\/ol>/);
  assert.match(html, /<pre><code class="language-js">const ok = true;\n<\/code><\/pre>/);
});

test("Agent Markdown treats untrusted HTML and unsafe links as text", () => {
  const html = renderMarkdown('<script>alert("x")</script> [roto](javascript:alert(1))');

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("incomplete fenced code remains readable while the Agent streams", () => {
  const html = renderMarkdown("```ts\nconst partial = true;");

  assert.match(html, /<pre><code class="language-ts">const partial = true;<\/code><\/pre>/);
});
