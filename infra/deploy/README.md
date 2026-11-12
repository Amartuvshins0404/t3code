# Self-hosted infra deploy

One Docker Compose project, `t3-infra`, on the owner's server. It runs Postgres 17 and the
[auth service](../auth/README.md). The Node relay (P2) joins the same project.

[`deploy-infra.yml`](../../.github/workflows/deploy-infra.yml) deploys it on every push to
`amaraa-mode` that touches `infra/auth`, `infra/deploy`, or the workflow. Run it by hand
(`workflow_dispatch`) to deploy another branch for testing.

## What a deploy does

1. Builds `ghcr.io/amartuvshins0404/t3-auth:<commit sha>` and pushes it to GHCR.
2. Copies this directory to `/opt/t3-infra` as the `deploy` user and writes `/opt/t3-infra/.env`
   (mode 600) from repository secrets.
3. Pulls with the job's short-lived `GITHUB_TOKEN`, in a throwaway Docker config, so the server
   stores no registry credential. Then runs `docker compose up -d --wait`.
4. Runs `sudo /usr/local/sbin/t3-infra-apply-ingress`, which adds [`cloudflared/ingress.yml`](./cloudflared/ingress.yml)
   to `/etc/cloudflared/config.yml` and restarts `cloudflared` only if the file changed.
5. Fails unless `https://auth.amartuvshin.com/api/auth/ok` and `/api/auth/jwks` answer.

## Exposure

Nothing listens publicly. Postgres has no host port. Each service binds `127.0.0.1` and is
reached through the server's Cloudflare named tunnel, which terminates TLS.

| Hostname                | Local port            |
| ----------------------- | --------------------- |
| `auth.amartuvshin.com`  | `127.0.0.1:3100`      |
| `relay.amartuvshin.com` | `127.0.0.1:3200` (P2) |

The ingress script owns only the lines between `# t3-infra:begin` and `# t3-infra:end` and puts
them before the catch-all `http_status:404` rule. It accepts only `*.amartuvshin.com` hostnames
that no other rule routes, pointed at `http://127.0.0.1:<port>`. It validates the result with
`cloudflared tunnel ingress validate` and restores the previous file if `cloudflared` does not
come back.

## Adding the relay (P2)

- Add a `relay` service to [`compose.yml`](./compose.yml) with
  `DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/relay`, port
  `127.0.0.1:3200:<container port>`, and `depends_on` Postgres like `auth`.
- Add the `relay.amartuvshin.com` rule to [`cloudflared/ingress.yml`](./cloudflared/ingress.yml).
- Add the relay paths, image build, `RELAY_TAG`, and a health check to the workflow.

The `relay` database already exists. [`postgres/init`](./postgres/init) runs only when the volume
is first created, so a new database on a running server needs `docker compose exec postgres
createdb -U postgres <name>`.

## Secrets

Repository secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `POSTGRES_PASSWORD`,
`BETTER_AUTH_SECRET`, `GH_OAUTH_CLIENT_SECRET`. Repository variable: `GH_OAUTH_CLIENT_ID`.
[`.env.example`](./.env.example) lists what lands in `/opt/t3-infra/.env`.

## One-time server setup

Already done on the current server. Repeat it as root for a new one:

```sh
useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# put the public half of DEPLOY_SSH_KEY in /home/deploy/.ssh/authorized_keys (mode 600)
install -d -m 755 -o deploy -g deploy /opt/t3-infra
install -m 755 -o root -g root apply-ingress.py /usr/local/sbin/t3-infra-apply-ingress
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/t3-infra-apply-ingress ""' > /etc/sudoers.d/t3-infra-deploy
chmod 440 /etc/sudoers.d/t3-infra-deploy
```

The installed script is a root-owned copy of [`cloudflared/apply-ingress.py`](./cloudflared/apply-ingress.py),
so a deploy cannot change what runs as root. Reinstall it by hand after changing that file.
