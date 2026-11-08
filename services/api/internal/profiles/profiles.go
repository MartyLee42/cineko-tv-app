// Package profiles manages viewing profiles under an account.
package profiles

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
	"martytv/api/internal/uilang"
)

const MaxProfilesPerUser = 8

var (
	ErrNotFound = errors.New("profile not found")
	pinPattern  = regexp.MustCompile(`^[0-9]{4,8}$`)
	colorRe     = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

type Profile struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	Avatar    string    `json:"avatar"`
	Color     string    `json:"color"`
	HasPIN    bool      `json:"has_pin"`
	CreatedAt time.Time `json:"created_at"`
	pinHash   *string
}

type Preferences struct {
	// UILanguage: the profile's interface language (en | ru | kk), "" = not
	// chosen. The apps apply it on a device without a language of its own.
	UILanguage                 string   `json:"ui_language"`
	PreferredAudioLanguages    []string `json:"preferred_audio_languages"`
	PreferredSubtitleLanguages []string `json:"preferred_subtitle_languages"`
	PreferredResolution        string   `json:"preferred_resolution"`
	MaxSizeGB                  *float64 `json:"max_size_gb"`
	PreferredCodecs            []string `json:"preferred_codecs"`
	PreferredVoiceovers        []string `json:"preferred_voiceovers"`
}

type Store struct{ q db.Querier }

func NewStore(q db.Querier) *Store { return &Store{q: q} }

const cols = `id, user_id, name, avatar, color, pin_hash, created_at`

func scan(row interface{ Scan(...any) error }) (*Profile, error) {
	var p Profile
	err := row.Scan(&p.ID, &p.UserID, &p.Name, &p.Avatar, &p.Color, &p.pinHash, &p.CreatedAt)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	p.HasPIN = p.pinHash != nil
	return &p, err
}

func (s *Store) query(ctx context.Context, sql string, args ...any) ([]Profile, error) {
	rows, err := s.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Profile
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// ListForUser returns an account's own profiles.
func (s *Store) ListForUser(ctx context.Context, userID string) ([]Profile, error) {
	return s.query(ctx, `SELECT `+cols+` FROM profiles WHERE user_id = $1 ORDER BY created_at`, userID)
}

// ListForDevice returns the profiles selectable on a TV: the owner's plus
// those of users the device is shared with at the "use" level.
func (s *Store) ListForDevice(ctx context.Context, deviceID string) ([]Profile, error) {
	return s.query(ctx, `
		SELECT `+prefixed("p.")+` FROM profiles p
		JOIN devices d ON d.id = $1
		WHERE p.user_id = d.owner_user_id
		   OR p.user_id IN (SELECT user_id FROM device_permissions WHERE device_id = $1 AND permission = 'use')
		ORDER BY (p.user_id = d.owner_user_id) DESC, p.created_at`, deviceID)
}

// AccessibleByDevice reports whether a profile can be used on a device.
func (s *Store) AccessibleByDevice(ctx context.Context, deviceID, profileID string) (bool, error) {
	var ok bool
	err := s.q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM profiles p JOIN devices d ON d.id = $1
			WHERE p.id = $2 AND (p.user_id = d.owner_user_id OR p.user_id IN
				(SELECT user_id FROM device_permissions WHERE device_id = $1 AND permission = 'use')))`,
		deviceID, profileID).Scan(&ok)
	return ok, err
}

func isNoRows(err error) bool { return db.IsNoRows(err) }

func prefixed(p string) string {
	parts := strings.Split(cols, ", ")
	for i := range parts {
		parts[i] = p + parts[i]
	}
	return strings.Join(parts, ", ")
}

// GetOwned returns a profile only if it belongs to userID. This is the single
// ownership check every profile-scoped endpoint goes through.
func (s *Store) GetOwned(ctx context.Context, userID, id string) (*Profile, error) {
	return scan(s.q.QueryRow(ctx, `SELECT `+cols+` FROM profiles WHERE id = $1 AND user_id = $2`, id, userID))
}

// EnsureDefault creates a profile named after the user (display name, else
// username) when the account has none. Safe to call concurrently.
func (s *Store) EnsureDefault(ctx context.Context, userID string) error {
	_, err := s.q.Exec(ctx, `
		WITH p AS (
			INSERT INTO profiles (user_id, name)
			SELECT u.id, left(coalesce(nullif(u.display_name, ''), u.username), 32)
			FROM users u
			WHERE u.id = $1 AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = $1)
			ON CONFLICT DO NOTHING
			RETURNING id
		) INSERT INTO profile_preferences (profile_id) SELECT id FROM p`, userID)
	return err
}

func (s *Store) Count(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.q.QueryRow(ctx, `SELECT count(*) FROM profiles WHERE user_id = $1`, userID).Scan(&n)
	return n, err
}

var ErrNameTaken = errors.New("profile name taken")

func (s *Store) Create(ctx context.Context, userID, name, avatar, color string, pinHash *string) (*Profile, error) {
	p, err := scan(s.q.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO profiles (user_id, name, avatar, color, pin_hash) VALUES ($1, $2, $3, $4, $5)
			RETURNING `+cols+`
		), prefs AS (
			INSERT INTO profile_preferences (profile_id) SELECT id FROM ins
		) SELECT * FROM ins`, userID, name, avatar, color, pinHash))
	if db.IsUniqueViolation(err) {
		return nil, ErrNameTaken
	}
	return p, err
}

