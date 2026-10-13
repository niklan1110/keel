# Publishing the Keel website

The public website (landing page, documentation and the downloadable install
files) is the `website/` folder, built with VitePress. `vercel.json` at the
repository root has everything Vercel needs.

## On Vercel

1. vercel.com > **Add New > Project** > import this repository.
2. **Root Directory** can be the repository root (uses `vercel.json`) or
   `website` (uses `website/vercel.json`, which runs the same commands from the
   repository root). Keep the two files' headers in step.
3. Under **Environment Variables**, optionally set:
   - `KEEL_SITE_URL`: the site's final address, e.g. `https://keel.example.com`
     (defaults to the project's production domain). It goes into the install
     command, the installer and the compose files.
   - `KEEL_IMAGE_PREFIX`: where the images are published, e.g. `ghcr.io/my-org`
     (defaults to `ghcr.io/<owner of the Git repository>`).
4. Deploy. Pick a project name that doesn't contain anything personal: it
   becomes `<name>.vercel.app`.

To count visitors, turn on **Analytics** in the Vercel project: builds on
Vercel load its cookieless script, and the docs built into Keel never do.

Every push to the default branch deploys again. On Vercel's free plan with a
private repository, only commits authored by the Vercel account's owner are
built; others fail before the build starts, with no error in the log.

The build stops if a page would publish a raw.githubusercontent.com link or an
unfilled `@@SITE@@`, `@@IMAGES@@`, `@@REPO@@`, `@@FILES@@` or `@@RELEASE@@`
placeholder. `@@REPO@@` (owner/name, for links to GitHub releases) comes from
`KEEL_SOURCE_REPO`, else Vercel's or GitHub's repository variables. Keel's source is
public, so pages and images may link to the repository.

## Release images to match

Set the repository variable `KEEL_SITE_URL` (Settings > Secrets and variables >
Actions > Variables) to the same address, so the docs inside Keel and Studio's
AI-agent prompt point at the website. Images are published by the **Release**
workflow (`.github/workflows/release.yml`): `edge` on every push to the default
branch, versions and `latest` only from `v*` tags. The packages on ghcr.io must
be public for other people to install Keel.

A release (a `v*` tag) also builds this site's install files with
`KEEL_RELEASE_VERSION` and `KEEL_FILES_URL` set, so the installer attached to
the GitHub release installs exactly that version and downloads the compose file
and the `keel` command from the same release.

## Files the site serves

| Path | From |
|---|---|
| `/install.sh` | `deploy/install.sh` |
| `/install.sh.sha256`, `/SHA256SUMS` | checksums of the files below, written by the build |
| `/keel-cli.sh` | `keel` |
| `/docker-compose.yml`, `/keel.env.example` | `deploy/compose/` |
| `/zimaos-docker-compose.yml`, `/icon.svg` | `deploy/zimaos/` |
| `/cloudflare-tunnel.yml` | `deploy/cloudflare-tunnel/docker-compose.yml` |
| `/llms.txt`, `/llms-full.txt` | generated from the docs |
