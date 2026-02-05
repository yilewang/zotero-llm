import { config } from "../../package.json";

type PrefKey =
  | "apiBase"
  | "apiKey"
  | "model"
  | "apiBasePrimary"
  | "apiKeyPrimary"
  | "modelPrimary"
  | "apiBaseSecondary"
  | "apiKeySecondary"
  | "modelSecondary"
  | "systemPrompt";

const pref = (key: PrefKey) => `${config.prefsPrefix}.${key}`;

const getPref = (key: PrefKey): string => {
  const value = Zotero.Prefs.get(pref(key), true);
  return typeof value === "string" ? value : "";
};

const setPref = (key: PrefKey, value: string) =>
  Zotero.Prefs.set(pref(key), value, true);

export async function registerPrefsScripts(_window: Window | undefined | null) {
  if (!_window) {
    ztoolkit.log("Preferences window not available");
    return;
  }

  const doc = _window.document;

  // Wait a bit for DOM to be ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Populate fields with saved values
  const apiBasePrimaryInput = doc.querySelector(
    `#${config.addonRef}-api-base-primary`,
  ) as HTMLInputElement | null;
  const apiKeyPrimaryInput = doc.querySelector(
    `#${config.addonRef}-api-key-primary`,
  ) as HTMLInputElement | null;
  const modelPrimaryInput = doc.querySelector(
    `#${config.addonRef}-model-primary`,
  ) as HTMLInputElement | null;
  const apiBaseSecondaryInput = doc.querySelector(
    `#${config.addonRef}-api-base-secondary`,
  ) as HTMLInputElement | null;
  const apiKeySecondaryInput = doc.querySelector(
    `#${config.addonRef}-api-key-secondary`,
  ) as HTMLInputElement | null;
  const modelSecondaryInput = doc.querySelector(
    `#${config.addonRef}-model-secondary`,
  ) as HTMLInputElement | null;
  const systemPromptInput = doc.querySelector(
    `#${config.addonRef}-system-prompt`,
  ) as HTMLTextAreaElement | null;
  const testButtonPrimary = doc.querySelector(
    `#${config.addonRef}-test-button-primary`,
  ) as HTMLButtonElement | null;
  const testStatusPrimary = doc.querySelector(
    `#${config.addonRef}-test-status-primary`,
  ) as HTMLElement | null;
  const testButtonSecondary = doc.querySelector(
    `#${config.addonRef}-test-button-secondary`,
  ) as HTMLButtonElement | null;
  const testStatusSecondary = doc.querySelector(
    `#${config.addonRef}-test-status-secondary`,
  ) as HTMLElement | null;

  if (apiBasePrimaryInput) {
    apiBasePrimaryInput.value =
      getPref("apiBasePrimary") || getPref("apiBase") || "";
    apiBasePrimaryInput.addEventListener("input", () => {
      setPref("apiBasePrimary", apiBasePrimaryInput.value);
    });
  }

  if (apiKeyPrimaryInput) {
    apiKeyPrimaryInput.value =
      getPref("apiKeyPrimary") || getPref("apiKey") || "";
    apiKeyPrimaryInput.addEventListener("input", () => {
      setPref("apiKeyPrimary", apiKeyPrimaryInput.value);
    });
  }

  if (modelPrimaryInput) {
    modelPrimaryInput.value =
      getPref("modelPrimary") || getPref("model") || "gpt-4o-mini";
    modelPrimaryInput.addEventListener("input", () => {
      setPref("modelPrimary", modelPrimaryInput.value);
    });
  }

  if (apiBaseSecondaryInput) {
    apiBaseSecondaryInput.value = getPref("apiBaseSecondary") || "";
    apiBaseSecondaryInput.addEventListener("input", () => {
      setPref("apiBaseSecondary", apiBaseSecondaryInput.value);
    });
  }

  if (apiKeySecondaryInput) {
    apiKeySecondaryInput.value = getPref("apiKeySecondary") || "";
    apiKeySecondaryInput.addEventListener("input", () => {
      setPref("apiKeySecondary", apiKeySecondaryInput.value);
    });
  }

  if (modelSecondaryInput) {
    modelSecondaryInput.value = getPref("modelSecondary") || "";
    modelSecondaryInput.addEventListener("input", () => {
      setPref("modelSecondary", modelSecondaryInput.value);
    });
  }

  if (systemPromptInput) {
    systemPromptInput.value = getPref("systemPrompt") || "";
    systemPromptInput.addEventListener("input", () => {
      setPref("systemPrompt", systemPromptInput.value);
    });
  }

  const attachTestHandler = (
    button: HTMLButtonElement | null,
    status: HTMLElement | null,
    getValues: () => { base: string; key: string; model: string },
  ) => {
    if (!button || !status) return;

    const runTest = async () => {
      status.textContent = "Testing...";
      status.style.color = "#666";

      try {
        const { base, key, model } = getValues();
        const apiBase = base.trim().replace(/\/$/, "");
        const apiKey = key.trim();
        const modelName = (model || "gpt-4o-mini").trim();

        if (!apiBase) {
          throw new Error("API URL is required");
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const usesMaxCompletionTokens = (name: string) => {
          const value = name.toLowerCase();
          return (
            value.startsWith("gpt-5") ||
            value.startsWith("o") ||
            value.includes("reasoning")
          );
        };

        const isResponsesBase = apiBase.endsWith("/v1/responses") ||
          apiBase.endsWith("/responses");

        const tokenParam = isResponsesBase
          ? { max_output_tokens: 16 }
          : usesMaxCompletionTokens(modelName)
            ? { max_completion_tokens: 5 }
            : { max_tokens: 5 };

        const testPayload = isResponsesBase
          ? {
              model: modelName,
              input: [{ role: "user", content: "Say OK" }],
              ...tokenParam,
            }
          : {
              model: modelName,
              messages: [{ role: "user", content: "Say OK" }],
              ...tokenParam,
            };

        const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
        const response = await fetchFn(apiBase, {
          method: "POST",
          headers,
          body: JSON.stringify(testPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const reply = data?.choices?.[0]?.message?.content || "OK";

        status.textContent = `Success! Model says: "${reply}"`;
        status.style.color = "green";
      } catch (error) {
        status.textContent = `Failed: ${(error as Error).message}`;
        status.style.color = "red";
      }
    };

    button.addEventListener("click", runTest);
    button.addEventListener("command", runTest);
  };

  attachTestHandler(testButtonPrimary, testStatusPrimary, () => ({
    base: apiBasePrimaryInput?.value || "",
    key: apiKeyPrimaryInput?.value || "",
    model: modelPrimaryInput?.value || "gpt-4o-mini",
  }));

  attachTestHandler(testButtonSecondary, testStatusSecondary, () => ({
    base: apiBaseSecondaryInput?.value || "",
    key: apiKeySecondaryInput?.value || "",
    model: modelSecondaryInput?.value || "",
  }));
}
