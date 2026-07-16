import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export class StateStore {
  constructor(path = StateStore.defaultPath()) {
    this.path = path;
  }

  static defaultPath() {
    return join(homedir(), '.cache', 'pr-review-agent', 'state.json');
  }

  async isHandled(prId, marker) {
    const state = await this.#readState();
    return state.handled[`${prId}:${marker}`] === true;
  }

  async markHandled(prId, marker) {
    const state = await this.#readState();
    state.handled[`${prId}:${marker}`] = true;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async #readState() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.handled && typeof parsed.handled === 'object') {
        return { handled: parsed.handled };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    return { handled: {} };
  }
}
