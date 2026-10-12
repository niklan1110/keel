import path from 'node:path';
import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress';
import { sectionsFrom, writeLlmsFiles } from './llms';
import { BASE, REPO, SITE, checkOutput, substitutePlugin, writeInstallFiles } from './site';

// The public website (KEEL_DOCS_BASE=/ with a real address in KEEL_SITE_URL or on
// Vercel) gets a sitemap, canonical links and share images; the copy built into
// every install leaves them out, since its address isn't known.
const PUBLIC_URL = BASE === '/' && !SITE.includes('YOUR-KEEL-WEBSITE') ? SITE : '';
const DESCRIPTION =
  'Self-hosted, Supabase-compatible backend: Postgres, REST API, auth, storage, realtime and edge functions on your own server.';

// Keel's website and documentation. Built two ways (see site.ts):
//   - into the Keel image, served by every install at /docs (the default);
//   - as the public website at / (KEEL_DOCS_BASE=/), e.g. on Vercel.

// One sidebar for every docs page, in the order a newcomer reads them:
// start, build features, run the server, look things up. Groups are one level
// deep, because llms.ts turns each group into a section of llms.txt, and each
// page appears once.
const guide: DefaultTheme.SidebarItem[] = [
  {
    text: 'Getting started',
    items: [
      { text: 'What is Keel?', link: '/guide/introduction' },
      { text: 'Quickstart', link: '/guide/quickstart' },
      { text: 'Core concepts', link: '/guide/concepts' },
      { text: 'Connecting your app', link: '/guide/connecting' },
      { text: 'API keys and rotation', link: '/guide/api-keys' },
      { text: 'Build with AI agents', link: '/guide/ai-agents' },
    ],
  },
  {
    text: 'Coming from Supabase',
    collapsed: false,
    items: [
      { text: 'What changes', link: '/guide/coming-from-supabase' },
      { text: 'Import a Supabase project', link: '/self-hosting/migrate-from-supabase' },
      { text: 'Compatibility', link: '/reference/compatibility' },
    ],
  },
  {
    text: 'Database',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/database/overview' },
      { text: 'Tables and data', link: '/database/tables' },
      { text: 'Querying with the API', link: '/database/querying' },
      { text: 'Row level security', link: '/database/row-level-security' },
      { text: 'Database functions (RPC)', link: '/database/functions' },
      { text: 'Extensions', link: '/database/extensions' },
      { text: 'Connecting directly', link: '/database/connecting-directly' },
    ],
  },
  {
    text: 'Auth',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/auth/overview' },
      { text: 'Email and password', link: '/auth/passwords' },
      { text: 'Magic links and email codes', link: '/auth/passwordless' },
      { text: 'Phone (SMS) sign-in', link: '/auth/phone' },
      { text: 'Social sign-in', link: '/auth/oauth' },
      { text: 'OpenID Connect providers', link: '/auth/oidc' },
      { text: 'Anonymous users', link: '/auth/anonymous' },
      { text: 'Two-factor authentication', link: '/auth/mfa' },
      { text: 'Sessions and tokens', link: '/auth/sessions' },
      { text: 'Managing users', link: '/auth/managing-users' },
      { text: 'Email setup', link: '/auth/email' },
    ],
  },
  {
    text: 'Storage',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/storage/overview' },
      { text: 'Uploading files', link: '/storage/uploads' },
      { text: 'Resumable uploads', link: '/storage/resumable-uploads' },
      { text: 'Serving files', link: '/storage/serving-files' },
      { text: 'Image transformations', link: '/storage/image-transformations' },
      { text: 'Access control', link: '/storage/access-control' },
    ],
  },
  {
    text: 'Realtime',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/realtime/overview' },
      { text: 'Database changes', link: '/realtime/postgres-changes' },
      { text: 'Broadcast', link: '/realtime/broadcast' },
      { text: 'Presence', link: '/realtime/presence' },
      { text: 'Private channels', link: '/realtime/authorization' },
      { text: 'Broadcast from the database', link: '/realtime/database-broadcast' },
    ],
  },
  {
    text: 'Edge functions',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/functions/overview' },
      { text: 'Your first function', link: '/functions/quickstart' },
      { text: 'Deploying', link: '/functions/deploying' },
      { text: 'Secrets', link: '/functions/secrets' },
      { text: 'Auth and calling Keel', link: '/functions/auth' },
      { text: 'Examples', link: '/functions/examples' },
      { text: 'Runtime and limits', link: '/functions/runtime' },
    ],
  },
  {
    text: 'Jobs and webhooks',
    collapsed: true,
    items: [
      { text: 'Scheduled jobs (cron)', link: '/database/cron' },
      { text: 'Webhooks and HTTP requests', link: '/database/webhooks' },
    ],
  },
  {
    text: 'Studio',
    collapsed: true,
    items: [
      { text: 'Studio tour', link: '/studio/tour' },
      { text: 'Accounts and sign-in', link: '/studio/accounts' },
      { text: 'SQL editor', link: '/studio/sql-editor' },
      { text: 'Defaults', link: '/studio/defaults' },
      { text: 'Logs and services', link: '/studio/logs' },
    ],
  },
];

