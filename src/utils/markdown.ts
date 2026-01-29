/**
 * Markdown to HTML renderer for chat messages
 *
 * Supports:
 * - Headers (h1-h4)
 * - Bold, italic, bold+italic
 * - Code blocks and inline code
 * - Links
 * - Ordered and unordered lists
 * - Tables
 * - Blockquotes
 * - Horizontal rules
 * - LaTeX math (via KaTeX)
 */

import katex from "katex";

// =============================================================================
// Constants
// =============================================================================

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  errorColor: "#cc0000",
  strict: false,
  trust: true,
  macros: {
    "\\R": "\\mathbb{R}",
    "\\N": "\\mathbb{N}",
    "\\Z": "\\mathbb{Z}",
  },
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

// =============================================================================
// Utilities
// =============================================================================

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (m) => HTML_ESCAPE_MAP[m]);
}

/** Render LaTeX to HTML using KaTeX */
function renderLatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    // Fallback: show the raw LaTeX in a styled span
    return `<span class="math-error" title="LaTeX error">${escapeHtml(latex)}</span>`;
  }
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Convert markdown text to HTML with LaTeX math support
 */
export function renderMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  const boldBlocks: string[] = [];
  const mathBlocks: string[] = [];

  // 1. Extract and protect code blocks first
  let source = text.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_match, lang, code) => {
      const langClass = lang ? ` class="lang-${lang}"` : "";
      const escaped = escapeHtml(code.trim());
      codeBlocks.push(`<pre${langClass}><code>${escaped}</code></pre>`);
      return `@@BLOCK${codeBlocks.length - 1}@@`;
    },
  );

  // 2. Extract and protect math expressions BEFORE any other processing
  // This prevents markdown from corrupting LaTeX (e.g., _ for subscripts being treated as italics)

  // First normalize \(...\) to $...$ and \[...\] to $$...$$
  source = source.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`);
  source = source.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$${inner}$$`);

  // Display math ($$...$$) - must come before inline math
  source = source.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math) => {
    const cleanMath = math.trim();
    // Render with KaTeX directly
    const rendered = renderLatex(cleanMath, true);
    mathBlocks.push(`<div class="math-display">${rendered}</div>`);
    return `@@MATH${mathBlocks.length - 1}@@`;
  });

  // Inline math ($...$)
  source = source.replace(/\$([^$\n]+?)\$/g, (_match, inner) => {
    const trimmed = inner.trim();
    // Skip if it looks like currency ($5, $100)
    if (!trimmed || /^\d+([.,]\d+)?$/.test(trimmed)) {
      return `$${inner}$`;
    }
    // Render with KaTeX directly
    const rendered = renderLatex(trimmed, false);
    mathBlocks.push(`<span class="math-inline">${rendered}</span>`);
    return `@@MATH${mathBlocks.length - 1}@@`;
  });

  // 3. Now apply HTML escaping (math is already protected as placeholders)
  source = escapeHtml(source);
  source = source.replace(/(@@BLOCK\d+@@)/g, "\n$1\n");

  // Inline code
  source = source.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headers (h1-h3)
  source = source.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  source = source.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  source = source.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Bold placeholders first to avoid overlapping tag mismatches
  source = source.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner) => {
    boldBlocks.push(`<strong><em>${inner}</em></strong>`);
    return `@@BOLD${boldBlocks.length - 1}@@`;
  });
  source = source.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
    boldBlocks.push(`<strong>${inner}</strong>`);
    return `@@BOLD${boldBlocks.length - 1}@@`;
  });
  source = source.replace(/__(.+?)__/g, (_m, inner) => {
    boldBlocks.push(`<strong>${inner}</strong>`);
    return `@@BOLD${boldBlocks.length - 1}@@`;
  });

  // Italic (avoid underscores inside words)
  source = source.replace(
    /(^|[\s(])\*(.+?)\*(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );
  source = source.replace(
    /(^|[\s(])_(.+?)_(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );

  // Links
  source = source.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  const lines = source.split(/\r?\n/);
  const blocks: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (/^@@BLOCK\d+@@$/.test(trimmed)) {
      blocks.push(trimmed);
      i++;
      continue;
    }

    if (/^---$/.test(trimmed)) {
      blocks.push("<hr/>");
      i++;
      continue;
    }

    if (/^<h[234]>/.test(trimmed)) {
      blocks.push(trimmed);
      i++;
      continue;
    }

    if (/^&gt; /.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("&gt; ")) {
        quoteLines.push(lines[i].trim().slice(5));
        i++;
      }
      blocks.push(`<blockquote>${quoteLines.join("<br/>")}</blockquote>`);
      continue;
    }

    const isTableRow = (value: string) =>
      value.includes("|") && !/^<h[234]>/.test(value.trim());
    const isTableDivider = (value: string) =>
      /^[\s|:-]+$/.test(value.trim()) && value.includes("-");

    if (isTableRow(trimmed) && i + 1 < lines.length) {
      const divider = lines[i + 1].trim();
      if (isTableDivider(divider)) {
        const readCells = (row: string) =>
          row
            .split("|")
            .map((cell) => cell.trim())
            .filter((cell, idx, arr) => {
              const isEdge =
                (idx === 0 || idx === arr.length - 1) && cell === "";
              return !isEdge;
            });

        const headerCells = readCells(lines[i]);
        const rows: string[] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) {
          const cells = readCells(lines[i]);
          rows.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`);
          i++;
        }

        const headerHtml = `<tr>${headerCells
          .map((c) => `<th>${c}</th>`)
          .join("")}</tr>`;
        const bodyHtml = rows.length ? `<tbody>${rows.join("")}</tbody>` : "";
        blocks.push(`<table><thead>${headerHtml}</thead>${bodyHtml}</table>`);
        continue;
      }
    }

    if (/^(\d+\.)\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed)) {
      const isOrdered = /^(\d+\.)\s+/.test(trimmed);
      const items: string[] = [];
      while (
        i < lines.length &&
        (isOrdered
          ? /^(\d+\.)\s+/.test(lines[i].trim())
          : /^[-*]\s+/.test(lines[i].trim()))
      ) {
        const itemLine = lines[i].trim().replace(/^(\d+\.)\s+|^[-*]\s+/, "");
        items.push(`<li>${itemLine}</li>`);
        i++;
      }
      const tag = isOrdered ? "ol" : "ul";
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^@@BLOCK\d+@@$/.test(lines[i].trim()) &&
      !/^---$/.test(lines[i].trim()) &&
      !/^<h[234]>/.test(lines[i].trim()) &&
      !/^&gt; /.test(lines[i].trim()) &&
      !/^(\d+\.)\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${paraLines.join("<br/>")}</p>`);
  }

  let html = blocks.join("\n");

  // Restore protected blocks in correct order
  html = html.replace(/@@BLOCK(\d+)@@/g, (_match, idx) => {
    const i = Number(idx);
    return codeBlocks[i] || "";
  });
  html = html.replace(/@@BOLD(\d+)@@/g, (_match, idx) => {
    const i = Number(idx);
    return boldBlocks[i] || "";
  });
  // Restore math blocks last (they were extracted first, so restore last)
  html = html.replace(/@@MATH(\d+)@@/g, (_match, idx) => {
    const i = Number(idx);
    return mathBlocks[i] || "";
  });

  return html;
}
