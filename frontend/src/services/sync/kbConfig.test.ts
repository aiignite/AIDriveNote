import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindSyncOwner,
  defaultSyncConfig,
  loadSyncConfig,
  saveSyncConfig,
} from './kbConfig';

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

describe('sync config owner isolation', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('migrates legacy config once and isolates users', () => {
    const legacy = defaultSyncConfig();
    legacy.notes.enabled = true;
    localStorage.setItem('aidrivenote.sync.sources', JSON.stringify(legacy));

    bindSyncOwner('user-a');
    expect(loadSyncConfig().notes.enabled).toBe(true);
    expect(localStorage.getItem('aidrivenote.sync.sources')).toBeNull();

    bindSyncOwner('user-b');
    expect(loadSyncConfig().notes.enabled).toBe(false);
    const bConfig = defaultSyncConfig();
    bConfig.notes.enabled = false;
    bConfig.kb.enabled = true;
    saveSyncConfig(bConfig);

    bindSyncOwner('user-a');
    expect(loadSyncConfig().notes.enabled).toBe(true);
    expect(loadSyncConfig().kb.enabled).toBe(false);

    bindSyncOwner('user-b');
    expect(loadSyncConfig().kb.enabled).toBe(true);

    bindSyncOwner(null);
    expect(loadSyncConfig().kb.enabled).toBe(false);
  });
});
