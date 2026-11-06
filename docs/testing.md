# Testing

| Command | What runs |
|---|---|
| `make test-go` | Go unit and integration tests in Docker against Postgres (`martytv_test` DB; each test gets its own schema) |
| `make test-js` | Vitest: realtime client (backoff, auth failure, acks, retry with the same id), i18n key/placeholder parity |
| `make e2e` (Phase 2) | also `web-catalog.spec.ts` (home rows → search → detail → season switch → browse filter) and `tv-catalog.spec.ts` (rows, arrow keys, Details `data-media-id`, Back restores focus, on-screen keyboard search, same title on phone `/title/<id>` and TV) |
| `make e2e` | Playwright (Chromium) against the running dev stack: login → TV shows code → phone approves → TV leaves pairing → device online → phone sends a message, TV shows it → TV reload reconnects without pairing → unpair |
| `make lint typecheck` | ESLint, `tsc --noEmit` for every package, `go vet` |

## Coverage of the spec's test list

| Requirement | Tests |
|---|---|
| Authentication, session expiry | `TestLoginAndSession`, `TestSessionIdleExpiry`, `TestLoginLockout`, `TestLoginDoesNotRevealUsernames`, `TestCSRFAndOrigin`, `TestChangePasswordRevokesOtherSessions` |
| Token issuance and revocation | `TestAPITokenScopesAndRevocation`, `TestExpiredAPIToken`, `TestManualTokenRegistration`, `TestLogoutAllWithDevices`, `auth.TestTokenHashing` |
| Pairing expiry and replay | `TestPairingIsSingleUse`, `TestPairingExpiry`, `TestPairingBoundToInitiatingTV`, `TestPairingDeny`, `TestPairingApprovalNeedsSignedInUser`, `TestPairingFromBrowserWithSessionCookie` |
| Device ownership | `TestDeviceOwnership`, `TestRealtimeAuthorization` |
| Profile isolation | `TestProfileIsolation` |
| Admin, privilege escalation | `TestAdminDisableUser` |
| WebSocket delivery, retries | `TestRealtimePresenceAndCommands`, `TestRealtimeCommandTimeoutAndOffline`, JS `realtime.test.ts` |
| Multi-device reconnection | `TestRealtimeReconnectAndRevocation`, `TestRealtimeTokenAuthIgnoresCookie` |
| Prowlarr / TorrServer adapters | `integrations_test.go` with mock servers (status, auth, unreachable, no redirects) |
| Catalog (Phase 2) | `catalog_test.go` (stable UUIDs across languages/endpoints, list validation, discover mapping, cache hits, stale refresh, image proxy safety, auth, unconfigured TMDB), `tmdb/client_test.go` (bearer vs key, 429 retry, no redirects, proxy) |
| Release normalization, matching, playback, recommendations, Movie Night | Later phases |

## Manual TV compatibility checklist

Run on each target TV (Samsung Tizen, LG webOS, Android TV) through MSX, then
directly in the TV browser:

1. MSX → Settings → Start Parameter → Setup → `<host>`. Cineko appears;
   "Open Cineko" opens the TV app **full screen**.
2. The pairing screen shows a readable QR code and code from 3 m away. Scanning
   with a phone opens the approval page.
3. After approval the TV leaves the pairing screen within ~3 s, and the profile
   picker or home screen appears.
4. Arrow keys move focus visibly, OK selects, and the PIN pad works with both
   the arrow pad and number keys.
5. **Back:** from the profile picker it returns home; pressed twice on home it
   exits to MSX.
6. Turn the TV off and on and relaunch: it reconnects without pairing (so
   localStorage persists).
7. Unplug the network: the "Reconnecting…" badge appears. Plug it back in: it
   clears within ~30 s.
8. From the phone, **Devices → Send test message** shows the toast on the TV.
9. Unpair from the phone: the TV returns to the pairing screen.
10. Catalog: hold Right on a row; it scrolls smoothly without lag (virtualized rows). Open a title, press Back: focus returns to the same card. The search keyboard switches EN/RU, the remote's number keys work, and posters load (through `/api/v1/images` on the server).
11. Note the TV's user agent (shown in Devices → platform) and the engine
    version for the Phase 4 codec matrix.
