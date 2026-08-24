import type { HTMLAttributes, Key, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  headerProps?: ThHTMLAttributes<HTMLTableCellElement>;
  render: (row: Row, index: number) => ReactNode;
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
  rowProps?: (row: Row, index: number) => (HTMLAttributes<HTMLTableRowElement> & { [dataAttribute: `data-${string}`]: string | number | boolean | undefined }) | undefined;
  emptyMessage?: ReactNode;
  wrapClassName?: string;
  tableClassName?: string;
};

export function DataTable<Row>({ columns, rows, getRowKey, rowProps, emptyMessage, wrapClassName = 'table-wrap', tableClassName }: DataTableProps<Row>) {
  const visibleColumns = columns.filter((column) => !column.hidden);
  return (
    <div className={`${wrapClassName} data-table-wrap`}>
      <table className={tableClassName}>
        <thead><tr>{visibleColumns.map((column) => <th key={column.key} {...column.headerProps}>{column.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={getRowKey(row, index)} {...rowProps?.(row, index)}>
            {visibleColumns.map((column) => <td key={column.key} {...column.cellProps?.(row, index)}>{column.render(row, index)}</td>)}
          </tr>)}
          {rows.length === 0 && emptyMessage !== undefined && <tr><td colSpan={visibleColumns.length} className="muted">{emptyMessage}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
