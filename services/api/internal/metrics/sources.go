package metrics

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"martytv/api/internal/devices"
	"martytv/api/internal/foryou"
	"martytv/api/internal/sysmon"
)

const mib = 1 << 20

// SystemSource: the admin Server tab's numbers (host or container load,
// containers, DB/image cache size, TorrServer, transcoder, integrations).
// sysmon caches the expensive parts; integrations come from the shared
// checker cache (30 s), the same one /readyz reads.
func SystemSource(status func(ctx context.Context) sysmon.SystemStatus) Source {
	return Source{Name: "system", Collect: func(ctx context.Context) ([]Family, error) {
		return SystemFamilies(status(ctx)), nil
	}}
}

// SystemFamilies converts one sysmon status.
func SystemFamilies(st sysmon.SystemStatus) []Family {
	h := st.HostStatus
	info := Vec("host_info", "Where host numbers come from: scope host (martytv-hostmon) or container (fallback).", "scope", "hostmon")
	info.Add(1, h.Scope, st.Hostmon)
	out := []Family{
		*info,
		Gauge("host_uptime_seconds", "Host (or container) uptime.", h.UptimeSeconds),
		Gauge("host_cpu_cores", "CPU cores.", float64(h.CPU.Cores)),
		Gauge("host_cpu_usage_ratio", "CPU use over the last sample, 0–1 of all cores.", h.CPU.UsagePercent/100),
		Gauge("host_cpu_steal_ratio", "CPU steal, 0–1.", h.CPU.StealPercent/100),
		Gauge("host_cpu_iowait_ratio", "CPU iowait, 0–1.", h.CPU.IOWaitPercent/100),
		Gauge("host_load1", "1-minute load average.", h.LoadAvg[0]),
		Gauge("host_load5", "5-minute load average.", h.LoadAvg[1]),
		Gauge("host_load15", "15-minute load average.", h.LoadAvg[2]),
		Gauge("host_memory_total_bytes", "Memory total.", float64(h.Memory.Total)),
		Gauge("host_memory_used_bytes", "Memory used.", float64(h.Memory.Used)),
		Gauge("host_memory_available_bytes", "Memory available.", float64(h.Memory.Available)),
		Gauge("host_memory_cached_bytes", "Page cache.", float64(h.Memory.Cached)),
		Gauge("host_swap_total_bytes", "Swap total.", float64(h.Memory.SwapTotal)),
		Gauge("host_swap_used_bytes", "Swap used.", float64(h.Memory.SwapUsed)),
	}
	dTotal := Vec("host_disk_total_bytes", "Filesystem size.", "mount")
	dUsed := Vec("host_disk_used_bytes", "Filesystem used.", "mount")
	dFree := Vec("host_disk_free_bytes", "Filesystem free.", "mount")
	seenMount := map[string]bool{}
	for _, d := range h.Disks {
		if seenMount[d.Mount] {
			continue
		}
		seenMount[d.Mount] = true
		dTotal.Add(float64(d.Total), d.Mount)
		dUsed.Add(float64(d.Used), d.Mount)
		dFree.Add(float64(d.Free), d.Mount)
	}
	rx := Vec("host_network_receive_bytes_total", "Bytes received.", "iface")
	tx := Vec("host_network_transmit_bytes_total", "Bytes sent.", "iface")
	rx.Type, tx.Type = prometheus.CounterValue, prometheus.CounterValue
	seenIface := map[string]bool{}
	for _, n := range h.Network {
		if seenIface[n.Iface] {
			continue
		}
		seenIface[n.Iface] = true
		rx.Add(float64(n.RxTotal), n.Iface)
		tx.Add(float64(n.TxTotal), n.Iface)
	}
	cRun := Vec("container_running", "1 when the Docker container is running (hostmon only).", "container")
	cCPU := Vec("container_cpu_ratio", "Container CPU use, 1 = one full core.", "container")
	cMem := Vec("container_memory_bytes", "Container memory use.", "container")
	cLim := Vec("container_memory_limit_bytes", "Container memory limit (0 = none).", "container")
	seenC := map[string]bool{}
	for _, c := range h.Containers {
		if seenC[c.Name] {
			continue
		}
		seenC[c.Name] = true
		cRun.Add(b2f(c.State == "running"), c.Name)
		cCPU.Add(c.CPUPercent/100, c.Name)
		cMem.Add(float64(c.MemBytes), c.Name)
		cLim.Add(float64(c.MemLimitBytes), c.Name)
	}
	out = append(out, *dTotal, *dUsed, *dFree, *rx, *tx, *cRun, *cCPU, *cMem, *cLim)

	a := st.App
	if a.DBSizeBytes != nil {
		out = append(out, Gauge("db_size_bytes", "Postgres database size.", float64(*a.DBSizeBytes)))
	}
	if a.ImageCacheBytes != nil {
		out = append(out, Gauge("image_cache_bytes", "TMDB image cache size.", float64(*a.ImageCacheBytes)))
	}
	ts := a.TorrServer
	if ts.Configured {
		out = append(out,
			Gauge("torrserver_up", "1 when TorrServer answered.", b2f(ts.OK)),
			Gauge("torrserver_torrents", "Torrents in TorrServer.", float64(ts.Torrents)),
			Gauge("torrserver_active_torrents", "Torrents preloading or streaming.", float64(ts.Active)),
			Gauge("torrserver_peers", "Connected peers, all torrents.", float64(ts.Peers)),
			Gauge("torrserver_download_bytes_per_second", "Download speed, all torrents.", ts.DownloadSpeedBps),
			Gauge("torrserver_upload_bytes_per_second", "Upload speed, all torrents.", ts.UploadSpeedBps),
		)
	}
	if tc := a.Transcoder; tc != nil {
		out = append(out, Gauge("transcoder_up", "1 when the transcoder answered.", b2f(tc.OK)))
		if tc.OK {
			out = append(out,
				Gauge("transcoder_active_jobs", "Running transcode jobs.", float64(tc.ActiveJobs)),
				Gauge("transcoder_active_subtitle_jobs", "Running subtitle jobs.", float64(tc.ActiveSubtitleJobs)),
				Gauge("transcoder_max_jobs", "Job limit.", float64(tc.MaxJobs)),
				Counter("transcoder_jobs_started_total", "Jobs started since the transcoder started.", float64(tc.JobsStarted)),
				Counter("transcoder_jobs_rejected_total", "Jobs rejected (limit reached).", float64(tc.JobsRejected)),
				Counter("transcoder_jobs_failed_total", "Jobs that failed.", float64(tc.JobsFailed)),
			)
		}
	}
	up := Vec("integration_up", "1 when the integration's last check succeeded (checked every 30 s).", "name")
	conf := Vec("integration_configured", "1 when the integration is configured.", "name")
	var budget []Family
	for _, it := range a.Integrations {
		up.Add(b2f(it.OK), it.Name)
		conf.Add(b2f(it.Configured), it.Name)
		if it.BudgetRemaining != nil {
			budget = append(budget, *Vec("integration_budget_remaining", "Requests left in today's budget (Kinopoisk).", "name").
				Add(float64(*it.BudgetRemaining), it.Name))
		}
	}
	out = append(out, *up, *conf)
	if len(budget) > 0 {
		f := budget[0]
		for _, b := range budget[1:] {
			f.Samples = append(f.Samples, b.Samples...)
		}
		out = append(out, f)
	}
	return out
}

