# duck-cli Provider — DroidClaw Integration

**Status:** ✅ Forked and adapted for Franzferdinan51/droidclaw

## What This Is

A new LLM provider for DroidClaw that routes calls through **duck-cli's multi-provider system** — giving DroidClaw access to Duckets' full model stack without needing separate API keys.

## Architecture

```
DroidClaw (perceive→reason→act)
    ↓
duck-cli Provider (LLM_PROVIDER=duck-cli)
    ↓
duck-cli's ProviderManager
    ├→ LM Studio (Gemma 4, Qwen 3.5) — LOCAL, FREE
    ├→ OpenClaw Gateway (kimi-k2.5) — FREE via OpenClaw
    ├→ OpenRouter (free tier models)
    ├→ MiniMax (quota + API credits)
    └→ Kimi (pay-per-use)
```

## Usage

```bash
# In .env
LLM_PROVIDER=duck-cli

# Preferred model for Android (Gemma 4 — vision + Android tool-calling trained!)
DUCK_CLI_MODEL=gemma-4-e4b-it

# Or use Kimi vision + coding
DUCK_CLI_MODEL=kimi-k2.5

# Or MiniMax fast reasoning
DUCK_CLI_MODEL=minimax/MiniMax-M2.7

# Or OpenRouter free tier
DUCK_CLI_MODEL=minimax/minimax-m2.5:free

# Provider priority chain (comma-separated)
DUCK_PRIORITY=gemma,kimi,minimax,openrouter

# bun run src/kernel.ts --goal "open WhatsApp"
bun run src/kernel.ts --goal "your Android task here"
```

## Model Routing

| DUCK_CLI_MODEL | Provider | Best For |
|----------------|----------|----------|
| `gemma-4-e4b-it` | LM Studio | **Android PREFERRED** — vision + tool-calling trained! |
| `google/gemma-4-26b-a4b` | LM Studio | Large Gemma 4, high quality |
| `kimi-k2.5` | Kimi/Moonshot | Vision + coding |
| `qwen3.5-9b` | LM Studio | Fast + local vision |
| `minimax/MiniMax-M2.7` | MiniMax | Fast reasoning |
| `minimax/minimax-m2.5:free` | OpenRouter | Free tier |

## duck-cli Provider Features

- **Auto-failover:** Tries providers in priority order until one succeeds
- **Vision support:** Gemma 4, Qwen 3.5, Kimi k2.5 have native vision
- **Tool calling:** Gemma 4 and OpenRouter support function calling
- **Retry with backoff:** Connection errors auto-retry with exponential backoff
- **No extra API keys:** LM Studio uses local models (no key needed!)
- **MiniMax system merge:** Combines multiple system prompts into one

## On-Phone Deployment

Since **Bun cannot run on Android** (glibc vs Bionic mismatch), the recommended deployment is:

```
┌─────────────────┐         ┌──────────────────┐
│  Android Phone   │   ADB   │  Mac/Linux (duck-cli) │
│                  │◄───────►│  - duck-cli Go binary │
│  Termux:API     │         │  - duck-cli TypeScript │
│  (execution)    │         │  - Provider routing    │
└─────────────────┘         │  - LLM reasoning        │
                            └──────────────────┘
                                      │
                               LM Studio / OpenRouter
                               / MiniMax / Kimi
```

**duck-cli Go binary works on Android** — it handles ADB execution on the phone while TypeScript on Mac/Linux handles LLM reasoning.

## duck-cli Android Agent

duck-cli has a full **DroidClaw-style agent loop** built-in:

```bash
# Run the perceive→reason→act loop
duck android agent "open WhatsApp and send the message hi"

# Uses Gemma 4 (LM Studio) by default — Android + vision trained!
```

Files: `duck-cli-src/src/android-agent/`
- `android-agent-service.ts` — Main agent loop
- `system-prompt.ts` — Full 22-action DroidClaw prompt
- `ui-parser.ts` — XML parsing + element filtering

## Environment Variables

```bash
# duck-cli Provider
LLM_PROVIDER=duck-cli
DUCK_CLI_MODEL=gemma-4-e4b-it

# LM Studio (local models — FREE!)
LMSTUDIO_URL=http://localhost:1234
LMSTUDIO_KEY=not-needed

# OpenClaw Gateway (kimi-k2.5 free via local gateway)
OPENCLAW_GATEWAY_URL=http://localhost:18789

# OpenRouter (Duckets' personal key — $0.20/month cap)
OPENROUTER_API_KEY=sk-or-v1-...

# MiniMax
MINIMAX_API_KEY=...

# Kimi
KIMI_API_KEY=...
```

## Files Changed

| File | Change |
|------|--------|
| `src/providers/duck-cli.ts` | **NEW** — Full provider implementation |
| `src/llm-providers.ts` | Added duck-cli to `getLlmProvider()` factory |
| `src/config.ts` | Added `DUCK_CLI_MODEL`, `DUCK_PRIORITY`, `OPENCLAW_GATEWAY_URL` |
| `src/android-agent/` | **NEW** — DroidClaw loop for duck-cli (separate integration) |

## Key Insight: Why Gemma 4 for Android?

Gemma 4 is specifically **trained on Android development** (Android Studio Agent Mode) and has:
- ✅ Native vision (screenshots)
- ✅ Tool-calling / function calling
- ✅ Autonomous agent behavior
- ✅ Runs LOCAL via LM Studio (FREE!)

This makes it the **perfect model for Android automation** — and it's what duck-cli uses by default for the Android agent.
