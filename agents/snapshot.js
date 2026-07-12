// Manual snapshot: compute and persist today's net worth + DTI series row.
// agent-daily does this automatically once the baseline is locked; this command
// exists for on-demand runs and verification.
import 'dotenv/config';
import { openStore } from './lib/store.js';
import { snapshot, formatOutcome } from './lib/outcomes.js';

const db = openStore();
snapshot(db, { actor: 'snapshot-cli' })
  .then((outcome) => {
    console.log(formatOutcome(outcome));
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
