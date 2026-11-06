package foryou

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

// Facts about a title written by DeepSeek («Факты» when Kinopoisk has
// none; internal/trivia caches them). Same client, daily token budget and
// admin temperature (`facts`) as the other AI features. The user message
// carries only catalog data, JSON-encoded.

const factsSystemPrompt = `You are a film historian for a private family home-cinema app.
Write interesting, verifiable facts about the film or TV series described by the user message: production, casting, filming locations, music, references and influences, cultural impact, reception, awards, records.
Rules:
- Only facts you are confident are true for exactly this title (check the year and original title). If you do not know the title well, return fewer facts or an empty list. Never invent numbers, names, quotes or anecdotes.
- 6 to 10 facts, each 1 to 3 sentences, at most 300 characters, plain text, no markdown.
- Set "spoiler" to true for any fact that reveals plot twists or the ending.
- Write in {LANGUAGE}.
Answer with JSON only, in this shape:
{"facts":[{"text":"","spoiler":false}]}`

// FactsTitle is what the model is told about a title.
type FactsTitle struct {
	Title         string `json:"title"`
	OriginalTitle string `json:"original_title,omitempty"`
	Year          int    `json:"year,omitempty"`
	Kind          string `json:"kind"`
}

// AIFact is one generated fact.
type AIFact struct {
	Text    string `json:"text"`
	Spoiler bool   `json:"spoiler"`
}

// AIAvailable reports whether DeepSeek is configured and the admin hasn't
// switched AI «Факты» off.
func (s *Service) AIAvailable(ctx context.Context) bool { return s.ai != nil && s.factsAI(ctx) }

// TitleFacts asks DeepSeek for facts about t in lang (ru | en).
// errAIDisabled without a key, errBudget when today's tokens are spent.
func (s *Service) TitleFacts(ctx context.Context, t FactsTitle, lang string) ([]AIFact, error) {
	if !s.AIAvailable(ctx) {
		return nil, errAIDisabled
	}
	run := &runState{interactive: true}
	if err := s.aiBudgetCheck(ctx, run); err != nil {
		return nil, err
	}
	b, _ := json.Marshal(t)
	system := strings.ReplaceAll(factsSystemPrompt, "{LANGUAGE}", tr(lang, "Russian", "English"))
	content, tokens, err := s.ai.complete(ctx, system, string(b)+"\nJSON only.", s.aiTemperature(ctx).Facts)
	if tokens > 0 || err == nil {
		s.recordAIUsage(ctx, run, tokens)
	}
	if err != nil {
		return nil, err
	}
	return parseFacts(content)
}

func parseFacts(content string) ([]AIFact, error) {
	content = strings.TrimSpace(strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(content), "```"), "```json"))
	var res struct {
		Facts []AIFact `json:"facts"`
	}
	if err := json.Unmarshal([]byte(content), &res); err != nil {
		return nil, errInvalidAI
	}
	out := make([]AIFact, 0, len(res.Facts))
	for _, f := range res.Facts {
		t := strings.TrimSpace(mdNoise.ReplaceAllString(f.Text, ""))
		if utf8.RuneCountInString(t) < 20 {
			continue
		}
		if utf8.RuneCountInString(t) > 400 {
			t = string([]rune(t)[:399]) + "…"
		}
		out = append(out, AIFact{Text: t, Spoiler: f.Spoiler})
		if len(out) == 12 {
			break
		}
	}
	return out, nil
}

// IsAIUnavailable: the error means no AI answer today (disabled or budget),
// not a failure worth logging.
func IsAIUnavailable(err error) bool {
	return errors.Is(err, errAIDisabled) || errors.Is(err, errBudget)
}
