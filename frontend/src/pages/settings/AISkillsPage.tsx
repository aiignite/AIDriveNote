import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Download,
  Filter,
  LayoutGrid,
  List,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { aiApi, type AISkill, type AISkillInput, type SkillBindingItem } from '../../services/ai/ai';
import ConfirmDialog from '../../components/ConfirmDialog';
import { SkillForm } from '../../components/ai/SkillForm';

const AISkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<AISkill[]>([]);
  const [pageBindings, setPageBindings] = useState<SkillBindingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showBuiltinOnly, setShowBuiltinOnly] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<AISkill | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<AISkill | null>(null);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const [skillList, bindings] = await Promise.all([
        aiApi.listSkills(),
        aiApi.getPageSkills(),
      ]);
      setSkills(skillList);
      setPageBindings(bindings);
    } catch {
      toast.error('加载技能失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    const keyword = deferredSearchTerm.trim().toLowerCase();
    return skills.filter((skill) => {
      if (showBuiltinOnly && !skill.isBuiltin) return false;
      if (!keyword) return true;
      return [skill.name, skill.code, skill.description, ...skill.keywords, ...skill.toolNames]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [deferredSearchTerm, showBuiltinOnly, skills]);

  const isPageSkillEnabled = (skillId: string) => {
    const binding = pageBindings.find((item) => item.skillId === skillId);
    return binding ? binding.isEnabled : false;
  };

  const togglePageSkill = (skillId: string) => {
    const existing = pageBindings.find((item) => item.skillId === skillId);
    if (existing) {
      setPageBindings((prev) =>
        prev.map((item) =>
          item.skillId === skillId ? { ...item, isEnabled: !item.isEnabled } : item,
        ),
      );
      return;
    }
    const skill = skills.find((item) => item.id === skillId);
    setPageBindings((prev) => [
      ...prev,
      {
        skillId,
        skillName: skill?.name,
        weight: skill?.priority ?? 50,
        isEnabled: true,
      },
    ]);
  };

  const handleSavePageSkills = async () => {
    setSaving(true);
    try {
      await aiApi.savePageSkills(
        pageBindings.map((item) => ({
          skillId: item.skillId,
          weight: item.weight,
          isEnabled: item.isEnabled,
        })),
      );
      toast.success('笔记页技能绑定已保存');
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const openCreate = useCallback(() => {
    setEditingSkill(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((skill: AISkill) => {
    setEditingSkill(skill);
    setShowForm(true);
  }, []);

  const handleSaveSkill = useCallback(
    async (data: AISkillInput) => {
      try {
        if (editingSkill) {
          await aiApi.updateSkill(editingSkill.id, data);
          toast.success('技能已更新');
        } else {
          await aiApi.createSkill(data);
          toast.success('技能已创建');
        }
        setShowForm(false);
        setEditingSkill(null);
        await loadSkills();
      } catch (error) {
        console.error('Failed to save skill:', error);
        toast.error('保存技能失败');
      }
    },
    [editingSkill, loadSkills],
  );

  const handleDeleteSkill = useCallback((skill: AISkill) => {
    if (skill.isBuiltin) {
      toast.error('内置技能不可删除，可编辑后禁用');
      return;
    }
    setSkillToDelete(skill);
  }, []);

  const confirmDeleteSkill = useCallback(async () => {
    if (!skillToDelete) return;
    setDeletingSkillId(skillToDelete.id);
    try {
      await aiApi.deleteSkill(skillToDelete.id);
      toast.success('技能已删除');
      setSkillToDelete(null);
      await loadSkills();
    } catch (error) {
      console.error('Failed to delete skill:', error);
      toast.error('删除技能失败');
    } finally {
      setDeletingSkillId(null);
    }
  }, [loadSkills, skillToDelete]);

  const handleExport = useCallback(() => {
    const csv = [
      ['名称', '代码', '关键词', '工具', '优先级', '内置', '启用'].join(','),
      ...filteredSkills.map((s) =>
        [
          s.name,
          s.code,
          s.keywords.join('|'),
          s.toolNames.join('|'),
          String(s.priority),
          s.isBuiltin ? 'Y' : 'N',
          s.isEnabled ? 'Y' : 'N',
        ].join(','),
      ),
    ].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-skills-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredSkills]);

  return (
    <div
      className={`h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6 ${
        isFullscreen ? 'fixed inset-0 z-50' : ''
      }`}
    >
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm">
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-lg shadow-orange-500/20">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">技能管理</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    编辑技能提示词与触发规则，配置笔记页自动激活绑定
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSavePageSkills()}
                  disabled={saving || loading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
                >
                  <Save className="w-4 h-4" />
                  {saving ? '保存中...' : '保存绑定'}
                </button>
                <button
                  onClick={handleExport}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="导出CSV"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => void loadSkills()}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="刷新"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setIsFullscreen((f) => !f)}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="全屏"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="搜索技能名称、关键词、工具..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowBuiltinOnly((f) => !f)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border ${
                showBuiltinOnly
                  ? 'bg-orange-50 border-orange-200 text-orange-600 dark:bg-orange-950/30 dark:border-orange-800 dark:text-orange-300'
                  : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              <Filter className="w-4 h-4" /> 仅内置
            </button>
            <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 gap-1">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-600'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-600'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <span className="px-3 py-2 rounded-lg bg-orange-50 dark:bg-orange-950/30 text-xs font-semibold text-orange-700 dark:text-orange-300">
              {filteredSkills.length}/{skills.length} 个技能
            </span>
            <button
              type="button"
              onClick={openCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" /> 新增技能
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-10 text-center text-sm text-gray-500">
            <Sparkles className="w-8 h-8 mx-auto mb-3 animate-pulse text-orange-300" />
            正在加载技能...
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-12 flex flex-col items-center justify-center">
            <Sparkles className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">暂无匹配技能</h2>
            <button
              type="button"
              onClick={openCreate}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700"
            >
              <Plus className="w-4 h-4" /> 新建技能
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredSkills.map((skill) => (
              <article
                key={skill.id}
                className="group rounded-2xl border-2 border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:shadow-lg hover:border-orange-300 dark:hover:border-orange-600 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{skill.name}</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">{skill.code}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {skill.isBuiltin ? (
                      <span className="px-2 py-0.5 rounded-full bg-orange-50 dark:bg-orange-950/30 text-xs text-orange-700 dark:text-orange-300">
                        内置
                      </span>
                    ) : null}
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        skill.isEnabled
                          ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
                      }`}
                    >
                      {skill.isEnabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-3 min-h-[36px]">
                  {skill.description || '暂无描述'}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {skill.keywords.slice(0, 5).map((kw) => (
                    <span
                      key={kw}
                      className="px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-700 text-xs text-gray-600 dark:text-gray-300"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
                  <div className="rounded-xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">优先级</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {skill.priority}
                    </div>
                  </div>
                  <div className="rounded-xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">工具数</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {skill.toolNames.length}
                    </div>
                  </div>
                </div>
                {skill.toolNames.length > 0 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 truncate" title={skill.toolNames.join(', ')}>
                    工具：{skill.toolNames.join('、')}
                  </p>
                ) : null}
                {skill.promptTemplate ? (
                  <p
                    className="text-xs text-gray-500 dark:text-gray-400 mt-2 line-clamp-2 font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-2"
                    title={skill.promptTemplate}
                  >
                    {skill.promptTemplate}
                  </p>
                ) : null}
                <label className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isPageSkillEnabled(skill.id)}
                    onChange={() => togglePageSkill(skill.id)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">笔记页启用</span>
                </label>
                <div className="flex flex-wrap items-center gap-2 mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => openEdit(skill)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                  >
                    <Pencil className="w-4 h-4" /> 编辑
                  </button>
                  {!skill.isBuiltin ? (
                    <button
                      type="button"
                      onClick={() => handleDeleteSkill(skill)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/40 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                      <Trash2 className="w-4 h-4" /> 删除
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">技能</th>
                  <th className="px-4 py-3 font-medium">关键词</th>
                  <th className="px-4 py-3 font-medium">工具</th>
                  <th className="px-4 py-3 font-medium">优先级</th>
                  <th className="px-4 py-3 font-medium text-center">笔记页</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSkills.map((skill) => (
                  <tr
                    key={skill.id}
                    className="border-t border-gray-100 dark:border-gray-700 hover:bg-orange-50/30 dark:hover:bg-orange-900/10"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-900 dark:text-white">{skill.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{skill.code}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 max-w-[180px] truncate">
                      {skill.keywords.join('、') || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 max-w-[160px] truncate">
                      {skill.toolNames.join('、') || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{skill.priority}</td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isPageSkillEnabled(skill.id)}
                        onChange={() => togglePageSkill(skill.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(skill)}
                          className="p-2 rounded-lg text-gray-500 hover:text-orange-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                          title="编辑"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {!skill.isBuiltin ? (
                          <button
                            type="button"
                            onClick={() => handleDeleteSkill(skill)}
                            className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm ? (
        <SkillForm
          skill={editingSkill || undefined}
          onSave={handleSaveSkill}
          onClose={() => {
            setShowForm(false);
            setEditingSkill(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        isOpen={Boolean(skillToDelete)}
        onClose={() => setSkillToDelete(null)}
        onConfirm={() => void confirmDeleteSkill()}
        title="删除技能"
        message={`确定删除技能「${skillToDelete?.name || ''}」吗？`}
        confirmLabel="确认删除"
        cancelLabel="取消"
        loadingLabel="删除中..."
        isLoading={deletingSkillId === skillToDelete?.id}
        variant="danger"
      />
    </div>
  );
};

export default AISkillsPage;
