import { getLocaleID, getString } from "../utils/locale";
import { callLLM } from "../utils/llmClient";

const PANE_ID = "llm-context-panel";

export function registerReaderContextPanel() {
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: "chrome://zotero/skin/16/universal/idea.svg",
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/idea.svg",
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader");
      return true;
    },
    onRender: ({ body, item }) => {
      renderShell(body);
      setContextPreview(body, item);
      setStatus(body, "llm-panel-status-ready");
    },
    onAsyncRender: async ({ body, item }) => {
      setContextPreview(body, item);
      bindSend(body, item);
    },
  });
}

function renderShell(body: Element) {
  body.textContent = "";
  const doc = body.ownerDocument!;
  const wrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  wrap.classList.add("llm-panel");
  wrap.innerHTML = `
    <div class="llm-context" id="${addon.data.config.addonRef}-context-preview"></div>
    <textarea class="llm-input" id="${addon.data.config.addonRef}-prompt" rows="4"
      placeholder="${getPlaceholder()}"></textarea>
    <div class="llm-actions">
      <button id="${addon.data.config.addonRef}-send">${getButtonLabel()}</button>
      <span id="${addon.data.config.addonRef}-status" class="llm-status"></span>
    </div>
    <div class="llm-answer" id="${addon.data.config.addonRef}-answer"></div>
  `;
  body.appendChild(wrap);
}

function setContextPreview(body: Element, item?: Zotero.Item | null) {
  const target = body.querySelector(
    `#${addon.data.config.addonRef}-context-preview`,
  );
  if (!target) return;
  if (!item) {
    target.textContent = "";
    return;
  }
  target.textContent = buildContextString(item);
}

function bindSend(body: Element, item?: Zotero.Item | null) {
  const button = body.querySelector(
    `#${addon.data.config.addonRef}-send`,
  ) as HTMLButtonElement | null;
  const statusNode = body.querySelector(
    `#${addon.data.config.addonRef}-status`,
  ) as HTMLElement | null;
  const promptNode = body.querySelector(
    `#${addon.data.config.addonRef}-prompt`,
  ) as HTMLTextAreaElement | null;
  const answerNode = body.querySelector(
    `#${addon.data.config.addonRef}-answer`,
  ) as HTMLElement | null;

  if (!button || !promptNode || !statusNode || !answerNode) return;

  button.onclick = async () => {
    if (!item) return;
    const prompt = promptNode.value.trim();
    if (!prompt) return;
    button.disabled = true;
    answerNode.textContent = "";
    setStatus(body, "llm-panel-status-sending");
    try {
      const context = buildContextString(item);
      const reply = await callLLM({ prompt, context });
      answerNode.textContent = reply;
      setStatus(body, "llm-panel-status-ready");
    } catch (error) {
      const msg = (error as Error).message;
      setStatus(body, "llm-panel-status-error", msg);
    } finally {
      button.disabled = false;
    }
  };
}

function setStatus(body: Element, l10nKey: string, extra?: string) {
  const node = body.querySelector(
    `#${addon.data.config.addonRef}-status`,
  ) as HTMLElement | null;
  if (!node) return;
  const text = getString(l10nKey as any);
  node.textContent = extra ? `${text}: ${extra}` : text || extra || "";
}

function buildContextString(item: Zotero.Item): string {
  const parts: string[] = [];
  const title = item.getField("title") as string;
  if (title) parts.push(`Title: ${title}`);
  const creators = (item as any).getCreatorsJSON?.() as
    | { firstName?: string; lastName?: string }[]
    | undefined;
  if (creators && creators.length) {
    const authorList = creators
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim())
      .filter(Boolean)
      .join(", ");
    if (authorList) parts.push(`Authors: ${authorList}`);
  }
  const abstractNote = item.getField("abstractNote") as string;
  if (abstractNote) parts.push(`Abstract: ${abstractNote}`);
  const publicationTitle = item.getField("publicationTitle") as string;
  if (publicationTitle) parts.push(`Venue: ${publicationTitle}`);
  return parts.join("\n");
}

function getPlaceholder(): string {
  return getString("llm-panel-placeholder");
}

function getButtonLabel(): string {
  return getString("llm-panel-send", "label");
}
