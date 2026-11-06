package foryou

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgconn"

	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Personal notes on titles («Моя заметка»): a private per-profile reaction
// — free text (≤ 1000) and quick reason codes. They come back as
// `me.note` on summaries, reach the AI prompts as the viewer's own
// reactions (data only, guarded like the taste note), and dislike reasons
// feed the taste (taste.go, score.go). Changing a note doesn't regenerate
// anything; the next run picks it up.

const (
	noteMaxText    = 1000
	noteMaxReasons = 15
	notesPage      = 30
	// Notes sent to the AI, and the text kept per note there.
	aiNotes    = 20
	aiNoteText = 240
)

// DislikeReasons / LikeReasons are the reason chip codes.
var (
	DislikeReasons = []string{"too_slow", "too_scary", "too_violent", "boring_plot", "bad_acting", "not_my_genre", "already_seen", "bad_ending", "too_long", "childish"}
	LikeReasons    = []string{"loved_atmosphere", "great_acting", "smart_plot", "funny", "beautiful"}
)

// negativeReason: a dislike reason that says something about the title
// ("already_seen" doesn't).
func negativeReason(r string) bool { return r != "already_seen" && slices.Contains(DislikeReasons, r) }

func validReason(r string) bool {
	return slices.Contains(DislikeReasons, r) || slices.Contains(LikeReasons, r)
}

// NoteItem is the contract's MediaNoteItem.
type NoteItem struct {
	Media     catalog.MediaSummary `json:"media"`
	Text      string               `json:"text"`
	Reasons   []string             `json:"reasons"`
	UpdatedAt time.Time            `json:"updated_at"`
}

// NoteInput is the contract's MediaNoteInput.
type NoteInput struct {
	Text    string   `json:"text"`
	Reasons []string `json:"reasons"`
}

// normalize trims the text, dedupes reasons (chip order kept) and
// validates both.
func (in *NoteInput) normalize() map[string]string {
	f := map[string]string{}
	in.Text = profiles.NormalizeTasteNote(in.Text)
	if utf8.RuneCountInString(in.Text) > noteMaxText {
		f["text"] = fmt.Sprintf("at most %d characters", noteMaxText)
	}
	var rs []string
	for _, r := range in.Reasons {
		if !validReason(r) {
			f["reasons"] = "unknown reason: " + clip(r, 40)
			break
		}
		if !slices.Contains(rs, r) {
			rs = append(rs, r)
		}
	}
	if len(rs) > noteMaxReasons {
		f["reasons"] = fmt.Sprintf("at most %d reasons", noteMaxReasons)
	}
	in.Reasons = nonNilSlice(rs)
	return f
}