// AISource: DeepSeek tokens/calls today against the daily budget (shared
// by the daily run, «Спросить ИИ» and facts), asks today, the balance.
func AISource(stats func(ctx context.Context) (foryou.AIStats, error)) Source {
	return Source{Name: "ai", Collect: func(ctx context.Context) ([]Family, error) {
		s, err := stats(ctx)
		if err != nil {
			return nil, err
		}
		return AIFamilies(s), nil
	}}
}

// AIFamilies converts the AI counters ("today" = the Moscow day, when the
// budgets reset).
func AIFamilies(s foryou.AIStats) []Family {
	out := []Family{
		Gauge("ai_enabled", "1 when a DeepSeek key is configured.", b2f(s.Enabled)),
		Gauge("ai_tokens_today", "DeepSeek tokens used today (Moscow day), all API features.", float64(s.TokensToday)),
		Gauge("ai_calls_today", "DeepSeek calls today (Moscow day).", float64(s.CallsToday)),
		Gauge("ai_daily_token_budget", "Daily DeepSeek token budget (FORYOU_AI_DAILY_TOKENS).", float64(s.DailyBudget)),
		Gauge("ai_asks_today", "«Спросить ИИ» requests today, all accounts.", float64(s.AsksToday)),
		Gauge("ai_ask_daily_limit_per_user", "«Спросить ИИ» limit per account per day.", float64(s.AskLimit)),
	}
	if b := s.Balance; b != nil {
		out = append(out, *Vec("ai_balance", "DeepSeek account balance (cached 10 min).", "currency").Add(b.Total, b.Currency))
	}
	return out
}

