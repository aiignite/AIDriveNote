/** 按笔记类型生成 AI 侧栏快捷操作 */
import type { QuickAction } from '../services/ai/ai';

export function buildNoteQuickActions(
  noteType: string | undefined,
  title: string,
): QuickAction[] {
  if (!noteType) {
    return [
      { label: '创建笔记', prompt: '帮我创建一条新笔记' },
      { label: '搜索相关', prompt: '帮我搜索与当前话题相关的笔记' },
    ];
  }

  switch (noteType) {
    case 'mindmap':
      return [
        { label: '总结结构', prompt: `请总结思维导图「${title}」的结构要点` },
        { label: '扩展节点', prompt: `请为思维导图「${title}」扩展相关子节点` },
        { label: '优化文案', prompt: `请优化思维导图「${title}」各节点的文案表述` },
      ];
    case 'flowchart':
      return [
        { label: '总结流程', prompt: `请总结流程图「${title}」的主要步骤与分支` },
        { label: '补充步骤', prompt: `请为流程图「${title}」补充缺失的步骤或决策分支` },
        { label: '优化标签', prompt: `请优化流程图「${title}」各节点的标签文字` },
      ];
    case 'markdown':
    case 'rich_text':
    default:
      return [
        { label: '总结', prompt: `请总结当前笔记「${title}」` },
        { label: '续写', prompt: `请续写当前笔记「${title}」` },
        { label: '优化', prompt: `请优化润色当前笔记「${title}」` },
      ];
  }
}
