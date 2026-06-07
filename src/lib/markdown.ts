import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

const renderer = new Renderer();

renderer.code = function(token) {
  const t = typeof token === 'string' ? token : (token as { text: string }).text;
  const l = typeof token === 'string' ? undefined : (token as { lang?: string }).lang;
  const language = l && hljs.getLanguage(l) ? l : 'plaintext';
  const highlighted = hljs.highlight(t, { language }).value;
  return `<pre class="hljs"><code class="language-${language}">${highlighted}</code></pre>`;
};

marked.use({ renderer, gfm: true, breaks: false });

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