// SaveNote stores (or, empty, deletes) a note. Returns nil when deleted.
func (s *Service) SaveNote(ctx context.Context, profileID, mediaID string, in NoteInput) (*catalog.MediaNote, *time.Time, error) {
	if in.Text == "" && len(in.Reasons) == 0 {
		_, err := s.pool.Exec(ctx, `DELETE FROM profile_media_notes WHERE profile_id = $1 AND media_id = $2`, profileID, mediaID)
		return nil, nil, err
	}
	var at time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO profile_media_notes (profile_id, media_id, text, reasons) VALUES ($1, $2, $3, $4)
		ON CONFLICT (profile_id, media_id) DO UPDATE SET text = EXCLUDED.text, reasons = EXCLUDED.reasons, updated_at = now()
		RETURNING updated_at`, profileID, mediaID, in.Text, in.Reasons).Scan(&at)
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23503" { // unknown media
		return nil, nil, errNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	return &catalog.MediaNote{Text: in.Text, Reasons: in.Reasons}, &at, nil
}

// Notes lists a profile's notes, newest first (keyset cursor).
func (s *Service) Notes(ctx context.Context, profileID, lang, cursor string) ([]NoteItem, string, error) {
	var after *time.Time
	afterID := ""
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		ts, id, ok := strings.Cut(string(b), "|")
		t, perr := time.Parse(time.RFC3339Nano, ts)
		if err != nil || !ok || perr != nil || !isUUID(id) {
			return nil, "", errBadCursor
		}
		after, afterID = &t, id
	}
	rows, err := s.pool.Query(ctx, `
		SELECT media_id::text, text, reasons, updated_at FROM profile_media_notes
		WHERE profile_id = $1 AND ($2::timestamptz IS NULL OR (updated_at, media_id) < ($2, $3::uuid))
		ORDER BY updated_at DESC, media_id DESC LIMIT $4`, profileID, after, nilIfEmpty(afterID), notesPage+1)
	if err != nil {
		return nil, "", err
	}
	type raw struct {
		id, text string
		reasons  []string
		at       time.Time
	}
	var list []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.id, &r.text, &r.reasons, &r.at); err != nil {
			rows.Close()
			return nil, "", err
		}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(list) > notesPage {
		list = list[:notesPage]
		last := list[len(list)-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(last.at.UTC().Format(time.RFC3339Nano) + "|" + last.id))
	}
	ids := make([]string, len(list))
	for i, r := range list {
		ids[i] = r.id
	}
	sums, err := s.summaries(ctx, profileID, lang, ids)
	if err != nil {
		return nil, "", err
	}
	byID := map[string]catalog.MediaSummary{}
	for _, m := range sums {
		byID[m.ID] = m
	}
	out := make([]NoteItem, 0, len(list))
	for _, r := range list {
		m, ok := byID[r.id]
		if !ok {
			continue
		}
		out = append(out, NoteItem{Media: m, Text: r.text, Reasons: nonNilSlice(r.reasons), UpdatedAt: r.at})
	}
	return out, next, nil
}

var errBadCursor = errors.New("bad cursor")

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---- AI ----

// titleNote is one note as the model sees it.
type titleNote struct {
	Title   string   `json:"title"`
	Year    int      `json:"year,omitempty"`
	Rating  *int     `json:"rating,omitempty"`
	Reasons []string `json:"reasons,omitempty"`
	Note    string   `json:"note,omitempty"`
}

// aiTitleNotes: the profile's 20 most recent notes. Text is cleaned,
// clipped and dropped when it trips the injection guard or leak check
// (the reasons, plain codes, are kept).
func (s *Service) aiTitleNotes(ctx context.Context, profileID string) ([]titleNote, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(NULLIF(m.translations -> 'en' ->> 'title', ''), m.original_title), COALESCE(m.year, 0), r.rating::int, n.text, n.reasons
		FROM profile_media_notes n JOIN media m ON m.id = n.media_id
		LEFT JOIN ratings r ON r.profile_id = n.profile_id AND r.media_id = n.media_id
		WHERE n.profile_id = $1 ORDER BY n.updated_at DESC, n.media_id LIMIT $2`, profileID, aiNotes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []titleNote
	for rows.Next() {
		var n titleNote
		if err := rows.Scan(&n.Title, &n.Year, &n.Rating, &n.Note, &n.Reasons); err != nil {
			return nil, err
		}
		n.Note = guardText(n.Note, aiNoteText)
		n.Reasons = filterIDs(n.Reasons, validReason)
		if n.Note == "" && len(n.Reasons) == 0 && n.Rating == nil {
			continue
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// guardText cleans viewer text for a prompt: one line, clipped, "" when
// it looks like an injection attempt or quotes a system prompt.
func guardText(s string, n int) string {
	s = clip(cleanText(s), n)
	if s == "" || looksLikeInjection(s) || leaksPrompt(s) {
		return ""
	}
	return s
}

// ---- reasons → taste ----

// loadNoteReasons: reason codes per title for the profile.
func (s *Service) loadNoteReasons(ctx context.Context, profileID string) (map[string][]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT media_id::text, reasons FROM profile_media_notes WHERE profile_id = $1 AND reasons <> '{}'`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var id string
		var rs []string
		if err := rows.Scan(&id, &rs); err != nil {
			return nil, err
		}
		out[id] = rs
	}
	return out, rows.Err()
}

// ---- HTTP ----

// usableParam: the profile in the path, usable by the caller (TVs too).
func (s *Service) usableParam(c fiber.Ctx) (string, error) {
	return s.usable(c, c.Params("id"))
}

func (s *Service) hPutNote(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	mid := c.Params("mediaId")
	if !isUUID(mid) {
		return httpx.NotFound()
	}
	var in NoteInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if f := in.normalize(); len(f) > 0 {
		return httpx.Validation(f)
	}
	note, at, err := s.SaveNote(c.Context(), pid, strings.Clone(mid), in)
	if err != nil {
		return fail(err)
	}
	if note == nil {
		return c.SendStatus(fiber.StatusNoContent)
	}
	return c.JSON(fiber.Map{"media_id": mid, "text": note.Text, "reasons": note.Reasons, "updated_at": at})
}

func (s *Service) hNotes(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	items, next, err := s.Notes(c.Context(), pid, lang, c.Query("cursor"))
	if errors.Is(err, errBadCursor) {
		return httpx.Validation(map[string]string{"cursor": "invalid cursor"})
	}
	if err != nil {
		return err
	}
	var nc *string
	if next != "" {
		nc = &next
	}
	return c.JSON(fiber.Map{"items": items, "next_cursor": nc})
}
