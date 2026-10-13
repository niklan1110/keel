## What and why

<!-- What this changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How it was checked

- [ ] `npm run typecheck` and `npm test`
- [ ] `npm run test:e2e` against `./keel up` (for changes to the services)
- [ ] `npm run build -w website` (for docs changes)

## Checklist

- [ ] Docs in `website/` updated, and a line under `Unreleased` in `CHANGELOG.md` if users will notice
- [ ] New schema upgrades are new numbered files in `server/sql/project/`; released ones are unchanged
- [ ] No secrets, sign-in links, codes or personal data in code, logs, tests or screenshots