const selfHosting: DefaultTheme.SidebarItem[] = [
  {
    text: 'Install',
    collapsed: true,
    items: [
      { text: 'Requirements', link: '/self-hosting/requirements' },
      { text: 'Choose a platform', link: '/self-hosting/platforms' },
      { text: 'Linux (Docker Compose)', link: '/self-hosting/docker' },
      { text: 'Windows', link: '/self-hosting/windows' },
      { text: 'macOS', link: '/self-hosting/macos' },
      { text: 'ZimaOS and CasaOS', link: '/self-hosting/zimaos' },
      { text: 'Unraid', link: '/self-hosting/unraid' },
      { text: 'TrueNAS SCALE', link: '/self-hosting/truenas' },
      { text: 'Synology', link: '/self-hosting/synology' },
    ],
  },
  {
    text: 'Network and remote access',
    collapsed: true,
    items: [
      { text: 'Internet access and HTTPS', link: '/self-hosting/remote-access' },
      { text: 'Cloudflare Tunnel', link: '/self-hosting/cloudflare-tunnel' },
    ],
  },
  {
    text: 'Operate',
    collapsed: true,
    items: [
      { text: 'Backups and disaster recovery', link: '/self-hosting/backups' },
      { text: 'Updating and rolling back', link: '/self-hosting/updating' },
      { text: 'Security checklist', link: '/self-hosting/security' },
      { text: 'Troubleshooting', link: '/self-hosting/troubleshooting' },
    ],
  },
];

const api: DefaultTheme.SidebarItem[] = [
  {
    text: 'Reference',
    collapsed: true,
    items: [
      { text: 'Configuration (.env)', link: '/self-hosting/configuration' },
      { text: 'keel CLI', link: '/self-hosting/cli' },
      { text: 'Limits', link: '/reference/limits' },
      { text: 'Architecture', link: '/reference/architecture' },
      { text: 'Glossary', link: '/reference/glossary' },
      { text: 'FAQ', link: '/reference/faq' },
    ],
  },
  {
    text: 'API reference',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/api/overview' },
      { text: 'REST (database)', link: '/api/rest' },
      { text: 'Auth', link: '/api/auth' },
      { text: 'Storage', link: '/api/storage' },
      { text: 'Realtime', link: '/api/realtime' },
      { text: 'Edge functions', link: '/api/functions' },
      { text: 'Errors', link: '/api/errors' },
    ],
  },
];

const sidebar: DefaultTheme.SidebarItem[] = [...guide, ...selfHosting, ...api];

