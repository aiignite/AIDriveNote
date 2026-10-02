/**
 * TranscriptPreview.tsx — 转写分段预览
 *
 * 由会议版 TranscriptView 精简移植：按章节分组展示时间戳 / 说话人 / 正文，
 * 并在顶部提供「AI 整理」「重转写」「重润色」三个操作入口。
 */
import React, { useMemo } from 'react';
import { Hash, Loader2, RefreshCw, Sparkles, Wand2, UserCircle2 } from 'lucide-react';
import type { TranscriptSegment } from '../../../services/note/recording';

interface TranscriptPreviewProps {
  /** 转写分段 */
  segments: TranscriptSegment[];
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 当前正在执行的动作 */
  busyAction?: 'retranscribe' | 'refine' | null;
  /** 重新转写回调 */
  onRetranscribe?: () => void;
  /** AI 整理回调（缺省时回落到 onRepolish） */
  onAiOrganize?: () => void;
  /** 重润色回调 */
  onRepolish?: () => void;
  /** 自定义类名 */
  className?: string;
}

/** 说话人气泡配色 */
const SPEAKER_PALETTE = [
  'bg-sky-100 text-sky-700 border-sky-200',
  'bg-emerald-100 text-emerald-700 border-emerald-200',
  'bg-violet-100 text-violet-700 border-violet-200',
  'bg-amber-100 text-amber-700 border-amber-200',
  'bg-rose-100 text-rose-700 border-rose-200',
  'bg-cyan-100 text-cyan-700 border-cyan-200',
];

/**
 * 计算说话人配色索引。
 * @param label 说话人标签
 * @returns 配色索引
 */
function hashSpeaker(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 说话人徽标样式。
 * @param label 说话人标签
 * @returns class 字符串
 */
function speakerBadgeClass(label?: string | null): string {
  if (!label) return 'bg-gray-100 text-gray-500 border-gray-200';
  return SPEAKER_PALETTE[hashSpeaker(label) % SPEAKER_PALETTE.length];
}

/**
 * 秒数格式化 mm:ss。
 * @param s 秒数
 * @returns 时间文本
 */
function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * 转写分段预览组件。
 * @param props 组件属性
 * @returns 章节化分段列表与操作按钮
 */
export const TranscriptPreview: React.FC<TranscriptPreviewProps> = ({
  segments,
  isDark = false,
  busyAction = null,
  onRetranscribe,
  onAiOrganize,
  onRepolish,
  className,
}) => {
  const sorted = useMemo(
    () => [...(segments ?? [])].sort((a, b) => a.segmentIndex - b.segmentIndex),
    [segments],
  );

  // 按章节分组，保留章节标题与关键词
  const chapters = useMemo(() => {
    const map = new Map<number, { id: number; title: string; keywords: string[] | null; segments: TranscriptSegment[] }>();
    for (const seg of sorted) {
      const chId = seg.chapterId ?? 0;
      if (!map.has(chId)) {
        map.set(chId, {
          id: chId,
          title: seg.chapterTitle || (seg.chapterId == null ? '' : `§${chId}`),
          keywords: seg.keywords ?? null,
          segments: [],
        });
      }
      map.get(chId)!.segments.push(seg);
    }
    return Array.from(map.values());
  }, [sorted]);

  const btnCls = `inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
    isDark ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-100'
  }`;

  return (
    <div className={`flex flex-col gap-2 ${className || ''}`}>
      {/* 操作按钮区 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onAiOrganize ?? onRepolish}
          disabled={!segments.length || busyAction !== null}
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors disabled:opacity-60 disabled:cursor-not-allowed border-violet-200 text-violet-700 hover:bg-violet-50`}
          title="调用大模型整理错别字 / 标点 / 分段"
        >
          {busyAction === 'refine' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          AI 整理
        </button>
        <button
          type="button"
          onClick={onRepolish}
          disabled={!segments.length || busyAction !== null}
          className={btnCls}
          title="重新润色转写文本"
        >
          {busyAction === 'refine' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          重润色
        </button>
        <button
          type="button"
          onClick={onRetranscribe}
          disabled={!segments.length || busyAction !== null}
          className={btnCls}
          title="重新进行语音转写"
        >
          {busyAction === 'retranscribe' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          重转写
        </button>
      </div>

      {/* 分段列表 */}
      {sorted.length === 0 ? (
        <div className={`text-xs italic p-4 border border-dashed rounded ${isDark ? 'text-gray-500 border-gray-700' : 'text-gray-400 border-gray-200'}`}>
          暂无转写内容
        </div>
      ) : (
        <ol className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {chapters.map((chapter) => (
            <li key={`ch-${chapter.id}`} className="space-y-1.5">
              {chapter.title && (
                <div className={`flex items-center gap-2 px-2 py-1 rounded border-l-2 border-violet-400 ${isDark ? 'bg-violet-900/20' : 'bg-gradient-to-r from-violet-50 to-transparent'}`}>
                  <span className={`text-[12px] font-semibold truncate ${isDark ? 'text-violet-200' : 'text-violet-800'}`}>{chapter.title}</span>
                  <span className="text-[10px] text-gray-400 ml-auto">{chapter.segments.length} 段</span>
                </div>
              )}
              {chapter.keywords && chapter.keywords.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 px-2">
                  <Hash size={10} className="text-amber-500" />
                  {chapter.keywords.map(k => (
                    <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">{k}</span>
                  ))}
                </div>
              )}
              <ol className="space-y-1.5 pl-1">
                {chapter.segments.filter(s => (s.text || '').trim().length > 0).map(seg => (
                  <li
                    key={seg.id}
                    className={`rounded-md p-2 border ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-gray-500">
                      <span className="font-mono">{formatTime(seg.startTime)} – {formatTime(seg.endTime)}</span>
                      {seg.speakerLabel && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border ${speakerBadgeClass(seg.speakerLabel)}`}>
                          <UserCircle2 size={10} />
                          {seg.speakerLabel}
                        </span>
                      )}
                    </div>
                    <p className={`mt-1 text-sm leading-relaxed whitespace-pre-wrap ${isDark ? 'text-gray-100' : 'text-gray-800'}`}>{seg.text}</p>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export default TranscriptPreview;