export const copyText = async (value: string): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

export const copyAddress = async (address: string): Promise<void> => {
  await copyText(address);
};

export const copyJson = async (value: unknown): Promise<boolean> =>
  copyText(JSON.stringify(value, null, 2));

export const saveJson = (value: unknown, filename: string): void => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export const CopyAddressButton = ({
  address,
  label = 'wallet address',
}: {
  address: string;
  label?: string;
}) => (
  <button
    type="button"
    className="icon-copy"
    title={`Copy ${label}`}
    aria-label={`Copy ${label}`}
    onClick={(event) => {
      event.stopPropagation();
      void copyAddress(address);
    }}
  >
    ⧉
  </button>
);

export const SaveRowButton = ({ row, filename }: { row: unknown; filename: string }) => (
  <button
    type="button"
    className="icon-copy row-save-button"
    title="Save this row as JSON"
    aria-label="Save this row as JSON"
    onClick={(event) => {
      event.stopPropagation();
      saveJson(row, filename);
    }}
  >
    ⇩
  </button>
);
