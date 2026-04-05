# DroidClaw × duck-cli Integration

**Status:** Forked to [Franzferdinan51/droidclaw](https://github.com/Franzferdinan51/droidclaw) | Integrated into duck-cli

---

## What Was Done

### 1. Forked DroidClaw
```
https://github.com/unitedbyai/droidclaw → Franzferdinan51/droidclaw
```
Already cloned at `~/.openclaw/workspace/droidclaw/` and pushed to GitHub.

### 2. Studied the Codebase
- **`src/kernel.ts`** — Main perceive→reason→act loop (457 lines)
- **`src/sanitizer.ts`** — XML parsing for Android accessibility trees
- **`src/llm-providers.ts`** — Provider abstraction (Groq, OpenAI, Bedrock, OpenRouter, Ollama)
- **`src/actions.ts`** — 28 ADB actions (tap, type, scroll, launch, etc.)
- **`src/skills.ts`** — Multi-step skills (read_screen, submit_message, compose_email)
- **`src/flow.ts`** — YAML flow runner (deterministic execution)
- **`src/workflow.ts`** — JSON workflow runner (LLM-guided multi-app)
- **`examples/workflows/`** — 35 ready-to-use workflows

### 3. Bun on Phone — CONFIRMED NOT POSSIBLE ❌

**Root cause: glibc vs Bionic mismatch (NOT noexec)**

The Android phone's Bionic libc is incompatible with glibc-based binaries like Bun:
```
# Bun install fails because:
# - Android uses Bionic (Google's libc)
# - Bun requires glibc (standard Linux libc)
# - These are fundamentally different C libraries
```

The Go binary `duck` works on the phone because Go statically links everything — no libc dependency.

### 4. Architecture Decision: Option B ✅ — ALREADY IMPLEMENTED

**duck-cli already has `duck android agent` — fully integrated!**

```
duck android agent "open settings"
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                        Mac (duck)                            │
│                                                              │
│   Go layer: duck android agent "goal"                       │
│        │                                                    │
│        ▼                                                    │
│   runNodeWithEnv("android-agent goal")                      │
│        │                                                    │
│        ▼                                                    │
│   ┌─────────────────────────────────────────────────────┐ │
│   │ AndroidAgentService                                   │ │
│   │                                                      │ │
│   │  1. PERCEIVE: android.dumpUiXml() → UI elements    │ │
│   │  2. REASON:   ProviderManager.route() → LLM         │ │
│   │  3. ACT:      AndroidTools.tap/type/scroll/etc.     │ │
│   │  4. LOOP:    until done or MAX_STEPS (30)          │ │
│   │                                                      │ │
│   │ Uses duck-cli's ProviderManager:                     │ │
│   │  • LM Studio gemma-4-e4b-it (Android tool-calling)  │ │
│   │  • Kimi kimi-k2.5 (vision + coding)                 │ │
│   │  • MiniMax M2.7 (reasoning)                         │ │
│   │  • OpenRouter qwen3.6-plus:free (fallback)          │ │
│   └─────────────────────────────────────────────────────┘ │
│                         │                                  │
└─────────────────────────┼──────────────────────────────────┘
                          │ adb (USB/WiFi)
                          ▼
               ┌─────────────────────────┐
               │   Android Phone         │
               │   Moto G Play 2026      │
               │   IP: 192.168.1.251    │
               │   Serial: ZT4227P8NK    │
               └─────────────────────────┘
```

---

## duck-cli Integration Details

### Key Files
| File | Purpose |
|------|---------|
| `cmd/duck/main.go` | `agentCmd` cobra command → `runNodeWithEnv("android-agent goal")` |
| `src/cli/main.ts` | `case 'android-agent':` → `AndroidAgentService.run()` |
| `src/android-agent/android-agent-service.ts` | Core perceive→reason→act loop (748 lines) |
| `src/android-agent/ui-parser.ts` | XML parsing for UI elements (from DroidClaw) |
| `src/android-agent/system-prompt.ts` | LLM system prompt (from DroidClaw) |

### duck-cli Commands
```bash
# AI agent loop (DroidClaw-style)
duck android agent "open settings and turn on dark mode"
duck android agent "send a WhatsApp message"

# With specific provider
duck android agent "open settings" -p kimi

# Other Android commands
duck android dump              # Dump UI hierarchy
duck android screenshot       # Capture screen
duck android tap 540 960      # Tap coordinates
duck android find "Settings"   # Find and tap element
```

---

## Provider Selection (Smart Routing)

Duck-cli's `ProviderManager.route()` automatically selects the best provider:

| Priority | Provider | Model | Why |
|----------|----------|-------|-----|
| 1 | LM Studio | `gemma-4-e4b-it` | **Android Studio Agent Mode trained** + vision + tool-calling |
| 2 | Kimi | `kimi-k2.5` | Best-in-class vision (256K context) |
| 3 | MiniMax | `M2.7` | Fast, generous quota |
| 4 | OpenRouter | `qwen3.6-plus:free` | Free fallback (1M ctx) |

**Preferred for Android:** `gemma-4-e4b-it` via LM Studio — specifically trained on Android tool-calling + vision.

---

## What Was Adapted from DroidClaw

### Imported from DroidClaw (MIT License)
1. **UI parser** (`ui-parser.ts`) — Android accessibility tree → element list
2. **System prompt** (`system-prompt.ts`) — LLM prompt for Android control
3. **Perceive→reason→act loop pattern** — The core architecture of the agent

### Integrated with duck-cli
1. **ProviderManager** replaces DroidClaw's `llm-providers.ts` (Groq/Ollama only)
2. **AndroidTools** replaces DroidClaw's `actions.ts` (same 28 ADB actions)
3. **Go CLI layer** with `duck android agent` command

### NOT Imported (duck-cli already has equivalents)
- Bun-specific code (Bun can't run on Android)
- Groq provider (replaced by duck-cli's smart routing)
- YAML flow runner (duck-cli has its own workflow system)

---

## Testing

```bash
# Verify phone connection
adb devices -l
# Should show: adb-ZT4227P8NK-... device

# Test the agent (from Mac)
cd ~/.openclaw/workspace/duck-cli-src
go build -o ~/go/bin/duck ./cmd/duck/
duck android agent "open settings"
duck android agent "take a screenshot"
duck android agent "go home"
```

---

## Key Findings

### Why Bun Can't Run on Android
- **NOT noexec** — was my initial wrong guess
- **Actual cause:** glibc (Linux) vs Bionic (Android) — incompatible C standard libraries
- **Go works because:** Go binaries are statically linked — no libc dependency
- **The `duck` binary already works on Android** (it was pushed earlier)

### Why Gemma 4 is Perfect for Android
All Gemma 4 models have:
- ✅ Native **vision** (see screenshots)
- ✅ **Tool-calling** (tap, type, scroll as tools)
- ✅ Trained on **Android Studio Agent Mode** — exactly this use case!
- ✅ Runs locally via LM Studio (free, fast)

### Why Kimi kimi-k2.5 as Fallback
- Best-in-class **vision** (256K context)
- Strong **coding + reasoning**
- Pay-per-use (Duckets' API key)

---

## Architecture Summary

```
DroidClaw (upstream)
├── Perceive→reason→act kernel ✅ (imported pattern)
├── 28 ADB actions ✅ (same as duck-cli AndroidTools)
├── XML sanitizer ✅ (imported as ui-parser.ts)
├── Groq/Ollama providers ❌ (replaced by duck-cli ProviderManager)
└── Bun runtime ❌ (can't run on Android Bionic)

duck-cli (existing)
├── ProviderManager ✅ (smart routing, 5+ providers)
├── AndroidTools ✅ (28 ADB actions)
├── Go CLI layer ✅ (duck binary works on Android)
└── Agent orchestrator ✅ (multi-agent system)

Integration: DroidClaw's kernel pattern + UI parsing → duck-cli's ProviderManager + AndroidTools
```

---

*Adapted by sub-agent — 2026-04-05*
