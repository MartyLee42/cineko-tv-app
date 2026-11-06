package webfetch

import "strings"

// VoiceKind maps a generic voice-over label (as balancers spell it) to the
// contract's voice kind: dub|mvo|dvo|avo|vo|original|sub, "" if it names a
// studio instead.
func VoiceKind(label string) string {
	t := strings.ToLower(label)
	switch {
	case strings.Contains(t, "дубл"), strings.Contains(t, "дубляж"):
		return "dub"
	case strings.Contains(t, "многоголос"), strings.Contains(t, "багатоголос"):
		return "mvo"
	case strings.Contains(t, "двухголос"), strings.Contains(t, "двоголос"):
		return "dvo"
	case strings.Contains(t, "авторск"):
		return "avo"
	case strings.Contains(t, "одноголос"), strings.Contains(t, "закадров"):
		return "vo"
	case strings.Contains(t, "оригинал"), strings.Contains(t, "original"):
		return "original"
	case strings.Contains(t, "субтитр"):
		return "sub"
	}
	return ""
}

// GenericVoice is the display label for a voice kind ("Дубляж"…), the
// spelling the releases voice-over parser understands.
func GenericVoice(kind string) string {
	switch kind {
	case "dub":
		return "Дубляж"
	case "mvo":
		return "Многоголосый"
	case "dvo":
		return "Двухголосый"
	case "avo":
		return "Авторский"
	case "vo":
		return "Одноголосый"
	case "original":
		return "Оригинал"
	case "sub":
		return "Субтитры"
	}
	return ""
}
