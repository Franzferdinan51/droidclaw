/**
 * Duck-Cli Provider Adapter for DroidClaw
 * 
 * Bridges DroidClaw's LLM call interface with duck-cli's ProviderManager.
 * Supports: Kimi, MiniMax, LM Studio, GPT-4o, OpenRouter free tier
 * 
 * This replaces llm-providers.ts so DroidClaw can use duck-cli's
 * multi-provider system instead of its own Groq/Ollama-only setup.
 */

import { ProviderManager } from '../../../duck-cli-src/src/providers/manager.js';

// Duck-cli's provider interface
interface Provider {
  name: string;
  complete(opts: { model?: string; messages: any[]; tools?: any[] }): Promise<{ text?: string; toolCalls?: any[]; error?: string }>;
}

export interface ContentPart {
  type: 'text';
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LLMProvider {
  name: string;
  capabilities: {
    supportsVision: boolean;
    supportsStreaming: boolean;
  };
  getDecision(messages: ChatMessage[]): Promise<any>;
  getDecisionStream?(messages: ChatMessage[]): AsyncGenerator<string, void, unknown>;
}

// System prompt adapted from DroidClaw's LLM prompt
export const SYSTEM_PROMPT = `You are an Android Driver Agent. Your job is to achieve the user's goal by navigating the Android UI.

You will receive:
1. GOAL — the user's task.
2. FOREGROUND_APP — the currently active app package and activity.
3. LAST_ACTION_RESULT — the outcome of your previous action (success/failure and details).
4. SCREEN_CONTEXT — JSON array of interactive UI elements with coordinates and states.
5. SCREEN_CHANGE — what changed since your last action (or if the screen is stuck).

Previous conversation turns contain your earlier observations and actions (multi-turn memory).

You must output ONLY a valid JSON object with your next action.

═══════════════════════════════════════════
THINKING & PLANNING
═══════════════════════════════════════════

Before each action, include a "think" field with your reasoning about the current state.

═══════════════════════════════════════════
AVAILABLE ACTIONS (28 total)
═══════════════════════════════════════════

Navigation:
  {"action": "tap", "coordinates": [540, 1200], "reason": "..."}
  {"action": "longpress", "coordinates": [540, 1200], "reason": "..."}
  {"action": "scroll", "direction": "up|down|left|right", "reason": "..."}
  {"action": "enter", "reason": "Press Enter/submit"}
  {"action": "back", "reason": "Navigate back"}
  {"action": "home", "reason": "Go to home screen"}

Text Input (include coordinates to focus the correct field):
  {"action": "type", "coordinates": [540, 648], "text": "Hello World", "reason": "..."}
  {"action": "clear", "reason": "Clear current text field"}
  {"action": "paste", "coordinates": [540, 804], "reason": "Paste clipboard into focused field"}

App Control:
  {"action": "launch", "package": "com.whatsapp", "reason": "Open WhatsApp"}
  {"action": "switch_app", "package": "com.whatsapp", "reason": "Switch to WhatsApp"}
  {"action": "open_url", "url": "https://example.com", "reason": "Open URL in browser"}

Data:
  {"action": "clipboard_get", "reason": "Read clipboard contents"}
  {"action": "clipboard_set", "text": "copied text", "reason": "Set clipboard"}

System:
  {"action": "wait", "reason": "Wait for screen to load"}
  {"action": "done", "reason": "Task is complete"}

═══════════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════════

1. DISABLED ELEMENTS: If "enabled": false, DO NOT tap.
2. TEXT INPUT: ALWAYS include "coordinates" with "type" to focus the correct field.
3. COORDINATES: Use coordinates from SCREEN_CONTEXT elements (the "center" field). NEVER guess.
4. REPETITION: Do NOT tap the same coordinates twice in a row if it didn't work.
5. DONE: Say "done" as soon as the goal is achieved.
6. BE DIRECT: Prefer "launch" with package name over hunting for icons.
7. LEARN FROM HISTORY: If an action failed before, try a different approach.

═══════════════════════════════════════════
ELEMENT FORMAT
═══════════════════════════════════════════

Each element has:
- text: visible label
- center: [x, y] coordinates to tap
- enabled: false = do not tap
- editable: true = text input field
- clickable: true = tappable

Output JSON only. No markdown, no explanation.`;

let providerManager: ProviderManager | null = null;

export async function initProviderManager(): Promise<void> {
  providerManager = new ProviderManager();
  await providerManager.load();
}

/**
 * Get the active LLM provider from duck-cli
 */
export function getDuckProvider(providerName?: string, modelName?: string): LLMProvider {
  if (!providerManager) {
    throw new Error('ProviderManager not initialized. Call initProviderManager() first.');
  }

  const prov = providerName 
    ? providerManager.getProvider(providerName) 
    : providerManager.getActive();

  if (!prov) {
    throw new Error(`Provider '${providerName || 'active'}' not available`);
  }

  return wrapProvider(prov, modelName || 'default');
}

function wrapProvider(prov: Provider, modelName: string): LLMProvider {
  return {
    name: prov.name,
    capabilities: {
      supportsVision: prov.name === 'kimi' || prov.name === 'openai' || prov.name === 'lmstudio',
      supportsStreaming: false, // duck-cli providers don't expose streaming yet
    },
    
    async getDecision(messages: ChatMessage[]): Promise<any> {
      // Convert DroidClaw messages to OpenAI-format messages
      const openaiMessages = messages.map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' 
          ? msg.content 
          : (msg.content as ContentPart[]).map(c => c.text).join('\n'),
      }));

      const result = await prov.complete({
        model: modelName !== 'default' ? modelName : undefined,
        messages: openaiMessages,
      });

      if (result.error) {
        throw new Error(`Provider error: ${result.error}`);
      }

      const text = result.text || '';
      
      // Try to parse as JSON
      try {
        // Extract JSON from response (might be wrapped in markdown)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Not JSON, return as text decision
        return { action: 'done', reason: `LLM said: ${text.slice(0, 200)}` };
      }

      return { action: 'done', reason: `Unexpected response: ${text.slice(0, 200)}` };
    },
  };
}

/**
 * Parse JSON from LLM response, handling markdown code blocks
 */
export function parseJsonResponse(text: string): any {
  try {
    // Try direct parse
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        // Try finding raw JSON
      }
    }
    
    // Try finding JSON object in text
    const rawMatch = text.match(/\{[\s\S]*\}/);
    if (rawMatch) {
      try {
        return JSON.parse(rawMatch[0]);
      } catch {
        // Give up
      }
    }
  }
  return { action: 'done', reason: `Could not parse: ${text.slice(0, 100)}` };
}
