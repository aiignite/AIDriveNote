import React, { useEffect, useMemo, useState } from 'react';
import { preflightZip, MAX_XLSX_COLS, MAX_XLSX_ROWS, MAX_XLSX_SHEETS } from './documentLimits';

interface Props {
  bytes: Uint8Array;
  isDark: boolean;
}

type Row = unknown[];
const PAGE_ROWS = 200;

const XlsxDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const [sheets, setSheets] = useState<{ name: string; rows: Row[]; cols: number }[]>([]);
  const [active, setActive] = useState(0);
  const [visibleRows, setVisibleRows] = useState(PAGE_ROWS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSheets([]);
    setActive(0);
    setVisibleRows(PAGE_ROWS);

    const load = async () => {
      await preflightZip(bytes);
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(bytes.slice(0), {
        type: 'array',
        dense: true,
        sheetRows: MAX_XLSX_ROWS + 1,
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        bookVBA: false,
      });
      if (cancelled) return;
      const names = workbook.SheetNames.slice(0, MAX_XLSX_SHEETS);
      const parsed = names.map((name) => {
        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json<Row>(sheet, {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
        }).slice(0, MAX_XLSX_ROWS);
        const cols = Math.min(
          MAX_XLSX_COLS,
          rows.reduce((max, row) => Math.max(max, row.length), 0),
        );
        return { name, rows, cols };
      });
      setSheets(parsed);
    };

    void load().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Excel 文档解析失败');
    });

    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const current = sheets[active];
  const shownRows = useMemo(
    () => (current ? current.rows.slice(0, visibleRows) : []),
    [current, visibleRows],
  );

  if (error) {
    return <div className="flex h-full items-center justify-center p-6 text-xs text-red-500">{error}</div>;
  }
  if (!current) {
    return (
      <div className={`flex h-full items-center justify-center text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        正在解析 Excel…
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
      <div className={`flex gap-1 overflow-x-auto border-b px-2 py-1.5 shrink-0 ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        {sheets.map((sheet, index) => (
          <button
            key={`${sheet.name}-${index}`}
            type="button"
            onClick={() => {
              setActive(index);
              setVisibleRows(PAGE_ROWS);
            }}
            className={`whitespace-nowrap rounded px-2 py-1 text-[11px] ${
              index === active
                ? 'bg-orange-600 text-white'
                : isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {sheet.name}
          </button>
        ))}
        {sheets.length === MAX_XLSX_SHEETS && (
          <span className={`self-center text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            仅展示前 {MAX_XLSX_SHEETS} 个工作表
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        <table className="border-collapse bg-white text-[12px] text-gray-800">
          <tbody>
            {shownRows.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex === 0 ? 'bg-gray-100 font-semibold' : rowIndex % 2 ? 'bg-gray-50' : ''}>
                <td className="sticky left-0 z-10 border border-gray-200 bg-inherit px-1.5 py-1 text-center text-[10px] text-gray-400">
                  {rowIndex + 1}
                </td>
                {Array.from({ length: current.cols }).map((_, colIndex) => (
                  <td key={colIndex} className="max-w-[320px] truncate border border-gray-200 px-1.5 py-1">
                    {String(row[colIndex] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows < current.rows.length && (
          <div className="py-2 text-center">
            <button
              type="button"
              onClick={() => setVisibleRows((value) => value + PAGE_ROWS)}
              className="rounded border border-gray-300 bg-white px-3 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              显示更多（已显示 {shownRows.length} / {current.rows.length} 行）
            </button>
          </div>
        )}
        {current.rows.length === MAX_XLSX_ROWS && (
          <div className="py-2 text-center text-[10px] text-gray-400">
            仅展示前 {MAX_XLSX_ROWS} 行，完整内容请下载原文件
          </div>
        )}
        {current.rows.length === 0 && (
          <div className="p-6 text-center text-xs text-gray-400">该工作表为空</div>
        )}
      </div>
    </div>
  );
};

export default XlsxDocumentViewer;
