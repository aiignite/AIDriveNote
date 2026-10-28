import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  FileText,
  GitMerge,
  Inbox,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { knowledgeApi, type KnowledgeCard, type KnowledgeLint, type KnowledgeStats } from '../services/knowledge';
import { ensurePermission, loadHandleFromIndexedDB } from '../services/sync/folderAccess';
import { writeKnowledgeCard } from '../services/sync/kbMaintenance';

const STATUS_TABS = [
  { key: 'pending_review', label: '待审核' },
  { key: 'approved', label: '已入库' },
  { key: 'merged', label: '已合并' },
  { key: 'ignored', label: '已忽略' },
  { key: 'all', label: '全部' },
];

const TYPE_LABELS: Record<string, string> = {
  concept: '概念',
  entity: '实体',
  topic: '主题',
  decision: '决策',
  note: '笔记',
};

const SOURCE_LABELS: Record<string, string> = {
  email: '邮件',
  upload: '上传',
  clip: '剪藏',
  web_clip: '网页分享',
  mcp: 'Agent',
  note: '自写笔记',
  kb: '知识库文件',
};

const confidenceClass = (confidence: string) => {
  if (confidence === 'high') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (confidence === 'low') return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
};

const KnowledgeInboxPage: React.FC = () => {
  const [tab, setTab] = useState('pending_review');
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [lintResult, setLintResult] = useState<KnowledgeLint | null>(null);
  const [selected, setSelected] = useState<KnowledgeCard | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editTags, setEditTags] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const selectedRef = useRef<string | null>(null);

  selectedRef.current = selectedId;

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const [list, nextStats] = await Promise.all([
        knowledgeApi.listInbox({ status: tab }),
        knowledgeApi.stats(),
      ]);
      setCards(list.items);
      setStats(nextStats);
      window.dispatchEvent(new Event('knowledge:updated'));
      const keepId = selectedRef.current;
      const targetId = keepId && list.items.some((item) => item.id === keepId)
        ? keepId
        : list.items[0]?.id ?? null;
      setSelectedId(targetId);
      if (targetId) {
        const detail = await knowledgeApi.getCard(targetId);
        setSelected(detail);
        setEditTitle(detail.title);
        setEditTags(detail.tags.join(', '));
      } else {
        setSelected(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载知识收件箱失败');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (tab !== 'pending_review') return;
    const timer = window.setInterval(() => {
      if (!busy) void load(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [tab, busy, load]);

  const pendingCards = useMemo(
    () => cards.filter((card) => card.status === 'pending_review'),
    [cards],
  );

  const selectCard = async (cardId: string) => {
    setSelectedId(cardId);
    setShowRaw(false);
    try {
      const detail = await knowledgeApi.getCard(cardId);
      setSelected(detail);
      setEditTitle(detail.title);
      setEditTags(detail.tags.join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载知识卡失败');
    }
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const approveNew = () => {
    if (!selected) return;
    void runAction('approve', async () => {
      const tags = editTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      const result = await knowledgeApi.approveCard(selected.id, {
        mode: 'new',
        title: editTitle.trim() || undefined,
        tags,
      });
      setNotice(`已生成知识笔记《${result.title}》`);
      await load(false);
    });
  };

  const approveMerge = () => {
    if (!selected?.mergeTarget) return;
    void runAction('merge', async () => {
      const result = await knowledgeApi.approveCard(selected.id, {
        mode: 'merge',
        noteId: selected.mergeTarget!.noteId,
      });
      setNotice(`已合并到笔记《${result.title}》`);
      await load(false);
    });
  };

  const ignore = () => {
    if (!selected) return;
    void runAction('ignore', async () => {
      await knowledgeApi.ignoreCard(selected.id);
      setNotice('已忽略该知识卡');
      await load(false);
    });
  };

  const retry = () => {
    if (!selected) return;
    void runAction('retry', async () => {
      await knowledgeApi.retryCard(selected.id);
      setNotice('已重新提交抽取，请稍后刷新');
      await load(false);
    });
  };

  const writeLocal = () => {
    if (!selected) return;
    void runAction('kb', async () => {
      const handle = await loadHandleFromIndexedDB('kb');
      if (!handle) {
        throw new Error('请先在「设置 → 本地同步」中绑定知识库根目录');
      }
      const granted = await ensurePermission(handle, { requestInGesture: true });
      if (!granted) {
        throw new Error('未获得知识库目录写入权限，请在设置中重新授权');
      }
      const result = await writeKnowledgeCard(handle, selected);
      const status = result.wiki === 'conflict' ? 'conflict' : 'written';
      await knowledgeApi.updateKbStatus(selected.id, { status, path: result.path });
      setNotice(
        result.wiki === 'conflict'
          ? `本地 wiki 页已存在且内容不同，已保留原文件：${result.path}`
          : `已写入本地知识库：${result.path}`,
      );
      await load(false);
    });
  };

  const approveAll = () => {
    const ids = pendingCards
      .filter((card) => card.confidence !== 'low')
      .map((card) => card.id);
    if (!ids.length) return;
    void runAction('batch', async () => {
      const result = await knowledgeApi.batchCards(ids, 'approve');
      const ok = result.results.filter((item) => item.ok).length;
      setNotice(`批量入库完成：成功 ${ok} / ${ids.length}`);
      await load(false);
    });
  };

  const runLint = () => {
    void runAction('lint', async () => {
      const result = await knowledgeApi.lint();
      setLintResult(result);
      setNotice(
        `体检完成：无来源 ${result.counts.missingSource} · 重复 ${result.counts.duplicates} · 断链 ${result.counts.brokenLinks} · 孤儿 ${result.counts.orphans}`,
      );
    });
  };

  const createEntityPage = (name: string, entityType: string) => {
    if (!selected) return;
    void runAction(`entity:${name}`, async () => {
      const result = await knowledgeApi.createEntityPage(selected.id, {
        name,
        entityType,
        topic: selected.topic || undefined,
      });
      setNotice(
        result.created
          ? `已创建知识页《${result.title}》`
          : `知识页《${result.title}》已存在`,
      );
    });
  };

  const editable = selected?.status === 'pending_review';

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 dark:bg-gray-950">
      <div className="shrink-0 border-b border-gray-200 bg-white px-[var(--app-gutter)] py-3 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link
              to="/"
              title="返回笔记主页"
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <ArrowLeft size={15} /> <span className="hidden sm:inline">返回主页</span>
            </Link>
            <Inbox size={20} className="text-orange-500" />
            <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">知识收件箱</h1>
            {stats && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                待审 {stats.pendingReview}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load(true)}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <RefreshCw size={14} /> 刷新
            </button>
            <button
              type="button"
              onClick={runLint}
              disabled={busy === 'lint'}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {busy === 'lint' ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
              知识库体检
            </button>
            <button
              type="button"
              onClick={approveAll}
              disabled={!pendingCards.length || busy === 'batch'}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} /> 批量入库（非低置信度）
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {STATUS_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded-full px-3 py-1 text-sm ${
                tab === item.key
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {(error || notice) && (
          <p className={`mt-2 text-sm ${error ? 'text-red-600' : 'text-emerald-600'}`}>
            {error || notice}
          </p>
        )}
        {lintResult && (
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              检查 {lintResult.checked} 篇
            </span>
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              无来源 {lintResult.counts.missingSource}
            </span>
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              重复 {lintResult.counts.duplicates}
            </span>
            <span className="rounded bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              断链 {lintResult.counts.brokenLinks}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              孤儿 {lintResult.counts.orphans}
            </span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-h-0 overflow-y-auto border-b border-gray-200 md:w-[360px] md:border-b-0 md:border-r dark:border-gray-700">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">
              <Loader2 size={18} className="mr-2 animate-spin" /> 加载中…
            </div>
          ) : cards.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-gray-500">
              暂无知识卡。上传文档、同步邮件或分享网页后会自动出现在这里。
            </div>
          ) : (
            cards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => void selectCard(card.id)}
                className={`block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-orange-50/60 dark:border-gray-800 dark:hover:bg-gray-900 ${
                  selectedId === card.id ? 'bg-orange-50 dark:bg-gray-900' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {card.title}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${confidenceClass(card.confidence)}`}>
                    {card.confidence}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{card.summary}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
                    {TYPE_LABELS[card.knowledgeType] || card.knowledgeType}
                  </span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
                    {SOURCE_LABELS[card.source.type] || card.source.type}
                  </span>
                  {card.extractor === 'rule' && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      规则兜底
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center text-sm text-gray-500">
              <Sparkles size={28} className="mb-2 text-orange-400" />
              选择左侧知识卡查看蒸馏结果
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editable ? (
                    <input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-lg font-semibold text-gray-900 outline-none focus:border-orange-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  ) : (
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{selected.title}</h2>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className={`rounded px-1.5 py-0.5 ${confidenceClass(selected.confidence)}`}>
                      置信度 {selected.confidence}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
                      {TYPE_LABELS[selected.knowledgeType] || selected.knowledgeType}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
                      {selected.extractor === 'llm' ? `模型 ${selected.model || 'LLM'}` : '规则抽取'}
                    </span>
                    {selected.source.occurredAt && (
                      <span>{new Date(selected.source.occurredAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={approveNew}
                      disabled={!!busy}
                      className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      入库为新笔记
                    </button>
                    {selected.mergeTarget && (
                      <button
                        type="button"
                        onClick={approveMerge}
                        disabled={!!busy}
                        className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {busy === 'merge' ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />}
                        合并到《{selected.mergeTarget.title || '相似笔记'}》
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={ignore}
                      disabled={!!busy}
                      className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      {busy === 'ignore' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                      忽略
                    </button>
                  </div>
                )}
              </div>

              {selected.status === 'approved' && Boolean(selected.kbTarget.wikiBody) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/50 dark:bg-emerald-900/20">
                  <div className="text-sm text-emerald-700 dark:text-emerald-300">
                    本地知识库目标：{String(selected.kbTarget.wikiPath || '')}
                    {selected.kbTarget.status === 'conflict' && '（存在冲突，未覆盖原文件）'}
                    {selected.kbTarget.status === 'written' && '（已写入）'}
                  </div>
                  <button
                    type="button"
                    onClick={writeLocal}
                    disabled={!!busy}
                    className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === 'kb' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {selected.kbTarget.status === 'written' ? '重新写入' : '写入本地知识库'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void runAction('reindex', async () => {
                        const result = await knowledgeApi.reindexDocument(selected.documentId);
                        setNotice(
                          result.mode === 'v1'
                            ? '当前环境未启用 RAG v2，已重建整篇向量索引'
                            : '已提交块级索引重建',
                        );
                      });
                    }}
                    disabled={!!busy}
                    className="flex items-center gap-1 rounded-lg border border-emerald-300 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                  >
                    {busy === 'reindex' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    重建索引
                  </button>
                </div>
              )}

              {(selected.needsReview || Boolean(selected.source.error)) && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>
                    这张卡片的置信度较低或原文文本不完整，建议核对原文后再入库。
                  </span>
                </div>
              )}

              <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">摘要</h3>
                <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-gray-300">
                  {selected.summary}
                </p>
              </section>

              {selected.keyPoints.length > 0 && (
                <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                  <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">要点</h3>
                  <ul className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
                    {selected.keyPoints.map((point, index) => (
                      <li key={`${point}-${index}`} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(selected.keywords.length > 0 || selected.entities.length > 0) && (
                <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                  <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">关键概念</h3>
                  {selected.keywords.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {selected.keywords.map((keyword) => (
                        <span key={keyword} className="rounded-full bg-orange-50 px-2 py-0.5 text-xs text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                  {selected.entities.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {selected.entities.map((entity, index) => (
                        <div key={`${entity.name}-${index}`} className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                          <span>{entity.name}（{entity.type}）</span>
                          <button
                            type="button"
                            onClick={() => createEntityPage(entity.name, entity.type)}
                            disabled={busy === `entity:${entity.name}`}
                            className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                          >
                            {busy === `entity:${entity.name}` ? '创建中…' : '建页'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {selected.topic && (
                    <button
                      type="button"
                      onClick={() => createEntityPage(selected.topic, 'topic')}
                      disabled={busy === `entity:${selected.topic}`}
                      className="mt-2 rounded border border-orange-200 px-2 py-0.5 text-[10px] text-orange-600 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-900 dark:text-orange-300 dark:hover:bg-orange-900/20"
                    >
                      建主题页「{selected.topic}」
                    </button>
                  )}
                </section>
              )}

              {selected.claims.length > 0 && (
                <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                  <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">依据</h3>
                  <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                    {selected.claims.map((claim, index) => (
                      <li key={`${claim.text}-${index}`}>
                        <p>{claim.text}</p>
                        {claim.sourceExcerpt && (
                          <p className="mt-1 border-l-2 border-gray-200 pl-2 text-xs text-gray-500 dark:border-gray-700">
                            {claim.sourceExcerpt}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">来源与标签</h3>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {SOURCE_LABELS[selected.source.type] || selected.source.type}：{selected.source.title}
                  {selected.source.url && (
                    <a
                      href={selected.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-0.5 text-orange-600 hover:underline"
                    >
                      打开原文 <ExternalLink size={12} />
                    </a>
                  )}
                </p>
                {editable ? (
                  <input
                    value={editTags}
                    onChange={(event) => setEditTags(event.target.value)}
                    placeholder="标签，用逗号分隔"
                    className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selected.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {Object.keys(selected.kbTarget || {}).length > 0 && (
                  <p className="mt-3 text-xs text-gray-500">
                    知识库目标：{String(selected.kbTarget.wikiPath || '')}
                    {selected.kbTarget.status ? ` · ${String(selected.kbTarget.status)}` : ''}
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">原文</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowRaw((value) => !value)}
                      className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <FileText size={12} /> {showRaw ? '收起' : '查看原文'}
                    </button>
                    <button
                      type="button"
                      onClick={retry}
                      disabled={!!busy || !editable}
                      className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      {busy === 'retry' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      重新抽取
                    </button>
                  </div>
                </div>
                {showRaw && (
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-700 dark:bg-gray-950 dark:text-gray-300">
                    {selected.rawText || '原文为空或尚未解析完成'}
                  </pre>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default KnowledgeInboxPage;
