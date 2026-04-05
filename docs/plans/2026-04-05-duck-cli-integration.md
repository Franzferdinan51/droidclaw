# DroidClaw x duck-cli Integration Plan

Date: 2026-04-05
Scope: Analyze DroidClaw's current architecture, map its LLM abstraction to duck-cli's provider layer, and define the file-level plan to make DroidClaw usable as a duck-cli tool.

## Executive Summary

DroidClaw currently has two different execution architectures:

1. A Bun-based local ADB agent loop in `src/`.
2. A Bun-based server/WebSocket pipeline in `server/` plus a Svelte settings UI in `web/`.

If the goal is to make DroidClaw work as a duck-cli tool, the correct integration target is the local ADB agent loop in `src/`, not the server pipeline. The server path is only needed if you also want the DroidClaw dashboard and Android companion app to use duck-cli's provider stack.

The key architectural fact is that DroidClaw's provider abstraction is duplicated:

- `src/llm-providers.ts` defines the Bun CLI agent provider layer.
- `server/src/agent/llm.ts` defines a separate server-side provider layer.

duck-cli already centralizes provider loading and selection in `ProviderManager`, including MiniMax and Kimi. That layer is the right source of truth for provider selection, but the current DroidClaw adapter draft is not usable as-is:

- it imports the wrong repo path,
- it calls methods that do not exist,
- it is excluded from DroidClaw's TypeScript build,
- and its Node-side Android agent draft contains syntax and wiring errors.

The recommended plan is:

1. Make DroidClaw's `src/` agent loop importable as a library.
2. Replace the hardcoded `getLlmProvider()` call with injected provider selection.
3. Add a duck-cli-backed provider adapter that accepts an existing `ProviderManager` instance.
4. Port the Bun-only runtime dependencies in the ADB path to a small runtime abstraction so the agent can run under duck-cli's Node runtime.
5. Register DroidClaw as a dangerous duck-cli tool and optional `duck android` command.
6. Only after that, optionally extend DroidClaw's server/UI provider settings to support MiniMax/Kimi directly.

## Current DroidClaw Architecture

### 1. Local ADB agent loop in `src/`

This is the fastest path to duck-cli integration.

Core flow:

- `src/kernel.ts` runs the perceive -> reason -> act loop.
- `src/actions.ts` executes ADB actions directly.
- `src/sanitizer.ts` parses the UI XML dump.
- `src/skills.ts` handles server-side multi-step Android skills.
- `src/workflow.ts` chains LLM-guided sub-goals.
- `src/flow.ts` runs deterministic YAML steps.

Important implementation details:

- DroidClaw is packaged around Bun, not Node. `package.json` uses Bun scripts and `bun build` for the agent.
- `src/actions.ts` uses `Bun.spawnSync` and `Bun.sleepSync` for all ADB work.
- `src/kernel.ts` uses `Bun.sleep`, `Bun.file`, and `Bun.stdin`.
- `src/workflow.ts`, `src/flow.ts`, and `src/skills.ts` also use Bun sleep helpers.
- `src/kernel.ts` calls `main()` at module top level, so it is not import-safe today.

Implication:

DroidClaw's core logic is good, but it is coupled to Bun and CLI side effects. duck-cli runs through Go -> Node, so an in-process integration must first remove or isolate the Bun-specific pieces.

### 2. Server pipeline in `server/`

This is a separate runtime, not a wrapper around `src/kernel.ts`.

Core flow:

- `server/src/agent/pipeline.ts` does parser -> classifier -> UI agent orchestration.
- `server/src/agent/classifier.ts` makes a small LLM call for goal routing.
- `server/src/agent/loop.ts` runs the UI agent loop over WebSocket.
- `server/src/agent/llm.ts` defines its own provider abstraction.
- `server/src/routes/goals.ts` loads provider config from request, DB, or env.

Implication:

If you only want a `duck-cli` Android tool, this stack can be left alone initially. If you want the full DroidClaw dashboard to use duck-cli providers, this is a second migration surface.