// VideoSource: the last Invidious health probe (every minute, no extra call).
func VideoSource(health func() (configured bool, reachable *bool, latency time.Duration)) Source {
	return Source{Name: "video", Collect: func(context.Context) ([]Family, error) {
		configured, reachable, latency := health()
		out := []Family{Gauge("invidious_configured", "1 when INVIDIOUS_URL is set.", b2f(configured))}
		if reachable != nil {
			out = append(out, Gauge("invidious_up", "1 when the last Invidious probe succeeded.", b2f(*reachable)))
			if *reachable {
				out = append(out, Gauge("invidious_latency_seconds", "Latency of the last Invidious probe.", latency.Seconds()))
			}
		}
		return out, nil
	}}
}

// activeSessionWindow matches watch.activeWindow (Admin → Activity).
const activeSessionWindow = "3 minutes"

// DBSource: a handful of indexed counts (playback sessions, downloads,
// client errors, devices) and the latest health sample of each TV.
func DBSource(pool *pgxpool.Pool) Source {
	return Source{Name: "db", Collect: func(ctx context.Context) ([]Family, error) {
		return dbFamilies(ctx, pool)
	}}
}

func dbFamilies(ctx context.Context, pool *pgxpool.Pool) ([]Family, error) {
	var out []Family

	var tv, web int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE device_id IS NOT NULL), count(*) FILTER (WHERE device_id IS NULL)
		FROM playback_sessions WHERE ended_at IS NULL AND updated_at > now() - $1::interval`,
		activeSessionWindow).Scan(&tv, &web); err != nil {
		return nil, err
	}
	out = append(out, *Vec("playback_sessions_active", "Playback sessions reported in the last 3 minutes, by client (tv = paired TV).", "client").
		Add(float64(tv), "tv").Add(float64(web), "web"))

	// Downloads: every status, also the empty ones (stable series).
	dl := map[string][3]float64{}
	rows, err := pool.Query(ctx, `SELECT status, count(*), COALESCE(sum(size), 0), COALESCE(sum(bytes_done), 0) FROM downloads GROUP BY status`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var st string
		var n, size, done int64
		if err := rows.Scan(&st, &n, &size, &done); err != nil {
			rows.Close()
			return nil, err
		}
		dl[st] = [3]float64{float64(n), float64(size), float64(done)}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	dn := Vec("downloads", "Server downloads by status.", "status")
	ds := Vec("downloads_size_bytes", "Total size of server downloads by status.", "status")
	dd := Vec("downloads_done_bytes", "Bytes downloaded so far by status.", "status")
	for _, st := range []string{"queued", "downloading", "paused", "done", "failed", "waiting_space"} {
		v := dl[st]
		dn.Add(v[0], st)
		ds.Add(v[1], st)
		dd.Add(v[2], st)
	}
	out = append(out, *dn, *ds, *dd)

	// Client errors (Admin → Errors), per app.
	ce := map[string][2]float64{}
	rows, err = pool.Query(ctx, `SELECT app, count(*) FILTER (WHERE resolved_at IS NULL), COALESCE(sum(count), 0) FROM client_error_groups GROUP BY app`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var app string
		var open, events int64
		if err := rows.Scan(&app, &open, &events); err != nil {
			rows.Close()
			return nil, err
		}
		ce[app] = [2]float64{float64(open), float64(events)}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	eo := Vec("client_error_groups_open", "Unresolved error groups (Admin → Errors) by app.", "app")
	ev := Vec("client_error_events", "Error events in the stored groups by app (drops when old groups are pruned).", "app")
	for _, app := range []string{"web", "tv", "api"} {
		eo.Add(ce[app][0], app)
		ev.Add(ce[app][1], app)
	}
	out = append(out, *eo, *ev)

	var users, profiles, devs, seen int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM users),
		       (SELECT count(*) FROM profiles),
		       (SELECT count(*) FROM devices WHERE revoked_at IS NULL),
		       (SELECT count(*) FROM devices WHERE revoked_at IS NULL AND last_seen_at > now() - interval '1 day')`).
		Scan(&users, &profiles, &devs, &seen); err != nil {
		return nil, err
	}
	out = append(out,
		Gauge("users", "Accounts.", float64(users)),
		Gauge("profiles", "Profiles.", float64(profiles)),
		Gauge("devices_paired", "Paired (not revoked) TVs.", float64(devs)),
		Gauge("devices_seen_1d", "Paired TVs seen in the last 24 hours.", float64(seen)),
	)

	health, err := deviceHealth(ctx, pool)
	if err != nil {
		return nil, err
	}
	return append(out, health...), nil
}

