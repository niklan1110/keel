# Contributing to Keel

Thanks for helping. Bug reports, docs fixes and code are all welcome. By taking
part you agree to the [code of conduct](CODE_OF_CONDUCT.md).

Found a security problem? Please don't open an issue: see [SECURITY.md](SECURITY.md).

## Before you start

- **Bugs:** open an issue with the "Bug report" form, with the version
  (`./keel version`) and steps to reproduce.
- **Features:** open an issue first, so we can agree on the shape before you
  spend time on it. Keel follows Supabase's APIs, so "Supabase does X like this"
  is a great starting point.
- **Small fixes** (typos, docs, an obvious bug) can go straight to a pull request.

## Setting up

You need Node.js 22, Docker with the Compose plugin and `openssl`. A quick
tour of the code is in [docs/architecture.md](docs/architecture.md).

```bash
npm ci --ignore-scripts
./keel init --url http://localhost:8000
./keel up                # builds the images from your checkout and starts Keel
```

| Folder | What it is |
|---|---|
| `server/` | The services (gateway, auth, rest, storage, realtime, functions, Studio's API, migrations), TypeScript |
| `server/sql/project/` | Numbered schema upgrades for every project database |
| `studio/` | Studio, React and Vite |
| `website/` | The documentation site, VitePress |
| `tests/e2e/` | End-to-end tests against a running stack |
| `deploy/` | Compose files, the installer, the ZimaOS app |

## Checks

Run these before you open a pull request; CI runs the same:

```bash
npm run typecheck
npm test                     # unit tests
npm run build -w website     # docs; fails on dead links
npm run test:e2e             # against the stack from ./keel up
```

Shell scripts (`keel`, `deploy/install.sh`) must pass `shellcheck`.

## Writing changes

- Keep a pull request to one change, with tests for behaviour you add or fix.
- **Schema upgrades** are new files in `server/sql/project/` with the next
  number. Never edit one that has been released: installs have already run it.
  `keel-migrate` refuses to start an image older than the database, so a new
  upgrade means older versions can't run on that database any more.
- **Security first.** Changes to auth, input handling, secrets, SQL or the
  network get extra review. Never log secrets, sign-in links, codes or
  personal data.
- **No personal data** in code, docs, screenshots or logs: no real names,
  emails, domains or addresses. Use `example.com` and made-up values.
- Update the docs in `website/` in the same pull request, and add a line to
  the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for anything users
  notice.
- Commit messages say what changed and why, in plain words.

## Releasing (maintainers)

Versions follow [Semantic Versioning](https://semver.org); before 1.0, a minor
version may change behaviour. A release is a `v*` tag; the
[release workflow](.github/workflows/release.yml) does the rest after CI passes.

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`,
   add a new empty `## [Unreleased]` above it, and update the links at the
   bottom.
2. Set `"version": "X.Y.Z"` in `package.json`, `server/package.json`,
   `studio/package.json`, `website/package.json` and `tests/e2e/package.json`,
   then run `npm install --package-lock-only --ignore-scripts`.
3. Commit ("Release X.Y.Z") and push to the default branch. Wait for CI.
4. Tag and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Keel X.Y.Z"
   git push origin vX.Y.Z
   ```

The workflow checks the tag has a changelog section, runs CI, scans, signs and
publishes the images (`X.Y.Z`, `X.Y`, `X` from 1.0 on, and `latest`), then
creates the GitHub release with the notes, the installer and the compose files
with checksums. A tag such as `vX.Y.Z-rc.1` publishes a pre-release without
moving `latest`.
