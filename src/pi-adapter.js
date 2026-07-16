import { spawn } from 'node:child_process';

const PI_ARGS = ['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print'];

export class PiAdapter {
  constructor({ run = runProcess } = {}) {
    this.run = run;
  }

  async review(prompt) {
    return this.run('pi', PI_ARGS, prompt);
  }
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}
