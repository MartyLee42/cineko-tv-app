// «Все устройства»: a super_admin may play on anyone's TV. Pickers keep showing
// the caller's own and shared TVs first; this small toggle (remembered per
// browser, super_admins only) adds everyone else's below, grouped by owner.
// Backend: GET /devices?scope=all (items with `via: "admin"` are reached only
// through the role); commands to them are audited server-side.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { isSuperAdminRole, unwrap, type Device } from "@martytv/contracts";
import { StatusDot, useI18n } from "@martytv/ui";
import { api, realtime } from "../api";
import { useDevices } from "../queries";
import { useSession } from "../session";

const KEY = "martytv.all_devices";
const listeners = new Set<() => void>();

function readFlag(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAllDevices(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: not remembered
  }
  listeners.forEach((l) => l());
}

function useFlag(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    readFlag,
    () => false,
  );
}

export function useIsSuperAdmin(): boolean {
  const { data: session } = useSession();
  return isSuperAdminRole(session?.user.role);
}

/** Someone else's TV, reached only through the super_admin role. */
export const isForeign = (d: Pick<Device, "via">) => d.via === "admin";

/**
 * The device list for TV pickers: own and shared TVs (as useDevices), plus —
 * for a super_admin with «Все устройства» on — everyone else's. `pin` adds
 * one foreign TV even with the toggle off (e.g. /remote/:id opened from a
 * "played on" toast).
 */
export function usePickerDevices(pin?: string) {
  const own = useDevices();
  const superAdmin = useIsSuperAdmin();
  const on = useFlag() && superAdmin;
  const needPin = superAdmin && !!pin && !!own.data && !own.data.some((d) => d.id === pin);
  const all = useQuery({
    // Under ["devices"], so presence / device.changed invalidations refresh it too.
    queryKey: ["devices", "all"],
    queryFn: async () => (await unwrap(api.GET("/devices", { params: { query: { scope: "all" } } }))).items,
    enabled: on || needPin,
  });
  const data = useMemo(() => {
    if (!own.data) return own.data;
    const extra = (all.data ?? []).filter((d) => isForeign(d) && (on || d.id === pin));
    return extra.length ? [...own.data, ...extra] : own.data;
  }, [own.data, all.data, on, pin]);
  return { data, isPending: own.isPending || (needPin && all.isPending), error: own.error };
}

/**
 * Small «Все устройства» switch for a TV picker (renders nothing for
 * non-super_admins). When on, lists the foreign TVs in `devices` grouped by
 * owner: buttons calling `onPick`, or links to the remote with `linkRemote`.
 */
export function AllDevicesToggle({
  devices,
  onPick,
  linkRemote = false,
  current,
}: {
  devices: Device[];
  onPick?: (id: string) => void;
  linkRemote?: boolean;
  /** Highlighted (remote page). */
  current?: string;
}) {
  const { t } = useI18n();
  const superAdmin = useIsSuperAdmin();
  const on = useFlag();
  const groups = useMemo(() => {
    const out = new Map<string, { key: string; name: string; items: Device[] }>();
    for (const d of devices) {
      if (!isForeign(d)) continue;
      const key = d.owner?.id ?? d.owner_user_id;
      const name = d.owner?.display_name || d.owner?.username || d.owner_username;
      const g = out.get(key) ?? { key, name, items: [] };
      g.items.push(d);
      out.set(key, g);
    }
    return [...out.values()];
  }, [devices]);
  if (!superAdmin) return null;

  return (
    <div className="mt-3" data-testid="all-devices">
      <button
        type="button"
        aria-pressed={on}
        title={t("superplay.hint")}
        onClick={() => setAllDevices(!on)}
        data-testid="all-devices-toggle"
        className="min-h-[32px] rounded-lg px-2 text-xs font-semibold text-muted underline-offset-2 hover:text-accent hover:underline"
      >
        {on ? t("superplay.hide_all") : t("superplay.show_all")}
      </button>
      {on && (
        <div className="mt-1 space-y-3" data-testid="all-devices-list">
          {!groups.length && <p className="px-2 text-xs text-muted">{t("superplay.none")}</p>}
          {groups.map((g) => (
            <section key={g.key}>
              <h3 className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.name}</h3>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {g.items.map((d) => {
                  const cls = `flex min-h-[36px] items-center gap-2 rounded-full border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    d.id === current ? "border-accent bg-accent/15" : "border-border bg-bg/40 hover:border-accent"
                  }`;
                  const body = (
                    <>
                      <StatusDot online={d.online} />
                      <span className="max-w-[12rem] truncate">{d.name}</span>
                    </>
                  );
                  return (
                    <li key={d.id} data-testid="all-device" data-device-id={d.id}>
                      {linkRemote ? (
                        <Link to={`/remote/${d.id}`} replace className={cls} aria-current={d.id === current ? "page" : undefined}>
                          {body}
                        </Link>
                      ) : (
                        <button type="button" disabled={!d.online} onClick={() => onPick?.(d.id)} className={cls}>
                          {body}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Keeps a foreign TV's remote live: the server forwards a TV's device.state /
 * device.presence to a super_admin's socket only after it sent that TV a
 * command, so ask for the state on open and after every reconnect.
 */
export function useWatchForeign(d: Device) {
  const foreign = isForeign(d);
  useEffect(() => {
    if (!foreign) return;
    const ask = () => {
      if (realtime.state === "open") realtime.command(d.id, "device.request_state").catch(() => {});
    };
    ask();
    return realtime.onState((s) => {
      if (s === "open") ask();
    });
  }, [foreign, d.id]);
}
