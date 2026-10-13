import crypto from 'node:crypto';

/**
 * Prints fresh secrets for a Keel .env (or a NAS app form), e.g.
 *   docker run --rm ghcr.io/<owner>/keel generate-env
 */
export async function main(): Promise<void> {
  const hex = (n: number) => crypto.randomBytes(n).toString('hex');
  const pw = crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, '').slice(0, 20);
  process.stdout.write(
    [
      `POSTGRES_PASSWORD=${hex(24)}`,
      `KEEL_SERVICE_PASSWORD=${hex(24)}`,
      `KEEL_SECRET=${hex(32)}`,
      `KEEL_FUNCTIONS_TOKEN=${hex(32)}`,
      `KEEL_DASHBOARD_PASSWORD=${pw}`,
      `IMGPROXY_KEY=${hex(32)}`,
      `IMGPROXY_SALT=${hex(32)}`,
      '',
    ].join('\n'),
  );
}
