package profiles

import (
	"encoding/json"
	"slices"

	"github.com/google/uuid"
)

// IPTVPlaylistsSetting is "all" | [playlist ids] (internal/iptv). All =
// every enabled playlist, including ones added later.
type IPTVPlaylistsSetting struct {
	All bool
	IDs []string
	bad string
}

func (s IPTVPlaylistsSetting) MarshalJSON() ([]byte, error) {
	if s.All {
		return []byte(`"all"`), nil
	}
	ids := s.IDs
	if ids == nil {
		ids = []string{}
	}
	return json.Marshal(ids)
}

func (s *IPTVPlaylistsSetting) UnmarshalJSON(b []byte) error {
	const msg = `must be "all" or a list of playlist ids`
	var all string
	if json.Unmarshal(b, &all) == nil {
		if all != "all" {
			*s = IPTVPlaylistsSetting{bad: msg}
			return nil
		}
		*s = IPTVPlaylistsSetting{All: true}
		return nil
	}
	var ids []string
	if err := json.Unmarshal(b, &ids); err != nil || ids == nil {
		*s = IPTVPlaylistsSetting{bad: msg}
		return nil
	}
	*s = IPTVPlaylistsSetting{IDs: ids}
	return nil
}

// knownIPTVPlaylists returns the existing playlist ids (set by the server).
var knownIPTVPlaylists func() []string

// SetKnownIPTVPlaylists makes settings validation reject unknown playlist ids.
func SetKnownIPTVPlaylists(f func() []string) { knownIPTVPlaylists = f }

func (s *IPTVPlaylistsSetting) validate() string {
	if s.bad != "" {
		return s.bad
	}
	if s.All {
		return ""
	}
	if len(s.IDs) > 100 {
		return "at most 100 playlist ids"
	}
	var known []string
	if knownIPTVPlaylists != nil {
		known = knownIPTVPlaylists()
	}
	for _, id := range s.IDs {
		if u, err := uuid.Parse(id); err != nil || u.String() != id {
			return "invalid playlist id"
		}
		if knownIPTVPlaylists != nil && !slices.Contains(known, id) {
			return "unknown playlist id: " + id
		}
	}
	return ""
}
