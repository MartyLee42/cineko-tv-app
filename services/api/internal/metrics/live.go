package metrics

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// Live series: read at scrape time, in-memory only.

// RegisterLive adds the DB pool stats, active streams and WebSocket
// counts. Any argument may be nil.
func (m *Metrics) RegisterLive(pool *pgxpool.Pool, activeStreams func() int64, wsCounts func() (users, devices int)) {
	if pool != nil {
		m.reg.MustRegister(poolCollector{pool.Stat})
	}
	if activeStreams != nil {
		m.reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: Namespace, Name: "active_streams", Help: "Video streams proxied right now (all users).",
		}, func() float64 { return float64(activeStreams()) }))
	}
	if wsCounts != nil {
		m.reg.MustRegister(wsCollector{wsCounts})
	}
}

var wsDesc = prometheus.NewDesc(Namespace+"_websocket_connections", "Open realtime WebSockets by kind (users, devices).", []string{"kind"}, nil)

type wsCollector struct{ counts func() (int, int) }

func (w wsCollector) Describe(ch chan<- *prometheus.Desc) { ch <- wsDesc }
func (w wsCollector) Collect(ch chan<- prometheus.Metric) {
	u, d := w.counts()
	ch <- prometheus.MustNewConstMetric(wsDesc, prometheus.GaugeValue, float64(u), "users")
	ch <- prometheus.MustNewConstMetric(wsDesc, prometheus.GaugeValue, float64(d), "devices")
}

func poolDesc(name, help string) *prometheus.Desc {
	return prometheus.NewDesc(Namespace+"_db_pool_"+name, help, nil, nil)
}

var (
	poolAcquired     = poolDesc("acquired_conns", "Connections in use.")
	poolIdle         = poolDesc("idle_conns", "Idle connections.")
	poolConstructing = poolDesc("constructing_conns", "Connections being opened.")
	poolTotal        = poolDesc("total_conns", "All open connections.")
	poolMax          = poolDesc("max_conns", "Pool size limit.")
	poolAcquires     = poolDesc("acquires_total", "Successful connection acquires.")
	poolAcquireSecs  = poolDesc("acquire_duration_seconds_total", "Time spent waiting for connections.")
	poolEmpty        = poolDesc("empty_acquires_total", "Acquires that had to wait for a connection.")
	poolCanceled     = poolDesc("canceled_acquires_total", "Acquires canceled by their context.")
	poolNew          = poolDesc("new_conns_total", "Connections opened.")
)

// poolCollector exposes pgxpool.Stat (cheap: a mutex and a few counters).
type poolCollector struct{ stat func() *pgxpool.Stat }

func (p poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{poolAcquired, poolIdle, poolConstructing, poolTotal, poolMax, poolAcquires,
		poolAcquireSecs, poolEmpty, poolCanceled, poolNew} {
		ch <- d
	}
}

func (p poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := p.stat()
	g := func(d *prometheus.Desc, v float64) { ch <- prometheus.MustNewConstMetric(d, prometheus.GaugeValue, v) }
	c := func(d *prometheus.Desc, v float64) {
		ch <- prometheus.MustNewConstMetric(d, prometheus.CounterValue, v)
	}
	g(poolAcquired, float64(s.AcquiredConns()))
	g(poolIdle, float64(s.IdleConns()))
	g(poolConstructing, float64(s.ConstructingConns()))
	g(poolTotal, float64(s.TotalConns()))
	g(poolMax, float64(s.MaxConns()))
	c(poolAcquires, float64(s.AcquireCount()))
	c(poolAcquireSecs, s.AcquireDuration().Seconds())
	c(poolEmpty, float64(s.EmptyAcquireCount()))
	c(poolCanceled, float64(s.CanceledAcquireCount()))
	c(poolNew, float64(s.NewConnsCount()))
}
