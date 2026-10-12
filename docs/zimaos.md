# Running Keel on a ZimaOS NAS

The current instructions are on the website: `website/self-hosting/zimaos.md`
(published as `/self-hosting/zimaos`). In short, over SSH as root:

```bash
curl -fsSL https://<your Keel website>/install.sh | bash
```

The installer puts Keel in `/DATA/AppData/keel` (settings in `.env`, data in
`db/`, `db-tls/`, `storage/`, `backups/`, `functions/`, `tunnel/`), and running
it again updates Keel. On ZimaOS and CasaOS it opens Studio (3000) to the LAN,
asking first when run in a terminal (`--no-lan` keeps it on the NAS); Postgres
(5432) stays on 127.0.0.1 unless `--lan-db`. The gateway (8000) is on all
interfaces.

The App Store route uses `deploy/zimaos/docker-compose.yml`. It publishes
explicit IPv4 binds: `0.0.0.0:8000`, `0.0.0.0:3000` (so the dashboard tile opens
Studio) and `127.0.0.1:5432`. It has seven `CHANGE_ME` values: four secrets,
the two imgproxy signing keys (`IMGPROXY_KEY`/`IMGPROXY_SALT` from
`generate-env`; imgproxy refuses to start without hex values) and the NAS
address. Postgres requires TLS from other machines; its certificate is made by
`keel-db-tls` in `/DATA/AppData/keel/db-tls` on the first start.

Images come from `ghcr.io/<owner>/keel`, `keel-functions` and `keel-postgres`, published by the
**Release** workflow (from version tags; see `CHANGELOG.md`). Make all three packages public (GitHub > Packages >
Package settings > Change visibility) so a NAS can pull them without a login.
