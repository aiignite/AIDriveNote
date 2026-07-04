/**
 * 笔记导出工具 — 支持 PDF / DOCX / HTML / Markdown / PNG / JSON
 * 重型依赖（jspdf/docx/html2canvas）仅在用户点击导出时加载。
 */
import jsPDF from 'jspdf';
import { saveAs } from 'file-saver';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType,
} from 'docx';
import type { ExportFormat } from './noteExportOptions';

export type { ExportFormat, ExportOption } from './noteExportOptions';
export { getExportOptions } from './noteExportOptions';

function md2html(md: string): string {
  let html = md
    // 代码块 (fenced)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 标题
    .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
    // 粗体 & 斜体
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // 删除线
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    // 无序列表
    .replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>')
    // 有序列表
    .replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')
    // 引用
    .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')
    // 水平线
    .replace(/^---+$/gm, '<hr />')
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 图片
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
    // 段落（非空行）
    .replace(/^(?!<[hplbuo]|<hr|<pre|<code|<block)(.*\S.*)$/gm, '<p>$1</p>');

  // 合并连续 <li> 为 <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>(\s*<li>[\s\S]*?<\/li>)*)/g, '<ul>$1</ul>');

  return html;
}

/* ────── 辅助：BlockNote blocks → 纯文本 / HTML ────── */

function blocksToText(blocks: any[]): string {
  if (!blocks?.length) return '';
  const lines: string[] = [];
  for (const b of blocks) {
    let text = '';
    if (Array.isArray(b.content)) {
      text = b.content.map((c: any) => c.text ?? '').join('');
    }
    const prefix = b.type === 'heading' ? '#'.repeat(b.props?.level ?? 1) + ' ' : '';
    if (text) lines.push(prefix + text);
    if (b.children?.length) lines.push(blocksToText(b.children));
  }
  return lines.join('\n');
}

function blocksToHtml(blocks: any[]): string {
  if (!blocks?.length) return '';
  const parts: string[] = [];
  for (const b of blocks) {
    let text = '';
    if (Array.isArray(b.content)) {
      text = b.content.map((c: any) => {
        let t = c.text ?? '';
        if (c.styles?.bold) t = `<strong>${t}</strong>`;
        if (c.styles?.italic) t = `<em>${t}</em>`;
        if (c.styles?.underline) t = `<u>${t}</u>`;
        if (c.styles?.strikethrough) t = `<del>${t}</del>`;
        if (c.styles?.code) t = `<code>${t}</code>`;
        return t;
      }).join('');
    }
    switch (b.type) {
      case 'heading': {
        const level = b.props?.level ?? 1;
        parts.push(`<h${level}>${text}</h${level}>`);
        break;
      }
      case 'bulletListItem':
        parts.push(`<li>${text}</li>`);
        break;
      case 'numberedListItem':
        parts.push(`<li>${text}</li>`);
        break;
      case 'checkListItem':
        parts.push(`<li>[${b.props?.checked ? 'x' : ' '}] ${text}</li>`);
        break;
      default:
        if (text) parts.push(`<p>${text}</p>`);
    }
    if (b.children?.length) parts.push(blocksToHtml(b.children));
  }
  return parts.join('\n');
}

/* ────── 核心导出函数 ────── */

export async function exportNote(
  noteType: string,
  format: ExportFormat,
  title: string,
  content: unknown,
  mindMapRef?: any,
): Promise<void> {
  const fileName = sanitizeFileName(title || 'note');

  switch (format) {
    case 'pdf':
      return exportPdf(noteType, title, content, mindMapRef);
    case 'docx':
      return exportDocx(noteType, title, content);
    case 'html':
      return exportHtml(noteType, title, content);
    case 'markdown':
      return exportMarkdown(noteType, title, content);
    case 'png':
      return exportPng(noteType, fileName, content, mindMapRef);
    case 'json':
      return exportJson(fileName, content);
    case 'svg':
      return exportSvg(noteType, fileName, content);
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 60);
}

/* ────── PDF ────── */

