#!/usr/bin/env node
import { GitHubAdapter } from './github-adapter.js';
import { Orchestrator } from './orchestrator.js';
import { PiAdapter } from './pi-adapter.js';
import { StateStore } from './state-store.js';

const options = parseArgs(process.argv.slice(2));
const orchestrator = new Orchestrator({
  github: new GitHubAdapter(),
  pi: new PiAdapter(),
  state: new StateStore(),
  dryRun: options.dryRun,
});

if (options.once) {
  const summary = await orchestrator.runTick();
  console.log(JSON.stringify(summary));
} else {
  orchestrator.startPolling(options.intervalMs);
  console.log(`pr-review-agent polling every ${options.intervalMs}ms${options.dryRun ? ' (dry run)' : ''}`);
}

function parseArgs(args) {
  const options = { once: false, dryRun: false, intervalMs: 300_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--interval-ms') {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--interval-ms requires a positive integer');
      }
      options.intervalMs = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}
