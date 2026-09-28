import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const EMPTY = {saves: {}, scores: []};

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    this.pending = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.file), {recursive: true});
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = {
        saves: parsed && typeof parsed.saves === 'object' ? parsed.saves : {},
        scores: Array.isArray(parsed?.scores) ? parsed.scores : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.flush();
    }
  }

  flush() {
    this.pending = this.pending.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.data), 'utf8');
      await rename(temp, this.file);
    });
    return this.pending;
  }

  async putSave(clientId, entry) {
    this.data.saves[clientId] = entry;
    await this.flush();
  }

  getSave(clientId) {
    return this.data.saves[clientId] || null;
  }

  async putScore(score) {
    const key = `${score.clientId}:${score.mode}:${score.period}`;
    const previous = this.data.scores.findIndex((item) => `${item.clientId}:${item.mode}:${item.period}` === key);
    if (previous >= 0) {
      const old = this.data.scores[previous];
      if (old.wave > score.wave || (old.wave === score.wave && old.kills >= score.kills)) return old;
      this.data.scores.splice(previous, 1);
    }
    this.data.scores.push(score);
    this.data.scores.sort((a, b) => b.wave - a.wave || b.kills - a.kills || a.time - b.time);
    this.data.scores = this.data.scores.slice(0, 1000);
    await this.flush();
    return score;
  }

  leaderboard(mode, period, limit = 10) {
    return this.data.scores
      .filter((item) => item.mode === mode && item.period === period)
      .sort((a, b) => b.wave - a.wave || b.kills - a.kills || a.time - b.time)
      .slice(0, limit);
  }
}

export function storePath(dataDir) {
  return join(dataDir, 'valhem.json');
}
