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

## Mobile (Clerk)

The mobile app still signs in with Clerk. EAS preview and production environments need
`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, and the relay URL.

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                      |
| ----------- | --------------------------------------------- |
| Development | `clerk://com.t3tools.t3code.dev.callback`     |
| Preview     | `clerk://com.t3tools.t3code.preview.callback` |
| Production  | `clerk://com.t3tools.t3code.callback`         |

Preserve existing entries. These callbacks are separate from the `t3code-dev` / `t3code-preview` / `t3code` navigation schemes.

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
