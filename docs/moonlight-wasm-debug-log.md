# Moonlight WASM/IWA Debug Log

This tracks the current browser Moonlight/Sunshine integration attempts so we do
not loop back through already-tested assumptions.

## Current Target

- Browser/IWA dev UI at `http://localhost:3001`.
- Sunshine container host IP: `192.168.68.64`.
- User manually posts displayed PIN into the container:

```sh
docker exec gst-fixed sh -c 'curl -sk -u "$(cat /tmp/.sunshine_user):$(cat /tmp/.sunshine_pass)" \
  -H "Content-Type: application/json" \
  -X POST "https://localhost:47990/api/pin" \
  -d "{\"pin\":\"1234\"}"'
```

## Known Container Port Behavior

- `http://192.168.68.64:47989/serverinfo?...` returns GameStream XML.
- `http://192.168.68.64:47984/serverinfo?...` did not return usable XML.
- `https://192.168.68.64:47990/api/pin` is the Sunshine Web UI/API path for PIN submission.
- `https://192.168.68.64:47984/applist` and `/launch` require a Moonlight client certificate.
- Sunshine serverinfo returned:
  - `HttpsPort=47984`
  - `ExternalPort=47989`
  - `ServerCodecModeSupport=65793`

## Things Fixed So Far

- Built `packages/protocol/dist/moonlight.js` and `moonlight.wasm`.
- Copied WASM assets to `apps/iwa/public/`.
- Fixed invalid Emscripten `-sUSE_MBEDTLS=1` by adding a WebCrypto platform crypto bridge.
- Fixed Vite proxy placement by moving `configureServer` into a proper Vite plugin.
- Added port auto-detection for the HTTP GameStream XML endpoint.
- Changed pairing device name to `roth`, matching Moonlight clients.
- Fixed the pairing flow to use:
  - PIN-derived AES key.
  - Encrypted client challenge.
  - `serverchallengeresp`.
  - Signed client pairing secret.
- Fixed the PIN race by starting the blocking `getservercert` request before showing the PIN.
- Moved `/applist`, `/launch`, and `/cancel` to HTTPS `HttpsPort`.
- Added client certificate support for HTTPS Sunshine requests through the dev proxy.

## Current Failure

After successful PIN submission (`{"status":true}`), HTTPS cert-auth requests
still fail. Instrumentation run `cert-auth-502` showed:

```text
/applist returned XML status_code=401 status_message="The client is not authorized. Certificate verification failed."
/launch then failed with TLS alert internal error
```

Meaning: the dev proxy is sending a cert/key, but Sunshine does not consider that
cert authorized after the pairing attempt.

## Latest Fix

- Runtime log showed Sunshine step 1 returned `<plaincert>` as PEM text hex:
  - `bodyPrefix` started `2D2D2D2D2D424547494E...`
  - `2D2D2D2D2D` decodes to `-----`
  - Existing parser treated it as DER ASN.1 and threw `Too few bytes to read ASN.1 value`.
- Fixed certificate parsing to accept both PEM-hex and DER-hex for Sunshine
  server certificates.
- Normalized generated PEM cert/key line endings to LF-only before sending to
  Sunshine and before using them as client TLS credentials. This targets observed
  `clientcert` CRLF bytes (`0d0a`) in failing step-1 pairing requests.
- Runtime log showed full pairing success through final HTTPS `pairchallenge`.
- Runtime log showed `/launch` returned:
  - `status_code=400`
  - `status_message="An app is already running on this host"`
- Sunshine source confirms this branch occurs when `proc::proc.running() > 0`
  and that `/resume` is the endpoint for an already-running app. Added a
  targeted `/resume` fallback only for that exact launch response.
- Runtime/user error after successful `/resume`:
  `Failed to fetch dynamically imported module:
  /@fs/home/coby/projects/game-stream/packages/protocol/src/moonlight.js`.
  Cause: `@basehack/protocol` is consumed from TS source in Vite, so its default
  `./moonlight.js` resolved relative to `packages/protocol/src`. Fixed IWA
  session creation to pass `moduleUrl: "/moonlight.js"` and `locateFile` mapping
  to public root assets.
- Runtime log `cert-auth-502` showed HTTP `/pair` was forwarded without the
  Moonlight `clientcert` query parameter:
  - Browser request had `clientcert`.
  - Upstream proxy `queryKeys` lacked `clientcert`.
  - Sunshine responded with only an XML declaration, causing parser error.
- Fixed proxy filtering so `clientcert/clientkey` are only treated as proxy TLS
  credentials for HTTPS requests. HTTP `/pair` now forwards Moonlight
  `clientcert` to Sunshine.

- Moved dev proxy transport from GET-only query params to POST JSON for HTTPS
  requests that require `clientCert` and `clientKey`.
- Kept GET compatibility for simple `/serverinfo` probes.
- This avoids leaking PEM material in the URL and preserves exact PEM newlines for
  Node's HTTPS client.
- Changed final pairing confirmation (`phrase=pairchallenge`) to use the HTTPS
  GameStream endpoint with the generated client certificate.
- Forced the dev proxy HTTPS client to TLS 1.2 for Sunshine GameStream HTTPS.
- Added pairing-step logs and stopped ignoring `/applist` authorization failures.
- Stopped continuing after a failed pairing attempt unless serverinfo explicitly
  reports `PairStatus=1`.

## Next Thing To Check

After restarting Vite, retry pairing and launch. Latest runtime pattern:

- HTTPS `pairchallenge` succeeds.
- Next HTTPS `/applist` fails with TLS alert internal error.
- HTTPS `/launch` succeeds.
- Next HTTPS `/resume` fails with TLS alert internal error.

New hypotheses under instrumentation:

- `H10`: Node HTTPS/TLS session reuse is incompatible with Sunshine's client-cert
  flow.
- `H11`: Sunshine is closing cert-auth HTTPS requests for endpoints that do not
  match its active session state.
- `H12`: TLS authorization/cipher details differ between successful and failing
  HTTPS requests.

If `/pair?phrase=pairchallenge`, `/applist`, `/launch`, or `/resume` returns 502,
the Vite proxy now logs socket `secureConnect` details including
`isSessionReused`, TLS protocol, authorization state, and cipher.

Latest experiment:

- Successful HTTPS requests log `isSessionReused=false`.
- Failing HTTPS requests fail before `secureConnect`, so they cannot report
  `isSessionReused`.
- Added an HTTPS agent with `maxCachedSessions=0` and `keepAlive=false` to
  disable TLS session caching entirely for Sunshine proxy requests.

Expected old failures were:

```text
tlsv13 alert certificate required
tlsv1 alert internal error
```

If that exact error persists, inspect the pairing-step logs. The next evidence
needed is whether step 1-5 returns `<paired>1</paired>` and whether final
`pairchallenge` fails before cert authorization.

## Do Not Repeat

- Do not use `47990` for GameStream XML. It is only Web UI/API.
- Do not assume `47984` is the HTTP XML endpoint for this container. Here,
  HTTP XML discovery worked on `47989`.
- Do not call HTTPS `/launch` without the paired client certificate.
- Do not regenerate a new cert after pairing and expect HTTPS launch to accept it.
