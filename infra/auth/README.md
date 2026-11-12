# T3 Code auth

Self-hosted identity issuer for T3 Connect, built on [Better Auth](https://www.better-auth.com).
It replaces Clerk at the one seam the relay touches: the identity JWT the relay verifies in its
RFC 8693 token exchange, and the RFC 8628 device login the CLI uses.

Users sign in with GitHub or a passkey. There is no email or password sign-in. Teams are Better
Auth organizations.

## Identity contract

The relay (P2) and clients (P3) code against this. Changing it is a breaking change.

|              |                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ |
| Issuer       | `https://auth.amartuvshin.com`                                                             |
| Base path    | `/api/auth`                                                                                |
| JWKS         | `https://auth.amartuvshin.com/api/auth/jwks`                                               |
| Health       | `GET /api/auth/ok` returns `{"ok":true}`                                                   |
| Signing      | EdDSA over Ed25519                                                                         |
| `aud`        | `t3-relay`                                                                                 |
| Lifetime     | 15 minutes                                                                                 |
| `sub`        | user id                                                                                    |
| Other claims | `email`, `name`, `orgs`: `[{ id, slug, role }]` for every organization the user belongs to |

A client gets a JWT from `GET /api/auth/token` with its session, either the session cookie or
`Authorization: Bearer <session token>`.

### CLI device login

1. `POST /api/auth/device/code` with `{"client_id":"t3-cli"}`. Other client ids get `invalid_client`.
2. Show `user_code` and `verification_uri` (`https://auth.amartuvshin.com/device`).
3. Poll `POST /api/auth/device/token` with
   `{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"…","client_id":"t3-cli"}`
   no faster than `interval` seconds. It answers `authorization_pending`, then an `access_token`.
4. The `access_token` is a session token. Use it as a bearer token on `GET /api/auth/token` to get
   the relay JWT.

The `/device` page signs the user in, then approves or denies the code.

### Passkeys

The relying party id is `amartuvshin.com`, so a passkey works on every `*.amartuvshin.com` origin.
Native apps can use the same passkeys once `amartuvshin.com` serves
`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for them. Passkey
ceremonies are accepted only from `https://auth.amartuvshin.com` today. Changing the relying party
id later invalidates every registered passkey.

### Trusted origins and CORS

Trusted origins are the desktop app schemes (`t3code`, `t3code-dev`, `amaraa-mode`,
`amaraa-mode-dev`), `http://localhost:*`, `http://127.0.0.1:*`, and `https://*.amartuvshin.com`.
`/api/auth/*` answers CORS for the same web origins and for the desktop renderers at
`<scheme>://app` ([cors.ts](src/cors.ts)). Clients authenticate with bearer session tokens, so
CORS does not allow credentials.

### Client sign-in

- Web GitHub: `GET /api/auth/oauth-popup/start` in a popup. The `oauthPopup` plugin posts the
  session token to the opener.
- Desktop GitHub: `POST /api/auth/sign-in/social` with `callbackURL` `<scheme>://auth-callback`,
  then the system browser opens `/api/auth/expo-authorization-proxy`. The `expo` plugin appends
  the session cookie to the deep link.
- Passkeys and the CLI: the device login above. Passkey ceremonies only work on this origin.

## Configuration

| Variable                                       |                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | Postgres connection string                                                                                                    |
| `BETTER_AUTH_SECRET`                           | Encrypts signing keys and signs cookies. Rotating it invalidates sessions and the stored signing key                          |
| `BETTER_AUTH_URL`                              | Public URL, default `https://auth.amartuvshin.com`                                                                            |
| `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET` | GitHub OAuth app. The callback is `https://auth.amartuvshin.com/api/auth/callback/github`. GitHub sign-in is off without them |
| `PASSKEY_RP_ID`                                | Default `amartuvshin.com`                                                                                                     |
| `PORT`                                         | Default `3000`                                                                                                                |

## Migrations

`migrations/*.sql` are generated by the Better Auth CLI and applied in order when the service
starts. Applied files are recorded in `schema_migrations`. After changing plugins, run the CLI
against a database that has every existing migration applied, and commit the new file:

```sh
DATABASE_URL=… BETTER_AUTH_SECRET=… vp run migrations:generate migrations/0002_<name>.sql
```

## Working locally

```sh
vp test run
vp run typecheck
```

Deployment lives in [`infra/deploy`](../deploy/README.md).
