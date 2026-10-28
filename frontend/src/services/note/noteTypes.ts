/** 笔记类型与展示文案的单一来源，避免前后端新增类型时漏改。 */
export const NOTE_TYPES = [
  'rich_text',
  'markdown',
  'mindmap',
  'flowchart',
  'document',
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

/** 可由用户直接创建/编辑的类型（文档只能通过上传导入）。 */
export const EDITABLE_NOTE_TYPES: NoteType[] = [
  'rich_text',
  'markdown',
  'mindmap',
  'flowchart',
];

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  rich_text: '富文本',
  markdown: 'Markdown',
  mindmap: '思维导图',
  flowchart: '流程图',
  document: '文档',
};

export function isDocumentType(noteType: string | null | undefined): boolean {
  return noteType === 'document';
}
