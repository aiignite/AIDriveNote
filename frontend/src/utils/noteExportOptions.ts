export type ExportFormat = 'pdf' | 'docx' | 'html' | 'markdown' | 'png' | 'json' | 'svg';

export interface ExportOption {
  format: ExportFormat;
  label: string;
  icon: string;
}

/** 根据笔记类型返回支持的导出格式（无重型依赖，可安全用于首屏） */
export function getExportOptions(noteType: string): ExportOption[] {
  switch (noteType) {
    case 'rich_text':
    case 'markdown':
      return [
        { format: 'pdf', label: '导出 PDF', icon: 'FileText' },
        { format: 'docx', label: '导出 Word', icon: 'FileText' },
        { format: 'html', label: '导出 HTML', icon: 'Code' },
        { format: 'markdown', label: '导出 Markdown', icon: 'Hash' },
      ];
    case 'mindmap':
      return [
        { format: 'pdf', label: '导出 PDF', icon: 'FileText' },
        { format: 'png', label: '导出 PNG', icon: 'Image' },
        { format: 'json', label: '导出 JSON', icon: 'Braces' },
      ];
    case 'flowchart':
      return [
        { format: 'pdf', label: '导出 PDF', icon: 'FileText' },
        { format: 'png', label: '导出 PNG', icon: 'Image' },
        { format: 'svg', label: '导出 SVG', icon: 'Image' },
      ];
    default:
      return [{ format: 'pdf', label: '导出 PDF', icon: 'FileText' }];
  }
}
