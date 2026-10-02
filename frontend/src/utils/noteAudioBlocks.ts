/**
 * noteAudioBlocks.ts — 富文本笔记中音频 / 转写内容到 BlockNote 块的转换工具
 *
 * 供录音面板在「插入笔记」时把后端返回的 audioUrl 与转写分段转换为
 * BlockNote 可识别的块数组：
 *  - buildAudioBlock：生成 audio 块（props: backgroundColor/name/url/caption/showPreview）；
 *  - transcriptToBlocks：按章节 / 段落生成 heading / paragraph 块。
 */
import type { PartialBlock } from '@blocknote/core';
import type { TranscriptSegment } from '../services/note/recording';

/** BlockNote 块公共默认 props */
const BASE_PROPS = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

/**
 * 构造一个 BlockNote audio 块。
 * @param audioUrl 可直接播放的音频地址（RecordingOut.audioUrl 或 buildAudioUrl 兜底）
 * @param name 音频名称（一般用原始文件名）
 * @returns BlockNote audio 块
 */
export function buildAudioBlock(audioUrl: string, name = ''): PartialBlock {
  return {
    type: 'audio',
    props: {
      backgroundColor: 'default',
      name,
      url: audioUrl,
      caption: '',
      showPreview: true,
    },
  } as PartialBlock;
}

/** transcriptToBlocks 可选项 */
export interface TranscriptToBlocksOptions {
  /** 是否按章节插入 heading 块（默认 true） */
  includeChapterHeadings?: boolean;
  /** 段落前缀是否带说话人标签（默认 true） */
  includeSpeaker?: boolean;
  /** 是否在每段前附带时间戳（默认 false） */
  includeTimestamp?: boolean;
}

/**
 * 把秒数格式化为 mm:ss。
 * @param seconds 秒数
 * @returns 形如 01:23 的时间文本
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 把转写分段转换为 BlockNote 块：按章节分组的 heading + paragraph。
 * @param segments 转写分段
 * @param options 生成选项
 * @returns BlockNote 块数组
 */
export function transcriptToBlocks(
  segments: TranscriptSegment[],
  options: TranscriptToBlocksOptions = {},
): PartialBlock[] {
  const {
    includeChapterHeadings = true,
    includeSpeaker = true,
    includeTimestamp = false,
  } = options;

  const sorted = [...(segments ?? [])].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const blocks: PartialBlock[] = [];
  let lastChapterId: number | null | undefined = undefined;

  for (const seg of sorted) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;

    const chapterId = seg.chapterId ?? null;
    // 章节变化时插入标题块，便于在笔记中形成结构化目录
    if (includeChapterHeadings && chapterId !== lastChapterId) {
      if (seg.chapterTitle) {
        blocks.push({
          type: 'heading',
          props: { ...BASE_PROPS, level: 2 },
          content: [{ type: 'text', text: seg.chapterTitle, styles: {} }],
        } as PartialBlock);
      }
      lastChapterId = chapterId;
    }

    const prefixParts: string[] = [];
    if (includeTimestamp) prefixParts.push(`[${formatTime(seg.startTime)}]`);
    if (includeSpeaker && seg.speakerLabel) prefixParts.push(`${seg.speakerLabel}：`);
    const content = `${prefixParts.length ? `${prefixParts.join(' ')} ` : ''}${text}`;

    blocks.push({
      type: 'paragraph',
      props: { ...BASE_PROPS },
      content: [{ type: 'text', text: content, styles: {} }],
    } as PartialBlock);
  }

  return blocks;
}