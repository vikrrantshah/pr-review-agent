import { spawn } from 'node:child_process';

export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export function runProcess(command, args, input, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, cwd, env, requireStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer;

    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1000);
    }, timeoutMs) : undefined;

    const clearProcessTimers = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearProcessTimers();
      reject(error);
    });
    child.on('close', (code) => {
      clearProcessTimers();
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        if (requireStdout && stdout.trim().length === 0) {
          reject(new Error(`${command} exited with 0 but produced no stdout${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}
