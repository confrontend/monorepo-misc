import { useEffect, useMemo, useState } from 'react';
import type {
  HTMLAttributes,
  Key,
  ReactElement,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  headerProps?: ThHTMLAttributes<HTMLTableCellElement>;
  render: (row: Row, index: number) => ReactNode;
  label?: string;
  cellProps?: (row: Row, index: number) => TdHTMLAttributes<HTMLTableCellElement> | undefined;
  /** Column stays in the `columns` array (so a caller's own visibility-picker state can name
   *  every column) but is skipped when hidden -- both header and body cells, and the empty-state
   *  colSpan uses the same filtered count, so callers never hand-recompute it themselves. */
  hidden?: boolean;
};

type DataTableProps<Row> = {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => Key;
  rowProps?: (
    row: Row,
    index: number,
  ) =>
    | (HTMLAttributes<HTMLTableRowElement> & {
        [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
      })
    | undefined;
  emptyMessage?: ReactNode;
  wrapClassName?: string;
  tableClassName?: string;
  enableColumnHiding?: boolean;
  columnVisibilityStorageKey?: string;
  enableExport?: boolean;
  exportFilename?: string;
  /** Replaces the body rows with a single spinner row spanning every visible column. */
  isLoading?: boolean;
  loadingMessage?: ReactNode;
  /** Replaces the body rows with a single error row; takes priority over isLoading. */
  isError?: boolean;
  errorMessage?: ReactNode;
};

const csvText = (value: ReactNode): string => {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(csvText).join('');
  if (typeof value === 'object' && 'props' in value) {
    const props = (value as ReactElement<{ status?: string; tag?: string; value?: unknown; children?: ReactNode }>).props;
    if (props.status) return props.status.replaceAll('_', ' ');
    if (props.tag) return props.tag;
    if (props.value !== undefined && typeof props.value !== 'object') return String(props.value);
    return csvText(props.children);
  }
  return '';
};

const csvCell = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const defaultColumnLabel = (key: string): string =>
  key
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (char) => char.toUpperCase());

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  rowProps,
  emptyMessage,
  wrapClassName = 'table-wrap',
  tableClassName,
  enableColumnHiding = false,
  columnVisibilityStorageKey,
  enableExport = false,
  exportFilename = 'table.csv',
  isLoading = false,
  loadingMessage = 'Loading…',
  isError = false,
  errorMessage = 'Something went wrong.',
}: DataTableProps<Row>) {
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!enableColumnHiding || !columnVisibilityStorageKey) return;
    try {
      const saved = window.localStorage.getItem(columnVisibilityStorageKey);
      if (saved) setHiddenColumnKeys(JSON.parse(saved) as string[]);
    } catch {
      // Local storage is an optional convenience; table rendering must still work without it.
    }
  }, [columnVisibilityStorageKey, enableColumnHiding]);

  useEffect(() => {
    if (!enableColumnHiding || !columnVisibilityStorageKey) return;
    try {
      window.localStorage.setItem(columnVisibilityStorageKey, JSON.stringify(hiddenColumnKeys));
    } catch {
      // Ignore unavailable or full local storage.
    }
  }, [columnVisibilityStorageKey, enableColumnHiding, hiddenColumnKeys]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !column.hidden && !hiddenColumnKeys.includes(column.key)),
    [columns, hiddenColumnKeys],
  );
  const hideableColumns = columns.filter((column) => !column.hidden);
  const resetColumns = () => setHiddenColumnKeys([]);
  const toggleColumn = (key: string) => {
    setHiddenColumnKeys((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key],
    );
  };
  const exportTable = () => {
    const header = visibleColumns.map((column) => csvCell(column.label ?? csvText(column.header)));
    const body = rows.map((row, index) =>
      visibleColumns.map((column) => csvCell(csvText(column.render(row, index)))),
    );
    const csv = [header, ...body].map((line) => line.join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFilename;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className={`${wrapClassName} data-table-wrap`}>
      {enableExport && (
        <button type="button" className="secondary data-table-export" onClick={exportTable}>
          Export CSV
        </button>
      )}
      {enableColumnHiding && (
        <details className="data-table-column-picker">
          <summary>Columns</summary>
          <div className="data-table-column-picker-menu">
            {hideableColumns.map((column) => {
              const isVisible = !hiddenColumnKeys.includes(column.key);
              return (
                <label key={column.key}>
                  <input
                    type="checkbox"
                    checked={isVisible}
                    disabled={isVisible && visibleColumns.length <= 1}
                    onChange={() => toggleColumn(column.key)}
                  />
                  {column.label ?? defaultColumnLabel(column.key)}
                </label>
              );
            })}
            <button type="button" className="secondary" onClick={resetColumns}>
              Reset columns
            </button>
          </div>
        </details>
      )}
      <table className={tableClassName}>
        <thead>
          <tr>
            {visibleColumns.map((column) => (
              <th key={column.key} {...column.headerProps}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isError ? (
            <tr>
              <td colSpan={visibleColumns.length} className="muted data-table-error-cell">
                {errorMessage}
              </td>
            </tr>
          ) : isLoading ? (
            <tr>
              <td colSpan={visibleColumns.length} className="muted data-table-loading-cell">
                <span className="loading-spinner" aria-hidden="true" /> {loadingMessage}
              </td>
            </tr>
          ) : (
            <>
              {rows.map((row, index) => (
                <tr key={getRowKey(row, index)} {...rowProps?.(row, index)}>
                  {visibleColumns.map((column) => (
                    <td key={column.key} {...column.cellProps?.(row, index)}>
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && emptyMessage !== undefined && (
                <tr>
                  <td colSpan={visibleColumns.length} className="muted">
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
