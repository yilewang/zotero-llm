/**
 * LLM API Client
 *
 * Provides streaming and non-streaming API calls to OpenAI-compatible endpoints.
 */

import { config } from "../../package.json";

// =============================================================================
// Types
// =============================================================================

/** Image content for vision-capable models */
export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

/** Text content */
export type TextContent = {
  type: "text";
  text: string;
};

/** Message content can be string or array of content parts (for vision) */
export type MessageContent = string | (TextContent | ImageContent)[];

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: MessageContent;
};

export type ChatParams = {
  prompt: string;
  context?: string;
  history?: ChatMessage[];
  signal?: AbortSignal;
  /** Base64 data URL of an image to include with the prompt */
  image?: string;
  /** Override model for this request */
  model?: string;
  /** Override API base for this request */
  apiBase?: string;
  /** Override API key for this request */
  apiKey?: string;
};

interface StreamChoice {
  delta?: { content?: string };
  message?: { content?: string };
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are an intelligent research assistant integrated into Zotero. You help users analyze and understand academic papers and documents.

When answering questions:
- Be concise but thorough
- Cite specific parts of the document when relevant
- Use markdown formatting for better readability (headers, lists, bold, code blocks)
- For mathematical expressions, use standard LaTeX syntax with dollar signs: use $...$ for inline math (e.g., $x^2 + y^2 = z^2$) and $$...$$ for display equations on their own line. IMPORTANT: Always use $ delimiters, never use \\( \\) or \\[ \\] delimiters.
- For tables, use markdown table syntax with pipes and a header divider row
- If you don't have enough information to answer, say so clearly
- Provide actionable insights when possible`;

const API_ENDPOINT = "/v1/chat/completions";
const RESPONSES_ENDPOINT = "/v1/responses";
const EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;

// =============================================================================
// Utilities
// =============================================================================

const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;
const getPref = (key: string) => Zotero.Prefs.get(prefKey(key), true) as string;

/** Get configured API settings */
function resolveEndpoint(baseOrUrl: string, path: string): string {
  const cleaned = baseOrUrl.replace(/\/$/, "");
  if (!cleaned) return "";
  const chatSuffix = "/chat/completions";
  const responsesSuffix = "/responses";
  const embeddingSuffix = "/embeddings";
  const hasChat = cleaned.endsWith(chatSuffix);
  const hasResponses = cleaned.endsWith(responsesSuffix);
  const hasEmbeddings = cleaned.endsWith(embeddingSuffix);

  if (hasChat) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, embeddingSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, responsesSuffix);
    }
    return cleaned;
  }

  if (hasResponses) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/responses$/, embeddingSuffix);
    }
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/responses$/, chatSuffix);
    }
    return cleaned;
  }

  if (hasEmbeddings) {
    return path === API_ENDPOINT
      ? cleaned.replace(/\/embeddings$/, chatSuffix)
      : cleaned;
  }

  // If a version segment is already present (e.g., /v1 or /v1beta),
  // avoid appending a second /v1 from the default OpenAI path.
  const hasVersion = /\/v\d+(?:beta)?\b/.test(cleaned);
  const normalizedPath =
    hasVersion && path.startsWith("/v1/")
      ? path.replace(/^\/v1\//, "/")
      : path;

  return `${cleaned}${normalizedPath}`;
}

function getApiConfig(overrides?: {
  apiBase?: string;
  apiKey?: string;
  model?: string;
}) {
  const prefApiBase =
    getPref("apiBasePrimary") || getPref("apiBase") || "";
  const apiBase = (overrides?.apiBase || prefApiBase).replace(/\/$/, "");
  const apiKey =
    overrides?.apiKey || getPref("apiKeyPrimary") || getPref("apiKey") || "";
  const modelPrimary =
    getPref("modelPrimary") || getPref("model") || DEFAULT_MODEL;
  const model = overrides?.model || modelPrimary;
  const embeddingModel = getPref("embeddingModel") || DEFAULT_EMBEDDING_MODEL;
  const customSystemPrompt = getPref("systemPrompt") || "";

  if (!apiBase) {
    throw new Error("API URL is missing in preferences");
  }

  return {
    apiBase,
    apiKey,
    model,
    embeddingModel,
    systemPrompt: customSystemPrompt || DEFAULT_SYSTEM_PROMPT,
  };
}

/** Build messages array from params */
function buildMessages(
  params: ChatParams,
  systemPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  if (params.context) {
    messages.push({
      role: "system",
      content: `Document Context:\n${params.context}`,
    });
  }

  if (params.history?.length) {
    messages.push(...params.history);
  }

  // Build user message - with image if provided (vision API format)
  if (params.image) {
    const contentParts: (TextContent | ImageContent)[] = [
      { type: "text", text: params.prompt },
      {
        type: "image_url",
        image_url: {
          url: params.image,
          detail: "high",
        },
      },
    ];
    messages.push({
      role: "user",
      content: contentParts,
    });
  } else {
    messages.push({
      role: "user",
      content: params.prompt,
    });
  }

  return messages;
}

/** Build request headers */
function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Get fetch function from Zotero global */
function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

function isResponsesBase(baseOrUrl: string): boolean {
  const cleaned = baseOrUrl.replace(/\/$/, "");
  return cleaned.endsWith("/v1/responses") || cleaned.endsWith("/responses");
}

function usesMaxCompletionTokens(model: string): boolean {
  const name = model.toLowerCase();
  return (
    name.startsWith("gpt-5") ||
    name.startsWith("o") ||
    name.includes("reasoning")
  );
}

function buildTokenParam(model: string, maxTokens: number) {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function buildResponsesTokenParam(maxTokens: number) {
  return { max_output_tokens: maxTokens };
}

function stringifyContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function buildResponsesInput(messages: ChatMessage[]) {
  const instructionsParts: string[] = [];
  const input: Array<{
    type: "message";
    role: "user" | "assistant";
    content:
      | string
      | Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail?: string }
        >;
  }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = stringifyContent(message.content);
      if (text) instructionsParts.push(text);
      continue;
    }

    if (typeof message.content === "string") {
      input.push({
        type: "message",
        role: message.role,
        content: message.content,
      });
      continue;
    }

    const contentParts = message.content.map((part) => {
      if (part.type === "text") {
        return { type: "input_text" as const, text: part.text };
      }
      return {
        type: "input_image" as const,
        image_url: part.image_url.url,
        detail: part.image_url.detail,
      };
    });

    input.push({
      type: "message",
      role: message.role,
      content: contentParts,
    });
  }

  return {
    instructions: instructionsParts.length
      ? instructionsParts.join("\n\n")
      : undefined,
    input,
  };
}

function extractResponsesOutputText(data: {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}): string {
  if (data?.output_text) return data.output_text;
  const firstText =
    data?.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text" && content.text)?.text ||
    "";
  return firstText || JSON.stringify(data);
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Call LLM API (non-streaming)
 */
export async function callLLM(params: ChatParams): Promise<string> {
  const { apiBase, apiKey, model, systemPrompt } = getApiConfig({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
  });
  const messages = buildMessages(params, systemPrompt);
  const useResponses = isResponsesBase(apiBase);

  const payload = useResponses
    ? {
        model,
        ...buildResponsesInput(messages),
        temperature: DEFAULT_TEMPERATURE,
        ...buildResponsesTokenParam(DEFAULT_MAX_TOKENS),
      }
    : {
        model,
        messages,
        temperature: DEFAULT_TEMPERATURE,
        ...buildTokenParam(model, DEFAULT_MAX_TOKENS),
      };

  const url = resolveEndpoint(
    apiBase,
    useResponses ? RESPONSES_ENDPOINT : API_ENDPOINT,
  );
  const res = await getFetch()(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as CompletionResponse & {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (useResponses) {
    return extractResponsesOutputText(data);
  }
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data)
  );
}

/**
 * Call LLM API with streaming response
 */
export async function callLLMStream(
  params: ChatParams,
  onDelta: (delta: string) => void,
): Promise<string> {
  const { apiBase, apiKey, model, systemPrompt } = getApiConfig({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
  });
  const messages = buildMessages(params, systemPrompt);
  const useResponses = isResponsesBase(apiBase);

  const payload = useResponses
    ? {
        model,
        ...buildResponsesInput(messages),
        temperature: DEFAULT_TEMPERATURE,
        ...buildResponsesTokenParam(DEFAULT_MAX_TOKENS),
        stream: true,
      }
    : {
        model,
        messages,
        temperature: DEFAULT_TEMPERATURE,
        ...buildTokenParam(model, DEFAULT_MAX_TOKENS),
        stream: true,
      };

  const url = resolveEndpoint(
    apiBase,
    useResponses ? RESPONSES_ENDPOINT : API_ENDPOINT,
  );
  const res = await getFetch()(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  // Fallback to non-streaming if body is not available
  if (!res.body) {
    return callLLM(params);
  }

  return useResponses
    ? parseResponsesStream(res.body, onDelta)
    : parseStreamResponse(res.body, onDelta);
}

/**
 * Call embeddings API
 */
export async function callEmbeddings(
  input: string[],
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<number[][]> {
  const { apiBase, apiKey, embeddingModel } = getApiConfig({
    apiBase: overrides?.apiBase,
    apiKey: overrides?.apiKey,
  });
  const payload = {
    model: embeddingModel,
    input,
  };

  const url = resolveEndpoint(apiBase, EMBEDDINGS_ENDPOINT);
  const res = await getFetch()(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as EmbeddingResponse;
  const embeddings = data?.data?.map((item) => item.embedding || []) || [];
  return embeddings;
}

/**
 * Parse SSE stream response
 */
async function parseStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as { choices?: StreamChoice[] };
          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.message?.content ??
            "";

          if (delta) {
            fullText += delta;
            onDelta(delta);
          }
        } catch (err) {
          ztoolkit.log("LLM stream parse error:", err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

async function parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: string;
            text?: string;
            response?: {
              output_text?: string;
            };
          };

          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            fullText += parsed.delta;
            onDelta(parsed.delta);
            continue;
          }

          if (parsed.type === "response.output_text.done" && parsed.text) {
            fullText += parsed.text;
            onDelta(parsed.text);
            continue;
          }

          if (parsed.type === "response.completed" && parsed.response?.output_text) {
            if (!fullText) {
              fullText = parsed.response.output_text;
              onDelta(parsed.response.output_text);
            }
          }
        } catch (err) {
          ztoolkit.log("LLM responses stream parse error:", err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}
