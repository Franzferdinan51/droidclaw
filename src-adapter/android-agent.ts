/**
 * Duck-Android-Agent: DroidClaw Perceive→Reason→Act Loop for duck-cli
 * 
 * Adapts DroidClaw's AI agent loop to run as a duck-cli tool/command.
 * Uses duck-cli's ProviderManager (Kimi, MiniMax, LM Studio, GPT-4o).
 * Runs on the Mac, controls Android phone via ADB.
 * 
 * Architecture:
 *   duck-cli (Mac) ←→ ADB ←→ Android phone
 *        ↓
 *   duck-cli's ProviderManager
 *   ├── Kimi (kimi-k2.5) — vision + coding
 *   ├── MiniMax (M2.7) — reasoning
 *   ├── LM Studio (gemma-4-e4b-it) — Android-specific tool-calling
 *   └── OpenRouter free (qwen3.6) — fallback
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';

const execAsync = promisify(exec);

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_STEPS = parseInt(process.env.DUCK_ANDROID_MAX_STEPS || '30');
const STEP_DELAY_MS = parseInt(process.env.DUCK_ANDROID_STEP_DELAY || '2000');
const MAX_ELEMENTS = parseInt(process.env.DUCK_ANDROID_MAX_ELEMENTS || '40');
const MAX_HISTORY = parseInt(process.env.DUCK_ANDROID_MAX_HISTORY || '10');
const VISION_MODE = process.env.DUCK_ANDROID_VISION_MODE || 'fallback'; // 'off' | 'fallback' | 'always'
const SCREEN_DUMP_DEVICE = '/sdcard/view.xml';
const SCREEN_DUMP_LOCAL = '/tmp/duck-android-view.xml';
const SCREENSHOT_DEVICE = '/sdcard/screenshot.png';
const SCREENSHOT_LOCAL = '/tmp/duck-android-screenshot.png';
const ADB_SERIAL = process.env.DUCK_ANDROID_SERIAL || '';

// ─── ADB Helpers ──────────────────────────────────────────────────────────

async function adbShell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const serial = ADB_SERIAL ? `-s ${ADB_SERIAL}` : '';
  try {
    const { stdout, stderr } = await execAsync(`adb ${serial} shell "${cmd.replace(/"/g, '\\"')}"`, { timeout: 30000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (e: any) {
    return { stdout: '', stderr: e.message, exitCode: e.code || 1 };
  }
}

async function adbPull remote(path: string, local: string): Promise<void> {
  const serial = ADB_SERIAL ? `-s ${ADB_SERIAL}` : '';
  await execAsync(`adb ${serial} pull "${path}" "${local}"`);
}

async function adb(args: string[]): Promise<string> {
  const serial = ADB_SERIAL ? `-s ${ADB_SERIAL}` : '';
  const { stdout } = await execAsync(`adb ${serial} ${args.join(' ')}`, { timeout: 30000 });
  return stdout.trim();
}

// ─── UI Element Types ────────────────────────────────────────────────────

interface UIElement {
  id: string;
  text: string;
  type: string;
  center: [number, number];
  clickable: boolean;
  editable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  scrollable: boolean;
  longClickable: boolean;
  hint: string;
  action: 'tap' | 'type' | 'longpress' | 'scroll' | 'read';
  bounds: string;
}

// ─── XML Parsing ─────────────────────────────────────────────────────────

function parseUIElements(xmlContent: string): UIElement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
  });

  let parsed: any;
  try {
    parsed = parser.parse(xmlContent);
  } catch {
    return [];
  }

  const elements: UIElement[] = [];
  
  function traverse(node: any, depth = 0, parent = ''): void {
    if (!node || typeof node !== 'object') return;
    
    const attrs = node['@_'];
    if (attrs) {
      const bounds = attrs['bounds'] || attrs['android:bounds'] || '';
      const center = parseBounds(bounds);
      const text = attrs['text'] || attrs['android:text'] || '';
      const hint = attrs['hint'] || attrs['android:hint'] || '';
      const clickable = attrs['clickable'] === 'true' || attrs['android:clickable'] === 'true';
      const longClickable = attrs['long-clickable'] === 'true' || attrs['android:longClickable'] === 'true';
      const editable = attrs['editable'] === 'true' || attrs['android:editable'] === 'true';
      const enabled = attrs['enabled'] !== 'false' && attrs['android:enabled'] !== 'false';
      const checked = attrs['checked'] === 'true' || attrs['android:checked'] === 'true';
      const focused = attrs['focused'] === 'true' || attrs['android:focused'] === 'true';
      const scrollable = attrs['scrollable'] === 'true' || attrs['android:scrollable'] === 'true';
      const className = attrs['class'] || attrs['android:class'] || '';

      // Determine action
      let action: UIElement['action'] = 'tap';
      if (className.includes('EditText') || editable) action = 'type';
      else if (longClickable) action = 'longpress';
      else if (!clickable && text) action = 'read';

      if (center && (text || clickable || hint)) {
        elements.push({
          id: attrs['resource-id'] || `el_${elements.length}`,
          text: String(text),
          type: className,
          center,
          bounds,
          clickable,
          editable,
          enabled,
          checked,
          focused,
          scrollable,
          longClickable,
          hint: String(hint),
          action,
        });
      }
    }

    // Traverse children
    for (const key of Object.keys(node)) {
      if (key.startsWith('@_')) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c: any) => traverse(c, depth + 1, text));
      } else if (typeof child === 'object') {
        traverse(child, depth + 1, text);
      }
    }
  }

  const root = parsed?.hierarchy?.node;
  if (root) {
    traverse(Array.isArray(root) ? root : [root]);
  }

  return elements;
}

function parseBounds(bounds: string): [number, number] | null {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (match) {
    const x1 = parseInt(match[1]);
    const y1 = parseInt(match[2]);
    const x2 = parseInt(match[3]);
    const y2 = parseInt(match[4]);
    return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
  }
  return null;
}

// ─── Screen Capture ───────────────────────────────────────────────────────

interface ScreenState {
  elements: UIElement[];
  compactJson: string;
  screenshot?: string; // base64
}

async function captureScreen(): Promise<ScreenState> {
  mkdirSync('/tmp/duck-android', { recursive: true });
  
  // Dump accessibility tree
  try {
    await adbShell(`uiautomator dump ${SCREEN_DUMP_DEVICE}`);
    await adbPull(SCREEN_DUMP_DEVICE, SCREEN_DUMP_LOCAL);
  } catch {
    return { elements: [], compactJson: 'Error: Could not capture accessibility tree' };
  }

  if (!existsSync(SCREEN_DUMP_LOCAL)) {
    return { elements: [], compactJson: 'Error: Accessibility tree not found' };
  }

  const xmlContent = readFileSync(SCREEN_DUMP_LOCAL, 'utf-8');
  const elements = parseUIElements(xmlContent);
  
  // Score and filter to top elements
  const scored = elements.map(el => ({
    el,
    score: scoreElement(el),
  })).sort((a, b) => b.score - a.score).slice(0, MAX_ELEMENTS);

  const compactJson = JSON.stringify(scored.map(s => ({
    text: s.el.text,
    id: s.el.id,
    center: s.el.center,
    action: s.el.action,
    enabled: s.el.enabled,
    editable: s.el.editable,
    clickable: s.el.clickable,
    hint: s.el.hint,
    checked: s.el.checked,
  })));

  // Screenshot if in vision mode
  let screenshot: string | undefined;
  if (VISION_MODE !== 'off' && (VISION_MODE === 'always' || elements.length === 0)) {
    screenshot = await captureScreenshot();
  }

  return { elements, compactJson, screenshot };
}

function scoreElement(el: UIElement): number {
  let score = 0;
  if (el.text) score += 10;
  if (el.clickable) score += 8;
  if (el.editable) score += 7;
  if (el.enabled) score += 5;
  if (el.hint) score += 3;
  return score;
}

async function captureScreenshot(): Promise<string | null> {
  try {
    await adbShell(`screencap -p ${SCREENSHOT_DEVICE}`);
    await adbPull(SCREENSHOT_DEVICE, SCCREENSHOT_LOCAL);
    if (existsSync(SCREENSHOT_LOCAL)) {
      const buffer = readFileSync(SCREENSHOT_LOCAL);
      return buffer.toString('base64');
    }
  } catch {
    // Screenshot failed
  }
  return null;
}

// ─── Screen Hash ─────────────────────────────────────────────────────────

function computeScreenHash(elements: UIElement[]): string {
  return elements.map(e => `${e.id}|${e.text}|${e.center[0]},${e.center[1]}|${e.enabled}`).join(';');
}

function diffScreen(
  prev: UIElement[],
  curr: UIElement[]
): { changed: boolean; summary: string } {
  const hash1 = computeScreenHash(prev);
  const hash2 = computeScreenHash(curr);
  
  if (hash1 === hash2) {
    return { changed: false, summary: 'Screen has NOT changed since last action.' };
  }
  
  const prevTexts = new Set(prev.map(e => e.text).filter(Boolean));
  const currTexts = new Set(curr.map(e => e.text).filter(Boolean));
  const added = [...currTexts].filter(t => !prevTexts.has(t));
  const removed = [...prevTexts].filter(t => !currTexts.has(t));
  
  const parts: string[] = [];
  if (added.length > 0) parts.push(`New: ${added.slice(0, 3).join(', ')}`);
  if (removed.length > 0) parts.push(`Gone: ${removed.slice(0, 3).join(', ')}`);
  
  return { changed: true, summary: parts.join('. ') || 'Screen layout changed.' };
}

// ─── ADB Action Execution ─────────────────────────────────────────────────

async function executeAction(decision: any, elements: UIElement[]): Promise<{ success: boolean; message: string }> {
  const { action } = decision;

  try {
    switch (action) {
      case 'tap': {
        const [x, y] = decision.coordinates || [];
        if (!x || !y) return { success: false, message: 'Missing coordinates for tap' };
        await adbShell(`input tap ${x} ${y}`);
        return { success: true, message: `Tapped at ${x},${y}` };
      }
      
      case 'type': {
        const [x, y] = decision.coordinates || [];
        if (x && y) await adbShell(`input tap ${x} ${y}`);
        await adbShell(`input text "${(decision.text || '').replace(/"/g, '')}"`);
        return { success: true, message: `Typed: ${decision.text}` };
      }
      
      case 'enter': {
        await adbShell('input keyevent 66');
        return { success: true, message: 'Pressed Enter' };
      }
      
      case 'back': {
        await adbShell('input keyevent 4');
        return { success: true, message: 'Pressed Back' };
      }
      
      case 'home': {
        await adbShell('input keyevent 3');
        return { success: true, message: 'Pressed Home' };
      }
      
      case 'longpress': {
        const [x1, y1] = decision.coordinates || [];
        const [x2, y2] = decision.coordinates || decision.coordinates2 || decision.coordinates;
        if (!x1 || !y1) return { success: false, message: 'Missing coordinates for longpress' };
        await adbShell(`input swipe ${x1} ${y1} ${x2 || x1} ${y2 || y1} 1000`);
        return { success: true, message: `Longpressed at ${x1},${y1}` };
      }
      
      case 'scroll': {
        const dir = decision.direction || 'down';
        const coords = dir === 'up' ? [540 200 540 1200] : [540 1200 540 200];
        await adbShell(`input swipe ${coords[0]} ${coords[1]} ${coords[2]} ${coords[3]} 300`);
        return { success: true, message: `Scrolled ${dir}` };
      }
      
      case 'launch': {
        const pkg = decision.package;
        if (!pkg) return { success: false, message: 'Missing package name' };
        await adbShell(`am start -n ${pkg}`);
        return { success: true, message: `Launched ${pkg}` };
      }
      
      case 'switch_app': {
        const pkg = decision.package;
        if (!pkg) return { success: false, message: 'Missing package name' };
        await adbShell(`am start -n ${pkg}`);
        return { success: true, message: `Switched to ${pkg}` };
      }
      
      case 'clear': {
        await adbShell('input keyevent KEYCODE_DEL');
        for (let i = 0; i < 50; i++) {
          await adbShell('input keyevent 67');
        }
        return { success: true, message: 'Cleared text field' };
      }
      
      case 'clipboard_set': {
        const text = decision.text || '';
        await adbShell(`am broadcast -a clipper.set -e text "${text.replace(/"/g, '')}"`);
        return { success: true, message: 'Clipboard set' };
      }
      
      case 'wait': {
        await new Promise(r => setTimeout(r, 2000));
        return { success: true, message: 'Waited 2 seconds' };
      }
      
      case 'done': {
        return { success: true, message: 'Task complete' };
      }
      
      case 'find_and_tap': {
        const query = (decision.query || '').toLowerCase();
        const el = elements.find(e => 
          e.text.toLowerCase().includes(query) || 
          e.hint.toLowerCase().includes(query)
        );
        if (!el) return { success: false, message: `Could not find "${query}" on screen` };
        const [x, y] = el.center;
        await adbShell(`input tap ${x} ${y}`);
        return { success: true, message: `Found and tapped "${query}"` };
      }
      
      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (e: any) {
    return { success: false, message: `Action failed: ${e.message}` };
  }
}

// ─── Provider Interface (duck-cli compatible) ────────────────────────────

interface LLMProvider {
  name: string;
  complete(messages: any[]): Promise<{ text?: string; error?: string }>;
}

// Placeholder - actual provider is injected when run as duck-cli tool
let llmProvider: LLMProvider | null = null;

export function setProvider(provider: LLMProvider): void {
  llmProvider = provider;
}

// ─── Message History ─────────────────────────────────────────────────────

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildPrompt(
  goal: string,
  foregroundApp: string,
  lastResult: string,
  compactJson: string,
  screenChange: string,
  history: Message[]
): string {
  let prompt = `GOAL: ${goal}\n\n`;
  prompt += `FOREGROUND_APP: ${foregroundApp}\n\n`;
  prompt += `LAST_ACTION_RESULT: ${lastResult}\n\n`;
  prompt += `SCREEN_CONTEXT: ${compactJson}\n\n`;
  prompt += `SCREEN_CHANGE: ${screenChange}\n\n`;
  
  if (history.length > 0) {
    prompt += `CONVERSATION HISTORY (last ${Math.min(history.length, MAX_HISTORY)} turns):\n`;
    history.slice(-MAX_HISTORY).forEach(m => {
      prompt += `[${m.role}]: ${m.content.slice(0, 300)}\n`;
    });
  }
  
  return prompt;
}

// ─── Main Agent Loop ─────────────────────────────────────────────────────

export interface AgentResult {
  success: boolean;
  stepsUsed: number;
  finalMessage: string;
  history: Message[];
}

export async function runAndroidAgent(
  goal: string,
  provider?: LLMProvider,
  maxSteps = MAX_STEPS
): Promise<AgentResult> {
  const llm = provider || llmProvider;
  if (!llm) {
    throw new Error('No LLM provider set. Call setProvider() first.');
  }

  // Get device info
  let deviceInfo = '';
  try {
    const model = (await adbShell('getprop ro.product.model')).stdout.trim();
    const androidVer = (await adbShell('getprop ro.build.version.release')).stdout.trim();
    deviceInfo = `${model} (Android ${androidVer})`;
  } catch {
    deviceInfo = 'Unknown device';
  }

  console.log(`\n🦆 Duck-Android-Agent`);
  console.log(`   Device: ${deviceInfo}`);
  console.log(`   Goal: ${goal}`);
  console.log(`   Provider: ${llm.name}`);
  console.log(`   Max steps: ${maxSteps}\n`);

  const history: Message[] = [];
  let prevElements: UIElement[] = [];
  let prevHash = '';
  const recentActions: string[] = [];
  
  const systemMsg: Message = {
    role: 'system',
    content: getSystemPrompt(),
  };

  for (let step = 1; step <= maxSteps; step++) {
    console.log(`\n--- step ${step}/${maxSteps} ---`);
    
    // 1. PERCEIVE: capture screen
    const screen = await captureScreen();
    const { changed, summary } = diffScreen(prevElements, screen.elements);
    
    // Get foreground app
    let foregroundApp = 'unknown';
    try {
      const output = await adbShell('dumpsys activity activities | grep mResumedActivity | head -1');
      const match = output.stdout.match(/([^\s\/]+)\/([^\s\/]+)/);
      if (match) foregroundApp = match[1];
    } catch { /* ignore */ }

    // 2. REASON: get LLM decision
    const lastResult = history.length > 0 
      ? (history[history.length - 1].content.match(/RESULT: (.*)/)?.[1] || 'N/A')
      : 'First step';
    
    const userContent = buildPrompt(
      goal,
      foregroundApp,
      lastResult,
      screen.compactJson,
      changed ? summary : 'Screen has NOT changed.',
      history
    );

    const messages: Message[] = [systemMsg, ...history.slice(-MAX_HISTORY), { role: 'user', content: userContent }];
    
    // Detect stuck loops
    const stuckHint = detectStuckLoop(recentActions, changed);
    
    let decision: any;
    try {
      const result = await llm.complete(messages);
      
      if (result.error) {
        console.log(`LLM Error: ${result.error}`);
        break;
      }
      
      decision = parseDecision(result.text || '');
      console.log(`think: ${(decision.think || decision.action || 'deciding').slice(0, 100)}`);
      console.log(`action: ${decision.action} ${formatAction(decision)}`);
    } catch (e: any) {
      console.log(`LLM call failed: ${e.message}`);
      break;
    }

    // Track recent actions
    const actionKey = `${decision.action}:${JSON.stringify(decision.coordinates || '')}`;
    recentActions.push(actionKey);
    if (recentActions.length > 5) recentActions.shift();

    // Add stuck hint if needed
    if (stuckHint && !decision.think?.includes('stuck')) {
      decision.think = (decision.think || '') + ` [RECOVERY HINT: ${stuckHint}]`;
    }

    // 3. ACT: execute decision
    const actionResult = await executeAction(decision, screen.elements);
    console.log(`→ ${actionResult.message}`);

    // Record in history
    history.push({
      role: 'user',
      content: `RESULT: ${actionResult.message}\nSCREEN_CHANGE: ${changed ? summary : 'No change detected'}`,
    });
    history.push({
      role: 'assistant',
      content: JSON.stringify(decision),
    });

    // Update prev state
    prevElements = screen.elements;
    prevHash = computeScreenHash(screen.elements);

    // Wait between steps
    await new Promise(r => setTimeout(r, STEP_DELAY_MS));

    // Check if done
    if (decision.action === 'done') {
      return {
        success: true,
        stepsUsed: step,
        finalMessage: actionResult.message,
        history,
      };
    }
  }

  return {
    success: false,
    stepsUsed: maxSteps,
    finalMessage: `Reached max steps (${maxSteps}) without completing goal.`,
    history,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getSystemPrompt(): string {
  return `You are an Android Driver Agent. Your job is to achieve the user's goal by navigating the Android UI.

You will receive GOAL, FOREGROUND_APP, LAST_ACTION_RESULT, SCREEN_CONTEXT (JSON of UI elements), and SCREEN_CHANGE info.

Output ONLY a valid JSON object with your next action:
{"action": "tap|scroll|type|enter|back|home|launch|switch_app|wait|done", "coordinates": [x, y], "text": "...", "reason": "...", "think": "..."}

Rules:
1. NEVER tap disabled elements
2. ALWAYS include coordinates with type
3. NEVER tap same coordinates twice in a row
4. Use "launch" with package name to open apps directly
5. Say "done" when goal is achieved
6. If stuck (screen not changing), try a different approach
7. Prefer "find_and_tap" with text query over coordinate tapping`;
}

function parseDecision(text: string): any {
  try {
    // Try direct parse
    return JSON.parse(text);
  } catch {
    // Try extracting from code block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch { /* try raw */ }
    }
    // Try finding JSON object
    const raw = text.match(/\{[\s\S]*\}/);
    if (raw) {
      try {
        return JSON.parse(raw[0]);
      } catch { /* give up */ }
    }
  }
  return { action: 'done', reason: `Could not parse LLM response: ${text.slice(0, 100)}` };
}

function formatAction(d: any): string {
  if (d.coordinates) return `(${d.coordinates.join(',')})`;
  if (d.text) return `"${d.text.slice(0, 30)}"`;
  if (d.direction) return d.direction;
  if (d.package) return d.package;
  return '';
}

function detectStuckLoop(recentActions: string[], screenChanged: boolean): string | null {
  if (recentActions.length < 3) return null;
  
  const last3 = recentActions.slice(-3);
  if (last3.every(a => a === last3[0])) {
    return 'Repeating the same action. Try a completely different approach.';
  }
  
  if (!screenChanged && last3.every(a => a.startsWith('tap:'))) {
    return 'Tap is not changing the screen. Try launching the app directly or using a different element.';
  }
  
  return null;
}
