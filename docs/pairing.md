# TV pairing

Three ways to sign in a TV:

1. **QR code**: scan with a phone that's signed in to the PWA.
2. **Short code**: type the 8-character code at `<site>/pair` in any signed-in browser.
3. **Token**: on the TV, enter a device credential (`mtd_…`), or an API token
   with the `device:register` scope (`mtp_…`). The API token is exchanged for a
   new device credential and isn't stored on the TV.

## Flow

```
TV                                   API                                  Phone (signed in)
│ POST /pairing {device_name}        │                                     │
│──────────────────────────────────► │ store hash(poll_secret), code,      │
│ ◄── {pairing_id, user_code,        │ expires_at = now + 5 min            │
│      poll_secret, verification_url_complete}                             │
│ show QR(verification_url_complete) + code                                │
│                                    │ ◄── GET /pairing/lookup?code=…      │ (scan QR → /pair?code=…)
│                                    │ ──► {device_name, platform, ip, code}
│                                    │ ◄── POST /pairing/{id}/approve      │ user checks the code matches
│ GET /pairing/{id}                  │     {name, default_profile_id}      │
│   Authorization: Pairing <secret>  │                                     │
│ ◄── {status: approved}             │                                     │
│ POST /pairing/{id}/exchange        │ in one transaction: create device + │
│   Authorization: Pairing <secret>  │ credential, mark consumed           │
│ ◄── {device, credential: mtd_…}    │                                     │
│ store credential (localStorage), open WebSocket, report state            │
```

## Guarantees

| Requirement | How |
|---|---|
| ~5-minute expiry | `PAIRING_TTL` (default 5 min). Approval leaves 2 min to collect the credential. |
| Approval needs an authenticated user | Lookup, approve and deny require a browser session (not an API token or TV). |
| Single use | Exchange locks the row (`FOR UPDATE`) and moves `approved → consumed`. A replay gets `410 pairing_consumed` and is audited. |
| Bound to the initiating TV | Status and exchange need the `poll_secret` that only the TV saw. It's stored as an HMAC hash and compared in constant time. A wrong secret gets 404 and counts toward a lockout. |
| No permanent secret in the QR | The QR holds only `/pair?code=XXXX-XXXX`. The code works for 5 minutes, only while pending, and only for signed-in users. |
| User can confirm the right TV | The phone shows the code, TV name, platform and requesting IP before approval. |
| Guessing codes | 31-symbol alphabet without look-alikes, 8 characters (~2^39.6), unique among pending requests, and lookups limited to 30 per IP and 20 per user every 5 minutes. |
| Revocable credentials | `DELETE /devices/{id}` revokes the device and all its credentials and closes its WebSocket. The TV returns to the pairing screen. |
| Default profile | Set at approval or later. It must belong to the device owner. PIN-protected profiles always ask for the PIN. |
| Sharing | `PUT /devices/{id}/permissions {username, permission: control|use}`. `use` also shows that user's profiles on the TV. |

## Auto-reconnect

The TV keeps its credential in localStorage, with an in-memory fallback. On
start it calls `GET /devices/me`:

- **200:** the TV connects its realtime link and opens the remembered profile.
- **401:** the TV clears the credential and shows the pairing screen.
- **Network error:** the TV shows an offline screen and retries every 5 s. The
  credential is kept.

The realtime client reconnects with exponential backoff and jitter (1 s to
30 s). It also reconnects right away when the network comes back or the page
becomes visible.
