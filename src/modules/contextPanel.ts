import { getLocaleID } from "../utils/locale";
import { renderMarkdown } from "../utils/markdown";
import { callEmbeddings, callLLMStream, ChatMessage } from "../utils/llmClient";
import { config } from "../../package.json";

// =============================================================================
// Constants
// =============================================================================

const PANE_ID = "llm-context-panel";
const MAX_CONTEXT_LENGTH = 8000;
const FORCE_FULL_CONTEXT = true;
const FULL_CONTEXT_CHAR_LIMIT = 500000;
const CHUNK_TARGET_LENGTH = 2000;
const CHUNK_OVERLAP = 200;
const MAX_CONTEXT_CHUNKS = 4;
const EMBEDDING_BATCH_SIZE = 16;
const HYBRID_WEIGHT_BM25 = 0.5;
const HYBRID_WEIGHT_EMBEDDING = 0.5;
const MAX_HISTORY_MESSAGES = 12;
const HTML_NS = "http://www.w3.org/1999/xhtml";

const SHORTCUT_FILES = [
  { id: "summarize", label: "Summarize", file: "summarize.txt" },
  { id: "key-points", label: "Key Points", file: "key-points.txt" },
  { id: "methodology", label: "Methodology", file: "methodology.txt" },
  { id: "limitations", label: "Limitations", file: "limitations.txt" },
  { id: "future-work", label: "Future Work", file: "future-work.txt" },
] as const;

// =============================================================================
// Types
// =============================================================================

interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  streaming?: boolean;
}

// =============================================================================
// State
// =============================================================================

const chatHistory = new Map<number, Message[]>();
type PdfContext = {
  title: string;
  chunks: string[];
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
  fullLength: number;
  embeddings?: number[][];
  embeddingPromise?: Promise<number[][] | null>;
  embeddingFailed?: boolean;
};

const pdfTextCache = new Map<number, PdfContext>();
const shortcutTextCache = new Map<string, string>();

let currentRequestId = 0;
let cancelledRequestId = -1;
let currentAbortController: AbortController | null = null;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "but",
  "not",
  "you",
  "your",
  "our",
  "their",
  "its",
  "they",
  "them",
  "can",
  "could",
  "may",
  "might",
  "will",
  "would",
  "also",
  "than",
  "then",
  "into",
  "about",
  "what",
  "which",
  "when",
  "where",
  "how",
  "why",
  "who",
  "whom",
  "been",
  "being",
  "such",
  "over",
  "under",
  "between",
  "within",
  "using",
  "use",
  "used",
  "via",
  "per",
  "et",
  "al",
]);

// =============================================================================
// Utilities
// =============================================================================

/** Create an HTML element with optional class and properties */
function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  props?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  if (props) Object.assign(el, props);
  return el;
}

/** Get AbortController constructor from global scope */
function getAbortController(): new () => AbortController {
  return (
    (ztoolkit.getGlobal("AbortController") as new () => AbortController) ||
    (
      globalThis as typeof globalThis & {
        AbortController: new () => AbortController;
      }
    ).AbortController
  );
}

export function registerLLMStyles(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  if (doc.getElementById(`${config.addonRef}-styles`)) return;

  // Main styles
  const link = doc.createElement("link") as HTMLLinkElement;
  link.id = `${config.addonRef}-styles`;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(link);

  // KaTeX styles for math rendering
  const katexLink = doc.createElement("link") as HTMLLinkElement;
  katexLink.id = `${config.addonRef}-katex-styles`;
  katexLink.rel = "stylesheet";
  katexLink.type = "text/css";
  katexLink.href = `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`;
  doc.documentElement?.appendChild(katexLink);
}

