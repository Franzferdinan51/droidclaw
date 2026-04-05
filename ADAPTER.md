# DroidClaw × duck-cli Integration

**Status:** Forked to [Franzferdinan51/droidclaw](https://github.com/Franzferdinan51/droidclaw) | Adapted for duck-cli ecosystem

---

## What Was Done

### 1. Forked DroidClaw
```
https://github.com/unitedbyai/droidclaw → Franzferdinan51/droidclaw
```
Already cloned at `~/.openclaw/workspace/droidclaw/`

### 2. Studied the Codebase
- **`src/kernel.ts`** — Main perceive→reason→act loop (457 lines)
- **`src/sanitizer.ts`** — XML parsing for Android accessibility trees
- **`src/llm-providers.ts`** — Provider abstraction (Groq, OpenAI, Bedrock, OpenRouter, Ollama)
- **`src/actions.ts`** — 28 ADB actions (tap, type, scroll, launch, etc.)
- **`src/skills.ts`** — Multi-step skills (read_screen, submit_message, compose_email)
- **`src/flow.ts`** — YAML flow runner (no-LLM deterministic execution)
- **`src/workflow.ts`** — JSON workflow runner (LLM-guided multi-app)
- **`examples/workflows/`** — 35 ready-to-use workflows

### 3. Bun on Phone — NOT POSSIBLE ❌
**Critical finding:** The Android phone's shell is extremely restricted:
```
/system/bin/sh  ← only this is available
curl: not found
bash: not found
wget: not found
python: not found
node: not found
busybox: not found
```
Bun cannot be installed via the standard `curl | bash` method. The `noexec` flag on `/data/local/tmp` also prevents running any pushed binaries.

**Conclusion:** DroidClaw MUST run on the Mac and control the phone via ADB. Native phone execution is not viable.

---

## Architecture Decision: Option B ✅

**DroidClaw as a `duck android agent` command in duck-cli**

```
┌─────────────────────────────────────────────────────────────┐
│                        Mac (duck-cli)                        │
│                                                              │
│   duck android agent "open settings"                         │
│         │                                                    │
│         ▼                                                    │
│   ┌─────────────────┐    ┌──────────────────────────────┐  │
│   │ ProviderManager │    │  Android Agent (perceive→     │  │
│   │                 │    │  reason→act loop)             │  │
│   │ • LM Studio     │    │                               │  │
│   │   gemma-4-e4b   │◄───│  1. PERCEIVE: uiautomator   │  │
│   │   (Android-     │    │     dump XML → parse UI      │  │
│   │    trained!)    │    │     elements                 │  │
│   │ • Kimi k2.5     │    │                               │  │
│   │   (vision)       │    │  2. REASON: LLM decides      │  │
│   │ • MiniMax M2.7  │    │     next action from         │  │
│   │   (reasoning)   │    │     goal + screen state      │  │
│   │ • OpenAI GPT-5  │    │                               │  │
│   │ • OpenRouter    │    │  3. ACT: execute via ADB     │  │
│   │   qwen3.6:free  │    │     tap/type/scroll/launch   │  │
│   └─────────────────┘    └──────────────────────────────┘  │
│                                    │                        │
└────────────────────────────────────┼────────────────────────┘
                                     │ adb (USB/WiFi)
                                     ▼
                          ┌─────────────────────────┐
                          │   Android Phone         │
                          │   Moto G Play 2026      │
                          │   IP: 192.168.1.251    │
                          │   Serial: ZT4227P8NK    │
                          └─────────────────────────┘
```

**vs. DroidClaw's Original Architecture:**
```
DroidClaw standalone: Bun on phone ←── noexec prevents this
DroidClaw standalone: Bun on Mac + ADB ←── same as our approach
```

---

## What Was Adapted

### New Files Created

| File | Purpose |
|------|---------|
| `src-adapter/duck-provider.ts` | Bridges DroidClaw's LLM call interface with duck-cli's ProviderManager |
| `src-adapter/android-agent.ts` | Core perceive→reason→act loop (Node.js, no Bun deps) |
| `src-adapter/android-agent-cli.ts` | CLI wrapper as `duck android agent` command |

### Key Changes from Original DroidClaw

1. **Removed Bun dependencies** — `Bun.spawnSync` → `child_process.exec`
2. **Removed `fast-xml-parser`** — Implemented minimal XML parser inline (no new deps)
3. **Replaced LLM provider system** — DroidClaw's own providers → duck-cli's ProviderManager
4. **Kept all 28 actions** — Same ADB action set, same sanitizer logic
5. **Kept workflow/flow runners** — Both JSON (LLM) and YAML (deterministic) formats preserved

### Provider Mapping

| DroidClaw Original | duck-cli Equivalent |
|-------------------|-------------------|
| `groq` (free tier) | `openrouter` (free tier: qwen3.6-plus:free) |
| `openai` (GPT-4o) | `kimi` (kimi-k2.5 — vision + coding) |
| `ollama` (local) | `lmstudio` (gemma-4-e4b-it — Android tool-calling trained!) |
| `bedrock` (Claude) | `openai` (GPT-5.4 — premium reasoning) |
| `openrouter` | `minimax` (M2.7 — fast, generous quota) |

**PREFERRED for Android:** `lmstudio/gemma-4-e4b-it` — Gemma 4 is specifically trained on Android Studio Agent Mode with tool-calling + vision capabilities.

---

## Integration with duck-cli

### duck-cli Tools (already exist)

The duck-cli already has a comprehensive Android tool set in `src/tools/android/`:
- `android_device_info` — Device model, Android version
- `android_device_list` — List connected devices
- `android_screenshot` — Capture screenshot
- `android_screen_text` — OCR text extraction
- `android_tap`, `android_swipe`, `android_type`, `android_long_press`
- `android_launch_app`, `android_get_ui_tree`, etc.

### New: `duck android agent` Command

```bash
# Single goal
duck android agent --goal "open settings and turn on dark mode"

# With specific provider
duck android agent --goal "send a message on WhatsApp" --provider kimi --max-steps 20

# Workflow (multi-app, LLM-guided)
duck android agent --workflow examples/workflows/messaging/whatsapp-broadcast.json

# Flow (deterministic, no LLM)
duck android agent --flow examples/flows/send-whatsapp.yaml
```

### Integration Points

1. **`src/orchestrator/core.ts`** — Already has perceive→reason→act loop structure. Can be extended to call `android-agent` for Android tasks.
2. **`src/providers/manager.ts`** — ProviderManager already handles Kimi, MiniMax, LM Studio, OpenAI, OpenRouter. No changes needed.
3. **`src/agent/android-tools.ts`** — Full ADB wrapper already exists. android-agent reuses this.
4. **`src/agent/core.ts`** — Agent core can spawn android-agent sub-agent for complex Android tasks.

---

## Next Steps (Full Integration)

### Phase 1: Standalone Tool ✅ (Done)
- [x] Fork DroidClaw to Franzferdinan51
- [x] Create adapter layer (duck-provider.ts, android-agent.ts)
- [x] Document architecture

### Phase 2: duck-cli Command
- [ ] Add `duck android agent` command to duck-cli's CLI (`src/cli/main.ts`)
- [ ] Add completion to the Agent's tool loop for Android tasks
- [ ] Register android-agent as a subagent in AgentCore

### Phase 3: Enhanced Perception
- [ ] Integrate duck-cli's `vision-analysis` skill for screenshot understanding
- [ ] Use Kimi kimi-k2.5 for screenshot analysis (best vision model)
- [ ] Add OCR fallback using apple-notes or vision-analysis

### Phase 4: Workflow Integration
- [ ] Make DroidClaw workflows callable from duck-cli's workflow runner
- [ ] Add duck-cli provider selection to workflow JSON format
- [ ] Support duck-cli skill calls within DroidClaw workflows

---

## Key Files Reference

```
droidclaw/
├── src/                          # Original DroidClaw source
│   ├── kernel.ts                 # Main agent loop (ORIGINAL - DO NOT MODIFY)
│   ├── actions.ts                # ADB actions (ORIGINAL)
│   ├── sanitizer.ts              # XML parsing (ORIGINAL)
│   ├── skills.ts                 # Multi-step skills (ORIGINAL)
│   ├── workflow.ts               # JSON workflow runner (ORIGINAL)
│   ├── flow.ts                   # YAML flow runner (ORIGINAL)
│   └── llm-providers.ts          # LLM abstraction (ORIGINAL - replace with duck-cli)
│
├── src-adapter/                  # duck-cli adaptation layer (NEW)
│   ├── duck-provider.ts          # Duck-cli ProviderManager adapter
│   ├── android-agent.ts          # Core agent loop (Node.js, no Bun)
│   └── android-agent-cli.ts      # CLI command wrapper
│
└── examples/
    ├── workflows/               # 35 LLM-guided workflows
    │   ├── messaging/
    │   ├── productivity/
    │   ├── research/
    │   └── lifestyle/
    └── flows/                   # 5 deterministic YAML flows
```

---

## Testing

```bash
# Check phone connection
adb devices -l
# Should show: adb-ZT4227P8NK-... device

# Test ADB shell access
adb -s ZT4227P8NK shell "getprop ro.product.model"
# Should show: moto_g_play_2026

# Test screen capture
adb -s ZT4227P8NK shell "uiautomator dump /sdcard/view.xml"
adb -s ZT4227P8NK pull /sdcard/view.xml /tmp/view.xml
# Check /tmp/view.xml for UI elements

# Run the adapted agent (once integrated into duck-cli)
duck android agent --goal "open settings"
```

---

## Technical Notes

### Why Gemma 4 for Android?
All Gemma 4 models have native **vision + tool-calling** capabilities AND are specifically trained on **Android Studio Agent Mode**. This makes Gemma 4 the ideal model for Android UI control tasks:
- Sees screenshots natively
- Has been trained on Android development workflows
- Supports autonomous tool-calling (tap, type, scroll as tools)
- Runs locally via LM Studio (free, fast)

### Why Kimi kimi-k2.5 as fallback?
Kimi kimi-k2.5 has:
- Best-in-class vision (256K context)
- Strong coding + reasoning
- Pay-per-use (Duckets' API key available)

### Bun on Phone — Confirmed Not Possible
The phone's Android shell is Toybox/Linux with no standard utilities:
```
/system/bin/sh ← only sh available
curl ❌ | bash ❌ | python ❌ | node ❌ | wget ❌
```
This confirms DroidClaw must run on Mac with ADB control.

---

*Adapted by sub-agent for duck-cli integration — 2026-04-05*