## Where DroidClaw's LLM Abstraction Lives

### A. `src/llm-providers.ts` (local agent path)

This file defines the main Bun-agent provider contract:

- `LLMProvider` exposes `getDecision()` and optional `getDecisionStream()`.
- `OpenAIProvider` is overloaded to handle OpenAI, Groq, and Ollama.
- `OpenRouterProvider` uses the AI SDK structured output path.
- `BedrockProvider` is separate.
- `getLlmProvider()` hard-selects provider by `Config.LLM_PROVIDER`.

Architectural consequences:

- Provider creation is global and env-driven.
- Provider capabilities are embedded in the provider classes (`supportsImages`, `supportsStreaming`).
- `src/kernel.ts` cannot inject a provider instance; it always calls `getLlmProvider()`.

### B. `server/src/agent/llm.ts` (server path)

This file is simpler and separate:

- `LLMConfig` is `(provider, apiKey, model, baseUrl?)`.
- `getLlmProvider(config)` returns an OpenAI-compatible `fetch` wrapper.
- It currently only knows `openai`, `groq`, and `openrouter` base URLs directly.

Architectural consequences:

- The server provider abstraction is not shared with `src/llm-providers.ts`.
- A duck-cli integration that only touches `src/` will not automatically affect the server/dashboard path.

## duck-cli Provider Layer Relevant To This Integration

### ProviderManager behavior

`duck-cli/src/providers/manager.ts` is the provider source of truth today.

What it already gives you:

- auto-loads `minimax`, `kimi`, `lmstudio`, `openrouter`, `openai`, `anthropic`, and `openclaw`,
- exposes `get(name?)`, `getActive()`, `setActive(name)`, `list()`,
- has a `route()` fallback chain,
- already accepts `DUCK_PROVIDER`, `DUCK_MODEL`, and `DUCK_PRIORITY` from the Go wrapper.

Important behaviors for DroidClaw:

1. `getActive()` is load-order dependent.
   - LM Studio is loaded first when available.
   - If you want MiniMax or Kimi specifically, do not rely on `getActive()`.
   - DroidClaw should resolve `get('minimax')` or `get('kimi')` explicitly unless the caller asked for the active provider.

2. `route()` is not MiniMax/Kimi-first.
   - The default route order prefers LM Studio, then OpenRouter free, then OpenClaw, then MiniMax, then Kimi.
   - That is fine for duck-cli chat, but wrong if DroidClaw is supposed to be pinned to MiniMax or Kimi.

3. duck-cli providers are text-first and non-streaming today.
   - The provider interface returns `{ text?, toolCalls?, error? }`.
   - There is no shared streaming interface for MiniMax/Kimi.
   - DroidClaw must treat duck-cli-backed MiniMax/Kimi as non-streaming unless you extend the provider layer.

### MiniMax specifics

duck-cli's MiniMax provider is useful for DroidClaw because it already handles a real incompatibility:

- it merges multiple system messages into one,
- and it normalizes non-system message content before sending.

That matters because DroidClaw can accumulate rich prompt state over time, and duck-cli has already encoded one of MiniMax's message-shape quirks.

### Kimi specifics

duck-cli's Kimi provider is a thin wrapper over the Moonshot/Kimi chat completions endpoint.

What matters for DroidClaw:

- model selection is already implemented,
- auth handling is already implemented,
- but there is no explicit DroidClaw-aware multimodal adaptation layer.

Inference from the source:

- The wrapper forwards `messages` as-is, so a multimodal adapter is possible.
- The current DroidClaw draft adapter throws away image parts by flattening everything to text, which defeats Kimi's main advantage for Android control.

## Why The Existing `src-adapter/` Draft Is Not A Safe Base

The repo already contains an adaptation attempt in `src-adapter/`, but it should be treated as an abandoned draft, not as the implementation plan.

### Problems in `src-adapter/duck-provider.ts`