export function registerReaderContextPanel() {
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: `chrome://${config.addonRef}/content/icons/neuron.jpg`,
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/neuron.jpg`,
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader" || tabType === "library");
      return true;
    },
    onRender: ({ body, item }) => {
      buildUI(body, item);
    },
    onAsyncRender: async ({ body, item }) => {
      if (item) {
        await cachePDFText(item);
      }
      await renderShortcuts(body, item);
      setupHandlers(body, item);
      refreshChat(body, item);
    },
  });
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  body.textContent = "";
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);
  const iconUrl = `chrome://${config.addonRef}/content/icons/neuron.jpg`;

  // Main container
  const container = createElement(doc, "div", "llm-panel", { id: "llm-main" });

  // Header section
  const header = createElement(doc, "div", "llm-header");
  const headerTop = createElement(doc, "div", "llm-header-top");
  const headerInfo = createElement(doc, "div", "llm-header-info");

  const headerIcon = createElement(doc, "img", "llm-header-icon", {
    alt: "LLM",
    src: iconUrl,
  });
  const title = createElement(doc, "div", "llm-title", {
    textContent: "LLM Assistant",
  });
  const subtitle = createElement(doc, "div", "llm-subtitle", {
    textContent: "Ask questions about your documents",
  });

  headerInfo.append(headerIcon, title, subtitle);
  headerTop.appendChild(headerInfo);

  const clearBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-clear",
    textContent: "Clear",
  });
  headerTop.appendChild(clearBtn);
  header.appendChild(headerTop);
  container.appendChild(header);

  // Chat display area
  const chatBox = createElement(doc, "div", "llm-messages", {
    id: "llm-chat-box",
  });
  container.appendChild(chatBox);

  // Shortcuts row
  const shortcutsRow = createElement(doc, "div", "llm-shortcuts", {
    id: "llm-shortcuts",
  });
  container.appendChild(shortcutsRow);

  // Shortcut context menu
  const shortcutMenu = createElement(doc, "div", "llm-shortcut-menu", {
    id: "llm-shortcut-menu",
  });
  shortcutMenu.style.display = "none";
  const menuEditBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-edit",
    type: "button",
    textContent: "Edit",
  });
  shortcutMenu.appendChild(menuEditBtn);
  container.appendChild(shortcutMenu);

  // Input section
  const inputSection = createElement(doc, "div", "llm-input-section");
  const inputBox = createElement(doc, "textarea", "llm-input", {
    id: "llm-input",
    placeholder: hasItem
      ? "Ask a question about this paper..."
      : "Open a PDF first",
    disabled: !hasItem,
  });
  inputSection.appendChild(inputBox);

  // Actions row
  const actionsRow = createElement(doc, "div", "llm-actions");
  const sendBtn = createElement(doc, "button", "llm-send-btn", {
    id: "llm-send",
    textContent: "Send",
    disabled: !hasItem,
  });
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-send-btn llm-cancel-btn",
    {
      id: "llm-cancel",
      textContent: "Cancel",
    },
  );
  cancelBtn.style.display = "none";

  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem ? "Ready" : "Select an item or open a PDF",
  });

  actionsRow.append(sendBtn, cancelBtn, statusLine);
  inputSection.appendChild(actionsRow);
  container.appendChild(inputSection);
  body.appendChild(container);
}

async function cachePDFText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;

  try {
    let pdfText = "";
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : item;

    const title = mainItem?.getField("title") || "";

    let pdfItem: Zotero.Item | null = null;
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      pdfItem = item;
    } else if (mainItem) {
      const attachments = mainItem.getAttachments();
      for (const attId of attachments) {
        const att = Zotero.Items.get(attId);
        if (att && att.attachmentContentType === "application/pdf") {
          pdfItem = att;
          break;
        }
      }
    }

    if (pdfItem) {
      try {
        const result = await Zotero.PDFWorker.getFullText(pdfItem.id);
        if (result && result.text) {
          pdfText = result.text;
        }
      } catch (e) {
        ztoolkit.log("PDF extraction failed:", e);
      }
    }

    if (pdfText) {
      const chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,
        embeddingFailed: false,
      });
    } else {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkStats: [],
        docFreq: {},
        avgChunkLength: 0,
        fullLength: 0,
        embeddingFailed: false,
      });
    }
  } catch (e) {
    ztoolkit.log("Error caching PDF:", e);
    pdfTextCache.set(item.id, {
      title: "",
      chunks: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      embeddingFailed: false,
    });
  }
}

type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};

function splitIntoChunks(text: string, targetLength: number): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > targetLength) {
      pushCurrent();
      let start = 0;
      while (start < p.length) {
        const end = Math.min(start + targetLength, p.length);
        const slice = p.slice(start, end).trim();
        if (slice) chunks.push(slice);
        if (end === p.length) break;
        start = Math.max(0, end - CHUNK_OVERLAP);
      }
      continue;
    }
    if (current.length + p.length + 2 <= targetLength) {
      current = current ? `${current}\n\n${p}` : p;
    } else {
      pushCurrent();
      current = p;
    }
  }
  pushCurrent();
  return chunks;
}

