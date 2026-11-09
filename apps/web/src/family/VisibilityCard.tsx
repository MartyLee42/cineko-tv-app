// Admin → Overview: «Кто видит чьи лайки» — who sees whose likes in «Семья
// советует» (GET/PUT /admin/family-visibility; services/api family/visibility.go).
// Rows are viewers (grouped by account), columns are sharers. A cell follows
// the sharer's «Делиться с семьёй» until the admin sets it (shown with a ring).
import { Fragment, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { ProfileAvatar, useI18n } from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText } from "../components";
import {
  applyChanges,
  cellOf,
  groupByAccount,
  overrideMap,
  resetAll,
  resetLine,
  toggleCell,
  toggleLine,
  type VisChange,
  type VisProfile,
  type Visibility,
} from "./visibility";

const KEY = ["admin", "family-visibility"] as const;

const lineBtn = "rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent";

export function FamilyVisibilityCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET("/admin/family-visibility")) });
  const seq = useRef(0);
  const save = useMutation({
    mutationFn: (changes: VisChange[]) => unwrap(api.PUT("/admin/family-visibility", { body: { changes } })),
    // Optimistic: the table flips at once; only the latest answer is applied.
    onMutate: (changes) => {
      const prev = qc.getQueryData<Visibility>(KEY);
      if (prev) qc.setQueryData(KEY, applyChanges(prev, changes));
      return ++seq.current;
    },
    onSuccess: (data, _changes, id) => {
      if (id === seq.current) qc.setQueryData(KEY, data);
    },
    onError: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const send = (changes: VisChange[]) => {
    if (changes.length > 0) save.mutate(changes);
  };

  const v = q.data;
  const overrides = v ? overrideMap(v) : new Map<string, boolean>();
  const cols = v?.profiles ?? [];
  const accounts = groupByAccount(cols);
  const colHasOverride = (sharer: string) => v?.overrides.some((o) => o.sharer_profile_id === sharer) ?? false;
  const rowHasOverride = (viewer: string) => v?.overrides.some((o) => o.viewer_profile_id === viewer) ?? false;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{t("familyvis.title")}</h2>
        {v && v.overrides.length > 0 && (
          <>
            <span className="text-sm text-muted">{t("familyvis.overrides", { n: v.overrides.length })}</span>
            <Button
              variant="secondary"
              className="ml-auto min-h-[36px] text-sm"
              onClick={() => confirm(t("familyvis.reset_all_confirm")) && send(resetAll(v))}
              data-testid="familyvis-reset-all"
            >
              {t("familyvis.reset_all")}
            </Button>
          </>
        )}
      </div>
      <p className="text-sm text-muted">{t("familyvis.hint")}</p>
      <Legend />
      <ErrorText error={q.error ?? save.error} />
      {v && cols.length < 2 && <p className="text-sm text-muted">{t("familyvis.empty")}</p>}
      {v && cols.length >= 2 && (
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5" data-testid="familyvis-table">
          <table className="border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-20 bg-surface pb-2 pr-3 text-left align-bottom text-xs font-medium text-muted">
                  {t("familyvis.corner")}
                </th>
                {cols.map((s) => (
                  <th key={s.profile_id} scope="col" className="w-[84px] min-w-[84px] px-1 pb-2 align-bottom font-normal">
                    <div className="flex flex-col items-center gap-0.5 text-center">
                      <ProfileAvatar name={s.name} color={s.color} avatar={s.avatar} size={28} />
                      <span className="block max-w-[80px] truncate font-medium" title={`${s.name} · ${s.user_name}`}>
                        {s.name}
                      </span>
                      <span className={`text-[11px] ${s.share_with_family ? "text-accent" : "text-muted"}`}>
                        {t(s.share_with_family ? "familyvis.legend_shares" : "familyvis.legend_private")}
                      </span>
                      <span className="flex">
                        <button type="button" className={lineBtn} aria-label={t("familyvis.toggle_col", { name: s.name })} title={t("familyvis.toggle_col", { name: s.name })} onClick={() => send(toggleLine(v, { sharer: s.profile_id }))}>
                          {t("familyvis.all")}
                        </button>
                        <button
                          type="button"
                          className={lineBtn}
                          disabled={!colHasOverride(s.profile_id)}
                          aria-label={t("familyvis.reset_col", { name: s.name })}
                          title={t("familyvis.reset_col", { name: s.name })}
                          onClick={() => send(resetLine(v, { sharer: s.profile_id }))}
                        >
                          ↺
                        </button>
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((acc) => (
                <Fragment key={acc.userId}>
                  <tr>
                    <th scope="rowgroup" className="sticky left-0 z-10 bg-surface pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      {acc.userName}
                    </th>
                    <td colSpan={cols.length} />
                  </tr>
                  {acc.profiles.map((viewer) => (
                    <tr key={viewer.profile_id} className={viewer.show_family ? "" : "opacity-60"}>
                      <th scope="row" className="sticky left-0 z-10 border-t border-border bg-surface py-1.5 pr-3 text-left font-normal">
                        <div className="flex items-center gap-2">
                          <ProfileAvatar name={viewer.name} color={viewer.color} avatar={viewer.avatar} size={28} />
                          <div className="min-w-0">
                            <div className="max-w-[9rem] truncate font-medium">{viewer.name}</div>
                            {!viewer.show_family && <div className="text-[11px] text-muted">{t("familyvis.hidden")}</div>}
                          </div>
                          <span className="ml-auto flex shrink-0">
                            <button type="button" className={lineBtn} aria-label={t("familyvis.toggle_row", { name: viewer.name })} title={t("familyvis.toggle_row", { name: viewer.name })} onClick={() => send(toggleLine(v, { viewer: viewer.profile_id }))}>
                              {t("familyvis.all")}
                            </button>
                            <button
                              type="button"
                              className={lineBtn}
                              disabled={!rowHasOverride(viewer.profile_id)}
                              aria-label={t("familyvis.reset_row", { name: viewer.name })}
                              title={t("familyvis.reset_row", { name: viewer.name })}
                              onClick={() => send(resetLine(v, { viewer: viewer.profile_id }))}
                            >
                              ↺
                            </button>
                          </span>
                        </div>
                      </th>
                      {cols.map((sharer) => (
                        <td key={sharer.profile_id} className="border-t border-border p-1 text-center">
                          <CellBox v={v} overrides={overrides} viewer={viewer} sharer={sharer} onToggle={(c) => send([c])} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CellBox({
  v,
  overrides,
  viewer,
  sharer,
  onToggle,
}: {
  v: Visibility;
  overrides: Map<string, boolean>;
  viewer: VisProfile;
  sharer: VisProfile;
  onToggle: (c: VisChange) => void;
}) {
  const { t } = useI18n();
  if (viewer.profile_id === sharer.profile_id) {
    return (
      <span className="text-muted" title={t("familyvis.self")} aria-label={t("familyvis.self")}>
        —
      </span>
    );
  }
  const c = cellOf(overrides, viewer.profile_id, sharer);
  const label = `${t("familyvis.cell", { viewer: viewer.name, sharer: sharer.name })} (${t(c.override === null ? "familyvis.cell_default" : "familyvis.cell_override")})`;
  return (
    <label
      className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg ${c.override === null ? "" : "bg-accent/15 ring-2 ring-accent"}`}
      title={label}
      data-testid={`familyvis-cell-${viewer.profile_id}-${sharer.profile_id}`}
      data-override={c.override === null ? "default" : "set"}
    >
      <input
        type="checkbox"
        className={`h-4 w-4 ${c.override === null ? "opacity-60" : ""}`}
        checked={c.visible}
        onChange={() => onToggle(toggleCell(v, viewer.profile_id, sharer))}
        aria-label={label}
      />
    </label>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md">
          <input type="checkbox" className="h-3.5 w-3.5 opacity-60" checked readOnly tabIndex={-1} aria-hidden />
        </span>
        {t("familyvis.legend_default")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 ring-2 ring-accent">
          <input type="checkbox" className="h-3.5 w-3.5" checked readOnly tabIndex={-1} aria-hidden />
        </span>
        {t("familyvis.legend_override")}
      </span>
    </div>
  );
}
