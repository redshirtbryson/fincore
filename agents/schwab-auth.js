// Interactive Schwab (re)authentication: loads .env, then hands off to the Python
// sidecar's login flow with stdio attached (it opens a browser for OAuth). Run
// weekly: Schwab refresh tokens expire every 7 days, and the daily heartbeat
// flags it when the token goes stale.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const venvPython = path.join(here, '..', 'schwab', '.venv', 'bin', 'python');
const pythonBin = process.env.SCHWAB_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3');
const script = path.join(here, '..', 'schwab', 'login.py');

if (!process.env.SCHWAB_APP_KEY || !process.env.SCHWAB_APP_SECRET) {
  console.error('SCHWAB_APP_KEY and SCHWAB_APP_SECRET must be set in .env first.');
  process.exit(1);
}

const r = spawnSync(pythonBin, [script], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