- Imports from `../../../duck-cli-src/src/providers/manager.js`, which is not the active repo and couples DroidClaw to an old sibling path.
- Calls `providerManager.getProvider(...)`, but duck-cli's `ProviderManager` exposes `get(...)`, not `getProvider(...)`.
- Falls back to `getActive()`, which will often pick LM Studio instead of MiniMax/Kimi.
- Flattens `ContentPart[]` into plain text, so screenshots are lost.
- Adds a parallel `LLMProvider` shape instead of adapting the existing one cleanly.

### Problems in `src-adapter/android-agent-cli.ts`

- Imports `../agent/android-tools.js`, but no such module exists in the current duck-cli tree.
- Calls `providerManager.getProvider(...)`, which again does not exist.
- Reaches into `providerManager` internals instead of using its public API.

### Problems in `src-adapter/android-agent.ts`

- Contains syntax errors (`adbPull remote`, malformed scroll coordinate array).
- Contains typos (`SCCREENSHOT_LOCAL`).
- Reimplements DroidClaw logic instead of reusing the actual `src/` core.
- Reintroduces its own XML parsing and Android execution path, increasing divergence risk.

### Problems in build wiring

- DroidClaw `tsconfig.json` includes only `src/**/*.ts`; `src-adapter/**/*.ts` is not part of the build.
- `package.json` has no build/start script for the adapter path.

Conclusion:

The adapter draft proves the intended direction, but it is not a reliable implementation base. The real path should refactor the existing `src/` core to make it embeddable.

## Recommended Target Design

### Recommendation

Use DroidClaw's existing `src/` agent loop as the core, and inject duck-cli providers into it.

Do not build a second Android agent in `src-adapter/`.

### Target shape

1. `src/` becomes importable library code.
2. The CLI entrypoint moves to a small wrapper file.
3. Provider selection becomes injectable.
4. Runtime-specific operations (`spawn`, `sleep`, `read stdin`, `read file`) move behind a thin abstraction.
5. duck-cli owns provider selection and tool registration.
6. DroidClaw stays the Android reasoning/execution engine.

### Recommended abstraction split

Introduce three boundaries in DroidClaw:

1. `LlmBackend`
   - translates DroidClaw `ChatMessage[]` to provider calls,
   - owns capability flags (`supportsImages`, `supportsStreaming`),
   - can be backed by the existing OpenAI/OpenRouter/Bedrock logic or duck-cli.

2. `DeviceExecutor`
   - wraps ADB command execution and device targeting,
   - allows adding device serial support cleanly.

3. `RuntimeAdapter`
   - wraps sleep, stdin, file reads/writes, temp path management.

This keeps the actual perceive -> reason -> act logic in one place and avoids a second agent implementation.

## Provider Swap Plan: MiniMax and Kimi

### Recommended provider selection rules

For DroidClaw tool mode, do not use `ProviderManager.route()` by default.

Use explicit resolution order instead:

1. tool argument `provider`
2. tool argument `model`
3. `DUCK_PROVIDER` / `DUCK_MODEL`
4. current active duck-cli provider if the tool is being invoked from an existing `Agent` instance
5. DroidClaw default fallback: `minimax`, then `kimi`

Reason:

- The default router prefers LM Studio/OpenRouter/OpenClaw ahead of MiniMax/Kimi.
- The user's request here is specifically about swapping in duck-cli's MiniMax/Kimi providers.

### MiniMax adapter behavior

Recommended behavior:

- preserve text conversation as-is,
- merge multiple system messages using duck-cli's existing provider behavior,
- disable screenshots unless a verified MiniMax multimodal path is added,
- set `supportsImages = false` in the DroidClaw adapter until verified.

### Kimi adapter behavior

Recommended behavior:

- preserve DroidClaw `ContentPart[]` for user messages when screenshots are attached,
- send OpenAI-style multimodal content arrays through the Kimi provider wrapper,
- set `supportsImages = true` in the adapter only after validating the exact message shape Kimi accepts in this wrapper path.