type Patch struct {
	Name     *string
	Avatar   *string
	Color    *string
	PinHash  *string
	ClearPIN bool
}

func (s *Store) Update(ctx context.Context, userID, id string, p Patch) (*Profile, error) {
	out, err := scan(s.q.QueryRow(ctx, `
		UPDATE profiles SET
			name = coalesce($3, name),
			avatar = coalesce($4, avatar),
			color = coalesce($5, color),
			pin_hash = CASE WHEN $7 THEN NULL ELSE coalesce($6, pin_hash) END,
			updated_at = now()
		WHERE id = $1 AND user_id = $2 RETURNING `+cols,
		id, userID, p.Name, p.Avatar, p.Color, p.PinHash, p.ClearPIN))
	if db.IsUniqueViolation(err) {
		return nil, ErrNameTaken
	}
	return out, err
}

func (s *Store) Delete(ctx context.Context, userID, id string) error {
	tag, err := s.q.Exec(ctx, `DELETE FROM profiles WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) GetPreferences(ctx context.Context, profileID string) (*Preferences, error) {
	var p Preferences
	err := s.q.QueryRow(ctx, `
		SELECT ui_language, preferred_audio_languages, preferred_subtitle_languages,
		       preferred_resolution, max_size_gb::float8, preferred_codecs, preferred_voiceovers
		FROM profile_preferences WHERE profile_id = $1`, profileID).
		Scan(&p.UILanguage, &p.PreferredAudioLanguages, &p.PreferredSubtitleLanguages,
			&p.PreferredResolution, &p.MaxSizeGB, &p.PreferredCodecs, &p.PreferredVoiceovers)
	if db.IsNoRows(err) {
		return &Preferences{UILanguage: "", PreferredAudioLanguages: []string{},
			PreferredSubtitleLanguages: []string{}, PreferredCodecs: []string{}, PreferredVoiceovers: []string{}}, nil
	}
	return &p, err
}

func (s *Store) PutPreferences(ctx context.Context, profileID string, p *Preferences) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO profile_preferences (profile_id, ui_language, preferred_audio_languages,
			preferred_subtitle_languages, preferred_resolution, max_size_gb, preferred_codecs, preferred_voiceovers, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (profile_id) DO UPDATE SET
			ui_language = EXCLUDED.ui_language,
			preferred_audio_languages = EXCLUDED.preferred_audio_languages,
			preferred_subtitle_languages = EXCLUDED.preferred_subtitle_languages,
			preferred_resolution = EXCLUDED.preferred_resolution,
			max_size_gb = EXCLUDED.max_size_gb,
			preferred_codecs = EXCLUDED.preferred_codecs,
			preferred_voiceovers = EXCLUDED.preferred_voiceovers,
			updated_at = now()`,
		profileID, p.UILanguage, nonNil(p.PreferredAudioLanguages), nonNil(p.PreferredSubtitleLanguages),
		p.PreferredResolution, p.MaxSizeGB, nonNil(p.PreferredCodecs), nonNil(p.PreferredVoiceovers))
	return err
}

