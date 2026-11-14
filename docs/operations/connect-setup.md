# T3 Connect setup

Deployment and client configuration for T3 Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions and the [auth README](../../infra/auth/README.md) owns the identity service.

## Public application configuration

Web, desktop, and bundled-server builds default to the self-hosted stack. To point a build at
another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_AUTH_URL=https://auth.example.com
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public URLs. Auth and relay
secrets belong only in their deployments, never in client configuration.

Client and bundled-server builds embed the values, so set them before building. Bundled servers
also accept `T3CODE_AUTH_URL` and `T3CODE_RELAY_URL` at runtime for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.

## New client origins

The auth service answers browser requests only from origins it knows. Before serving the web app
from a new origin or shipping a desktop build with a new app scheme, add the origin to
`trustedOrigins` in [auth.ts](../../infra/auth/src/auth.ts) and to the CORS list in
[cors.ts](../../infra/auth/src/cors.ts). Without the first, GitHub sign-in rejects the callback;
without the second, the browser blocks every auth request.

## Mobile

The mobile app signs in against the same auth service, with GitHub or a passkey. GitHub returns to
the app through `<scheme>://auth-callback`, so each app scheme a build uses must be in
`trustedOrigins` in [auth.ts](../../infra/auth/src/auth.ts). A passkey sign-in opens the device
approval page in the in-app browser and needs no callback.

A build reads `T3CODE_AUTH_URL` and `T3CODE_RELAY_URL` at prebuild and bundling. With
`T3CODE_OWNER_NAME` set, the app takes the owner's name, bundle identifier and scheme, and drops the
upstream Apple team, universal links and OTA update source.

On the fork, pushing a `mobile-v*` tag runs
[fork-mobile-android.yml](../../.github/workflows/fork-mobile-android.yml), which builds a release
APK for arm64 phones and keeps it as a workflow artifact. It is signed with the debug keystore, so
it installs by hand and is not a store build.

## Signed macOS builds

Desktop sign-in, passkeys included, runs in the system browser and needs no entitlement. Signed
macOS builds still entitle the in-app browser's passkeys:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
T3CODE_PASSKEY_RP_DOMAINS=amartuvshin.com
```

After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair. Configure signing as
described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).
