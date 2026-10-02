/**
 * CommonTermsPage — 常用词库管理（常用词投喂 AI）
 *
 * 由会议版 CommonTermsPage 去会议化移植，接口改为 /note-asr/common-terms：
 * 用户维护领域词条，语音转写润色与 AI 整理时会自动注入提示词，提升识别准确度。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { noteAsrApi, type CommonTerm } from '../../services/note/asrSettings';

/** 搜索防抖延迟（毫秒） */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 常用词库管理页组件。
 * @returns 词条管理界面
 */
const CommonTermsPage: React.FC = () => {
  /** 词条列表 */
  const [items, setItems] = useState<CommonTerm[]>([]);
  /** 加载中 */
  const [loading, setLoading] = useState(false);
  /** 保存中 */
  const [saving, setSaving] = useState(false);
  /** 搜索关键字 */
  const [searchText, setSearchText] = useState('');
  /** 是否展开新增表单 */
  const [showForm, setShowForm] = useState(false);
  /** 新增表单 */
  const [form, setForm] = useState<{ term: string; alias: string; remark: string }>({
    term: '', alias: '', remark: '',
  });
  /** 搜索防抖定时器 */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDark = document.documentElement.classList.contains('dark');

  const inputCls = `w-full px-3 py-2 rounded-lg border text-sm ${
    isDark ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-200 text-gray-900'
  } focus:outline-none focus:ring-2 focus:ring-orange-500`;

  /**
   * 加载常用词列表。
   * @param keyword 关键词（服务端过滤）
   * @returns Promise<void>
   */
  const load = useCallback(async (keyword?: string) => {
    setLoading(true);
    try {
      const res = await noteAsrApi.listCommonTerms(keyword?.trim() || undefined);
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      console.error('加载常用词失败', err);
      toast.error('加载常用词失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 搜索输入防抖：输入停止后再请求
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void load(searchText);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchText, load]);

  /** 新增词条 */
  const handleCreate = async () => {
    if (!form.term.trim()) {
      toast.error('请输入词条');
      return;
    }
    setSaving(true);
    try {
      await noteAsrApi.createCommonTerm({
        term: form.term.trim(),
        alias: form.alias.trim() || null,
        remark: form.remark.trim() || null,
        isEnabled: true,
      });
      toast.success('词条已添加');
      setForm({ term: '', alias: '', remark: '' });
      setShowForm(false);
      await load(searchText);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  /**
   * 切换词条启用状态。
   * @param item 词条
   * @returns Promise<void>
   */
  const handleToggle = async (item: CommonTerm) => {
    try {
      await noteAsrApi.updateCommonTerm(item.id, { isEnabled: !item.isEnabled });
      await load(searchText);
    } catch {
      toast.error('更新失败');
    }
  };

  /**
   * 删除词条。
   * @param item 词条
   * @returns Promise<void>
   */
  const handleDelete = async (item: CommonTerm) => {
    if (!window.confirm(`确认删除词条「${item.term}」？`)) return;
    try {
      await noteAsrApi.deleteCommonTerm(item.id);
      toast.success('已删除');
      await load(searchText);
    } catch {
      toast.error('删除失败');
    }
  };

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">常用词库</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            维护领域专有词条；语音转写润色与 AI 整理时会自动把这些词条注入提示词，提升识别与整理准确度（常用词投喂 AI）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load(searchText)}
            className="p-2 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowForm(v => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 text-white text-sm hover:bg-orange-700"
          >
            {showForm ? <X size={14} /> : <Plus size={14} />}
            {showForm ? '取消' : '添加词条'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">词条 *（≤64字）</label>
              <input
                type="text"
                className={inputCls}
                value={form.term}
                onChange={e => setForm(f => ({ ...f, term: e.target.value }))}
                placeholder="如：工装夹具 / 客户产品名 / 内部系统名"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">同音/易错写法（逗号分隔）</label>
              <input
                type="text"
                className={inputCls}
                value={form.alias}
                onChange={e => setForm(f => ({ ...f, alias: e.target.value }))}
                placeholder="如：工装夹俱, 工装加具"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">备注</label>
            <input
              type="text"
              className={inputCls}
              value={form.remark}
              onChange={e => setForm(f => ({ ...f, remark: e.target.value }))}
              placeholder="可选：词条用途说明"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleCreate}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm hover:bg-orange-700 disabled:opacity-60"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}保存
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          className={`${inputCls} pl-9`}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="搜索词条 / 别名 / 备注"
        />
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <BookOpenPlaceholder />
          <p className="text-sm">暂无词条</p>
          <p className="text-xs mt-1">点击右上角「添加词条」开始维护常用词库</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">词条</th>
                <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">同音/易错写法</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">备注</th>
                <th className="px-4 py-2.5 text-center font-medium">状态</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
              {items.map(it => (
                <tr key={it.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100 font-medium">{it.term}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 hidden sm:table-cell">{it.alias || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 hidden md:table-cell">{it.remark || '—'}</td>
                  <td className="px-4 py-2.5 text-center">
                    <button
                      onClick={() => void handleToggle(it)}
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        it.isEnabled
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                      }`}
                    >
                      {it.isEnabled ? '启用' : '停用'}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => void handleDelete(it)}
                      className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** 空状态占位图标 */
const BookOpenPlaceholder: React.FC = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

export default CommonTermsPage;