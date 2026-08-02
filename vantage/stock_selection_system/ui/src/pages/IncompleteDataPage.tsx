import InsufficientDataCases from "../components/InsufficientDataCases";
import type { InsufficientDataCase } from "../types";

export default function IncompleteDataPage({ cases }: { cases: InsufficientDataCase[] }) {
  return <div className="page"><div className="page-header"><div><h1>Incomplete Data</h1><div className="page-sub">Cases waiting for required Earnings, Market, or Context inputs before scoring.</div></div></div><div className="hr" /><InsufficientDataCases cases={cases} /></div>;
}
