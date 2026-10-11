/**
 * PasswordDialog – 加密文档 / 加密文件夹的密码输入对话框。
 *
 * 支持四种模式：
 * - set：设置新密码（含确认输入）；
 * - unlock：输入密码解锁（换取会话票据）；
 * - decrypt：输入密码取消加密（含风险提示）；
 * - change：修改密码（原密码 + 新密码 + 确认）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';

export type PasswordDialogMode = 'set' | 'unlock' | 'decrypt' | 'change';

export interface PasswordDialogProps {
  /** 是否显示 */
  open: boolean;
  /** 交互模式 */
  mode: PasswordDialogMode;
  /** 标题，如「加密文档」「解锁文档」 */
  title: string;
  /** 副标题说明（可选） */
  description?: string;
  /** 深色模式 */
  isDark?: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /**
   * 提交回调。
   * @param password 当前密码（change 模式下为原密码）
   * @param newPassword 新密码（仅 set / change 模式传入）
   * 抛出的异常信息会展示在对话框内，由调用方负责关闭对话框。
   */
  onSubmit: (password: string, newPassword?: string) => Promise<void> | void;
}

/** 各模式的文案配置 */
const MODE_TEXT: Record<PasswordDialogMode, { ok: string; hint: string }> = {
  set: { ok: '加密', hint: '密码至少 4 位，请牢记；忘记后无法恢复文档内容' },
  unlock: { ok: '解锁', hint: '输入密码以在当前会话中查看内容' },
  decrypt: { ok: '取消加密', hint: '取消后文档将恢复为明文存储，此操作需要密码确认' },
  change: { ok: '保存', hint: '请输入原密码，并设置新密码（至少 4 位）' },
};

const PasswordDialog: React.FC<PasswordDialogProps> = ({
  open,
  mode,
  title,
  description,
  isDark = false,
  onClose,
  onSubmit,
}) => {
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 每次打开时重置内部状态并聚焦输入框 */
  useEffect(() => {
    if (open) {
      setPassword('');
      setNewPassword('');
      setConfirm('');
      setError('');
      setLoading(false);
      setShowPwd(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, mode]);

  if (!open) return null;

  const isChange = mode === 'change';
  const isSet = mode === 'set';

  /**
   * 校验并提交。
   * @param e 表单事件
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    const primary = password.trim();
    if (!primary) {
      setError(isChange ? '请输入原密码' : '请输入密码');
      return;
    }

    // 依据模式做差异校验
    let newPwd: string | undefined;
    if (isSet) {
      if (primary.length < 4) {
        setError('密码至少 4 位');
        return;
      }
      if (primary !== confirm.trim()) {
        setError('两次输入的密码不一致');
        return;
      }
      newPwd = primary;
    } else if (isChange) {
      const next = newPassword.trim();
      if (next.length < 4) {
        setError('新密码至少 4 位');
        return;
      }
      if (next !== confirm.trim()) {
        setError('两次输入的新密码不一致');
        return;
      }
      newPwd = next;
    }

    setLoading(true);
    try {
      await onSubmit(primary, newPwd);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
      setLoading(false);
    }
  };

  const inputClass = `w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${
    isDark
      ? 'bg-gray-700 border-gray-600 text-gray-100 placeholder-gray-500 focus:border-orange-500'
      : 'bg-white border-gray-300 text-gray-800 placeholder-gray-400 focus:border-orange-500'
  }`;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-sm rounded-xl shadow-2xl border overflow-hidden ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`flex items-center gap-2 px-4 py-3 border-b text-sm font-medium ${
            isDark ? 'border-gray-700 text-gray-200' : 'border-gray-200 text-gray-800'
          }`}
        >
          <Lock size={15} className="text-orange-500" />
          {title}
        </div>

        <form onSubmit={handleSubmit} className="px-4 py-4 space-y-3">
          <p className={`text-xs leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {description || MODE_TEXT[mode].hint}
          </p>

          {/* 密码 / 原密码 */}
          <div className="relative">
            <input
              ref={inputRef}
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isChange ? '原密码' : '密码'}
              autoComplete="off"
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded ${
                isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-400 hover:text-gray-600'
              }`}
              tabIndex={-1}
              aria-label={showPwd ? '隐藏密码' : '显示密码'}
            >
              {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          {/* change 模式：新密码输入 */}
          {isChange && (
            <input
              type={showPwd ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码（至少 4 位）"
              autoComplete="new-password"
              className={inputClass}
            />
          )}

          {/* set / change 模式：确认密码 */}
          {(isSet || isChange) && (
            <input
              type={showPwd ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={isChange ? '确认新密码' : '确认密码'}
              autoComplete="new-password"
              className={inputClass}
            />
          )}

          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                isDark
                  ? 'text-gray-300 hover:bg-gray-700'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1.5 text-xs rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-60 transition-colors"
            >
              {loading ? '处理中…' : MODE_TEXT[mode].ok}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PasswordDialog;
