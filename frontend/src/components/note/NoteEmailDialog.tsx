/**
 * NoteEmailDialog – 把当前笔记发送到邮箱
 *
 * 复用「设置 → 本地同步」之外的发信入口：顶部工具栏点邮件图标打开，
 * 填写收件人与可选附言后由后端渲染 HTML 正文并通过 SMTP 发出。
 */
import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Mail, Loader2, X } from 'lucide-react';
import { noteEmailApi } from '../../services/note/note';
import type { Note } from '../../services/note/note';

export interface NoteEmailDialogProps {
  /** 待发送的笔记；为空表示当前没有打开的笔记 */
  note: Note | null;
  isDark: boolean;
  onClose: () => void;
}

const NoteEmailDialog: React.FC<NoteEmailDialogProps> = ({ note, isDark, onClose }) => {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const toInputRef = useRef<HTMLInputElement>(null);

  // 打开时预填标题与默认收件人
  useEffect(() => {
    if (!note) return;
    setSubject(note.title || '无标题笔记');
    setTo('');
    setMessage('');
    // 让焦点落在收件人输入框，便于直接输入
    const t = setTimeout(() => toInputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [note?.id]); // 只在切换笔记时重置，避免用户输入被覆盖

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, sending]);

  const handleSend = async () => {
    if (!note) return;
    if (!to.trim()) {
      toast.error('请填写收件人邮箱');
      toInputRef.current?.focus();
      return;
    }
    setSending(true);
    try {
      const result = await noteEmailApi.sendNote({
        noteId: note.id,
        to: to.trim(),
        subject: subject.trim() || undefined,
        message: message.trim() || undefined,
      });
      if (result.mocked) {
        toast.success('邮件服务未配置（EMAIL_MOCK），已模拟发送');
      } else {
        toast.success(`已发送至 ${result.recipients.join('、')}`);
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发送失败，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  const inputCls = `w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${
    isDark
      ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500'
      : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-orange-500'
  }`;
  const labelCls = `block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4"
      onClick={() => !sending && onClose()}
    >
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl border p-5 ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="发送笔记到邮箱"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-sm font-semibold flex items-center gap-2 ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
            <Mail size={15} className="text-orange-500" />
            发送到邮箱
          </h3>
          <button
            onClick={onClose}
            disabled={sending}
            className={`p-1 rounded-md transition-colors disabled:opacity-40 ${
              isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
            }`}
            title="关闭"
          >
            <X size={15} />
          </button>
        </div>

        {/* 待发送的笔记 */}
        <div className={`mb-4 px-3 py-2 rounded-lg text-xs ${isDark ? 'bg-gray-700/50 text-gray-300' : 'bg-gray-50 text-gray-600'}`}>
          笔记：<span className="font-medium">{note?.title || '无标题笔记'}</span>
        </div>

        {/* 收件人 */}
        <div className="mb-3">
          <label className={labelCls} htmlFor="email-to">收件人 *</label>
          <input
            id="email-to"
            ref={toInputRef}
            value={to}
            onChange={e => setTo(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !sending) void handleSend(); }}
            placeholder="name@example.com（多个用逗号分隔）"
            className={inputCls}
            disabled={sending}
          />
        </div>

        {/* 标题 */}
        <div className="mb-3">
          <label className={labelCls} htmlFor="email-subject">邮件标题</label>
          <input
            id="email-subject"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className={inputCls}
            disabled={sending}
          />
        </div>

        {/* 附言 */}
        <div className="mb-5">
          <label className={labelCls} htmlFor="email-message">附言（可选）</label>
          <textarea
            id="email-message"
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            placeholder="想对收件人说的话，会显示在正文最前面"
            className={`${inputCls} resize-none`}
            disabled={sending}
          />
        </div>

        {/* 操作 */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={sending}
            className={`px-4 py-2 text-sm rounded-lg transition-colors disabled:opacity-40 ${
              isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            取消
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sending || !to.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {sending && <Loader2 size={14} className="animate-spin" />}
            {sending ? '发送中...' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NoteEmailDialog;
