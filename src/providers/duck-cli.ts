/**
 * duck-cli LLM Provider for DroidClaw.
 *
 * Routes LLM calls through duck-cli's multi-provider system:
 *   - MiniMax (quota-based)
 *   - Kimi/Moonshot (pay-per-use)
 *   - ChatGPT (OAuth subscription)
 *   - LM Studio (local - Gemma 4, Qwen 3.5, etc.)
 *   - OpenRouter (free tier)
 *   - OpenClaw Gateway (kimi-k2.5 free)
 *
 * The provider uses duck-cli's provider routing logic with model
 * overrides for Android-specific tasks (Gemma 4 preferred).
 *
 * Usage:
 *   LLM_PROVIDER=duck-cli
 *   DUCK_CLI_MODEL=gemma-4-e4b-it        # Android + vision (PREFERRED)
 *   DUCK_CLI_MODEL=kimi-k2.5              # Kimi vision + coding
 *   DUCK_CLI_MODEL=google/gemma-4-26b-a4b # Large Gemma 4
 *   DUCK_CLI_MODEL=qwen3.5-9b            # Fast + local vision
 *   DUCK_CLI_MODEL=minimax/MiniMax-M2.7  # Fast reasoning
 */

import { Config } from "../config.js";
import { sanitizeCoordinates, type ActionDecision } from "../actions.js";
import type { LLMProvider, ChatMessage, ContentPart } from "../llm-providers.js";
import { parseJsonResponse } from "../llm-providers.js";

// ===========================================
// duck-cli Provider Interface
// ===========================================

interface DuckCLIProviderResult {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  error?: string;
}

interface DuckCLIProvider {
  name: string;
  complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult>;
}

// ===========================================
// MiniMax Provider (from duck-cli)
// ===========================================

class MiniMaxProvider implements DuckCLIProvider {
  name = "minimax";
  private retryDelays = [500, 1000, 2000, 4000];

  constructor(private apiKey: string) {}

  async complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult> {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
      }

      try {
        // Merge system messages (MiniMax only supports one)
        let systemParts: string[] = [];
        const nonSystem: unknown[] = [];
        for (const m of opts.messages as any[]) {
          if (m.role === "system") {
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            systemParts.push(text);
          } else {
            nonSystem.push(m);
          }
        }
        const combinedSystem = systemParts.join("\n---\n");
        const msgs = [
          { role: "system", content: combinedSystem },
          ...nonSystem.map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.trimEnd() : (Array.isArray(m.content) ? JSON.stringify(m.content) : m.content)
          }))
        ];

        const minimaxModel = (opts.model && opts.model !== "minimax") ? opts.model : "MiniMax-M2.7";
        const res = await fetch("https://api.minimax.io/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({ model: minimaxModel, messages: msgs }),
        });

        if (!res.ok) {
          const data: any = await res.json().catch(() => ({}));
          return { error: `HTTP ${res.status}: ${data.error?.message || res.statusText}` };
        }

        const data: any = await res.json();
        return { text: data.choices?.[0]?.message?.content };
      } catch (error: any) {
        const isRetryable = error.message?.includes("Connection") ||
                           error.message?.includes("timeout") ||
                           error.message?.includes("ECONNRESET") ||
                           error.message?.includes("ETIMEDOUT");
        if (!isRetryable || attempt === this.retryDelays.length) {
          return { error: error.message };
        }
      }
    }
    return { error: "Failed after retries" };
  }
}

// ===========================================
// LM Studio Provider (from duck-cli)
// ===========================================

class LMStudioProvider implements DuckCLIProvider {
  name = "lmstudio";
  private retryDelays = [500, 1000, 2000, 4000];

  constructor(private url: string, private key: string = "not-needed") {}

  async complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult> {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
      }

