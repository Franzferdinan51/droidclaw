/**
 * Duck-Android-Agent CLI Command
 * 
 * Usage:
 *   duck android agent "open settings and turn on dark mode"
 *   duck android agent --goal "open settings" --model kimi-k2.5
 *   duck android agent --workflow examples/workflows/messaging/whatsapp-broadcast.json
 * 
 * Provider priority (from duck-cli):
 *   1. LM Studio gemma-4-e4b-it (Android-specific tool-calling) — PREFERRED
 *   2. Kimi kimi-k2.5 (vision + coding)
 *   3. MiniMax M2.7 (reasoning)
 *   4. OpenRouter qwen3.6-plus:free (fallback)
 */

import { AndroidTools } from '../agent/android-tools.js';
import { ProviderManager } from '../providers/manager.js';
import { runAndroidAgent } from './android-agent.js';
import { existsSync, readFileSync } from 'fs';

interface AndroidAgentConfig {
  goal?: string;
  maxSteps?: number;
  provider?: string;
  model?: string;
  workflow?: string;
  serial?: string;
}

export async function androidAgentCommand(args: AndroidAgentConfig): Promise<void> {
  // Initialize Android tools
  const android = new AndroidTools();
  const devices = await android.refreshDevices();
  
  if (devices.length === 0) {
    console.error('❌ No Android device connected. Enable USB debugging and try again.');
    return;
  }

  // Use specified serial or first connected device
  if (args.serial) {
    android.setDevice(args.serial);
  }

  const device = android.getCurrentDevice();
  console.log(`\n🦆 Duck-Android-Agent`);
  console.log(`   Device: ${device?.model || device?.serial || 'Unknown'}`);
  console.log(`   State: ${device?.state || 'unknown'}`);

  // Initialize provider manager
  const providerManager = new ProviderManager();
  await providerManager.load();

  // Select provider
  const providerName = args.provider || pickBestAndroidProvider(providerManager);
  const provider = providerManager.getProvider(providerName);
  
  if (!provider) {
    console.error(`❌ Provider '${providerName}' not available.`);
    console.log(`   Available: ${Array.from((providerManager as any).providers.keys()).join(', ')}`);
    return;
  }

  console.log(`   Provider: ${providerName}`);

  // Load workflow or run single goal
  if (args.workflow) {
    await runWorkflow(args.workflow, provider, args.maxSteps);
  } else if (args.goal) {
    await runSingleGoal(args.goal, provider, args.maxSteps);
  } else {
    console.error('❌ Provide --goal or --workflow');
    console.log(`\nUsage:`);
    console.log(`  duck android agent --goal "open settings"`);
    console.log(`  duck android agent --workflow examples/workflows/research/weather-to-whatsapp.json`);
    console.log(`  duck android agent --goal "open settings" --provider kimi --max-steps 20`);
  }
}

async function runSingleGoal(
  goal: string,
  provider: any,
  maxSteps?: number
): Promise<void> {
  const result = await runAndroidAgent(
    goal,
    { name: provider.name, complete: provider.complete.bind(provider) },
    maxSteps
  );

  if (result.success) {
    console.log(`\n✅ Goal completed in ${result.stepsUsed} steps`);
    console.log(`   ${result.finalMessage}`);
  } else {
    console.log(`\n⚠️ Goal not completed (${result.stepsUsed} steps used)`);
    console.log(`   ${result.finalMessage}`);
  }
}

async function runWorkflow(
  workflowPath: string,
  provider: any,
  maxSteps?: number
): Promise<void> {
  if (!existsSync(workflowPath)) {
    console.error(`❌ Workflow file not found: ${workflowPath}`);
    return;
  }

  const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8'));
  console.log(`\n📋 Workflow: ${workflow.name}`);
  console.log(`   Steps: ${workflow.steps?.length || 0}`);

  for (let i = 0; i < (workflow.steps?.length || 0); i++) {
    const step = workflow.steps[i];
    const goal = step.goal;
    console.log(`\n--- Step ${i + 1}/${workflow.steps.length} ---`);
    console.log(`   Goal: ${goal}`);

    const result = await runAndroidAgent(
      goal,
      { name: provider.name, complete: provider.complete.bind(provider) },
      maxSteps
    );

    console.log(`   ${result.success ? '✅' : '⚠️'} ${result.finalMessage}`);
  }

  console.log(`\n✅ Workflow complete`);
}

function pickBestAndroidProvider(pm: ProviderManager): string {
  // Gemma 4 is specifically trained for Android tool-calling
  const providers = (pm as any).providers as Map<string, any>;
  
  if (providers.has('lmstudio')) return 'lmstudio';
  if (providers.has('kimi')) return 'kimi';
  if (providers.has('minimax')) return 'minimax';
  if (providers.has('openai')) return 'openai';
  if (providers.has('openrouter')) return 'openrouter';
  
  return Array.from(providers.keys())[0] || 'openclaw';
}
