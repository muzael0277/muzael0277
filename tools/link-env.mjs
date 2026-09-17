#!/usr/bin/env node
/**
 * One .env, several readers.
 *
 * The API and the Prisma CLI each load the nearest .env rather than the
 * workspace root's, so a naive setup ends up with three copies of the same
 * secrets drifting apart — and three places to forget when rotating one. This
 * links the consumers at the single root file instead.
 *
 * Run: pnpm setup:env
 */
import { existsSync, copyFileSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootEnv = join(root, '.env');

// Consumers that load their own nearest .env.
const consumers = [join(root, 'apps', 'api', '.env'), join(root, 'packages', 'database', '.env')];

if (!existsSync(rootEnv)) {
  copyFileSync(join(root, '.env.example'), rootEnv);
  console.log('created .env from .env.example');
  console.log('  → fill in JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and SECRETS_ENCRYPTION_KEY');
}

for (const target of consumers) {
  const shown = relative(root, target);

  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (resolve(dirname(target), readlinkSync(target)) === rootEnv) {
        console.log(`ok       ${shown}`);
        continue;
      }
      rmSync(target);
    } else {
      // A real file here is someone's deliberate override, or an old copy from
      // before this script existed. Either way, silently replacing a file that
      // may hold the only copy of a working secret is not ours to do.
      console.log(`skipped  ${shown} (real file, not a link — delete it to re-link)`);
      continue;
    }
  }

  symlinkSync(relative(dirname(target), rootEnv), target);
  console.log(`linked   ${shown} → .env`);
}
