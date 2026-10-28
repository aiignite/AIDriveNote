import { describe, expect, it } from 'vitest';
import type { Note } from '../note';
import {
  kbDescriptionFromFrontmatter,
  kbFileTags,
  kbTagsFromFrontmatter,
  parseFrontmatter,
  serializeNoteText,
} from './syncEngine';

const note: Note = {
  id: 'note-1',
  noteNo: 'T0001',
  title: '执行器选型讨论',
  noteType: 'markdown',
  status: 'Active',
  isPinned: false,
  isDeleted: false,
  content: { text: '> 摘要：优先锁定产能\n\n## 要点\n- 优先选择博世' },
  description:
    '[kb] confidence: low | sources: [raw/notes/x.md] | related: [wiki/entities/博世.md]',
  tags: [
    { id: 't1', name: 'kb:decision', color: '#000' },
    { id: 't2', name: 'topic:产品开发', color: '#000' },
    { id: 't3', name: '执行器', color: '#000' },
  ],
  updatedAt: '2026-10-28T00:00:00Z',
};

describe('knowledge base frontmatter', () => {
  it('writes type/topic/sources/related/confidence and round-trips', () => {
    const text = serializeNoteText(note, 'wiki/decisions/执行器选型讨论.md', kbFileTags(note), {
      writeAppKeys: false,
      idKey: null,
    });

    expect(text).toContain('type: decision');
    expect(text).toContain('topic: 产品开发');
    expect(text).toContain('confidence: low');
    expect(text).toContain('sources: [raw/notes/x.md]');
    expect(text).toContain('related: [wiki/entities/博世.md]');
    // 派生标签不写回文件，避免同步震荡
    expect(text).toContain('tags: [执行器]');

    const fm = parseFrontmatter(text);
    expect(fm.data.type).toBe('decision');
    expect(fm.data.topic).toBe('产品开发');
    expect(fm.data.sources).toBe('[raw/notes/x.md]');
    expect(kbTagsFromFrontmatter(fm, fm.tags)).toEqual(
      expect.arrayContaining(['执行器', 'kb:decision', 'topic:产品开发']),
    );
    expect(kbDescriptionFromFrontmatter(fm)).toBe(
      '[kb] confidence: low | sources: [raw/notes/x.md] | related: [wiki/entities/博世.md]',
    );
  });
});