Conservative default:

- first milestone: MiniMax text-only and Kimi text-only with no regressions,
- second milestone: enable Kimi screenshot support,
- third milestone: optionally add LM Studio/Gemma support after MiniMax/Kimi are stable.

### Streaming behavior

Because duck-cli providers do not expose streaming for MiniMax/Kimi today:

- set `supportsStreaming = false` in the duck-cli-backed provider adapter,
- and have DroidClaw skip `getDecisionStream()` for these providers.

This is a clean degradation path. Streaming can be added later without changing the rest of the agent loop.

## File-Level Change Plan In DroidClaw

This section is split into:

- required changes for `duck-cli` tool mode,
- optional changes if you also want DroidClaw's server/dashboard to use duck-cli providers.

### Required for `duck-cli` tool mode

#### 1. `src/kernel.ts`

Required changes:

- Remove the top-level `main()` side effect and move CLI startup into a separate wrapper file.
- Change `runAgent()` to accept an injected provider and optional runtime/device dependencies.
- Keep `runAgent()` pure enough to be called from duck-cli tool handlers.

Why:

- importing `src/kernel.ts` today will execute `main()` immediately,
- `runAgent()` currently hardcodes `getLlmProvider()` internally,
- duck-cli needs to call DroidClaw as a function, not as a script.

Suggested outcome:

- `src/agent.ts` or `src/lib/run-agent.ts` exports `runAgent()`.
- `src/kernel.ts` becomes a thin Bun CLI wrapper.

#### 2. `src/llm-providers.ts`

Required changes:

- Split provider factory from provider interfaces.
- Keep existing OpenAI/OpenRouter/Bedrock providers.
- Add `createDuckCliProviderAdapter(manager, selection)`.
- Make provider creation explicit, not global-only.

Why:

- this is the main seam where duck-cli MiniMax/Kimi belongs,
- current `getLlmProvider()` only understands Bun-side env config.

Suggested outcome:

- existing factory becomes `createDefaultLlmProvider(config)`.
- duck-cli tool path can inject `LLMProvider` directly.

#### 3. `src/config.ts`

Required changes:

- Add duck-cli-aware provider settings for tool mode.
- At minimum support `duck`, `minimax`, and `kimi` selection semantics.
- Add model overrides that map cleanly to duck-cli conventions.

Why:

- current config only understands `groq`, `openai`, `bedrock`, `openrouter`, and `ollama`.
- the tool needs a consistent way to select MiniMax/Kimi without abusing unrelated config keys.

Suggested additions:

- `DUCK_PROVIDER`
- `DUCK_MODEL`
- `ADB_SERIAL`
- maybe `DROIDCLAW_RUNTIME=node|bun` if you want dual-runtime support.

#### 4. `src/actions.ts`

Required changes:

- Replace direct `Bun.spawnSync` usage with an injected command runner or a small runtime helper.
- Add support for `ADB_SERIAL` so duck-cli can target a specific device.
- Consider session-scoped temp file paths if multiple runs may happen concurrently.

Why:

- duck-cli runs under Node, not Bun,
- current code assumes a single global `adb` target,
- current local paths are shared filenames (`window_dump.xml`, `kernel_screenshot.png`) and are not concurrency-safe.

#### 5. `src/skills.ts`

Required changes:

- Replace `Bun.sleepSync` calls with runtime helper usage.
- Reuse the same device executor abstraction as `src/actions.ts`.

Why:

- duck-cli tool mode will hit these skills for `submit_message`, `read_screen`, `find_and_tap`, etc.

#### 6. `src/workflow.ts`

Required changes:

- Allow workflow execution to reuse the injected provider and device/runtime dependencies.
- Replace `Bun.sleep` with runtime helper usage.

Why:

- a duck-cli tool should be able to run DroidClaw workflows without falling back to global Bun-only state.

#### 7. `src/flow.ts`

Required changes:

- Replace `Bun.sleepSync` / `Bun.sleep` usage.
- Ensure deterministic flows can run from the same tool runtime.