function tokenizeText(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function buildChunkIndex(chunks: string[]): {
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
} {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = [];
  let totalLength = 0;

  chunks.forEach((chunk, index) => {
    const tokens = tokenizeText(chunk);
    const tf: Record<string, number> = {};
    for (const term of tokens) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    const length = tokens.length;
    totalLength += length;
    chunkStats.push({ index, length, tf, uniqueTerms });
  });

  const avgChunkLength = chunks.length ? totalLength / chunks.length : 0;
  return { chunkStats, docFreq, avgChunkLength };
}

function tokenizeQuery(query: string): string[] {
  const tokens = tokenizeText(query);
  return Array.from(new Set(tokens));
}

function scoreChunkBM25(
  chunk: ChunkStat,
  terms: string[],
  docFreq: Record<string, number>,
  totalChunks: number,
  avgChunkLength: number,
): number {
  if (!terms.length || !chunk.length) return 0;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  for (const term of terms) {
    const tf = chunk.tf[term] || 0;
    if (!tf) continue;
    const df = docFreq[term] || 0;
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    const norm =
      tf *
      (k1 + 1) /
      (tf + k1 * (1 - b + (b * chunk.length) / avgChunkLength));
    score += idf * norm;
  }

  return score;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeScores(scores: number[]): number[] {
  if (!scores.length) return [];
  let min = scores[0];
  let max = scores[0];
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 0);
  return scores.map((s) => (s - min) / (max - min));
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await callEmbeddings(batch);
    all.push(...batchEmbeddings);
  }
  return all;
}

async function ensureEmbeddings(pdfContext: PdfContext): Promise<boolean> {
  if (pdfContext.embeddingFailed) return false;
  if (pdfContext.embeddings && pdfContext.embeddings.length) {
    return pdfContext.embeddings.length === pdfContext.chunks.length;
  }

  if (pdfContext.embeddingPromise) {
    const result = await pdfContext.embeddingPromise;
    if (result) {
      pdfContext.embeddings = result;
      return result.length === pdfContext.chunks.length;
    }
    return false;
  }

  pdfContext.embeddingPromise = (async () => {
    try {
      const embeddings = await embedTexts(pdfContext.chunks);
      return embeddings;
    } catch (err) {
      ztoolkit.log("Embedding generation failed:", err);
      return null;
    }
  })();

  const result = await pdfContext.embeddingPromise;
  pdfContext.embeddingPromise = undefined;
  if (result) {
    pdfContext.embeddings = result;
    return result.length === pdfContext.chunks.length;
  }
  pdfContext.embeddingFailed = true;
  return false;
}

