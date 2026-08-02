function cls(score: number | null): string {
  if (score === null) return "zero";
  if (score > 0) return "pos";
  if (score < 0) return "neg";
  return "zero";
}

function sign(score: number | null): string {
  if (score === null) return "n/a";
  return score > 0 ? `+${score}` : String(score);
}

export default function ScoreBadge({ score }: { score: number | null }) {
  return <span className={`score ${cls(score)}`}>{sign(score)}</span>;
}
