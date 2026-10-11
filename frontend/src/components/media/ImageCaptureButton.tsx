import React, { useState } from 'react';
import { Camera, Loader } from 'lucide-react';
import toast from 'react-hot-toast';
import { pickImage, type PickImageOptions } from '../../hooks/useImageCapture';

export interface ImageCaptureButtonProps {
  /**
   * 拿到拍照 / 选图结果后的业务回调（上传、插入等由调用方处理）。
   * 注意：本组件内部已负责调起 pickImage，onCaptured 里不要再调用 pickImage，
   * 否则第二次 input.click() 因用户激活已消耗而被浏览器拦截，Promise 永远挂起。
   */
  onCaptured: (file: File) => void | Promise<void>;
  onError?: (error: unknown) => void;
  pickOptions?: PickImageOptions;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** 图标旁的可见文字（可选） */
  label?: string;
  size?: number;
}

/**
 * 可复用的相机 / 相册触发按钮（移植自 AIIgnitePLM ImageCaptureButton）。
 * 只负责取图，不上传——压缩与存储统一走调用方的 uploadNoteImage。
 */
const ImageCaptureButton: React.FC<ImageCaptureButtonProps> = ({
  onCaptured,
  onError,
  pickOptions = { capture: 'environment' },
  disabled = false,
  className = '',
  title = '拍照录入',
  label,
  size = 16,
}) => {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const file = await pickImage(pickOptions);
      if (!file) return;
      await onCaptured(file);
    } catch (err) {
      onError?.(err);
      if (!onError) {
        toast.error(err instanceof Error ? err.message : '拍照失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || busy}
      onClick={() => void handleClick()}
      className={className}
    >
      {busy ? <Loader size={size} className="animate-spin" /> : <Camera size={size} />}
      {label ? <span className="ml-1">{label}</span> : null}
    </button>
  );
};

export default ImageCaptureButton;
