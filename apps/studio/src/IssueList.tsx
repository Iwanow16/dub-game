import type { Issue } from "@dubroom/clip-format";

export function IssueList({ errors, warnings }: { errors: Issue[]; warnings: Issue[] }) {
  if (!errors.length && !warnings.length) return <p className="ok-text">✓ Проверки пройдены</p>;
  return (
    <ul className="issues" aria-live="polite">
      {errors.map((e, i) => (
        <li key={`e${i}`} className="error-text">
          ✗ {e.message}
          {e.path && <span className="dr-muted small"> ({e.path})</span>}
        </li>
      ))}
      {warnings.map((w, i) => (
        <li key={`w${i}`} className="warn-text">
          ⚠ {w.message}
        </li>
      ))}
    </ul>
  );
}
