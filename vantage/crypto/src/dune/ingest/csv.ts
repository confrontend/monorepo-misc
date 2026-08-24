export interface CsvRecord {
  rowNumber: number;
  value: Record<string, string>;
}

/** RFC 4180-style parser with quoted fields, escaped quotes, and embedded newlines. */
export const parseCsv = (input: string): CsvRecord[] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV ended inside a quoted field.');
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows[0].map((header, index) => {
    const value = index === 0 ? header.replace(/^\uFEFF/, '') : header;
    return value.trim();
  });
  if (headers.some((header) => header.length === 0)) {
    throw new Error('CSV contains an empty column header.');
  }

  return rows
    .slice(1)
    .filter((values) => values.some((value) => value.length > 0))
    .map((values, index) => {
      const value: Record<string, string> = {};
      headers.forEach((header, column) => {
        value[header] = values[column] ?? '';
      });
      if (values.length > headers.length) {
        value.__extra_columns = JSON.stringify(values.slice(headers.length));
      }
      return { rowNumber: index + 2, value };
    });
};
