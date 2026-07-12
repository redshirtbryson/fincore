// fincore.db backup (SPEC section 11): the outcomes store is irreplaceable, so it
// is backed up daily off this host. Uses better-sqlite3's online backup API (safe
// with WAL, no downtime), verifies the copy by opening it and running an integrity
// check, then rotates old copies. The Firefly database has its own backup script in
// firefly-stack/ since it lives on the LXC, not here.
//
// Config (.env):
//   FINCORE_BACKUP_DIR   destination directory (ideally a mount that leaves the host,
//                        e.g. NFS to the NAS). Unset = skip with a loud message.
//   FINCORE_BACKUP_KEEP  how many daily copies to keep (default 14).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './lib/store.js';
import { nyDateStr } from './lib/firefly.js';
import { sendHeartbeat } from './lib/discord.js';

const DIR = process.env.FINCORE_BACKUP_DIR || '';
const KEEP = Number(process.env.FINCORE_BACKUP_KEEP) > 0 ? Number(process.env.FINCORE_BACKUP_KEEP) : 14;

async function main() {
  if (!DIR) {
    throw new Error('FINCORE_BACKUP_DIR not set. The baseline is irreplaceable: set a destination off this host.');
  }
  // Deliberately no mkdir: the destination is expected to be a mount that leaves
  // this host. Creating it here would silently turn a dropped mount into local
  // "backups" that die with the machine.
  if (!fs.existsSync(DIR)) {
    throw new Error(`FINCORE_BACKUP_DIR ${DIR} does not exist. Is the backup mount down?`);
  }

  const db = openStore();
  const dest = path.join(DIR, `fincore-${nyDateStr()}.db`);
  const tmp = `${dest}.tmp`;

  try {
    await db.backup(tmp);

    // Verify before trusting: open the copy and check integrity and schema version.
    const copy = new Database(tmp, { readonly: true });
    const integrity = copy.pragma('integrity_check', { simple: true });
    const version = copy.pragma('user_version', { simple: true });
    copy.close();
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    if (version !== db.pragma('user_version', { simple: true })) {
      throw new Error('backup schema version does not match the live store');
    }

    fs.renameSync(tmp, dest); // atomic: a partial copy never sits under a valid name
    console.log(`backup ok: ${dest} (integrity ok, schema v${version})`);
  } finally {
    fs.rmSync(tmp, { force: true });
    db.close();
  }

  // Rotate: keep the newest KEEP dated copies.
  const copies = fs
    .readdirSync(DIR)
    .filter((f) => /^fincore-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of copies.slice(KEEP)) {
    fs.rmSync(path.join(DIR, old));
    console.log(`rotated out: ${old}`);
  }
}

main().catch(async (e) => {
  // A failed backup must reach a surface Bryson actually watches, not just the
  // PM2 log: the file being backed up is the one whose loss forfeits the ROI claim.
  console.error('backup FAILED:', e.message);
  try {
    await sendHeartbeat(`Fincore backup FAILED: ${e.message}`);
  } catch (_) {}
  process.exit(1);
});
