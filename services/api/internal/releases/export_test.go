package releases

import "time"

// SetNow replaces the clock (tests).
func (s *Service) SetNow(now func() time.Time) { s.now = now }