async function buildContext(
  pdfContext: PdfContext | undefined,
  question: string,
): Promise<string> {
  if (!pdfContext) return "";
  const { title, chunks, chunkStats, docFreq, avgChunkLength, fullLength } =
    pdfContext;
  const contextParts: string[] = [];
  if (title) contextParts.push(`Title: ${title}`);
  if (!chunks.length) return contextParts.join("\n\n");
  if (FORCE_FULL_CONTEXT) {
    if (!fullLength || fullLength <= FULL_CONTEXT_CHAR_LIMIT) {
      contextParts.push("Paper Text:");
      contextParts.push(chunks.join("\n\n"));
      if (fullLength) {
        contextParts.push(`\n[Full context ${fullLength} chars]`);
      }
      return contextParts.join("\n\n");
    }
    contextParts.push(
      `\n[Full context ${fullLength} chars exceeds ${FULL_CONTEXT_CHAR_LIMIT}. Falling back to retrieval.]`,
    );
  }

  const terms = tokenizeQuery(question);
  const bm25Scores = chunkStats.map((chunk) =>
    scoreChunkBM25(
      chunk,
      terms,
      docFreq,
      chunks.length,
      avgChunkLength || 1,
    ),
  );

  let embeddingScores: number[] | null = null;
  const embeddingsReady = await ensureEmbeddings(pdfContext);
  if (embeddingsReady && pdfContext.embeddings) {
    try {
      const queryEmbedding = (await callEmbeddings([question]))[0] || [];
      if (queryEmbedding.length) {
        embeddingScores = pdfContext.embeddings.map((vec) =>
          cosineSimilarity(queryEmbedding, vec),
        );
      }
    } catch (err) {
      ztoolkit.log("Query embedding failed:", err);
    }
  }

  const bm25Norm = normalizeScores(bm25Scores);
  const embedNorm = embeddingScores
    ? normalizeScores(embeddingScores)
    : null;

  const bm25Weight = embedNorm ? HYBRID_WEIGHT_BM25 : 1;
  const embedWeight = embedNorm ? HYBRID_WEIGHT_EMBEDDING : 0;

  const scored = chunkStats.map((chunk, idx) => ({
    index: chunk.index,
    chunk: chunks[chunk.index],
    score: bm25Norm[idx] * bm25Weight + (embedNorm ? embedNorm[idx] * embedWeight : 0),
  }));

  scored.sort((a, b) => b.score - a.score);
  const picked = new Set<number>();
  const addIndex = (idx: number) => {
    if (idx < 0 || idx >= chunks.length) return;
    if (picked.size >= MAX_CONTEXT_CHUNKS) return;
    picked.add(idx);
  };

  for (const entry of scored) {
    if (picked.size >= MAX_CONTEXT_CHUNKS) break;
    if (entry.score === 0 && picked.size > 0) break;
    addIndex(entry.index);
  }

  if (picked.size === 0) {
    addIndex(0);
    addIndex(1);
  }

  if (picked.size < MAX_CONTEXT_CHUNKS) {
    const primary = Array.from(picked);
    for (const idx of primary) {
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx - 1);
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx + 1);
    }
  }

  const totalChunks = chunks.length;
  let remaining = MAX_CONTEXT_LENGTH;
  if (title) remaining -= `Title: ${title}`.length + 2;

  const excerpts: string[] = [];
  const sortedPicked = Array.from(picked).sort((a, b) => a - b);
  for (const index of sortedPicked) {
    if (index < 0 || index >= totalChunks) continue;
    const label = `Excerpt ${index + 1}/${totalChunks}`;
    const body = chunks[index];
    const block = `${label}\n${body}`;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      excerpts.push(block.slice(0, Math.max(0, remaining)));
      remaining = 0;
      break;
    }
    excerpts.push(block);
    remaining -= block.length + 2;
  }

  if (excerpts.length) {
    contextParts.push("Paper Text:");
    contextParts.push(excerpts.join("\n\n"));
  }

  if (fullLength) {
    contextParts.push(`\n[Context window from ${fullLength} chars total]`);
  }

  return contextParts.join("\n\n");
}

function setStatus(
  statusEl: HTMLElement,
  text: string,
  variant: "ready" | "sending" | "error",
) {
  statusEl.textContent = text;
  statusEl.className = `llm-status llm-status-${variant}`;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function sanitizeText(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i];
  }
  return out;
}

/** Get/set JSON preferences with error handling */
function getJsonPref(key: string): Record<string, string> {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, string>): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

const getShortcutOverrides = () => getJsonPref("shortcuts");
const setShortcutOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcuts", v);
const getShortcutLabelOverrides = () => getJsonPref("shortcutLabels");
const setShortcutLabelOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcutLabels", v);

async function loadShortcutText(file: string): Promise<string> {
  if (shortcutTextCache.has(file)) {
    return shortcutTextCache.get(file)!;
  }
  const uri = `chrome://${config.addonRef}/content/shortcuts/${file}`;
  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const res = await fetchFn(uri);
  if (!res.ok) {
    throw new Error(`Failed to load ${file}`);
  }
  const text = await res.text();
  shortcutTextCache.set(file, text);
  return text;
}

