package metrics

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// RefreshInterval is how often Refresher re-reads its sources while
// someone scrapes (a scrape then sees data at most this old).
const RefreshInterval = 20 * time.Second

// idleAfter: with no scrape for this long the background refresh pauses,
// so an unscraped install pays nothing; the next scrape refreshes inline.
const idleAfter = 5 * time.Minute

// sourceTimeout bounds one source's refresh.
const sourceTimeout = 5 * time.Second

// Family is one metric with its samples. Names get the "cineko_" prefix.
type Family struct {
	Name    string
	Help    string
	Type    prometheus.ValueType // GaugeValue or CounterValue
	Labels  []string
	Samples []Sample
}

// Sample is one series of a Family (LabelValues in Family.Labels order).
type Sample struct {
	LabelValues []string
	Value       float64
}

// Gauge is a label-less gauge family.
func Gauge(name, help string, v float64) Family {
	return Family{Name: name, Help: help, Type: prometheus.GaugeValue, Samples: []Sample{{Value: v}}}
}

// Counter is a label-less counter family.
func Counter(name, help string, v float64) Family {
	return Family{Name: name, Help: help, Type: prometheus.CounterValue, Samples: []Sample{{Value: v}}}
}

// Vec starts a gauge family with labels; add series with Add.
func Vec(name, help string, labels ...string) *Family {
	return &Family{Name: name, Help: help, Type: prometheus.GaugeValue, Labels: labels}
}

// Add appends one series.
func (f *Family) Add(v float64, labelValues ...string) *Family {
	f.Samples = append(f.Samples, Sample{LabelValues: labelValues, Value: v})
	return f
}

// Source produces part of the snapshot. An error drops its families until
// the next successful refresh (cineko_metrics_source_up{source} = 0).
type Source struct {
	Name    string
	Collect func(ctx context.Context) ([]Family, error)
}

type sourceState struct {
	families []Family
	ok       bool
	took     time.Duration
	at       time.Time
}

// Refresher keeps the latest families of every source and serves them as
// one prometheus.Collector (unchecked: the set changes between refreshes).
type Refresher struct {
	sources []Source
	log     *slog.Logger
	now     func() time.Time

	refreshMu sync.Mutex // one Refresh at a time

	mu         sync.RWMutex
	state      map[string]sourceState
	refreshed  time.Time // last complete Refresh
	lastScrape time.Time
}

func NewRefresher(log *slog.Logger, sources ...Source) *Refresher {
	return &Refresher{sources: sources, log: log, now: time.Now, state: map[string]sourceState{}}
}

// Run refreshes every RefreshInterval while /metrics is being scraped.
func (r *Refresher) Run(ctx context.Context) {
	t := time.NewTicker(RefreshInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		r.mu.RLock()
		active := r.now().Sub(r.lastScrape) < idleAfter
		r.mu.RUnlock()
		if active {
			r.Refresh(ctx)
		}
	}
}

// Refresh reads every source once (one after another: they are cheap and
// this keeps the load flat).
func (r *Refresher) Refresh(ctx context.Context) {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	for _, s := range r.sources {
		if ctx.Err() != nil {
			return
		}
		sctx, cancel := context.WithTimeout(ctx, sourceTimeout)
		start := time.Now()
		fams, err := s.Collect(sctx)
		cancel()
		st := sourceState{families: fams, ok: err == nil, took: time.Since(start), at: time.Now()}
		if err != nil {
			st.families = nil
			if r.log != nil && ctx.Err() == nil {
				r.log.Warn("metrics: source failed", "source", s.Name, "err", err)
			}
		}
		r.mu.Lock()
		r.state[s.Name] = st
		r.mu.Unlock()
	}
	r.mu.Lock()
	r.refreshed = r.now()
	r.mu.Unlock()
}

// fresh notes a scrape and refreshes inline when the snapshot is missing
// or older than two intervals (first scrape, or after an idle pause).
func (r *Refresher) fresh() {
	r.mu.Lock()
	r.lastScrape = r.now()
	stale := r.now().Sub(r.refreshed) > 2*RefreshInterval
	r.mu.Unlock()
	if stale {
		ctx, cancel := context.WithTimeout(context.Background(), 2*sourceTimeout)
		defer cancel()
		r.Refresh(ctx)
	}
}

// Describe sends nothing: an unchecked collector.
func (r *Refresher) Describe(chan<- *prometheus.Desc) {}

// Collect emits the snapshot plus per-source health.
func (r *Refresher) Collect(ch chan<- prometheus.Metric) {
	r.fresh()
	r.mu.RLock()
	defer r.mu.RUnlock()
	up := prometheus.NewDesc(Namespace+"_metrics_source_up", "1 when the source's last refresh succeeded.", []string{"source"}, nil)
	took := prometheus.NewDesc(Namespace+"_metrics_source_duration_seconds", "How long the source's last refresh took.", []string{"source"}, nil)
	age := prometheus.NewDesc(Namespace+"_metrics_source_timestamp_seconds", "When the source was last refreshed (unix time).", []string{"source"}, nil)
	for _, s := range r.sources {
		st, seen := r.state[s.Name]
		if !seen {
			continue
		}
		ch <- prometheus.MustNewConstMetric(up, prometheus.GaugeValue, b2f(st.ok), s.Name)
		ch <- prometheus.MustNewConstMetric(took, prometheus.GaugeValue, st.took.Seconds(), s.Name)
		ch <- prometheus.MustNewConstMetric(age, prometheus.GaugeValue, float64(st.at.UnixNano())/1e9, s.Name)
		for _, f := range st.families {
			emit(ch, f)
		}
	}
}

func emit(ch chan<- prometheus.Metric, f Family) {
	desc := prometheus.NewDesc(Namespace+"_"+f.Name, f.Help, f.Labels, nil)
	for _, s := range f.Samples {
		m, err := prometheus.NewConstMetric(desc, f.Type, s.Value, s.LabelValues...)
		if err != nil {
			m = prometheus.NewInvalidMetric(desc, err)
		}
		ch <- m
	}
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