// SetUILanguage changes only the profile's interface language.
func (s *Store) SetUILanguage(ctx context.Context, profileID, lang string) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO profile_preferences (profile_id, ui_language, updated_at) VALUES ($1, $2, now())
		ON CONFLICT (profile_id) DO UPDATE SET ui_language = EXCLUDED.ui_language, updated_at = now()`, profileID, lang)
	return err
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ---- HTTP ----

type Handlers struct {
	store   *Store
	audit   *audit.Logger
	pinLock *httpx.Lockout
	// onSettings run after a settings PUT (see OnSettingsChanged).
	onSettings []func(ctx context.Context, profileID string, before, after Settings)
}

func NewHandlers(s *Store, a *audit.Logger) *Handlers {
	return &Handlers{store: s, audit: a, pinLock: httpx.NewLockout(5, 30*time.Second, 15*time.Minute)}
}

func (h *Handlers) Routes(r fiber.Router) {
	g := r.Group("/profiles")
	g.Get("/", auth.RequireAny(), h.list)
	g.Post("/", auth.RequireUser(), h.create)
	g.Patch("/:id", auth.RequireUser(), h.update)
	g.Delete("/:id", auth.RequireUser(), h.delete)
	g.Post("/:id/verify-pin", auth.RequireAny(), h.verifyPIN)
	g.Get("/:id/preferences", RequireProfileCaller(), h.getPrefs)
	g.Put("/:id/preferences", auth.RequireUser(), h.putPrefs)
	g.Patch("/:id/preferences", auth.RequireUser(), h.patchPrefs)
	g.Get("/:id/settings", RequireProfileCaller(), h.getSettings)
	g.Put("/:id/settings", RequireProfileCaller(), h.putSettings)
}

func (h *Handlers) list(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	load := func() ([]Profile, error) {
		if p.Kind == auth.KindDevice {
			return h.store.ListForDevice(c.Context(), p.DeviceID)
		}
		return h.store.ListForUser(c.Context(), p.UserID)
	}
	list, err := load()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		// Nobody should face an empty "Who's watching?": give the account
		// (for a TV, its owner) a default profile named after the user.
		if err := h.store.EnsureDefault(c.Context(), p.UserID); err != nil {
			return err
		}
		if list, err = load(); err != nil {
			return err
		}
	}
	return c.JSON(httpx.List(list))
}

type profileInput struct {
	Name     *string `json:"name"`
	Avatar   *string `json:"avatar"`
	Color    *string `json:"color"`
	PIN      *string `json:"pin"`
	ClearPIN bool    `json:"clear_pin"`
}

func (in *profileInput) validate(creating bool) map[string]string {
	f := map[string]string{}
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		in.Name = &n
		if n == "" || len([]rune(n)) > 32 {
			f["name"] = "must be 1-32 characters"
		}
	} else if creating {
		f["name"] = "required"
	}
	if in.Avatar != nil && len(*in.Avatar) > 64 {
		f["avatar"] = "at most 64 characters"
	}
	if in.Color != nil && !colorRe.MatchString(*in.Color) {
		f["color"] = "must be a #rrggbb color"
	}
	if in.PIN != nil && !pinPattern.MatchString(*in.PIN) {
		f["pin"] = "must be 4-8 digits"
	}
	return f
}

func (h *Handlers) create(c fiber.Ctx) error {
	var in profileInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if f := in.validate(true); len(f) > 0 {
		return httpx.Validation(f)
	}
	p := auth.PrincipalFrom(c)
	n, err := h.store.Count(c.Context(), p.UserID)
	if err != nil {
		return err
	}
	if n >= MaxProfilesPerUser {
		return httpx.Conflict("profile_limit", "This account already has the maximum number of profiles.")
	}
	pinHash, err := h.hashPIN(c.Context(), in.PIN)
	if err != nil {
		return err
	}
	color := "#6366f1"
	if in.Color != nil {
		color = *in.Color
	}
	avatar := ""
	if in.Avatar != nil {
		avatar = *in.Avatar
	}
	prof, err := h.store.Create(c.Context(), p.UserID, *in.Name, avatar, color, pinHash)
	if errors.Is(err, ErrNameTaken) {
		return httpx.Validation(map[string]string{"name": "already used by another profile"})
	}
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(prof)
}

func (h *Handlers) update(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var in profileInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if f := in.validate(false); len(f) > 0 {
		return httpx.Validation(f)
	}
	pinHash, err := h.hashPIN(c.Context(), in.PIN)
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	prof, err := h.store.Update(c.Context(), p.UserID, id, Patch{
		Name: in.Name, Avatar: in.Avatar, Color: in.Color, PinHash: pinHash, ClearPIN: in.ClearPIN && in.PIN == nil,
	})
	switch {
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrNameTaken):
		return httpx.Validation(map[string]string{"name": "already used by another profile"})
	case err != nil:
		return err
	}
	return c.JSON(prof)
}

func (h *Handlers) delete(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	if err := h.store.Delete(c.Context(), p.UserID, id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "profile.deleted", TargetType: "profile",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}

// verifyPIN lets a TV (or the owner) unlock a PIN-protected profile.
func (h *Handlers) verifyPIN(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		PIN string `json:"pin"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	prof, err := h.accessible(c, id)
	if err != nil {
		return err
	}
	if !prof.HasPIN {
		return c.JSON(fiber.Map{"ok": true})
	}
	key := id
	if wait := h.pinLock.Check(key); wait > 0 {
		return httpx.TooManyRequests(wait)
	}
	ok, err := auth.VerifyPassword(c.Context(), *prof.pinHash, req.PIN)
	if err != nil {
		return err
	}
	if !ok {
		h.pinLock.Fail(key)
		return httpx.NewError(fiber.StatusForbidden, "wrong_pin", "Incorrect PIN.")
	}
	h.pinLock.Succeed(key)
	return c.JSON(fiber.Map{"ok": true})
}