// deviceHealth: the newest sample (≤ 1 day old) of each paired TV,
// labelled by device id and the model it reported (never its name).
func deviceHealth(ctx context.Context, pool *pgxpool.Pool) ([]Family, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (h.device_id) h.device_id::text, h.at, h.sample
		FROM device_health_samples h JOIN devices d ON d.id = h.device_id
		WHERE d.revoked_at IS NULL AND h.at > now() - interval '1 day'
		ORDER BY h.device_id, h.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []DeviceSample
	for rows.Next() {
		var ds DeviceSample
		var raw []byte
		if err := rows.Scan(&ds.DeviceID, &ds.At, &raw); err != nil {
			return nil, err
		}
		if json.Unmarshal(raw, &ds.Sample) != nil {
			continue
		}
		list = append(list, ds)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return DeviceHealthFamilies(list), nil
}

// DeviceSample is one TV's latest health report.
type DeviceSample struct {
	DeviceID string
	At       time.Time
	Sample   devices.HealthSample
}

// DeviceHealthFamilies converts TV health reports (apps/tv health agent).
// A measurement the TV's engine lacks is simply absent for that device.
func DeviceHealthFamilies(list []DeviceSample) []Family {
	labels := []string{"device", "model"}
	type spec struct {
		name, help string
		get        func(h devices.HealthSample) (float64, bool)
	}
	f64 := func(p *float64, scale float64) (float64, bool) {
		if p == nil {
			return 0, false
		}
		return *p * scale, true
	}
	i64 := func(p *int64) (float64, bool) {
		if p == nil {
			return 0, false
		}
		return float64(*p), true
	}
	specs := []spec{
		{"device_health_uptime_seconds", "TV app uptime at the report.", func(h devices.HealthSample) (float64, bool) { return i64(h.UptimeS) }},
		{"device_health_heap_used_bytes", "JS heap used.", func(h devices.HealthSample) (float64, bool) { return f64(h.HeapUsedMB, mib) }},
		{"device_health_heap_limit_bytes", "JS heap limit.", func(h devices.HealthSample) (float64, bool) { return f64(h.HeapLimitMB, mib) }},
		{"device_health_memory_bytes", "navigator.deviceMemory bucket.", func(h devices.HealthSample) (float64, bool) { return f64(h.DeviceMemoryGB, 1<<30) }},
		{"device_health_cores", "Reported CPU cores.", func(h devices.HealthSample) (float64, bool) { return i64(h.Cores) }},
		{"device_health_fps", "Frame rate over the sample.", func(h devices.HealthSample) (float64, bool) { return f64(h.FPS, 1) }},
		{"device_health_slow_frames_ratio", "Share of slow frames, 0–1.", func(h devices.HealthSample) (float64, bool) { return f64(h.SlowFramesPct, 0.01) }},
		{"device_health_event_loop_lag_seconds", "Mean event-loop lag.", func(h devices.HealthSample) (float64, bool) { return f64(h.LagMS, 0.001) }},
		{"device_health_event_loop_lag_max_seconds", "Max event-loop lag.", func(h devices.HealthSample) (float64, bool) { return f64(h.LagMaxMS, 0.001) }},
		{"device_health_long_tasks", "Long tasks over the sample.", func(h devices.HealthSample) (float64, bool) { return i64(h.LongTasks) }},
		{"device_health_dropped_frames", "Dropped video frames, last playback.", func(h devices.HealthSample) (float64, bool) { return i64(h.DroppedFrames) }},
		{"device_health_total_frames", "Decoded video frames, last playback.", func(h devices.HealthSample) (float64, bool) { return i64(h.TotalFrames) }},
	}
	at := &Family{Name: "device_health_timestamp_seconds", Help: "When the TV's latest health report arrived (unix time).",
		Type: prometheus.GaugeValue, Labels: labels}
	fams := make([]*Family, len(specs))
	for i, s := range specs {
		fams[i] = &Family{Name: s.name, Help: s.help, Type: prometheus.GaugeValue, Labels: labels}
	}
	for _, d := range list {
		model := ""
		if d.Sample.Model != nil {
			model = *d.Sample.Model
		}
		at.Add(float64(d.At.UnixNano())/1e9, d.DeviceID, model)
		for i, s := range specs {
			if v, ok := s.get(d.Sample); ok {
				fams[i].Add(v, d.DeviceID, model)
			}
		}
	}
	out := []Family{*at}
	for _, f := range fams {
		if len(f.Samples) > 0 {
			out = append(out, *f)
		}
	}
	return out
}
