package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AI playlists: DeepSeek (OpenAI-compatible chat API, the same key Cineko
// uses for its AI collections) turns a description ("вечер под дождём",
// "русский рок 90-х") plus the listener's top artists into a track list;
// each track is then matched to the catalog like an import.

type AI struct {
	key, base, model string
	hc               *http.Client
	perDay           int

	mu   sync.Mutex
	used map[string]int // user|date → requests
}

func newAI(key, base, model string, perDay int) *AI {
	return &AI{key: key, base: strings.TrimRight(base, "/"), model: model, perDay: perDay,
		hc: &http.Client{Timeout: 90 * time.Second}, used: map[string]int{}}
}

func (a *AI) Configured() bool { return a.key != "" }

var errAILimit = errors.New("ai daily limit")

func (a *AI) take(user string) error {
	day := time.Now().Format("2006-01-02")
	k := user + "|" + day
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.used) > 5000 {
		a.used = map[string]int{}
	}
	if a.used[k] >= a.perDay {
		return errAILimit
	}
	a.used[k]++
	return nil
}

type aiTrack struct {
	Artist string `json:"artist"`
	Title  string `json:"title"`
}

type aiPlaylist struct {
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Tracks      []aiTrack `json:"tracks"`
}

const aiSystem = `Ты — музыкальный редактор стримингового сервиса. По запросу пользователя составь плейлист из реально существующих треков (только официально изданные песни, без выдуманных названий).
Отвечай строго JSON без пояснений: {"title": "короткое название по-русски", "description": "одно предложение по-русски", "tracks": [{"artist": "исполнитель", "title": "название трека"}]}.
Правила: 25 треков; не больше 2 треков одного исполнителя; названия и имена — как в оригинале (кириллица для русских исполнителей); порядок — как в хорошем плейлисте (плавные переходы).`

func (a *AI) Generate(ctx context.Context, prompt string, taste []string, avoid []string) (*aiPlaylist, error) {
	user := "Запрос: " + prompt
	if len(taste) > 0 {
		user += "\nСлушатель любит: " + strings.Join(taste, ", ") + ". Учитывай вкус, но не ограничивайся этими исполнителями."
	}
	if len(avoid) > 0 {
		user += "\nНе повторяй эти треки: " + strings.Join(avoid, "; ")
	}
	body, _ := json.Marshal(map[string]any{
		"model": a.model,
		"messages": []map[string]string{
			{"role": "system", "content": aiSystem},
			{"role": "user", "content": user},
		},
		"temperature":     1.0,
		"max_tokens":      2500,
		"response_format": map[string]string{"type": "json_object"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ai: %w", shortErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ai: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return nil, errors.New("ai: bad response")
	}
	content := strings.TrimSpace(out.Choices[0].Message.Content)
	content = strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(content, "```json"), "```"), "```")
	var pl aiPlaylist
	if err := json.Unmarshal([]byte(content), &pl); err != nil {
		return nil, errors.New("ai: response is not JSON")
	}
	if len(pl.Tracks) > 40 {
		pl.Tracks = pl.Tracks[:40]
	}
	return &pl, nil
}

// ---- cache: one result per account and prompt, reused for 3 days ----

const aiCacheTTL = 3 * 24 * time.Hour

func migrateAI(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS ai_cache (
		key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`)
	return err
}

func aiKey(user, prompt string) string { return user + "|" + normalize(prompt) }

func (s *Store) AICached(ctx context.Context, key string) (json.RawMessage, int64, bool) {
	var data string
	var at int64
	err := s.db.QueryRowContext(ctx, `SELECT data, created_at FROM ai_cache WHERE key=?`, key).Scan(&data, &at)
	if err != nil || time.Since(time.Unix(at, 0)) > aiCacheTTL {
		return nil, 0, false
	}
	return json.RawMessage(data), at, true
}

func (s *Store) SetAICache(ctx context.Context, key string, data []byte) {
	_, _ = s.db.ExecContext(ctx, `INSERT INTO ai_cache(key,data,created_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET data=excluded.data, created_at=excluded.created_at`, key, string(data), now())
	_, _ = s.db.ExecContext(ctx, `DELETE FROM ai_cache WHERE created_at < ?`, time.Now().Add(-aiCacheTTL).Unix())
}

// hAIPlaylist: POST {prompt, avoid?, fresh?} → {title, description, tracks:[Track], createdAt, cached}.
// The same prompt within 3 days returns the saved result (no AI call);
// "avoid" (another variant) or "fresh" asks the AI again.
func (a *App) hAIPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	if !a.ai.Configured() {
		return errStatus(503, "ai_off", "ИИ не настроен на сервере")
	}
	var b struct {
		Prompt string   `json:"prompt"`
		Avoid  []string `json:"avoid"`
		Taste  *bool    `json:"taste"`
		Fresh  bool     `json:"fresh"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	prompt := strings.TrimSpace(b.Prompt)
	if prompt == "" || len([]rune(prompt)) > 300 {
		return errStatus(400, "bad_prompt", "Опишите, что хочется послушать")
	}
	key := aiKey(u.ID, prompt)
	if !b.Fresh && len(b.Avoid) == 0 {
		if data, at, ok := a.st.AICached(r.Context(), key); ok {
			var cached map[string]any
			if json.Unmarshal(data, &cached) == nil {
				cached["createdAt"] = at
				cached["cached"] = true
				writeJSON(w, 200, cached)
				return nil
			}
		}
	}
	if err := a.ai.take(u.ID); err != nil {
		return errStatus(429, "ai_limit", "Лимит ИИ-подборок на сегодня исчерпан")
	}
	var taste []string
	if b.Taste == nil || *b.Taste {
		for _, ar := range a.topArtists(r.Context(), u.ID, 12) {
			if ar.Name != "" {
				taste = append(taste, ar.Name)
			}
		}
	}
	if len(b.Avoid) > 60 {
		b.Avoid = b.Avoid[:60]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	pl, err := a.ai.Generate(ctx, prompt, taste, b.Avoid)
	if err != nil {
		a.log.Warn("ai playlist", "err", err.Error())
		return errStatus(502, "ai_failed", "ИИ не ответил, попробуйте ещё раз")
	}
	tracks := make([]Track, len(pl.Tracks))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, t := range pl.Tracks {
		wg.Add(1)
		go func(i int, t aiTrack) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			it := ImportItem{Title: t.Title, Artists: []string{t.Artist}}
			if m := a.matchImport(ctx, it); m != nil {
				tracks[i] = *m
				return
			}
			tracks[i] = Track{ID: yqID(t.Artist, t.Title), Title: t.Title, Artist: t.Artist}
		}(i, t)
	}
	wg.Wait()
	seen := map[string]bool{}
	out := make([]Track, 0, len(tracks))
	for _, t := range tracks {
		if t.ID == "" || seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		out = append(out, t)
	}
	res := map[string]any{"title": pl.Title, "description": pl.Description, "prompt": prompt, "tracks": out}
	if data, err := json.Marshal(res); err == nil {
		a.st.SetAICache(r.Context(), key, data)
	}
	res["createdAt"] = now()
	res["cached"] = false
	writeJSON(w, 200, res)
	return nil
}
