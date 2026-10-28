/**
 * 知识库写回：把已批准的知识卡落成 raw / wiki / index / log 四类文件。
 *
 * 红线：
 * - raw 只新增，已存在则跳过；
 * - wiki 已存在且内容不同视为冲突，**不覆盖**；
 * - index.md / log.md 只追加缺失行，绝不重写历史。
 */
import { knowledgeApi, type KnowledgeCard, type KnowledgeSourceText } from '../knowledge';
import { readTextFile, writeFileAtomic, type SyncDirectoryHandle } from './folderAccess';

export type KbWriteStatus = 'created' | 'exists' | 'conflict' | 'skipped' | 'appended';

export interface KbWriteResult {
  raw: KbWriteStatus;
  wiki: KbWriteStatus;
  index: KbWriteStatus;
  log: KbWriteStatus;
  path: string;
}

function yamlScalar(value: unknown): string {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_\u4e00-\u9fff./-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

/** 生成知识页 frontmatter；数组写成 `[a, b]`，空值跳过。 */
export function serializeKnowledgeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== null && item !== undefined && String(item).trim());
      if (items.length === 0) continue;
      lines.push(`${key}: [${items.map(yamlScalar).join(', ')}]`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join('\n');
}

function hasLine(text: string, line: string): boolean {
  const needle = line.trim();
  return text.split('\n').some((item) => item.trim() === needle);
}

async function appendUniqueLine(
  root: SyncDirectoryHandle,
  relPath: string,
  header: string,
  line: string,
): Promise<KbWriteStatus> {
  const trimmed = line.trim();
  if (!trimmed) return 'skipped';
  const existing = await readTextFile(root, relPath);
  if (existing === null) {
    await writeFileAtomic(root, relPath, `${header}\n\n${trimmed}\n`);
    return 'appended';
  }
  if (hasLine(existing, trimmed)) return 'exists';
  await writeFileAtomic(root, relPath, `${existing.replace(/\s+$/, '')}\n${trimmed}\n`);
  return 'appended';
}

/**
 * 把一张已批准的知识卡写入本地知识库。
 * @param root 知识库根目录句柄（需已授权 readwrite）
 * @param card 知识卡（含 kbTarget）
 * @returns 各文件写入状态
 */
export async function writeKnowledgeCard(
  root: SyncDirectoryHandle,
  card: KnowledgeCard,
  options: { source?: KnowledgeSourceText } = {},
): Promise<KbWriteResult> {
  const kb = (card.kbTarget || {}) as Record<string, unknown>;
  const wikiPath = String(kb.wikiPath || '');
  const wikiBody = String(kb.wikiBody || '');
  if (!wikiPath || !wikiBody) {
    throw new Error('该知识卡没有可写回的知识库页面');
  }

  const source = options.source ?? await knowledgeApi.getCardSource(card.id);

  let rawStatus: KbWriteStatus = 'skipped';
  const rawPath = String(kb.rawPath || '');
  if (rawPath.endsWith('.md') && source.rawText.trim()) {
    const existing = await readTextFile(root, rawPath);
    if (existing !== null) {
      rawStatus = 'exists';
    } else {
      await writeFileAtomic(root, rawPath, `${source.rawText.trim()}\n`);
      rawStatus = 'created';
    }
  }

  const frontmatter = (kb.frontmatter || {}) as Record<string, unknown>;
  const wikiText = [
    '---',
    serializeKnowledgeFrontmatter(frontmatter),
    '---',
    '',
    wikiBody.trim(),
    '',
  ].join('\n');
  const existingWiki = await readTextFile(root, wikiPath);
  let wikiStatus: KbWriteStatus;
  if (existingWiki === null) {
    await writeFileAtomic(root, wikiPath, wikiText);
    wikiStatus = 'created';
  } else if (existingWiki.trim() === wikiText.trim()) {
    wikiStatus = 'exists';
  } else {
    wikiStatus = 'conflict';
  }

  const indexStatus = await appendUniqueLine(
    root,
    'index.md',
    '# 知识库索引',
    String(kb.indexLine || ''),
  );
  const logStatus = await appendUniqueLine(
    root,
    'log.md',
    '# 操作日志',
    String(kb.logLine || ''),
  );

  return {
    raw: rawStatus,
    wiki: wikiStatus,
    index: indexStatus,
    log: logStatus,
    path: wikiPath,
  };
}