      try {
        const baseUrl = this.url.replace(/\/v1\/?$/, "").replace("/api/v1", "");
        const endpoint = `${baseUrl}/v1/chat/completions`;

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.key}`
          },
          body: JSON.stringify({
            model: opts.model || process.env.GEMMA_MODEL || "google/gemma-4-26b-a4b",
            messages: opts.messages,
            tools: opts.tools,
            stream: false
          })
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "Unknown error");
          return { error: `HTTP ${res.status}: ${errorText}` };
        }

        const data: any = await res.json();
        const message = data.message || data.choices?.[0]?.message || {};
        return {
          text: message.content || "",
          toolCalls: (message.tool_calls || []).map((tc: any) => ({
            id: tc.id,
            name: tc.function?.name,
            input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
          }))
        };
      } catch (error: any) {
        const isRetryable = error.message?.includes("Connection") ||
                           error.message?.includes("timeout") ||
                           error.message?.includes("ECONNRESET") ||
                           error.message?.includes("ETIMEDOUT");
        if (!isRetryable || attempt === this.retryDelays.length) {
          return { error: error.message };
        }
      }
    }
    return { error: "Failed after retries" };
  }
}

// ===========================================
// Kimi Provider (from duck-cli)
// ===========================================

class KimiProvider implements DuckCLIProvider {
  name = "kimi";
  private retryDelays = [500, 1000, 2000, 4000];

  constructor(private apiKey: string) {}

  async complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult> {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
      }

      try {
        const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: opts.model || "kimi-k2.5",
            messages: opts.messages,
            tools: opts.tools
          })
        });

        if (!res.ok) {
          const data: any = await res.json().catch(() => ({}));
          return { error: `HTTP ${res.status}: ${data.error?.message || res.statusText}` };
        }

        const data: any = await res.json();
        const message = data.choices?.[0]?.message || {};
        return {
          text: message.content || "",
          toolCalls: (message.tool_calls || []).map((tc: any) => ({
            id: tc.id,
            name: tc.function?.name,
            input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
          }))
        };
      } catch (error: any) {
        if (attempt === this.retryDelays.length) {
          return { error: error.message };
        }
      }
    }
    return { error: "Failed after retries" };
  }
}

// ===========================================
// OpenClaw Gateway Provider (from duck-cli)
// Uses OpenClaw's local gateway with Kimi k2.5 (free)
// ===========================================

class OpenClawGatewayProvider implements DuckCLIProvider {
  name = "openclaw";
  private gatewayUrl: string;
  private gatewayToken: string;

  constructor() {
    this.gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
    this.gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  }

  async complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult> {
    try {
      const model = opts.model || "kimi/kimi-k2.5";
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (this.gatewayToken) {
        headers["Authorization"] = `Bearer ${this.gatewayToken}`;
      }

      // Convert messages to OpenClaw format
      const openClawMessages = (opts.messages as any[]).map(m => ({
        role: m.role,
        content: m.content
      }));

      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: openClawMessages,
          tools: opts.tools
        })
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unknown error");
        return { error: `HTTP ${res.status}: ${errorText}` };
      }

      const data: any = await res.json();
      const message = data.choices?.[0]?.message || {};
      return {
        text: message.content || "",
        toolCalls: (message.tool_calls || []).map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        }))
      };
    } catch (error: any) {
      return { error: error.message };
    }
  }
}

// ===========================================
// OpenRouter Provider (from duck-cli)
// Uses Duckets' personal OpenRouter key for free tier
// ===========================================

class OpenRouterProvider implements DuckCLIProvider {
  name = "openrouter";
  private apiKey: string;

  constructor(private key: string) {
    this.apiKey = key;
  }

  async complete(opts: { model?: string; messages: unknown[]; tools?: unknown[] }): Promise<DuckCLIProviderResult> {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://duck-agent.dev",
          "X-Title": "DroidClaw"
        },
        body: JSON.stringify({
          model: opts.model || "minimax/minimax-m2.5:free",
          messages: opts.messages,
          tools: opts.tools
        })
      });

      const data: any = await res.json();
      if (data.error) {
        return { error: data.error.message };
      }
      const message = data.choices?.[0]?.message;
      return {
        text: message?.content,
        toolCalls: (message?.tool_calls || []).map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        }))
      };
    } catch (error: any) {
      return { error: error.message };
    }
  }
}

// ===========================================
// duck-cli Provider Priority Routing
// ===========================================

interface RouterTarget {
  provider: DuckCLIProvider;
  model?: string;
  label: string;
}

/**
 * Maps DUCK_CLI_MODEL env var to (provider, model) pairs.
 * Supports both short names and full model IDs.
 */
function resolveModelTarget(modelName: string): { provider: string; model?: string; label: string } {
  // LM Studio models (local)
  if (modelName.includes("gemma") || modelName.includes("qwen") || modelName.includes("llama") || modelName.includes("janus")) {
    return { provider: "lmstudio", model: modelName, label: `LM Studio: ${modelName}` };
  }

  // MiniMax models
  if (modelName.toLowerCase().includes("minimax") || modelName.includes("glm-")) {
    // Strip provider prefix: "minimax/MiniMax-M2.7" → "MiniMax-M2.7"
    const stripped = modelName.includes("/") ? modelName.split("/")[1] : modelName;
    return { provider: "minimax", model: stripped, label: `MiniMax: ${stripped}` };
  }

  // Kimi models
  if (modelName.includes("kimi") || modelName.includes("k2p")) {
    return { provider: "kimi", model: modelName.replace("kimi-", ""), label: `Kimi: ${modelName}` };
  }

  // OpenClaw Gateway (kimi-k2.5 free)
  if (modelName === "kimi-k2.5" || modelName === "k2p5") {
    return { provider: "openclaw", model: "kimi/kimi-k2.5", label: "OpenClaw Gateway (Kimi k2.5)" };
  }

  // OpenRouter free models
  if (modelName.includes(":free")) {
    return { provider: "openrouter", model: modelName, label: `OpenRouter: ${modelName}` };
  }

  // Bare provider names → full model
  if (modelName === "minimax") return { provider: "minimax", model: "MiniMax-M2.7", label: "MiniMax M2.7" };
  if (modelName === "kimi") return { provider: "kimi", model: "moonshot-v1-8k", label: "Kimi" };
  if (modelName === "openrouter") return { provider: "openrouter", model: "openrouter/auto", label: "OpenRouter" };

  // Default: try LM Studio first (free), then OpenClaw
  return { provider: "lmstudio", model: modelName, label: modelName };
}

/**
 * Builds the provider priority list based on DUCK_PRIORITY env var.
 * Falls back to smart default order: local → free → API → paid.
 */
function buildRouterTargets(): RouterTarget[] {
  const duckPriority = process.env.DUCK_PRIORITY;
  const duckModel = process.env.DUCK_CLI_MODEL || process.env.GEMMA_MODEL || "gemma-4-e4b-it";

  // If DUCK_PRIORITY is set, use it for the order (models from duck-cli env vars)
  if (duckPriority) {
    const names = duckPriority.split(",").map(s => s.trim());
    return names.map(name => {
      const target = resolveModelTarget(name);
      return {
        provider: getProviderInstance(target.provider),
        model: target.model,
        label: target.label
      };
    }).filter(t => t.provider !== null) as RouterTarget[];
  }

  // Smart default order
  const primary = resolveModelTarget(duckModel);

  const targets: RouterTarget[] = [
    // Primary: user's chosen model
    { provider: getProviderInstance(primary.provider)!, model: primary.model, label: primary.label },
  ];

  // Fallbacks in priority order
  const fallbacks = [
    { provider: "lmstudio", model: "google/gemma-4-26b-a4b", label: "LM Studio: Gemma 4 26B" },
    { provider: "openclaw", model: "kimi/kimi-k2.5", label: "OpenClaw Gateway (Kimi k2.5)" },
    { provider: "openrouter", model: "minimax/minimax-m2.5:free", label: "OpenRouter: MiniMax M2.5 (free)" },
    { provider: "minimax", model: "MiniMax-M2.7", label: "MiniMax M2.7" },
    { provider: "kimi", model: "kimi-k2.5", label: "Kimi K2.5" },
  ];

  for (const fb of fallbacks) {
    if (fb.provider === primary.provider) continue; // Don't duplicate primary
    const inst = getProviderInstance(fb.provider);
    if (inst) {
      targets.push({ provider: inst, model: fb.model, label: fb.label });
    }
  }

  return targets.filter(t => t.provider !== null) as RouterTarget[];
}

function getProviderInstance(name: string): DuckCLIProvider | null {
  switch (name) {
    case "minimax":
      if (process.env.MINIMAX_API_KEY) {
        return new MiniMaxProvider(process.env.MINIMAX_API_KEY);
      }
      break;
    case "kimi":
    case "moonshot":
      if (process.env.KIMI_API_KEY) {
        return new KimiProvider(process.env.KIMI_API_KEY);
      }
      if (process.env.MOONSHOT_API_KEY) {
        return new KimiProvider(process.env.MOONSHOT_API_KEY);
      }
      break;
    case "openclaw":
      return new OpenClawGatewayProvider();
    case "openrouter":
      if (process.env.OPENROUTER_API_KEY) {
        return new OpenRouterProvider(process.env.OPENROUTER_API_KEY);
      }
      break;
    case "lmstudio":
      // Try LM Studio at localhost first
      const lmUrl = process.env.LMSTUDIO_URL || "http://localhost:1234";
      return new LMStudioProvider(lmUrl, process.env.LMSTUDIO_KEY || "not-needed");
  }
  return null;
}

// ===========================================
// duck-cli LLM Provider Implementation
// ===========================================

export class DuckCLIProvider implements LLMProvider {
  readonly capabilities: { supportsImages: boolean; supportsStreaming: boolean };

  constructor() {
    const duckModel = process.env.DUCK_CLI_MODEL || process.env.GEMMA_MODEL || "gemma-4-e4b-it";
    const target = resolveModelTarget(duckModel);

    // Determine capabilities based on model type
    const isVisionModel =
      duckModel.includes("gemma") ||
      duckModel.includes("qwen") ||
      duckModel.includes("kimi") ||
      duckModel.includes("llava") ||
      duckModel.includes("vision");

    this.capabilities = {
      supportsImages: isVisionModel,
      supportsStreaming: false, // duck-cli providers don't stream individually
    };

    console.log(`[duck-cli] Provider initialized with model: ${duckModel} (${target.label})`);
  }

  private convertMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (typeof msg.content === "string") {
        return { role: msg.role, content: msg.content };
      }
      // ContentPart[] → openai-style content
      const parts = (msg.content as ContentPart[]).map((part) => {
        if (part.type === "text") {
          return { type: "text", text: part.text };
        }
        // Image part → base64 data URL
        return {
          type: "image_url",
          image_url: {
            url: `data:${part.mimeType};base64,${part.base64}`,
            detail: "low"
          }
        };
      });
      return { role: msg.role, content: parts };
    });
  }

  async getDecision(messages: ChatMessage[]): Promise<ActionDecision> {
    const targets = buildRouterTargets();
    const convertedMessages = this.convertMessages(messages);

    for (const target of targets) {
      console.log(`[duck-cli] Trying ${target.label}...`);

      try {
        const result = await Promise.race([
          target.provider.complete({
            model: target.model,
            messages: convertedMessages,
          }),
          new Promise<DuckCLIProviderResult>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out after 60s")), 60000)
          )
        ]);

        if (result.error) {
          console.log(`[duck-cli] ❌ ${target.label}: ${result.error}`);
          continue;
        }

        if (result.text) {
          console.log(`[duck-cli] ✅ ${target.label} succeeded`);
          return parseJsonResponse(result.text);
        }
      } catch (err) {
        console.log(`[duck-cli] ❌ ${target.label}: ${(err as Error).message}`);
      }
    }

    console.log("[duck-cli] ⚠️  All providers exhausted, falling back to wait");
    return { action: "wait", reason: "All duck-cli providers failed, waiting" };
  }

  async *getDecisionStream(messages: ChatMessage[]): AsyncIterable<string> {
    // Streaming not directly supported by duck-cli providers.
    // Fall back to non-streaming and yield chunks for UI feedback.
    const decision = await this.getDecision(messages);
    const json = JSON.stringify(decision);

    // Simulate streaming by yielding word chunks
    const words = json.split(" ");
    for (let i = 0; i < words.length; i++) {
      yield words[i] + (i < words.length - 1 ? " " : "");
      // Small delay between words for visual effect
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}
