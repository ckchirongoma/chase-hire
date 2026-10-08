export function Stars({ stars, max = 6 }: { stars: number; max?: number }) {
  return (
    <span aria-label={`${stars} out of ${max} stars`} className="text-2xl tracking-wider text-amber-500">
      {"★".repeat(stars)}
      <span className="text-slate-300">{"★".repeat(Math.max(0, max - stars))}</span>
    </span>
  );
}

export function ReasoningResultCard({
  rawScore,
  percentile,
  stars,
  normVersion,
}: {
  rawScore: number;
  percentile: number;
  stars: number;
  normVersion: string | null;
}) {
  const provisional = (normVersion ?? "").startsWith("provisional");
  return (
    <div className="card space-y-2">
      <h2 className="h2">Reasoning Assessment result</h2>
      <Stars stars={stars} />
      <p className="text-sm">
        You answered <strong>{rawScore} of 30</strong> correctly, which places you at the{" "}
        <strong>{Math.round(percentile)}th percentile</strong>.
      </p>
      <p className="muted">
        The percentile compares you with other people who applied to Chase Agents, not with the general population.
        {provisional && " Until enough people have taken the assessment, it is based on a provisional estimate and may be updated."}
        {" "}This is a job-related problem-solving assessment. It carries 10% of the pre-interview score and is never used to reject anyone automatically.
      </p>
    </div>
  );
}