export default defineConfig({
  title: 'Keel',
  titleTemplate: ':title · Keel Docs',
  description: DESCRIPTION,
  lang: 'en',
  base: BASE,
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['snippets/**', 'README.md'],
  // Pages mention http://localhost:3000 and friends as text; every other link is checked.
  ignoreDeadLinks: 'localhostLinks',
  head: [
    ['link', { rel: 'icon', href: `${BASE}favicon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#f0522e' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }],
    ['meta', { name: 'referrer', content: 'no-referrer' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Keel' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  ...(PUBLIC_URL ? { sitemap: { hostname: `${PUBLIC_URL}/` } } : {}),
  // Per-page title, description and canonical address for search engines and link previews.
  transformHead({ pageData, title, description }) {
    const head: HeadConfig[] = [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
    ];
    if (PUBLIC_URL) {
      const page = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
      const url = `${PUBLIC_URL}/${page}`;
      head.push(
        ['link', { rel: 'canonical', href: url }],
        ['meta', { property: 'og:url', content: url }],
        ['meta', { property: 'og:image', content: `${PUBLIC_URL}/og-image.png` }],
        ['meta', { property: 'og:image:width', content: '1200' }],
        ['meta', { property: 'og:image:height', content: '630' }],
        ['meta', { property: 'og:image:alt', content: 'Keel: your backend, on your own server' }],
      );
      if (pageData.relativePath === 'index.md') {
        const app = {
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'Keel',
          description: DESCRIPTION,
          url: `${PUBLIC_URL}/`,
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Linux, macOS, Windows',
          license: 'https://opensource.org/licenses/MIT',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        };
        head.push(['script', { type: 'application/ld+json' }, JSON.stringify(app)]);
      }
    }
    return head;
  },
  themeConfig: {
    logo: { src: '/logo-mark.svg', alt: '' },
    siteTitle: 'keel docs',
    nav: [
      { text: 'Guides', link: '/guide/introduction', activeMatch: '^/(guide|database|auth|storage|realtime|functions|studio)/' },
      { text: 'Self-hosting', link: '/self-hosting/requirements', activeMatch: '^/self-hosting/' },
      { text: 'API reference', link: '/api/overview', activeMatch: '^/(api|reference)/' },
    ],
    sidebar,
    search: {
      provider: 'local',
      options: {
        detailedView: 'auto',
        translations: {
          button: { buttonText: 'Search docs', buttonAriaLabel: 'Search the docs' },
          modal: { noResultsText: 'No results for', footer: { selectText: 'to open', navigateText: 'to move', closeText: 'to close' } },
        },
      },
    },
    // Only when the repository is named explicitly: an automatic name (Vercel,
    // Actions) may be a private repository that visitors can't open.
    ...(process.env.KEEL_SOURCE_REPO ? { socialLinks: [{ icon: 'github', link: `https://github.com/${REPO}`, ariaLabel: 'Keel on GitHub' }] } : {}),
    externalLinkIcon: true,
    returnToTopLabel: 'Back to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Appearance',
    notFound: {
      title: 'Page not found',
      quote: "That page isn't in the docs. It may have moved, or the link has a typo.",
      linkText: 'Back to the docs',
      linkLabel: 'Go to the docs home page',
    },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Keel is open source under the MIT license.',
      copyright: 'Runs on your own hardware. Speaks the Supabase APIs.',
    },
  },
  // Markdown copies of every page for coding agents (llms.txt and friends),
  // the files the installer downloads, and a last check for private links.
  async buildEnd(site) {
    await writeInstallFiles(path.resolve(site.srcDir, '..'), site.outDir);
    await writeLlmsFiles({
      srcDir: site.srcDir,
      outDir: site.outDir,
      intro:
        'Keel is a self-hosted backend that speaks the Supabase APIs: Postgres with an instant REST API, auth, file storage, realtime and edge functions, running on your own server with Docker. Apps use @supabase/supabase-js (or any Supabase client) with the API URL http://<server>:8000/<project> and the project\'s anon key.',
      sections: sectionsFrom([
        { prefix: '', items: guide },
        { prefix: 'Self-hosting', items: selfHosting },
        { prefix: '', items: api },
      ]),
    });
    await checkOutput(site.outDir);
  },
  // The local search index holds every page, so it's one large (lazy-loaded) chunk.
  vite: { build: { chunkSizeWarningLimit: 1200 } },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    image: { lazyLoading: true },
    // @@SITE@@ and @@IMAGES@@ in pages become the website address and image prefix.
    config: (md) => md.use(substitutePlugin),
  },
});
