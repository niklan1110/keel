import fs from 'node:fs/promises';
import path from 'node:path';
import type { DefaultTheme } from 'vitepress';

// Writes the docs as Markdown for coding agents (https://llmstxt.org):
//   /docs/llms.txt       index of every page with a summary
//   /docs/llms-full.txt  every page in one file
//   /docs/<page>.md      each page on its own
// Links point at the .md versions, relative to the server (/docs/...).

type Section = { title: string; pages: { title: string; link: string }[] };

import { BASE as SITE_BASE, substitute } from './site';

const BASE = SITE_BASE.replace(/\/$/, '');

export function sectionsFrom(groups: { prefix: string; items: DefaultTheme.SidebarItem[] }[]): Section[] {
  const out: Section[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      const pages = (item.items || []).filter((i) => i.link).map((i) => ({ title: i.text || '', link: i.link! }));
      if (pages.length) out.push({ title: g.prefix ? `${g.prefix}: ${item.text}` : item.text || '', pages });
    }
  }
  return out;
}

const CALLOUT_TITLES: Record<string, string> = { tip: 'Tip', info: 'Note', warning: 'Warning', danger: 'Danger', details: 'Details' };

/** Turns a VitePress page into plain Markdown that reads well outside the site. */
export async function toPlainMarkdown(srcDir: string, source: string): Promise<string> {
  let md = substitute(source.replace(/^---\n[\s\S]*?\n---\n/, ''));

  // Code snippet imports: <<< @/snippets/file.txt{md}
  const imports = [...md.matchAll(/^<<< @\/(\S+?)(?:\{([^}]*)\})?\s*$/gm)];
  for (const m of imports) {
    const body = substitute(await fs.readFile(path.join(srcDir, m[1]), 'utf8')).replace(/\n+$/, '');
    const lang = (m[2] || '').trim().split(/\s+/).pop() || '';
    md = md.replace(m[0], '```' + lang + '\n' + body + '\n```');
  }

  // Card grids become link lists.
  md = md.replace(/<div class="cards">([\s\S]*?)<\/div>/g, (_all, inner: string) =>
    [...inner.matchAll(/<a class="card" href="([^"]+)"><strong>([\s\S]*?)<\/strong><span>([\s\S]*?)<\/span><\/a>/g)]
      .map((c) => `- [${c[2]}](${c[1]}): ${c[3]}`)
      .join('\n'),
  );
  md = md.replace(/^<div class="[^"]*">\s*$/gm, '').replace(/^<\/div>\s*$/gm, '');
  md = md.replace(/<code class="method (\w+)">(\w+)<\/code>/g, '$2');
  md = md.replace(/<span class="pill">([\s\S]*?)<\/span>/g, '$1');

  // Containers: ::: code-group is dropped, callouts become block quotes.
  const lines = md.split('\n');
  const out: string[] = [];
  const stack: ('group' | 'quote')[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const quoted = stack.includes('quote');
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[2].startsWith(fence)) fence = null;
      out.push(quoted ? `> ${line}` : line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[2];
      // Tab labels (```js [JavaScript]) become a line above the block.
      const label = /^\s*`{3,}\S*\s+\[([^\]]*)\]/.exec(line)?.[1];
      const cleaned = line.replace(/^(\s*`{3,}\S*)\s+\[[^\]]*\].*$/, '$1');
      if (label) out.push(quoted ? `> ${label}:` : `${label}:`, quoted ? '>' : '');
      out.push(quoted ? `> ${cleaned}` : cleaned);
      continue;
    }
    const open = /^:::\s*(\S+)\s*(.*)$/.exec(line);
    if (open) {
      if (open[1] === 'code-group') stack.push('group');
      else {
        stack.push('quote');
        out.push(`> **${open[2] || CALLOUT_TITLES[open[1]] || open[1]}**`, '>');
      }
      continue;
    }
    if (/^:::\s*$/.test(line) && stack.length) {
      stack.pop();
      continue;
    }
    out.push(quoted ? (line ? `> ${line}` : '>') : line);
  }
  md = out.join('\n');

  // Site links -> Markdown files on this server; images -> /docs/...
  md = md.replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (_all, p: string, hash = '') => {
    if (/\.(png|jpe?g|svg|webp|gif|txt)$/.test(p)) return `](${BASE}${p})`;
    return `](${BASE}${p === '/' ? '/index' : p}.md${hash})`;
  });
  return md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function summary(md: string): string {
  const body = md.replace(/^# .*\n/, '').trim();
  const para = body.split(/\n\s*\n/).find((p) => p && !/^(```|>|\||- |<|#)/.test(p)) || '';
  const text = para
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  const first = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] || text;
  return first.length > 220 ? first.slice(0, 217) + '…' : first;
}

export async function writeLlmsFiles(opts: { srcDir: string; outDir: string; sections: Section[]; intro: string }) {
  const index: string[] = [
    '# Keel',
    '',
    `> ${opts.intro}`,
    '',
    `Links are relative to the server that serves these docs. All pages in one file: [llms-full.txt](${BASE}/llms-full.txt). Instructions for coding agents: [Build with AI agents](${BASE}/guide/ai-agents.md).`,
  ];
  const full: string[] = [`# Keel documentation\n\n> ${opts.intro}\n`];
  for (const section of opts.sections) {
    index.push('', `## ${section.title}`, '');
    for (const page of section.pages) {
      const src = await fs.readFile(path.join(opts.srcDir, `${page.link}.md`), 'utf8');
      const md = await toPlainMarkdown(opts.srcDir, src);
      const file = path.join(opts.outDir, `${page.link}.md`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, md);
      index.push(`- [${page.title}](${BASE}${page.link}.md): ${summary(md)}`);
      full.push(`---\n\nSource: ${BASE}${page.link}.md\n\n${md}`);
    }
  }
  await fs.writeFile(path.join(opts.outDir, 'llms.txt'), index.join('\n') + '\n');
  await fs.writeFile(path.join(opts.outDir, 'llms-full.txt'), full.join('\n'));
}
