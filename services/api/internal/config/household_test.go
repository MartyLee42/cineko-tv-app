package config

import "testing"

func TestHouseholdTZ(t *testing.T) {
	for _, tc := range []struct {
		tz, ne, want string
	}{
		{"", "", "Europe/Moscow"},
		{"Asia/Almaty", "Europe/Moscow", "Asia/Almaty"},
		{"Etc/UTC", "Asia/Almaty", "Asia/Almaty"}, // install.sh's UTC fallback loses to a real zone
		{"Etc/UTC", "", "Etc/UTC"},
		{"", "UTC", "UTC"},
		{"Nowhere/City", "", "Europe/Moscow"},
		{"Nowhere/City", "Asia/Tbilisi", "Asia/Tbilisi"},
	} {
		got := loadHouseholdTZ(func(k, def string) string {
			switch k {
			case "TZ":
				return tc.tz
			case "NEW_EPISODES_TZ":
				return tc.ne
			}
			return def
		})
		if got.String() != tc.want {
			t.Errorf("TZ=%q NEW_EPISODES_TZ=%q: %s, want %s", tc.tz, tc.ne, got, tc.want)
		}
	}
}
