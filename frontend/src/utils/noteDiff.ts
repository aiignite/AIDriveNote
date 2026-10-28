/** 笔记版本对比：把不同笔记类型展开为纯文本，再做行级 diff。 */
import type { Note } from '../services/note';

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 原/新文本中的行号（用于展示） */
  oldLine?: number;
  newLine?: number;
}

const MAX_DIFF_LINES = 1200;

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const record = block as Record<string, unknown>;
  const content = record.content;
  let text = '';
  if (Array.isArray(content)) {
    text = content
      .map(item => (item && typeof item === 'object' ? String((item as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  const children = record.children;
  if (Array.isArray(children) && children.length > 0) {
    text += '\n' + children.map(blockText).filter(Boolean).join('\n');
  }
  return text;
}

function mindmapText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  const data = (record.data ?? {}) as { text?: unknown };
  const lines = [String(data.text ?? '')];
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const childText = mindmapText(child);
      if (childText) lines.push(childText.split('\n').map(line => `  ${line}`).join('\n'));
    }
  }
  return lines.filter(Boolean).join('\n');
}

/** 把笔记 content 展开成纯文本（diff / 查找用）。 */
export function contentToPlainText(noteType: Note['noteType'], content: unknown): string {
  if (content == null) return '';
  if (noteType === 'markdown') {
    return typeof content === 'object' ? String((content as { text?: unknown }).text ?? '') : String(content);
  }
  if (noteType === 'rich_text') {
    const blocks = (content as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) return blocks.map(blockText).filter(Boolean).join('\n');
  }
  if (noteType === 'mindmap') {
    return mindmapText(content);
  }
  if (noteType === 'flowchart') {
    const xml = String((content as { xml?: unknown }).xml ?? '');
    return Array.from(xml.matchAll(/value="([^"]*)"/g)).map(match => match[1]).join('\n');
  }
  if (noteType === 'document') return '';
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

/** 行级 LCS diff；超长文本只比较前 MAX_DIFF_LINES 行，避免卡死 UI。 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const split = (text: string) =>
    (text === '' ? [] : text.split('\n')).slice(0, MAX_DIFF_LINES);
  const oldLines = split(oldText);
  const newLines = split(newText);
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: 'same', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: 'del', text: oldLines[i], oldLine: i + 1 });
      i += 1;
    } else {
      result.push({ kind: 'add', text: newLines[j], newLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ kind: 'del', text: oldLines[i], oldLine: i + 1 });
    i += 1;
  }
  while (j < m) {
    result.push({ kind: 'add', text: newLines[j], newLine: j + 1 });
    j += 1;
  }
  return result;
}
