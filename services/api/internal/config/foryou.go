package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ForYouConfig drives Phase 6 personal recommendations (internal/foryou).
type ForYouConfig struct {
	// DeepSeekAPIKey enables AI collections (подборки). Never log it.
	DeepSeekAPIKey string
	// DeepSeekBaseURL is the OpenAI-compatible endpoint (tests point it at a fake).
	DeepSeekBaseURL string
	DeepSeekModel   string
	// AIDailyTokens caps DeepSeek tokens per Moscow day; AIRunTokens per run.
	AIDailyTokens int
	AIRunTokens   int
	// DailyAt is the Moscow time of the daily run ("05:00"); DailyOff disables it.
	DailyHour, DailyMinute int
	DailyOff               bool
	// CreditsPerProfile caps TMDB detail fetches (cast/crew of rated titles)
	// per profile per run.
	CreditsPerProfile int
	// AskDailyPerUser caps «Спросить ИИ» requests per account per Moscow day.
	AskDailyPerUser int
}

// AIConfigured reports whether AI collections can run.
func (f ForYouConfig) AIConfigured() bool { return f.DeepSeekAPIKey != "" }

// DailyAt renders the schedule as HH:MM (or "off").
func (f ForYouConfig) DailyAt() string {
	if f.DailyOff {
		return "off"
	}
	return fmt.Sprintf("%02d:%02d", f.DailyHour, f.DailyMinute)
}

func loadForYou(get func(string, string) string, secret func(string) string, errs *[]error) ForYouConfig {
	f := ForYouConfig{
		DeepSeekAPIKey:    secret("DEEPSEEK_API_KEY"),
		DeepSeekBaseURL:   strings.TrimRight(get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"), "/"),
		DeepSeekModel:     get("DEEPSEEK_MODEL", "deepseek-chat"),
		AIDailyTokens:     300000,
		AIRunTokens:       200000,
		DailyHour:         5,
		CreditsPerProfile: 150,
		AskDailyPerUser:   30,
	}
	posInt := func(name string, dst *int) {
		v := get(name, "")
		if v == "" {
			return
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			*errs = append(*errs, errors.New(name+" must be a non-negative integer"))
			return
		}
		*dst = n
	}
	posInt("FORYOU_AI_DAILY_TOKENS", &f.AIDailyTokens)
	posInt("FORYOU_AI_RUN_TOKENS", &f.AIRunTokens)
	posInt("FORYOU_CREDITS_PER_PROFILE", &f.CreditsPerProfile)
	posInt("FORYOU_ASK_DAILY_PER_USER", &f.AskDailyPerUser)
	switch at := strings.ToLower(get("FORYOU_DAILY_AT", "05:00")); at {
	case "off", "none", "false", "-", "disabled":
		f.DailyOff = true
	default:
		h, m, ok := strings.Cut(at, ":")
		hh, err1 := strconv.Atoi(h)
		mm, err2 := strconv.Atoi(m)
		if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
			*errs = append(*errs, fmt.Errorf("FORYOU_DAILY_AT must be HH:MM (Moscow time) or off, got %q", at))
		} else {
			f.DailyHour, f.DailyMinute = hh, mm
		}
	}
	return f
}
