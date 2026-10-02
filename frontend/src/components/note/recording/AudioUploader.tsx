/**
 * AudioUploader.tsx — 音频文件上传组件（拖拽 / 点击选择）
 *
 * 由会议版 AudioUploader 去会议化移植：按 maxBytes 限制文件大小，
 * 超限时阻止回调；compact 变体提供工具栏按钮，支持通过 openRef 由父组件
 * 命令式打开文件选择（供 AudioRecorder 的非安全上下文降级入口复用）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UploadCloud, FileAudio, X, Upload } from 'lucide-react';

interface AudioUploaderProps {
  /** 单文件大小上限（字节），默认 500MB */
  maxBytes?: number;
  /** 选中合法文件回调 */
  onSelected: (file: File) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 展示变体：default（拖拽区）/ compact（工具栏按钮） */
  variant?: 'default' | 'compact';
  /** compact 下仅显示图标 */
  iconOnly?: boolean;
  /** 命令式打开文件选择的引用（供录音降级使用） */
  openRef?: React.RefObject<(() => void) | null>;
}

/** 默认大小上限：500MB */
const DEFAULT_MAX = 500 * 1024 * 1024;

/** 允许的音频扩展名 */
const ACCEPTED = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm,.mp4,.mpeg,.mpga';

/**
 * 音频上传组件。
 * @param props 组件属性
 * @returns 拖拽区或紧凑上传按钮
 */
export const AudioUploader: React.FC<AudioUploaderProps> = ({
  maxBytes = DEFAULT_MAX,
  onSelected,
  disabled,
  className,
  variant = 'default',
  iconOnly = false,
  openRef,
}) => {
  /** 隐藏文件输入 */
  const inputRef = useRef<HTMLInputElement>(null);
  /** 拖拽悬停态 */
  const [dragOver, setDragOver] = useState(false);
  /** 校验错误提示 */
  const [error, setError] = useState<string | null>(null);
  /** 已选文件（用于展示） */
  const [picked, setPicked] = useState<File | null>(null);

  /** 打开文件选择器 */
  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  useEffect(() => {
    if (!openRef) return undefined;
    openRef.current = openPicker;
    return () => {
      openRef.current = null;
    };
  }, [openRef, openPicker]);

  /**
   * 校验文件大小。
   * @param file 待校验文件
   * @returns 错误文案，合法时返回 null
   */
  const validate = useCallback((file: File): string | null => {
    if (file.size > maxBytes) {
      return `文件过大：${(file.size / 1024 / 1024).toFixed(1)}MB > 限制 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`;
    }
    return null;
  }, [maxBytes]);

  /**
   * 处理选中的文件。
   * @param file 文件
   * @returns void
   */
  const handleFile = (file: File) => {
    setError(null);
    const err = validate(file);
    if (err) {
      setError(err);
      return;
    }
    setPicked(file);
    onSelected(file);
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPTED}
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
        e.target.value = '';
      }}
    />
  );

  if (variant === 'compact') {
    return (
      <div className={`inline-flex items-center gap-2 ${className || ''}`}>
        <button
          type="button"
          onClick={openPicker}
          disabled={disabled}
          title="上传音频文件（mp3 / wav / m4a / webm 等）"
          aria-label="上传音频"
          className={`inline-flex items-center justify-center font-medium rounded-lg bg-sky-50 text-sky-700 hover:bg-sky-100 border border-sky-200 disabled:opacity-50 shadow-sm ${
            iconOnly ? 'p-2' : 'gap-1.5 px-4 py-2 text-sm'
          }`}
        >
          <Upload size={14} />
          {!iconOnly && '上传音频'}
        </button>
        {fileInput}
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled) return;
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          dragOver
            ? 'border-sky-400 bg-sky-50/50 dark:bg-sky-900/20'
            : 'border-gray-200 dark:border-gray-700 hover:border-sky-300'
        } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        onClick={openPicker}
      >
        <UploadCloud className="mx-auto mb-2 text-sky-500" size={28} />
        <p className="text-sm text-gray-700 dark:text-gray-200">
          拖拽音频文件到此处，或<span className="text-sky-600 mx-1">点击选择</span>
        </p>
        <p className="text-[11px] text-gray-400 mt-1">
          支持 mp3 / wav / m4a / ogg / opus / webm 等，单文件 ≤ {(maxBytes / 1024 / 1024).toFixed(0)}MB
        </p>
        {fileInput}
      </div>
      {picked && (
        <div className="mt-2 flex items-center justify-between text-xs bg-gray-50 dark:bg-gray-800/60 rounded px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-gray-700 dark:text-gray-200">
            <FileAudio size={14} />
            {picked.name} <span className="text-gray-400">({(picked.size / 1024 / 1024).toFixed(2)} MB)</span>
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPicked(null); }}
            className="text-gray-400 hover:text-rose-500"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
};

export default AudioUploader;