async function renderShortcuts(body: Element, item?: Zotero.Item | null) {
  const container = body.querySelector(
    "#llm-shortcuts",
  ) as HTMLDivElement | null;
  const menu = body.querySelector(
    "#llm-shortcut-menu",
  ) as HTMLDivElement | null;
  const menuEdit = body.querySelector(
    "#llm-shortcut-menu-edit",
  ) as HTMLButtonElement | null;
  if (!container) return;

  container.innerHTML = "";
  const overrides = getShortcutOverrides();
  const labelOverrides = getShortcutLabelOverrides();

  for (const shortcut of SHORTCUT_FILES) {
    let promptText = overrides[shortcut.id];
    if (!promptText) {
      try {
        promptText = (await loadShortcutText(shortcut.file)).trim();
      } catch {
        promptText = "";
      }
    }

    const labelText = labelOverrides[shortcut.id] || shortcut.label;

    const btn = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    btn.className = "llm-shortcut-btn";
    btn.type = "button";
    btn.textContent = labelText;
    btn.dataset.shortcutId = shortcut.id;
    btn.dataset.prompt = promptText || "";
    btn.dataset.label = labelText;
    btn.disabled = !item || !promptText;

    btn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !promptText) return;
      sendQuestion(body, item, btn.dataset.prompt || "");
    });

    btn.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!menu) return;
      const evt = e as MouseEvent;
      const panel = body.querySelector("#llm-main") as HTMLElement | null;
      const panelRect = panel?.getBoundingClientRect();
      if (panelRect) {
        menu.style.left = `${evt.clientX - panelRect.left}px`;
        menu.style.top = `${evt.clientY - panelRect.top}px`;
      } else {
        menu.style.left = `${evt.clientX}px`;
        menu.style.top = `${evt.clientY}px`;
      }
      menu.dataset.shortcutId = shortcut.id;
      (menu as any)._target = btn;
      menu.style.display = "block";
    });

    container.appendChild(btn);
  }

  if (menu && menuEdit) {
    if (!menu.dataset.listenerAttached) {
      menu.dataset.listenerAttached = "true";
      menuEdit.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const shortcutId = menu.dataset.shortcutId || "";
        if (!shortcutId) return;
        const target = (menu as any)._target as HTMLButtonElement | null;
        const currentPrompt = target?.dataset.prompt || "";
        const currentLabel = target?.dataset.label || "";
        const updated = await openShortcutEditDialog(
          currentLabel,
          currentPrompt,
        );
        if (!updated) {
          menu.style.display = "none";
          return;
        }
        const { label: nextLabel, prompt: nextPrompt } = updated;
        const next = nextPrompt.trim();
        const nextOverrides = getShortcutOverrides();
        nextOverrides[shortcutId] = next;
        setShortcutOverrides(nextOverrides);
        const nextLabelOverrides = getShortcutLabelOverrides();
        const labelValue = nextLabel.trim();
        if (labelValue) {
          nextLabelOverrides[shortcutId] = labelValue;
        } else {
          delete nextLabelOverrides[shortcutId];
        }
        setShortcutLabelOverrides(nextLabelOverrides);
        if (target) {
          target.dataset.prompt = next;
          target.disabled = !next;
          target.dataset.label =
            labelValue || target.dataset.label || shortcutId;
          target.textContent = labelValue || target.dataset.label || shortcutId;
        }
        menu.style.display = "none";
      });

      body.addEventListener("click", () => {
        menu.style.display = "none";
        menu.dataset.shortcutId = "";
        (menu as any)._target = null;
      });
    }
  }
}

async function openShortcutEditDialog(
  initialLabel: string,
  initialPrompt: string,
): Promise<{ label: string; prompt: string } | null> {
  const dialogData: { [key: string]: any } = {
    labelValue: initialLabel || "",
    promptValue: initialPrompt || "",
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };

  const dialog = new ztoolkit.Dialog(6, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "Edit Shortcut" },
      styles: { margin: "0 0 8px 0" },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-label-input" },
      properties: { innerHTML: "Label" },
    })
    .addCell(
      1,
      1,
      {
        tag: "input",
        namespace: "html",
        id: "llm-shortcut-label-input",
        attributes: {
          "data-bind": "labelValue",
          "data-prop": "value",
          type: "text",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addCell(2, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-prompt-input" },
      properties: { innerHTML: "Prompt" },
    })
    .addCell(
      2,
      1,
      {
        tag: "textarea",
        namespace: "html",
        id: "llm-shortcut-prompt-input",
        attributes: {
          "data-bind": "promptValue",
          "data-prop": "value",
          rows: "6",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addButton("Save", "save")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open("Edit Shortcut");

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "save") return null;

  return {
    label: dialogData.labelValue || "",
    prompt: dialogData.promptValue || "",
  };
}

function setupHandlers(body: Element, item?: Zotero.Item | null) {
  // Use querySelector on body to find elements
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const clearBtn = body.querySelector("#llm-clear") as HTMLButtonElement | null;

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  const doSend = async () => {
    if (!item) return;
    const text = inputBox.value.trim();
    if (!text) return;
    inputBox.value = "";
    await sendQuestion(body, item, text);
  };

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  // Enter key (Shift+Enter for newline)
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      doSend();
    }
  });

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentAbortController) {
        currentAbortController.abort();
      }
      cancelledRequestId = currentRequestId;
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Cancelled", "ready");
      // Re-enable UI
      if (inputBox) inputBox.disabled = false;
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      cancelBtn.style.display = "none";
    });
  }

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (item) {
        chatHistory.delete(item.id);
        refreshChat(body, item);
        const status = body.querySelector("#llm-status") as HTMLElement | null;
        if (status) setStatus(status, "Cleared", "ready");
      }
    });
  }
}