Why:

- deterministic flows are useful as low-risk Android tool subroutines in duck-cli.

#### 8. `src/constants.ts`

Required changes:

- Replace fixed local dump/screenshot filenames with per-run temp-path generation, or move them out of constants into runtime state.

Why:

- tool mode may run concurrently or across multiple devices.

#### 9. `.env.example`

Required changes:

- Document MiniMax/Kimi/duck-cli provider usage.
- Add `ADB_SERIAL` example.
- Mark old local-only provider settings as optional when running through duck-cli.

#### 10. `package.json`

Required changes:

- Add an adapter/library build path if DroidClaw is going to be consumed from duck-cli directly.
- If you keep a Bun wrapper, keep it thin and library-backed.

Why:

- current scripts only build and run the Bun entrypoint.

#### 11. `tsconfig.json`

Required changes:

- Build the importable library path, not only `src/kernel.ts`.
- If any integration code stays outside `src/`, include it properly or move it under `src/`.

Why:

- the current adapter draft is excluded from compilation completely.

### Optional if you also want full server/dashboard parity

If you want DroidClaw's hosted/server mode to use duck-cli providers too, also change:

#### 12. `server/src/agent/llm.ts`

- Add a duck-cli-backed provider path or shared adapter.
- Expand `BASE_URLS` / `DEFAULT_MODELS` only if you plan to keep direct HTTP mode.
- Prefer reusing the same adapter abstraction used by `src/llm-providers.ts`.

#### 13. `server/src/routes/goals.ts`

- Accept `minimax` / `kimi` provider values.
- If server mode will call into duck-cli provider code, make provider selection explicit and validated.

#### 14. `server/src/routes/investigate.ts`

- Same provider acceptance and config normalization as `goals.ts`.

#### 15. `server/src/ws/device.ts`

- Normalize any device-triggered provider config reads the same way as the HTTP routes.

#### 16. `web/src/routes/dashboard/settings/+page.svelte`

- Add MiniMax and Kimi to the provider list.
- Add sensible default model lists.
- Clarify whether credentials are raw provider credentials or duck-cli-managed credentials.

#### 17. `web/src/lib/schema/settings.ts`

- Add provider validation if you move beyond free-form provider strings.

#### 18. `README.md`

- Document the difference between Bun standalone mode and duck-cli tool mode.

## Recommended duck-cli Integration Shape

The DroidClaw-side refactor above should be paired with two duck-cli surfaces:

### 1. CLI command

Recommended command surface:

`duck android agent --goal "..." [--provider minimax|kimi] [--model ...] [--serial ...] [--max-steps N]`

duck-cli side implications:

- add a new Go subcommand under `cmd/duck/main.go`, probably under `agent` or a new `android` command,
- add a corresponding case in `duck-cli/src/cli/main.ts`,
- pass `-p/-m` through existing env handling,
- pass the Android serial explicitly.

### 2. Tool registry entry

Recommended tool:

`android_agent_run`

Suggested schema:

- `goal: string`
- `provider?: string`
- `model?: string`
- `serial?: string`
- `maxSteps?: number`
- `mode?: 'goal' | 'workflow' | 'flow'`
- `path?: string`

Recommended safety level:

- mark dangerous / approval-required in duck-cli,
- because it controls an external Android device.

## Phased Implementation Plan

### Phase 1: Make DroidClaw importable

Goal:

Get the current `src/` agent loop callable from another runtime without changing behavior.

Tasks:

1. Move CLI startup out of `src/kernel.ts`.
2. Introduce runtime helpers for sleep, spawn, file IO, stdin.
3. Add device serial support.
4. Replace shared temp file names with per-session paths.

Exit criteria:

- existing Bun CLI behavior still works,
- `runAgent()` can be imported without side effects.

### Phase 2: Add duck-cli provider adapter

Goal:

Run DroidClaw with duck-cli MiniMax/Kimi providers in-process.

