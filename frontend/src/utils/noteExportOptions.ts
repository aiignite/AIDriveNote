/**
 * 笔记导出格式选项 —— 按笔记类型返回支持的导出格式（无重型依赖，可安全用于首屏）。
 */

/** 支持的导出格式 */
export type ExportFormat =
  | 'pdf' | 'docx' | 'html' | 'markdown' | 'png' | 'json' | 'svg'
  | 'xmind' | 'xml';

/** 单个导出选项 */
export interface ExportOption {
  /** 格式标识 */
  format: ExportFormat;
  /** 按钮/菜单项文案 */
  label: string;
  /** 图标名（沿用历史字段，界面已改用统一图标） */
  icon: string;
}

/**
 * 根据笔记类型返回支持的导出格式。
 * @param noteType 笔记类型（rich_text / markdown / mindmap / flowchart）
 * @returns 该类型可用的导出格式列表
 */
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
        { format: 'png', label: '导出 PNG 图片', icon: 'Image' },
        { format: 'svg', label: '导出 SVG 矢量图', icon: 'Image' },
        { format: 'pdf', label: '导出 PDF', icon: 'FileText' },
        { format: 'xmind', label: '导出 XMind', icon: 'Braces' },
        { format: 'json', label: '导出 JSON 源文件', icon: 'Braces' },
      ];
    case 'flowchart':
      return [
        { format: 'png', label: '导出 PNG 图片', icon: 'Image' },
        { format: 'svg', label: '导出 SVG 矢量图', icon: 'Image' },
        { format: 'pdf', label: '导出 PDF', icon: 'FileText' },
        { format: 'xml', label: '导出 XML 源文件', icon: 'Code' },
      ];
    default:
      return [{ format: 'pdf', label: '导出 PDF', icon: 'FileText' }];
  }
}