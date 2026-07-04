/**
 * NoteTemplateGallery – 笔记模板选择弹窗
 *
 * 展示按类型分组的模板列表，支持搜索、预览、选择创建
 * 支持模板 CRUD (创建/编辑/删除)
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X, Search, Plus, FileText, Code2, Brain, GitFork,
  Pencil, Trash2, LayoutTemplate, Loader2, BookTemplate,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  noteTemplateApi,
  type NoteTemplate, type TemplateCreate,
} from '../../services/note';

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; gradient: string }> = {
  rich_text: { label: '富文本', icon: <FileText size={16} />, color: 'text-orange-500 dark:text-orange-400', gradient: 'from-orange-500 to-orange-600' },
  markdown: { label: 'Markdown', icon: <Code2 size={16} />, color: 'text-green-600 dark:text-green-400', gradient: 'from-green-500 to-emerald-600' },
  mindmap: { label: '思维导图', icon: <Brain size={16} />, color: 'text-purple-600 dark:text-purple-400', gradient: 'from-orange-500 to-red-500' },
  flowchart: { label: '流程图', icon: <GitFork size={16} />, color: 'text-orange-600 dark:text-orange-400', gradient: 'from-orange-500 to-amber-600' },
};

interface NoteTemplateGalleryProps {
  visible: boolean;
  onClose: () => void;
  onSelectTemplate: (templateId: string, noteType: string) => void;
  isDark?: boolean;
}

const NoteTemplateGallery: React.FC<NoteTemplateGalleryProps> = ({
  visible, onClose, onSelectTemplate, isDark = false,
}) => {
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeType, setActiveType] = useState<string>('all');

  // Edit modal
  const [editModal, setEditModal] = useState<{ visible: boolean; template?: NoteTemplate }>({ visible: false });
  const [editForm, setEditForm] = useState<{
    name: string; noteType: string; description: string; contentText: string;
  }>({ name: '', noteType: 'markdown', description: '', contentText: '' });
  const [saving, setSaving] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const data = await noteTemplateApi.list({ search: search || undefined });
      setTemplates(data);
    } catch {
      toast.error('加载模板失败');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (visible) fetchTemplates();
  }, [visible, fetchTemplates]);

  // Filter by type
  const filtered = useMemo(() => activeType === 'all'
    ? templates
    : templates.filter(t => t.noteType === activeType), [templates, activeType]);

  // Group by type
  const grouped = useMemo(() => Object.entries(TYPE_META).reduce((acc, [key, meta]) => {
    const items = filtered.filter(t => t.noteType === key);
    if (items.length > 0) acc.push({ type: key, meta, items });
    return acc;
  }, [] as { type: string; meta: typeof TYPE_META[string]; items: NoteTemplate[] }[]), [filtered]);

  const handleCreateTemplate = () => {
    setEditForm({ name: '', noteType: 'markdown', description: '', contentText: '' });
    setEditModal({ visible: true });
  };

  const handleEditTemplate = (tpl: NoteTemplate) => {
    const contentText = tpl.noteType === 'markdown'
      ? String((tpl.content as { text?: string })?.text ?? '')
      : tpl.noteType === 'rich_text'
        ? JSON.stringify((tpl.content as { blocks?: unknown })?.blocks ?? [], null, 2)
        : JSON.stringify(tpl.content ?? {}, null, 2);
    setEditForm({
      name: tpl.name,
      noteType: tpl.noteType,
      description: tpl.description || '',
      contentText,
    });
    setEditModal({ visible: true, template: tpl });
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('确定删除此模板吗？')) return;
    try {
      await noteTemplateApi.delete(id);
      toast.success('模板已删除');
      fetchTemplates();
    } catch {
      toast.error('删除失败');
    }
  };

  const handleSaveTemplate = async () => {
    if (!editForm.name.trim()) {
      toast.error('模板名称不能为空');
      return;
    }
    setSaving(true);
    try {
      let content: Record<string, unknown> | undefined;
      if (editForm.contentText.trim()) {
        if (editForm.noteType === 'markdown') {
          content = { text: editForm.contentText };
        } else if (editForm.noteType === 'rich_text') {
          try {
            content = { blocks: JSON.parse(editForm.contentText) };
          } catch {
            toast.error('富文本内容必须是有效的 JSON blocks 数组');
            setSaving(false);
            return;
          }
        } else {
          try {
            content = JSON.parse(editForm.contentText);
          } catch {
            toast.error('内容必须是有效的 JSON');
            setSaving(false);
            return;
          }
        }
      }
      if (editModal.template) {
        await noteTemplateApi.update(editModal.template.id, {
          name: editForm.name,
          noteType: editForm.noteType as TemplateCreate['noteType'],
          description: editForm.description || undefined,
          content,
        });
        toast.success('模板已更新');
      } else {
        await noteTemplateApi.create({
          name: editForm.name,
          noteType: editForm.noteType as TemplateCreate['noteType'],
          description: editForm.description || undefined,
          content,
        });
        toast.success('模板已创建');
      }
      setEditModal({ visible: false });
      fetchTemplates();
    } catch {
      toast.error('保存模板失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSelect = (tpl: NoteTemplate) => {
    onSelectTemplate(tpl.id, tpl.noteType);
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className={`w-[720px] max-h-[80vh] rounded-2xl shadow-2xl border flex flex-col ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
              <BookTemplate size={18} className="text-white" />
            </div>
            <div>
              <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>笔记模板</h2>
              <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>选择模板快速创建笔记</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateTemplate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
            >
              <Plus size={14} />
              新建模板
            </button>
            <button
              onClick={onClose}
              className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Search + Type filter */}
        <div className={`flex items-center gap-3 px-6 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="relative flex-1">
            <Search size={14} className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索模板..."
              className={`w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border outline-none transition-colors ${
                isDark
                  ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500'
                  : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-orange-500'
              }`}
            />
          </div>
          <div className="flex gap-1">
            {[{ key: 'all', label: '全部' }, ...Object.entries(TYPE_META).map(([k, v]) => ({ key: k, label: v.label }))].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveType(tab.key)}
                className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                  activeType === tab.key
                    ? 'bg-orange-600 text-white'
                    : isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin text-orange-500" size={24} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <LayoutTemplate size={40} className={isDark ? 'text-gray-600' : 'text-gray-300'} />
              <p className={`mt-3 text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {search ? '没有匹配的模板' : '暂无模板，点击右上角"新建模板"创建'}
              </p>
            </div>
          ) : activeType === 'all' ? (
            // Grouped view
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.type}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={group.meta.color}>{group.meta.icon}</span>
                    <h3 className={`text-sm font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{group.meta.label}</h3>
                    <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>({group.items.length})</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {group.items.map(tpl => (
                      <TemplateCard
                        key={tpl.id}
                        template={tpl}
                        isDark={isDark}
                        onSelect={handleSelect}
                        onEdit={handleEditTemplate}
                        onDelete={handleDeleteTemplate}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // Flat view
            <div className="grid grid-cols-3 gap-3">
              {filtered.map(tpl => (
                <TemplateCard
                  key={tpl.id}
                  template={tpl}
                  isDark={isDark}
                  onSelect={handleSelect}
                  onEdit={handleEditTemplate}
                  onDelete={handleDeleteTemplate}
                />
              ))}
            </div>
          )}
        </div>

        {/* Edit Modal */}
        {editModal.visible && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setEditModal({ visible: false })}>
            <div
              className={`w-[440px] rounded-xl shadow-2xl border p-6 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
              onClick={e => e.stopPropagation()}
            >
              <h3 className={`text-base font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {editModal.template ? '编辑模板' : '新建模板'}
              </h3>
              <div className="space-y-4">
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>模板名称</label>
                  <input
                    value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="输入模板名称"
                    className={`w-full px-3 py-2 text-sm rounded-lg border outline-none ${
                      isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                    } focus:border-orange-500`}
                  />
                </div>
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>笔记类型</label>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(TYPE_META).map(([key, meta]) => (
                      <button
                        key={key}
                        onClick={() => setEditForm(f => ({ ...f, noteType: key }))}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                          editForm.noteType === key
                            ? `border-orange-500 ${isDark ? 'bg-orange-500/10 text-orange-400' : 'bg-orange-50 text-orange-700'}`
                            : isDark ? 'border-gray-600 text-gray-400 hover:border-gray-500' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                        }`}
                      >
                        <span className={meta.color}>{meta.icon}</span>
                        {meta.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>描述</label>
                  <textarea
                    value={editForm.description}
                    onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="模板描述（可选）"
                    rows={2}
                    className={`w-full px-3 py-2 text-sm rounded-lg border outline-none resize-none ${
                      isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                    } focus:border-orange-500`}
                  />
                </div>
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    模板内容 {editForm.noteType === 'markdown' ? '(Markdown)' : '(JSON)'}
                  </label>
                  <textarea
                    value={editForm.contentText}
                    onChange={e => setEditForm(f => ({ ...f, contentText: e.target.value }))}
                    placeholder={editForm.noteType === 'markdown' ? '# 标题\n\n正文内容...' : '{"blocks": [...]} 或 JSON 结构'}
                    rows={6}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border outline-none resize-y ${
                      isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                    } focus:border-orange-500`}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={() => setEditModal({ visible: false })}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'}`}
                >
                  取消
                </button>
                <button
                  onClick={handleSaveTemplate}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-60 transition-colors"
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Template Card ─────────────────────────────── */

interface TemplateCardProps {
  template: NoteTemplate;
  isDark: boolean;
  onSelect: (tpl: NoteTemplate) => void;
  onEdit: (tpl: NoteTemplate) => void;
  onDelete: (id: string) => void;
}

const TemplateCard: React.FC<TemplateCardProps> = ({ template, isDark, onSelect, onEdit, onDelete }) => {
  const meta = TYPE_META[template.noteType] || TYPE_META.markdown;

  return (
    <div
      className={`group relative rounded-xl border p-4 cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${
        isDark
          ? 'border-gray-700 bg-gray-800/50 hover:border-orange-500/40'
          : 'border-gray-200 bg-white hover:border-orange-300'
      }`}
      onClick={() => onSelect(template)}
    >
      {/* Type badge */}
      <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${meta.gradient} flex items-center justify-center text-white mb-3`}>
        {meta.icon}
      </div>
      <h4 className={`text-sm font-semibold truncate ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
        {template.name}
      </h4>
      {template.description && (
        <p className={`text-xs mt-1 line-clamp-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          {template.description}
        </p>
      )}
      {template.isBuiltin && (
        <span className={`inline-block mt-2 px-1.5 py-0.5 text-[10px] rounded ${isDark ? 'bg-orange-500/20 text-orange-400' : 'bg-orange-50 text-orange-600'}`}>
          内置
        </span>
      )}

      {/* Actions (hover) */}
      {!template.isBuiltin && (
        <div className="absolute top-2 right-2 hidden group-hover:flex items-center gap-1">
          <button
            onClick={e => { e.stopPropagation(); onEdit(template); }}
            className={`p-1 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-600 hover:text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'}`}
            title="编辑"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(template.id); }}
            className={`p-1 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:bg-red-900/30 hover:text-red-400' : 'text-gray-400 hover:bg-red-50 hover:text-red-600'}`}
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
};

export default NoteTemplateGallery;
