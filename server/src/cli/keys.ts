import { config } from '../lib/config.js';
import { waitForDb } from '../lib/db.js';
import { DEFAULT_KEY_GRACE_HOURS, keyGraceHours, listKeys, revokeOldKeys, rollKeys } from '../lib/projects.js';

/**
 * Project API keys from the server's command line:
 *
 *   keel keys list <project>
 *   keel keys roll <project> [--grace HOURS]       (old keys verify for 24 hours by default)
 *   keel keys roll <project> --emergency --yes     (old keys stop now; every user signs in again)
 *   keel keys revoke-old <project>                 (end the grace period now)
 */

const out = (s: string) => process.stdout.write(s + '\n');
const fail = (s: string): never => {
  process.stderr.write(`keel: ${s}\n`);
  process.exit(1);
};

const USAGE = 'usage: keel keys <list|roll|revoke-old> <project> [--grace HOURS] [--emergency --yes]';

export function parseKeysArgs(argv: string[]) {
  const positional: string[] = [];
  let grace: string | undefined;
  let emergency = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grace') grace = argv[++i];
    else if (a.startsWith('--grace=')) grace = a.slice('--grace='.length);
    else if (a === '--emergency') emergency = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else positional.push(a);
  }
  return { cmd: positional[0], project: positional[1], grace, emergency, yes };
}

export async function main(): Promise<void> {
  let args: ReturnType<typeof parseKeysArgs>;
  try {
    args = parseKeysArgs(process.argv.slice(3));
  } catch (err) {
    return fail((err as Error).message);
  }
  const { cmd, project, grace, emergency, yes } = args;
  if (!cmd || !project || !['list', 'roll', 'revoke-old'].includes(cmd)) fail(USAGE);

  await waitForDb(config.db.controlDb, config.db.superuser, 30_000);
  switch (cmd) {
    case 'list': {
      const { keys, events } = await listKeys(project);
      if (!keys.length) fail(`project "${project}" not found`);
      for (const k of keys) {
        const state = k.current ? 'signing' : k.expiresAt ? `verifies until ${k.expiresAt}` : 'verifies';
        out(`${k.kid.padEnd(14)} ${state.padEnd(40)} created ${k.createdAt}`);
      }
      if (events.length) out('');
      for (const e of events.slice(0, 10)) out(`${e.createdAt}  ${e.action.padEnd(15)} ${(e.kid || '').padEnd(14)} ${e.actor}`);
      return;
    }
    case 'roll': {
      if (emergency && !yes) fail('an emergency roll stops the old keys at once and signs every user out; add --yes to go ahead');
      if (emergency && grace !== undefined) fail('--grace and --emergency don\'t go together');
      let hours = DEFAULT_KEY_GRACE_HOURS;
      if (!emergency) {
        try {
          hours = keyGraceHours(grace);
        } catch (err) {
          fail((err as Error).message);
        }
      }
      const r = await rollKeys(project, { emergency, graceHours: hours, actor: 'cli' });
      out(`New signing key ${r.kid}.`);
      if (emergency) out(`Old keys stopped working (${r.revoked.join(', ') || 'none'}); ${r.endedSessions} user session(s) ended.`);
      else out(`Old keys keep working for ${hours} hour(s); end that early with: keel keys revoke-old ${project}`);
      out('');
      out(`anon key:         ${r.anonKey}`);
      out(`service role key: ${r.serviceKey}`);
      out('');
      out('Put the new keys in your apps (Studio > Connect shows them too). Keep the service role key secret.');
      return;
    }
    case 'revoke-old': {
      const { revoked } = await revokeOldKeys(project, 'cli');
      out(revoked.length ? `Old keys stopped working: ${revoked.join(', ')}.` : 'No old keys were active.');
      return;
    }
  }
}