// accessible loads a profile the caller may use: owned by the user, or
// selectable on the calling device.
func (h *Handlers) accessible(c fiber.Ctx, id string) (*Profile, error) {
	p := auth.PrincipalFrom(c)
	if p.Kind == auth.KindDevice {
		ok, err := h.store.AccessibleByDevice(c.Context(), p.DeviceID, id)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, httpx.NotFound()
		}
		prof, err := scan(h.store.q.QueryRow(c.Context(), `SELECT `+cols+` FROM profiles WHERE id = $1`, id))
		if errors.Is(err, ErrNotFound) {
			return nil, httpx.NotFound()
		}
		return prof, err
	}
	prof, err := h.store.GetOwned(c.Context(), p.UserID, id)
	if errors.Is(err, ErrNotFound) {
		return nil, httpx.NotFound()
	}
	return prof, err
}

// getPrefs is readable by a TV too (device credential, a profile the device
// may use), so its player can pick the profile's preferred voice-over.
// Writing stays user-only (putPrefs).
func (h *Handlers) getPrefs(c fiber.Ctx) error {
	id, err := h.usable(c)
	if err != nil {
		return err
	}
	prefs, err := h.store.GetPreferences(c.Context(), id)
	if err != nil {
		return err
	}
	return c.JSON(prefs)
}

var langRe = regexp.MustCompile(`^[a-z]{2,3}$`)

func (h *Handlers) putPrefs(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	if _, err := h.accessible(c, id); err != nil {
		return err
	}
	var in Preferences
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	f := map[string]string{}
	if !validUILanguage(in.UILanguage) {
		f["ui_language"] = "must be en, ru, kk or empty"
	}
	for _, l := range append(append([]string{}, in.PreferredAudioLanguages...), in.PreferredSubtitleLanguages...) {
		if !langRe.MatchString(l) {
			f["languages"] = "use ISO 639 codes such as en, ru"
		}
	}
	switch in.PreferredResolution {
	case "", "480p", "720p", "1080p", "2160p":
	default:
		f["preferred_resolution"] = "must be 480p, 720p, 1080p or 2160p"
	}
	if in.MaxSizeGB != nil && (*in.MaxSizeGB <= 0 || *in.MaxSizeGB > 1000) {
		f["max_size_gb"] = "must be between 0 and 1000"
	}
	if len(in.PreferredCodecs) > 10 || len(in.PreferredAudioLanguages) > 10 || len(in.PreferredSubtitleLanguages) > 10 {
		f["lists"] = "at most 10 entries each"
	}
	if len(in.PreferredVoiceovers) > 10 {
		f["preferred_voiceovers"] = "at most 10 entries"
	}
	for i, v := range in.PreferredVoiceovers {
		v = strings.TrimSpace(v)
		in.PreferredVoiceovers[i] = v
		if n := utf8.RuneCountInString(v); n < 1 || n > 40 {
			f["preferred_voiceovers"] = "each entry must be 1-40 characters"
		}
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	if err := h.store.PutPreferences(c.Context(), id, &in); err != nil {
		return err
	}
	return h.getPrefs(c)
}

// validUILanguage: an interface language, or "" (not chosen).
func validUILanguage(l string) bool { return l == "" || uilang.Valid(l) }

// patchPrefs changes only the fields sent (today ui_language, what the
// language pickers write), so a picker never overwrites playback choices.
func (h *Handlers) patchPrefs(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	if _, err := h.accessible(c, id); err != nil {
		return err
	}
	var in struct {
		UILanguage *string `json:"ui_language"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.UILanguage != nil {
		if !validUILanguage(*in.UILanguage) {
			return httpx.Validation(map[string]string{"ui_language": "must be en, ru, kk or empty"})
		}
		if err := h.store.SetUILanguage(c.Context(), id, *in.UILanguage); err != nil {
			return err
		}
	}
	return h.getPrefs(c)
}

func (h *Handlers) hashPIN(ctx context.Context, pin *string) (*string, error) {
	if pin == nil {
		return nil, nil
	}
	hash, err := auth.HashPassword(ctx, *pin)
	if err != nil {
		return nil, err
	}
	return &hash, nil
}
