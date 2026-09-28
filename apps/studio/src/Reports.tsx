import { useEffect, useState } from "react";
import { Button } from "@dubroom/ui";
import { api, type Report } from "./api.ts";

/** Complaints (§14): takedown within 24 h — archive the clip from the library view. */
export function Reports() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const load = () => api.reports().then((r) => setReports(r.reports));
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="library">
      <h2>Жалобы</h2>
      {reports?.length === 0 && <p className="dr-muted">Жалоб нет.</p>}
      <table className="table">
        <tbody>
          {reports?.map((r) => (
            <tr key={r.id} className={r.resolved_at ? "muted-row" : ""}>
              <td>{new Date(r.created_at).toLocaleString("ru")}</td>
              <td>
                {r.target_type}: <code>{r.target_id}</code>
              </td>
              <td>{r.reason}</td>
              <td>
                {r.resolved_at ? (
                  "✓ решено"
                ) : (
                  <Button size="small" onClick={() => api.resolveReport(r.id).then(load)}>
                    Решено
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
