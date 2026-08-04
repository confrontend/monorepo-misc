import type { GmailMessageSummary } from '../gmail/gmailApi';

const PAGE_SIZE_OPTIONS = [10, 25, 50];

interface EmailListProps {
  items: GmailMessageSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  pageNumber: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNext: () => void;
  onPrevious: () => void;
  loading: boolean;
}

export default function EmailList({
  items,
  selectedId,
  onSelect,
  pageSize,
  onPageSizeChange,
  pageNumber,
  hasNextPage,
  hasPreviousPage,
  onNext,
  onPrevious,
  loading,
}: EmailListProps) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid #ccc',
        }}
      >
        <span style={{ fontSize: 13, color: '#666' }}>
          {loading ? 'Loading…' : `${items.length} shown`}
        </span>
        <label style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 6 }}>
          Per page
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 320 }}>
        {!loading && items.length === 0 && (
          <p style={{ padding: 12, color: '#666', fontSize: 14 }}>
            No messages from seekingalpha.com on this page.
          </p>
        )}
        {items.map((item, i) => (
          <div
            key={item.id}
            onClick={() => onSelect(item.id)}
            style={{
              padding: '10px 12px',
              borderTop: i === 0 ? 'none' : '1px solid #eee',
              cursor: 'pointer',
              background: item.id === selectedId ? '#f2f2f2' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{item.from}</span>
              <span style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>{item.date}</span>
            </div>
            <div style={{ fontSize: 14 }}>{item.subject}</div>
            <div
              style={{
                fontSize: 13,
                color: '#666',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.snippet}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderTop: '1px solid #ccc',
        }}
      >
        <button onClick={onPrevious} disabled={!hasPreviousPage || loading}>
          Previous
        </button>
        <span style={{ fontSize: 13, color: '#666' }}>Page {pageNumber}</span>
        <button onClick={onNext} disabled={!hasNextPage || loading}>
          Next
        </button>
      </div>
    </div>
  );
}
