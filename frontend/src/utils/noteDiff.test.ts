import { describe, expect, it } from 'vitest';
import { contentToPlainText, diffLines } from './noteDiff';

describe('contentToPlainText', () => {
  it('extracts markdown text', () => {
    expect(contentToPlainText('markdown', { text: '# 标题\n\n正文' })).toBe('# 标题\n\n正文');
  });

  it('flattens rich text blocks and nested children', () => {
    const content = {
      blocks: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
        {
          type: 'bulletListItem',
          content: [{ type: 'text', text: '父节点' }],
          children: [{ type: 'paragraph', content: [{ type: 'text', text: '子节点' }] }],
        },
      ],
    };
    const text = contentToPlainText('rich_text', content);
    expect(text).toContain('第一段');
    expect(text).toContain('父节点');
    expect(text).toContain('子节点');
  });

  it('extracts flowchart labels from draw.io xml', () => {
    const content = { xml: '<mxCell value="提交申请"/><mxCell value="审批通过"/>' };
    expect(contentToPlainText('flowchart', content)).toBe('提交申请\n审批通过');
  });

  it('handles empty content', () => {
    expect(contentToPlainText('markdown', null)).toBe('');
  });
});

describe('diffLines', () => {
  it('marks unchanged, added and removed lines', () => {
    const diff = diffLines('a\nb\nc', 'a\nc\nd');
    expect(diff.filter(line => line.kind === 'same').map(line => line.text)).toEqual(['a', 'c']);
    expect(diff.find(line => line.kind === 'del')?.text).toBe('b');
    expect(diff.find(line => line.kind === 'add')?.text).toBe('d');
  });

  it('treats identical text as all same', () => {
    const diff = diffLines('同一行\n第二行', '同一行\n第二行');
    expect(diff.every(line => line.kind === 'same')).toBe(true);
  });

  it('returns additions for empty old text', () => {
    const diff = diffLines('', '新内容');
    expect(diff).toEqual([{ kind: 'add', text: '新内容', newLine: 1 }]);
  });

  it('returns deletions for empty new text', () => {
    const diff = diffLines('旧内容', '');
    expect(diff).toEqual([{ kind: 'del', text: '旧内容', oldLine: 1 }]);
  });
});
