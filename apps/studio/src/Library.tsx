import { useCallback, useEffect, useState } from "react";
import { localized } from "@dubroom/shared";
import { Button, Modal, useToast } from "@dubroom/ui";
import { api, type ClipRow, type ClipVersion, type Draft } from "./api.ts";
import { PackagePreview } from "./PackagePreview.tsx";
import { IssueList } from "./IssueList.tsx";

const STATUS_LABEL: Record<string, string> = {
  draft: "черновик",
  queued: "в очереди",
  processing: "обработка",
  done: "обработан",
  failed: "ошибка",
  review: "на модерации",
  published: "опубликован",
  rejected: "отклонён",
  superseded: "прошлая версия",
  archived: "в архиве",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status status--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Library + moderation (§9.2 steps 8–9): review, publish, reject, roll back, archive. */
export function Library() {
  const toast = useToast();
  const [clips, setClips] = useState<ClipRow[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<ClipVersion | null>(null);

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([api.clips(), api.drafts()]);
    setClips(c.clips);
    setDrafts(d.drafts);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast({ text: done, kind: "success" }, 2500);
      setPreview(null);
      await load();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const openDrafts = drafts.filter((d) => d.status !== "done");
  const review = (clips ?? []).flatMap((c) => c.versions.filter((v) => v.status === "review"));

  return (
    <main className="library">
      {review.length > 0 && (
        <section>
          <h2>На модерации</h2>
          <div className="cards">
            {review.map((v) => (
              <div key={`${v.clipId}-${v.version}`} className="dr-card clip-row">
                <strong>{v.manifest ? localized(v.manifest.title, "ru") : v.clipId}</strong>
                <span className="dr-muted">
                  v{v.version} · {v.manifest?.ageRating} · {v.manifest?.license}
                </span>
                {v.warnings.length > 0 && (
                  <span className="warn-text">⚠ предупреждений: {v.warnings.length}</span>
                )}
                <Button size="small" onClick={() => setPreview(v)}>
                  Проверить
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {openDrafts.length > 0 && (
        <section>
          <h2>Черновики</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Клип</th>
                <th>Версия</th>
                <th>Статус</th>
                <th>Обновлён</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {openDrafts.map((d) => (
                <tr key={d.id}>
                  <td>{localized(d.manifest.title, "ru")}</td>
                  <td>v{d.version}</td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.status === "processing" && ` ${Math.round(d.progress * 100)}%`}
                  </td>
                  <td>{new Date(d.updatedAt).toLocaleString("ru")}</td>
                  <td className="row">
                    <a className="dr-btn dr-btn--small" href={`#/draft/${d.id}`}>
                      Открыть
                    </a>
                    {(d.status === "draft" || d.status === "failed") && (
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() =>
                          confirm("Удалить черновик?") &&
                          act(() => api.deleteDraft(d.id), "Черновик удалён")
                        }
                      >
                        Удалить
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Клипы</h2>
        {clips === null && <div className="dr-skeleton" style={{ height: 120 }} />}
        {clips?.length === 0 && <p className="dr-muted">Пока пусто. Нажмите «+ Новый клип».</p>}
        <table className="table">
          <tbody>
            {clips?.map((c) => {
              const current =
                c.versions.find((v) => v.version === c.currentVersion) ?? c.versions[0];
              const title = current?.manifest ? localized(current.manifest.title, "ru") : c.slug;
              return (
                <tr key={c.id}>
                  <td>
                    <strong>{title}</strong>
                    <div className="dr-muted small">{c.slug}</div>
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="small">
                    {c.versions.map((v) => (
                      <div key={v.version}>
                        v{v.version}: <StatusBadge status={v.status} />
                        {v.error && <span className="error-text"> {v.error.slice(0, 80)}</span>}
                        {(v.status === "superseded" || v.status === "review") && (
                          <Button size="small" variant="ghost" onClick={() => setPreview(v)}>
                            {v.status === "superseded" ? "откатить" : "проверить"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td className="row">
                    {current?.manifest && (
                      <Button size="small" onClick={() => void newVersion(c, current)}>
                        Новая версия
                      </Button>
                    )}
                    {c.status === "archived" ? (
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => act(() => api.unarchive(c.id), "Возвращён")}
                      >
                        Вернуть
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() =>
                          confirm("Снять клип из игры?") &&
                          act(() => api.archive(c.id), "Клип снят")
                        }
                      >
                        В архив
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {preview && (
        <Modal
          title={`${preview.manifest ? localized(preview.manifest.title, "ru") : ""} · v${preview.version}`}
          onClose={() => setPreview(null)}
        >
          <PackagePreview version={preview} />
          <IssueList errors={[]} warnings={preview.warnings} />
          <ModerationChecklist />
          <div className="row">
            <Button
              variant="primary"
              onClick={() =>
                act(() => api.publish(preview.clipId, preview.version), "Опубликовано")
              }
            >
              {preview.status === "superseded" ? "Откатить на эту версию" : "Опубликовать"}
            </Button>
            {preview.status === "review" && (
              <Button
                variant="danger"
                onClick={() => {
                  const reason = prompt("Причина отклонения") ?? "";
                  void act(() => api.reject(preview.clipId, preview.version, reason), "Отклонено");
                }}
              >
                Отклонить
              </Button>
            )}
          </div>
        </Modal>
      )}
    </main>
  );

  async function newVersion(c: ClipRow, v: ClipVersion) {
    const m = { ...v.manifest! };
    delete m.media;
    delete m.checksums;
    try {
      const { draftId } = await api.createDraft(m);
      location.hash = `#/draft/${draftId}`;
    } catch (e) {
      toast({ text: `${c.slug}: ${(e as Error).message}`, kind: "error" });
    }
  }
}

/** Second-pair-of-eyes checklist (§9.2 step 8, §10 author checklist). */
function ModerationChecklist() {
  return (
    <ul className="checklist">
      <li>Права и источник указаны, лицензия допускает использование</li>
      <li>Голос в фоне не слышен в местах реплик</li>
      <li>Реплики совпадают с губами, роли назначены верно</li>
      <li>Возрастной рейтинг соответствует содержанию</li>
    </ul>
  );
}
