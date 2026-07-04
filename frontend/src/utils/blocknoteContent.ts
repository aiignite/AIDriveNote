/**
 * BlockNote 富文本 blocks 规范化 — 确保 AI 写入/外部导入的 JSON 能被 BlockNote 正确渲染。
 */
import type { PartialBlock } from '@blocknote/core';

const BASE_PROPS = {
  textColor: 'default',
  backgroundColor: 'default',
  textAlignment: 'left',
} as const;

const VALID_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'codeBlock',
  'quote',
]);

type RawBlock = Record<string, unknown>;

function normalizeInlineContent(content: unknown): PartialBlock['content'] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => {
      if (item.type === 'link' && typeof item.href === 'string') {
        return {
          type: 'link' as const,
          href: item.href,
          content: normalizeInlineContent(item.content) as { type: 'text'; text: string; styles: Record<string, boolean> }[],
        };
      }
      return {
        type: 'text' as const,
        text: String(item.text ?? ''),
        styles: (item.styles && typeof item.styles === 'object' ? item.styles : {}) as Record<string, boolean>,
      };
    });
}

function defaultPropsForType(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...BASE_PROPS, ...props };
  if (type === 'heading' && merged.level == null) merged.level = 1;
  if (type === 'checkListItem' && merged.checked == null) merged.checked = false;
  return merged;
}

/** 将 AI/外部 blocks 转为 BlockNote 可识别的 PartialBlock 列表（剥离自定义 id，补全 props）。 */
export function normalizeBlocksForBlockNote(raw: unknown): PartialBlock[] {
  let blocks: RawBlock[] = [];
  if (Array.isArray(raw)) {
    blocks = raw as RawBlock[];
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) blocks = obj.blocks as RawBlock[];
  }
  if (blocks.length === 0) {
    return [{ type: 'paragraph', props: { ...BASE_PROPS } }];
  }

  return blocks.map(block => {
    const type = typeof block.type === 'string' && VALID_BLOCK_TYPES.has(block.type)
      ? block.type
      : 'paragraph';
    const props = defaultPropsForType(
      type,
      block.props && typeof block.props === 'object' ? (block.props as Record<string, unknown>) : {},
    );
    const normalized = {
      type: type as PartialBlock['type'],
      props: props as PartialBlock['props'],
      content: normalizeInlineContent(block.content),
    } as PartialBlock;
    // 不保留 AI 自定义 id / 空 children，避免 BlockNote 解析异常
    if (Array.isArray(block.children) && block.children.length > 0) {
      normalized.children = normalizeBlocksForBlockNote(block.children);
    }
    return normalized;
  });
}

export function parseBlockNoteContent(content?: Record<string, unknown>): PartialBlock[] | undefined {
  if (!content) return undefined;
  return normalizeBlocksForBlockNote(content);
}
