#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createLogger, formatStartup, formatSummary } from './loggers.js';
import { GitHubAdapter } from './github-adapter.js';
import { Orchestrator } from './orchestrator.js';
import { PiAdapter } from './pi-adapter.js';
import { StateStore } from './state-store.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logger = createLogger({ format: options.logFormat, color: process.stdout.isTTY });
  const orchestrator = new Orchestrator({
    github: new GitHubAdapter(),
    pi: new PiAdapter({ model: options.piModel, thinking: options.piThinking }),
    state: new StateStore(),
    dryRun: options.dryRun,
    concurrency: options.concurrency,
    logger,
  });

  if (options.once) {
    const summary = await orchestrator.runTick();
    logger.logText(options.logFormat === 'json' ? JSON.stringify({ event: 'tick_completed', ...summary }) : formatSummary(summary));
  } else {
    orchestrator.startPolling(options.intervalMs);
    logger.logText(options.logFormat === 'json' ? JSON.stringify({ event: 'agent_started', intervalMs: options.intervalMs, concurrency: options.concurrency, dryRun: options.dryRun }) : formatStartup(options));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function parseArgs(args) {
  const options = { once: false, dryRun: false, intervalMs: 60_000, concurrency: 3, logFormat: 'pretty' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
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
    } else if (arg === '--concurrency') {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--concurrency requires a positive integer');
      }
      options.concurrency = value;
      index += 1;
    } else if (arg === '--log-format') {
      const value = args[index + 1];
      if (value !== 'pretty' && value !== 'json') {
        throw new Error('--log-format requires pretty or json');
      }
      options.logFormat = value;
      index += 1;
    } else if (arg === '--pi-model') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--pi-model requires a model name');
      }
      options.piModel = value;
      index += 1;
    } else if (arg === '--pi-thinking') {
      const value = args[index + 1];
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
        throw new Error('--pi-thinking requires off, minimal, low, medium, high, xhigh, or max');
      }
      options.piThinking = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}
