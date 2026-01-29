import { config } from "../../package.json";

type ChatParams = {
  prompt: string;
  context?: string;
};

const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;

const getPref = (key: string) => Zotero.Prefs.get(prefKey(key), true) as string;

export async function callLLM(params: ChatParams): Promise<string> {
  const apiBase = (getPref("apiBase") || "").replace(/\/$/, "");
  const apiKey = getPref("apiKey") || "";
  const model = getPref("model") || "gpt-4o-mini";

  if (!apiBase) throw new Error("API base URL is missing in preferences");

  const messages = [
    {
      role: "system",
      content:
        "You are helping the user analyze the currently opened Zotero item. Keep answers concise.",
    },
    {
      role: "user",
      content: `${params.context ? `Context:\n${params.context}\n\n` : ""}Question: ${params.prompt}`,
    },
  ];

  const payload = {
    model,
    messages,
    temperature: 0.3,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const res = await fetchFn(`${apiBase}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json();
  const reply =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data);
  return reply;
}
