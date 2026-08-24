export type CriteriaChecklistState = 'pass' | 'fail' | 'pending';
export type CriteriaChecklistItem = {
  key: string;
  label: string;
  state: CriteriaChecklistState;
  detail: string;
};

/** The one minimal pass/fail/pending list style used for any "criteria behind this verdict"
 *  display -- the 30-day decision gates and the Scrutiny checks both render through this in the
 *  Wallet Stats detail dialog, so the two checklists read as one consistent design instead of a
 *  compact list next to a grid of bordered cards. */
export function CriteriaChecklist({ items }: { items: CriteriaChecklistItem[] }) {
  return (
    <ul className="copytrade-decision-checklist">
      {items.map((item) => (
        <li key={item.key} className={item.state}>
          <span className="copytrade-decision-checklist-icon" aria-hidden="true">
            {item.state === 'pending' ? '…' : item.state === 'pass' ? '✓' : '✗'}
          </span>
          <span className="copytrade-decision-checklist-label">{item.label}</span>
          <span className="copytrade-decision-checklist-detail">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