Tasks:

1. Implement `DuckCliProviderAdapter` against `ProviderManager`.
2. Resolve provider selection explicitly with `get(name)`.
3. Preserve DroidClaw multimodal messages for Kimi path.
4. Disable streaming on this path.

Exit criteria:

- `runAgent(goal, { llmProvider })` works with `minimax` and `kimi`.
- No Bun-specific provider code is needed for that path.

### Phase 3: Register duck-cli command and tool

Goal:

Make DroidClaw available from duck-cli UX.

Tasks:

1. Add CLI command.
2. Add tool registry entry.
3. Add approval flow.
4. Expose device serial selection.

Exit criteria:

- direct CLI command works,
- an Agent instance can invoke DroidClaw as a tool.

### Phase 4: Optional full-stack parity

Goal:

Make DroidClaw's dashboard/server mode use the same provider backend.

Tasks:

1. Refactor `server/src/agent/llm.ts` to share adapter logic.
2. Add MiniMax/Kimi provider options in web settings.
3. Normalize route validation and stored config handling.

Exit criteria:

- server mode and local ADB mode can use the same provider family.

## Risks and Design Constraints

### 1. Cross-repo import coupling

Directly importing `duck-cli/src/providers/...` from DroidClaw is the fastest path, but it is brittle.

Preferred longer-term option:

- extract duck-cli provider code into a small shared package,
- e.g. `packages/duck-providers` or `packages/provider-core`,
- then have both repos depend on that.

This avoids fragile relative imports and duplicated provider logic.

### 2. Bun vs Node runtime mismatch

This is the main technical blocker for in-process integration.

If you want the fastest proof of concept, you can temporarily shell out from duck-cli into Bun. That would work, but it is not the clean architecture because:

- provider injection becomes harder,
- error handling is worse,
- tool UX is worse,
- and you still have two runtimes in the hot path.

Recommendation:

Use Bun subprocess mode only as a temporary spike, not as the final integration.

### 3. Vision support asymmetry

The provider abstraction must expose real capabilities.

Recommended initial truth table:

- MiniMax adapter: `supportsImages = false`, `supportsStreaming = false`
- Kimi adapter: `supportsImages = provisional`, `supportsStreaming = false`

Do not claim image support until Kimi's exact accepted message shape is validated through duck-cli's wrapper path.

### 4. Active provider ambiguity

Do not use `ProviderManager.getActive()` as DroidClaw's default unless the caller explicitly asked for the active provider.

Reason:

- load order may resolve to LM Studio or OpenRouter even when the intent is MiniMax/Kimi.

## Validation Plan

### Unit-level

1. Import DroidClaw core from Node without triggering CLI startup.
2. Inject fake providers and confirm `runAgent()` uses the injected provider.
3. Confirm MiniMax path merges system prompts correctly.
4. Confirm Kimi path preserves multimodal content arrays when enabled.

### Integration-level

1. `duck android agent --goal "open settings" --provider minimax`
2. `duck android agent --goal "open whatsapp" --provider kimi`
3. deterministic flow execution through duck-cli
4. workflow execution through duck-cli
5. multi-device selection with `--serial`

### Regression-level

1. Existing Bun standalone CLI still works.
2. Existing workflows still work.
3. Existing deterministic flows still work.
4. Existing OpenAI/OpenRouter/Groq/Bedrock/Ollama paths still work.

## Final Recommendation

If the immediate deliverable is a usable duck-cli Android tool, the implementation order should be:

1. Refactor DroidClaw `src/` into importable library code.
2. Add duck-cli provider injection there.
3. Use explicit `minimax` / `kimi` provider selection, not `route()` and not `getActive()`.
4. Register DroidClaw in duck-cli as a dangerous tool and CLI command.
5. Defer server/dashboard provider migration until after the local tool path is stable.

That produces the smallest correct integration surface, keeps DroidClaw's mature Android loop intact, and lets duck-cli own provider selection without forcing a second Android agent implementation.
