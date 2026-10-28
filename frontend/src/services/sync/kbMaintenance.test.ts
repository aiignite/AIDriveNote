import { describe, expect, it } from 'vitest';
import type { KnowledgeCard, KnowledgeSourceText } from '../knowledge';
import type { SyncDirectoryHandle } from './folderAccess';
import { serializeKnowledgeFrontmatter, writeKnowledgeCard } from './kbMaintenance';

class FakeFile {
  content = '';
  arrayBuffer = async () => new TextEncoder().encode(this.content).buffer;
}

class FakeFileHandle {
  constructor(private readonly file: FakeFile) {}

  async getFile() {
    return this.file as unknown as File;
  }

  async createWritable() {
    const file = this.file;
    return {
      write: async (data: string) => { file.content = String(data); },
      close: async () => {},
    };
  }
}

function notFound(): Error {
  return new DOMException('not found', 'NotFoundError');
}

class FakeDir {
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw notFound();
      dir = new FakeDir();
      this.dirs.set(name, dir);
    }
    return dir as unknown as SyncDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw notFound();
      file = new FakeFile();
      this.files.set(name, file);
    }
    return new FakeFileHandle(file);
  }
}

function read(root: FakeDir, path: string): string {
  const parts = path.split('/');
  const name = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = dir.dirs.get(part)!;
  }
  return dir.files.get(name)?.content ?? '';
}

const card: KnowledgeCard = {
  id: 'card-1',
  documentId: 'doc-1',
  status: 'approved',
  knowledgeType: 'concept',
  title: '出风口执行器',
  summary: '执行器用于控制风门角度。',
  confidence: 'low',
  keyPoints: ['控制风门角度'],
  keywords: ['执行器'],
  entities: [],
  claims: [],
  topic: '产品开发',
  tags: ['kb:concept', 'topic:产品开发'],
  needsReview: false,
  mergeTarget: null,
  noteId: 'note-1',
  extractor: 'rule',
  model: null,
  createdAt: null,
  source: {
    documentId: 'doc-1',
    type: 'email',
    title: '测试邮件',
    url: null,
    occurredAt: null,
    status: 'approved',
    parser: 'text',
    parseMeta: {},
    error: null,
  },
  kbTarget: {
    rawPath: 'raw/notes/2026-10-28-出风口执行器.md',
    wikiPath: 'wiki/concepts/出风口执行器.md',
    wikiBody: '> 摘要：执行器用于控制风门角度。\n\n## 要点\n- 控制风门角度',
    frontmatter: {
      title: '出风口执行器',
      type: 'concept',
      tags: ['执行器'],
      topic: '产品开发',
      sources: ['raw/notes/2026-10-28-出风口执行器.md'],
      related: [],
      confidence: 'low',
    },
    indexLine: '- [出风口执行器](wiki/concepts/出风口执行器.md) — 执行器用于控制风门角度。',
    logLine: '- 2026-10-28 ingest email → wiki/concepts/出风口执行器.md',
    mode: 'new',
  },
};

const source: KnowledgeSourceText = {
  rawText: '## 摘要\n执行器用于控制风门角度。',
  rawMeta: {},
  source: card.source,
};

describe('knowledge base maintenance', () => {
  it('writes raw/wiki/index/log once and never overwrites a conflicting wiki page', async () => {
    const root = new FakeDir();
    const first = await writeKnowledgeCard(root as unknown as SyncDirectoryHandle, card, { source });
    expect(first.raw).toBe('created');
    expect(first.wiki).toBe('created');
    expect(first.index).toBe('appended');
    expect(first.log).toBe('appended');
    expect(read(root, 'raw/notes/2026-10-28-出风口执行器.md')).toContain('控制风门角度');
    expect(read(root, 'wiki/concepts/出风口执行器.md')).toContain('type: concept');
    expect(read(root, 'index.md')).toContain('出风口执行器');
    expect(read(root, 'log.md')).toContain('ingest email');

    const second = await writeKnowledgeCard(root as unknown as SyncDirectoryHandle, card, { source });
    expect(second.raw).toBe('exists');
    expect(second.wiki).toBe('exists');
    expect(second.index).toBe('exists');
    expect(second.log).toBe('exists');

    const wiki = root.dirs.get('wiki')!.dirs.get('concepts')!.files.get('出风口执行器.md')!;
    wiki.content = '手工修改后的知识页';
    const third = await writeKnowledgeCard(root as unknown as SyncDirectoryHandle, card, { source });
    expect(third.wiki).toBe('conflict');
    expect(read(root, 'wiki/concepts/出风口执行器.md')).toBe('手工修改后的知识页');
  });

  it('serializes arrays and skips empty frontmatter values', () => {
    const text = serializeKnowledgeFrontmatter({
      title: '出风口执行器',
      type: 'concept',
      tags: ['执行器', '风门'],
      topic: '',
      sources: ['raw/notes/a.md'],
      confidence: 'low',
    });
    expect(text).toContain('tags: [执行器, 风门]');
    expect(text).toContain('sources: [raw/notes/a.md]');
    expect(text).not.toContain('topic:');
  });
});
