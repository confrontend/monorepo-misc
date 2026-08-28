import { formatTime } from '../httpClient.js';

type FormattedDateProps = {
  value: string | null | undefined;
};

export function FormattedDate({ value }: FormattedDateProps) {
  const formatted = formatTime(value ?? null);

  if (!value) return <span>{formatted}</span>;

  return <time dateTime={value}>{formatted}</time>;
}
