import type { HTMLAttributes, Key, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  headerProps?: ThHTMLAttributes<HTMLTableCellElement>;
  render: (row: Row, index: number) => ReactNode;
  cellProps?: (row: Row, index: number) => TdHTMLAttributes<HTMLTableCellElement> | undefined;
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
  return (
    <div className={`${wrapClassName} data-table-wrap`}>
      <table className={tableClassName}>
        <thead><tr>{columns.map((column) => <th key={column.key} {...column.headerProps}>{column.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={getRowKey(row, index)} {...rowProps?.(row, index)}>
            {columns.map((column) => <td key={column.key} {...column.cellProps?.(row, index)}>{column.render(row, index)}</td>)}
          </tr>)}
          {rows.length === 0 && emptyMessage !== undefined && <tr><td colSpan={columns.length} className="muted">{emptyMessage}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
