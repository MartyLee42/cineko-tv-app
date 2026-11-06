package appsettings

import (
	"math"
	"testing"
)

func TestTemperatureHelpers(t *testing.T) {
	for _, c := range []struct {
		base float64
		cr   string
		want float64
		ok   bool
	}{
		{1, "", 1, true}, {1, "normal", 1, true}, {1, "bold", 1.4, true}, {1, "precise", 0.6, true},
		{1.3, "bold", 1.5, true}, {0.2, "precise", 0, true}, {1, "wild", 1, false},
	} {
		got, ok := WithCreativity(c.base, c.cr)
		if ok != c.ok || math.Abs(got-c.want) > 1e-9 {
			t.Errorf("WithCreativity(%v, %q) = %v, %v; want %v, %v", c.base, c.cr, got, ok, c.want, c.ok)
		}
	}
	if ValidTemperature(math.NaN()) || ValidTemperature(-0.1) || ValidTemperature(1.51) || !ValidTemperature(0) || !ValidTemperature(1.5) {
		t.Error("ValidTemperature range")
	}
	if got := ClampTemperature(0.73); got != 0.75 {
		t.Errorf("ClampTemperature(0.73) = %v", got)
	}
}
