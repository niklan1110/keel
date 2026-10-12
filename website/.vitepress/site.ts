import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Build settings for the two places the site is published:
 *   - inside every Keel install, at /docs/ (the default), and
 *   - as the public website, e.g. on Vercel, at / (KEEL_DOCS_BASE=/).
 *
 * KEEL_SITE_URL      the public website's address, used in install commands.
 *                    On Vercel it defaults to the project's production address.
 * KEEL_IMAGE_PREFIX  where the Docker images are published, e.g. ghcr.io/my-org.
 *                    Defaults to ghcr.io/<owner of the Git repository>.
 * KEEL_SOURCE_REPO   the GitHub repository (owner/name), for links to releases.
 *                    Defaults to the repository being built.
 *
 * Set by the release workflow when it builds a release's install files:
 * KEEL_RELEASE_VERSION  the version the installer installs (default: the
 *                       newest release).
 * KEEL_FILES_URL        where the installer downloads the compose file and the
 *                       keel command (default: the website).
 *
 * In Markdown, write @@SITE@@, @@IMAGES@@ and @@REPO@@ for these values.
 */

const env = process.env;

export const BASE = (() => {
  let b = env.KEEL_DOCS_BASE || '/docs/';
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
})();

export const IMAGES = (
  env.KEEL_IMAGE_PREFIX ||
  `ghcr.io/${(env.KEEL_IMAGE_OWNER || env.VERCEL_GIT_REPO_OWNER || env.GITHUB_REPOSITORY_OWNER || 'YOUR-GITHUB-NAME').toLowerCase()}`
).replace(/\/+$/, '');

export const SITE = (
  env.KEEL_SITE_URL ||
  (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
  'https://YOUR-KEEL-WEBSITE'
).replace(/\/+$/, '');

export const REPO = (
  env.KEEL_SOURCE_REPO ||
  (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : '') ||
  env.GITHUB_REPOSITORY ||
  'YOUR-GITHUB-NAME/keel'
).replace(/^\/+|\/+$/g, '');

const RELEASE = (env.KEEL_RELEASE_VERSION || '').replace(/^v/, '');
if (RELEASE && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(RELEASE)) {
  throw new Error(`KEEL_RELEASE_VERSION is not a version: ${RELEASE}`);
}
const FILES = (env.KEEL_FILES_URL || SITE).replace(/\/+$/, '');

export function substitute(text: string): string {
  return text.replaceAll('@@SITE@@', SITE).replaceAll('@@IMAGES@@', IMAGES).replaceAll('@@REPO@@', REPO);
}

/** markdown-it plugin: applies substitute() to text, code and link targets. */
export function substitutePlugin(md: any): void {
  md.core.ruler.push('keel_substitute', (state: any) => {
    const walk = (tokens: any[]) => {
      for (const t of tokens) {
        if (typeof t.content === 'string' && t.content.includes('@@')) t.content = substitute(t.content);
        if (t.attrs) for (const a of t.attrs) if (typeof a[1] === 'string' && a[1].includes('@@')) a[1] = substitute(a[1]);
        if (t.children) walk(t.children);
      }
    };
    walk(state.tokens);
  });
  // Snippets imported with <<< are read while rendering, after the rule above.
  const render = md.render.bind(md);
  md.render = (src: string, env?: unknown) => {
    const html = render(src, env);
    return html.includes('@@') ? substitute(html) : html;
  };
}

/**
 * Files people download from the website: the installer, the `keel` command
 * and the compose files. Made from the repository's deploy/ folder with the
 * image prefix and website address filled in. For a release, the installer
 * defaults to that version and the compose files to its images. SHA256SUMS,
 * install.sh.sha256 and install.ps1.sha256 hold their checksums, for
 * "download, check, run"; the installers check every file they download
 * against SHA256SUMS.
 */
export async function writeInstallFiles(repoRoot: string, outDir: string): Promise<void> {
  const files: [string, string][] = [
    ['deploy/install.sh', 'install.sh'],
    ['keel', 'keel-cli.sh'],
    ['deploy/install.ps1', 'install.ps1'],
    ['deploy/windows/keel-cli.ps1', 'keel-cli.ps1'],
    ['deploy/windows/keel.cmd', 'keel.cmd'],
    ['deploy/compose/docker-compose.yml', 'docker-compose.yml'],
    ['deploy/compose/docker-compose.small.yml', 'docker-compose.small.yml'],
    ['deploy/compose/docker-compose.windows.yml', 'docker-compose.windows.yml'],
    ['deploy/compose/.env.example', 'keel.env.example'],
    ['deploy/zimaos/docker-compose.yml', 'zimaos-docker-compose.yml'],
    // The same self-contained file, for the app screens of other NAS systems.
    ['deploy/zimaos/docker-compose.yml', 'nas-docker-compose.yml'],
    ['deploy/cloudflare-tunnel/docker-compose.yml', 'cloudflare-tunnel.yml'],
    ['deploy/zimaos/icon.svg', 'icon.svg'],
  ];
  const sums: string[] = [];
  for (const [from, to] of files) {
    let text = await fs.readFile(path.join(repoRoot, from), 'utf8');
    text = substitute(text)
      // The repository's own files point at its maintainer's images and repo;
      // the published copies use the configured prefix and website instead.
      .replace(/ghcr\.io\/[a-z0-9-]+\/(keel(?:-functions|-postgres)?)\b/g, `${IMAGES}/$1`)
      .replace(/https:\/\/raw\.githubusercontent\.com\/[^\s"']+\/icon\.svg/g, `${SITE}/icon.svg`)
      .replaceAll('@@FILES@@', FILES)
      .replaceAll('@@RELEASE@@', RELEASE);
    if (RELEASE) {
      // A release's compose files use its own images, not the newest ones.
      text = text
        .replaceAll('${KEEL_VERSION:-latest}', `\${KEEL_VERSION:-${RELEASE}}`)
        .replace(/(\/keel(?:-functions|-postgres)?):latest\b/g, `$1:${RELEASE}`);
    }
    await fs.writeFile(path.join(outDir, to), text, { mode: to.endsWith('.sh') ? 0o755 : 0o644 });
    sums.push(`${crypto.createHash('sha256').update(text).digest('hex')}  ${to}`);
  }
  await fs.writeFile(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  for (const f of ['install.sh', 'install.ps1']) {
    await fs.writeFile(path.join(outDir, `${f}.sha256`), `${sums.find((l) => l.endsWith(`  ${f}`))}\n`);
  }
}

/**
 * Refuses to publish raw.githubusercontent.com links (the site serves those
 * files itself) or anything that still has a placeholder in it.
 */
export async function checkOutput(outDir: string): Promise<void> {
  const problems: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(html|js|md|txt|sh|ps1|cmd|yml|example|json|xml)$/.test(e.name)) {
        const text = await fs.readFile(p, 'utf8');
        for (const re of [/raw\.githubusercontent\.com/, /@@(SITE|IMAGES|REPO|FILES|RELEASE)@@/]) {
          const m = re.exec(text);
          if (m) problems.push(`${path.relative(outDir, p)}: ${m[0]}`);
        }
      }
    }
  };
  await walk(outDir);
  if (problems.length) throw new Error(`The site would publish raw GitHub links or placeholders:\n  ${problems.join('\n  ')}`);
}
