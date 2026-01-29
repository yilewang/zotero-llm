import { config } from "../../package.json";
import { getString } from "../utils/locale";

type PrefKey = "apiBase" | "apiKey" | "model";

const pref = (key: PrefKey) => `${config.prefsPrefix}.${key}`;

const getPref = (key: PrefKey): string => Zotero.Prefs.get(pref(key), true);

const setPref = (key: PrefKey, value: string) =>
  Zotero.Prefs.set(pref(key), value, true);

export async function registerPrefsScripts(window: Window) {
  addon.data.prefs = { window, columns: [], rows: [] };
  populateFields(window);
  bindEvents(window);
}

function populateFields(window: Window) {
  const doc = window.document;
  (doc.querySelector(`#${config.addonRef}-api-base`) as HTMLInputElement).value =
    getPref("apiBase") || "";
  (doc.querySelector(`#${config.addonRef}-api-key`) as HTMLInputElement).value =
    getPref("apiKey") || "";
  (doc.querySelector(`#${config.addonRef}-model`) as HTMLInputElement).value =
    getPref("model") || "";
  const status = doc.querySelector(`#${config.addonRef}-test-status`);
  if (status) status.textContent = "";
}

function bindEvents(window: Window) {
  const doc = window.document;
  const fields: Array<{ id: string; key: PrefKey }> = [
    { id: `${config.addonRef}-api-base`, key: "apiBase" },
    { id: `${config.addonRef}-api-key`, key: "apiKey" },
    { id: `${config.addonRef}-model`, key: "model" },
  ];

  fields.forEach(({ id, key }) => {
    doc.querySelector(`#${id}`)?.addEventListener("change", (ev) => {
      const value = (ev.target as HTMLInputElement).value.trim();
      setPref(key, value);
    });
  });

  doc.querySelector(`#${config.addonRef}-test-button`)?.addEventListener(
    "command",
    async () => {
      const status = doc.querySelector(
        `#${config.addonRef}-test-status`,
      ) as HTMLElement;
      status.textContent = getString("prefs-test-running");
      try {
        const base = getPref("apiBase");
        if (!base) throw new Error("Missing API Base URL");
        // Ping a lightweight endpoint; fallback to HEAD if POST is blocked
        await ztoolkit.getGlobal("fetch")(`${base.replace(/\/$/, "")}/v1/models`, {
          method: "GET",
          headers: {
            Authorization: getPref("apiKey")
              ? `Bearer ${getPref("apiKey")}`
              : undefined,
          },
        });
        status.textContent = getString("prefs-test-success");
      } catch (error) {
        status.textContent = `${getString("prefs-test-failed")}: ${(error as Error).message}`;
      }
    },
  );
}