async function exportPdf(
  noteType: string,
  title: string,
  content: unknown,
  mindMapRef?: any,
): Promise<void> {
  const fileName = sanitizeFileName(title);

  if (noteType === 'mindmap' && mindMapRef?.current) {
    // 思维导图 → 导出 PNG → 嵌入 PDF
    try {
      const dataUrl = await mindMapRef.current.export('png');
      if (dataUrl) {
        const pdf = new jsPDF({ orientation: 'landscape' });
        pdf.setFontSize(18);
        pdf.text(title, 14, 20);
        pdf.addImage(dataUrl, 'PNG', 10, 30, 270, 160);
        pdf.save(`${fileName}.pdf`);
        return;
      }
    } catch { /* fallback below */ }
  }

  if (noteType === 'flowchart') {
    // 流程图 → 截图方式
    const flowchartEl = document.querySelector('iframe[title="Drawio Editor"], iframe[title="Flowchart Viewer"]');
    if (flowchartEl) {
      const pdf = new jsPDF({ orientation: 'landscape' });
      pdf.setFontSize(18);
      pdf.text(title, 14, 20);
      pdf.setFontSize(10);
      pdf.text('流程图内容请在编辑器中查看（Draw.io 跨域限制无法直接截图）', 14, 35);
      pdf.save(`${fileName}.pdf`);
      return;
    }
  }

  // 文本类笔记（rich_text / markdown）→ HTML 渲染到隐藏 div → html2canvas → PDF
  let htmlContent = '';
  if (noteType === 'rich_text') {
    const blocks = Array.isArray(content)
      ? content
      : (content as any)?.blocks ?? [];
    htmlContent = blocksToHtml(blocks);
  } else if (noteType === 'markdown') {
    const text = typeof content === 'string' ? content : (content as any)?.text ?? '';
    htmlContent = md2html(text);
  }

  // 创建临时 DOM 渲染并用 html2canvas 截图
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:794px;padding:40px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.8;color:#1a1a1a;background:#fff;';
  container.innerHTML = `<h1 style="font-size:22px;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #e5e7eb;">${title}</h1>${htmlContent}`;
  document.body.appendChild(container);

  try {
    const { default: html2canvas } = await import('html2canvas-pro');
    const canvas = await html2canvas(container, { scale: 2, useCORS: true });
    const imgData = canvas.toDataURL('image/png');

    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

    let heightLeft = pdfHeight;
    let position = 0;

    pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
    heightLeft -= pdf.internal.pageSize.getHeight();

    while (heightLeft > 0) {
      position -= pdf.internal.pageSize.getHeight();
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
      heightLeft -= pdf.internal.pageSize.getHeight();
    }

    pdf.save(`${fileName}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}

/* ────── DOCX ────── */

function parseBlocksToParagraphs(blocks: any[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  if (!blocks?.length) return paragraphs;

  for (const b of blocks) {
    const runs: TextRun[] = [];
    if (Array.isArray(b.content)) {
      for (const c of b.content) {
        runs.push(new TextRun({
          text: c.text ?? '',
          bold: c.styles?.bold ?? false,
          italics: c.styles?.italic ?? false,
          underline: c.styles?.underline ? {} : undefined,
          strike: c.styles?.strikethrough ?? false,
          font: 'Microsoft YaHei',
          size: b.type === 'heading' ? (28 - (b.props?.level ?? 1) * 2) : 22,
        }));
      }
    }

    if (runs.length === 0 && b.type !== 'heading') continue;

    let heading: (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined;
    if (b.type === 'heading') {
      const level = b.props?.level ?? 1;
      heading = level === 1 ? HeadingLevel.HEADING_1
        : level === 2 ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3;
    }

    paragraphs.push(new Paragraph({
      children: runs.length ? runs : [new TextRun({ text: '' })],
      heading,
      bullet: b.type === 'bulletListItem' ? { level: 0 } : undefined,
      alignment: b.props?.textAlignment === 'center' ? AlignmentType.CENTER
        : b.props?.textAlignment === 'right' ? AlignmentType.RIGHT
        : AlignmentType.LEFT,
      spacing: { after: 120 },
    }));

    if (b.children?.length) {
      paragraphs.push(...parseBlocksToParagraphs(b.children));
    }
  }
  return paragraphs;
}

function mdToParagraphs(md: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = md.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: headingMatch[2], bold: true, font: 'Microsoft YaHei', size: 28 - level * 2 })],
        heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        spacing: { after: 120 },
      }));
      continue;
    }

    // List items
    const listMatch = trimmed.match(/^[-*+]\s+(.+)/);
    if (listMatch) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: listMatch[1], font: 'Microsoft YaHei', size: 22 })],
        bullet: { level: 0 },
        spacing: { after: 60 },
      }));
      continue;
    }

    // Blockquote
    const quoteMatch = trimmed.match(/^>\s+(.+)/);
    if (quoteMatch) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: quoteMatch[1], italics: true, font: 'Microsoft YaHei', size: 22 })],
        indent: { left: 720 },
        spacing: { after: 60 },
      }));
      continue;
    }

    // Normal paragraph - handle bold/italic inline
    const runs: TextRun[] = [];
    const parts = trimmed.split(/(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/);
    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**')) {
        runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: 'Microsoft YaHei', size: 22 }));
      } else if (part.startsWith('*') && part.endsWith('*')) {
        runs.push(new TextRun({ text: part.slice(1, -1), italics: true, font: 'Microsoft YaHei', size: 22 }));
      } else if (part.startsWith('~~') && part.endsWith('~~')) {
        runs.push(new TextRun({ text: part.slice(2, -2), strike: true, font: 'Microsoft YaHei', size: 22 }));
      } else if (part.startsWith('`') && part.endsWith('`')) {
        runs.push(new TextRun({ text: part.slice(1, -1), font: 'Courier New', size: 22 }));
      } else if (part) {
        runs.push(new TextRun({ text: part, font: 'Microsoft YaHei', size: 22 }));
      }
    }
    if (runs.length) {
      paragraphs.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
    }
  }
  return paragraphs;
}

async function exportDocx(
  noteType: string,
  title: string,
  content: unknown,
): Promise<void> {
  const fileName = sanitizeFileName(title);

  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, font: 'Microsoft YaHei', size: 32 })],
      heading: HeadingLevel.TITLE,
      spacing: { after: 300 },
    }),
  ];

  if (noteType === 'rich_text') {
    const blocks = Array.isArray(content) ? content : (content as any)?.blocks ?? [];
    paragraphs.push(...parseBlocksToParagraphs(blocks));
  } else if (noteType === 'markdown') {
    const text = typeof content === 'string' ? content : (content as any)?.text ?? '';
    paragraphs.push(...mdToParagraphs(text));
  } else {
    // mindmap/flowchart → 纯文本说明
    paragraphs.push(new Paragraph({
      children: [new TextRun({
        text: `此笔记为${noteType === 'mindmap' ? '思维导图' : '流程图'}类型，请在系统中在线查看。`,
        font: 'Microsoft YaHei',
        size: 22,
      })],
    }));
  }

  const doc = new Document({
    sections: [{ children: paragraphs }],
  });

  const buffer = await Packer.toBlob(doc);
  saveAs(buffer, `${fileName}.docx`);
}

/* ────── HTML ────── */

async function exportHtml(
  noteType: string,
  title: string,
  content: unknown,
): Promise<void> {
  const fileName = sanitizeFileName(title);
  let bodyHtml = '';

  if (noteType === 'rich_text') {
    const blocks = Array.isArray(content) ? content : (content as any)?.blocks ?? [];
    bodyHtml = blocksToHtml(blocks);
  } else if (noteType === 'markdown') {
    const text = typeof content === 'string' ? content : (content as any)?.text ?? '';
    bodyHtml = md2html(text);
  }

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: system-ui, -apple-system, sans-serif; line-height: 1.8; color: #1a1a1a; }
    h1 { font-size: 1.8em; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.3em; }
    h2 { font-size: 1.4em; margin-top: 1.5em; }
    h3 { font-size: 1.2em; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre code { display: block; padding: 12px; overflow-x: auto; }
    blockquote { border-left: 4px solid #d1d5db; margin: 1em 0; padding: 0.5em 1em; color: #6b7280; }
    ul, ol { padding-left: 2em; }
    li { margin: 0.3em 0; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
    a { color: #3b82f6; text-decoration: none; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${bodyHtml}
</body>
</html>`;

  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${fileName}.html`);
}

/* ────── Markdown ────── */

async function exportMarkdown(
  noteType: string,
  title: string,
  content: unknown,
): Promise<void> {
  const fileName = sanitizeFileName(title);
  let md = `# ${title}\n\n`;

  if (noteType === 'markdown') {
    const text = typeof content === 'string' ? content : (content as any)?.text ?? '';
    md += text;
  } else if (noteType === 'rich_text') {
    const blocks = Array.isArray(content) ? content : (content as any)?.blocks ?? [];
    md += blocksToText(blocks);
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  saveAs(blob, `${fileName}.md`);
}

/* ────── PNG ────── */

async function exportPng(
  noteType: string,
  fileName: string,
  _content: unknown,
  mindMapRef?: any,
): Promise<void> {
  if (noteType === 'mindmap' && mindMapRef?.current) {
    try {
      const dataUrl = await mindMapRef.current.export('png');
      if (dataUrl) {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${fileName}.png`;
        link.click();
        return;
      }
    } catch { /* fallback */ }
  }

  if (noteType === 'flowchart') {
    // Draw.io 通过 postMessage 触发导出
    const iframe = document.querySelector('iframe[title="Drawio Editor"]') as HTMLIFrameElement | null;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(JSON.stringify({
        action: 'export',
        format: 'png',
        filename: `${fileName}.png`,
      }), '*');
      return;
    }
  }
}

/* ────── JSON ────── */

async function exportJson(fileName: string, content: unknown): Promise<void> {
  const json = JSON.stringify(content, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  saveAs(blob, `${fileName}.json`);
}

/* ────── SVG ────── */

async function exportSvg(noteType: string, fileName: string, _content: unknown): Promise<void> {
  if (noteType === 'flowchart') {
    // Draw.io 通过 postMessage 触发 SVG 导出
    const iframe = document.querySelector('iframe[title="Drawio Editor"]') as HTMLIFrameElement | null;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(JSON.stringify({
        action: 'export',
        format: 'svg',
        filename: `${fileName}.svg`,
      }), '*');
      return;
    }
  }
}