async function sendQuestion(
  body: Element,
  item: Zotero.Item,
  question: string,
) {
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;

  // Track this request
  currentRequestId++;
  const thisRequestId = currentRequestId;

  // Show cancel, hide send
  if (sendBtn) sendBtn.style.display = "none";
  if (cancelBtn) cancelBtn.style.display = "";
  if (inputBox) inputBox.disabled = true;
  if (status) {
    setStatus(status, "Thinking...", "sending");
  }

  // Add user message
  if (!chatHistory.has(item.id)) {
    chatHistory.set(item.id, []);
  }
  const history = chatHistory.get(item.id)!;
  const historyForLLM = history.slice(-MAX_HISTORY_MESSAGES);
  history.push({ role: "user", text: question, timestamp: Date.now() });
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    streaming: true,
  };
  history.push(assistantMessage);
  if (history.length > MAX_HISTORY_MESSAGES * 2) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES * 2);
  }
  refreshChat(body, item);

  try {
    const pdfContext = await buildContext(pdfTextCache.get(item.id), question);
    const llmHistory: ChatMessage[] = historyForLLM.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));

    const AbortControllerCtor = getAbortController();
    currentAbortController = AbortControllerCtor
      ? new AbortControllerCtor()
      : null;
    let refreshQueued = false;
    const queueRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(() => {
        refreshQueued = false;
        refreshChat(body, item);
      }, 50);
    };

    const answer = await callLLMStream(
      {
        prompt: question,
        context: pdfContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
      },
      (delta) => {
        assistantMessage.text += sanitizeText(delta);
        queueRefresh();
      },
    );

    if (cancelledRequestId >= thisRequestId) {
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || assistantMessage.text || "No response.";
    assistantMessage.streaming = false;
    refreshChat(body, item);

    if (status) setStatus(status, "Ready", "ready");
  } catch (err) {
    if (cancelledRequestId >= thisRequestId) {
      return;
    }

    const errMsg = (err as Error).message || "Error";
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChat(body, item);

    if (status) {
      setStatus(status, `Error: ${errMsg.slice(0, 40)}`, "error");
    }
  } finally {
    // Only restore UI if this is still the current request
    if (cancelledRequestId < thisRequestId) {
      if (inputBox) {
        inputBox.disabled = false;
        inputBox.focus();
      }
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      if (cancelBtn) cancelBtn.style.display = "none";
    }
    currentAbortController = null;
  }
}

function refreshChat(body: Element, item?: Zotero.Item | null) {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const doc = body.ownerDocument!;

  if (!item) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">📄</div>
        <div class="llm-welcome-text">Select an item or open a PDF to start.</div>
      </div>
    `;
    return;
  }

  const history = chatHistory.get(item.id) || [];

  if (history.length === 0) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">💬</div>
        <div class="llm-welcome-text">Start a conversation by asking a question or using one of the quick actions above.</div>
      </div>
    `;
    return;
  }

  chatBox.innerHTML = "";

  for (const msg of history) {
    const isUser = msg.role === "user";
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = `llm-message-wrapper ${isUser ? "user" : "assistant"}`;

    const bubble = doc.createElement("div") as HTMLDivElement;
    bubble.className = `llm-bubble ${isUser ? "user" : "assistant"}`;

    if (isUser) {
      bubble.textContent = sanitizeText(msg.text || "");
    } else {
      if (!msg.text) {
        bubble.innerHTML =
          '<div class="llm-typing"><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span></div>';
      } else {
        const safeText = sanitizeText(msg.text);
        if (msg.streaming) bubble.classList.add("streaming");
        try {
          bubble.innerHTML = renderMarkdown(safeText);
        } catch (err) {
          ztoolkit.log("LLM render error:", err);
          bubble.textContent = safeText;
        }
      }
    }

    const meta = doc.createElement("div") as HTMLDivElement;
    meta.className = "llm-message-meta";

    const time = doc.createElement("span") as HTMLSpanElement;
    time.className = "llm-message-time";
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(time);

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    chatBox.appendChild(wrapper);
  }

  // Scroll to bottom
  chatBox.scrollTop = chatBox.scrollHeight;
}

export function clearConversation(itemId: number) {
  chatHistory.delete(itemId);
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
