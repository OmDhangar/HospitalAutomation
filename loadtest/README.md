# Load tests

Budgets and scenarios are in [the IPD sheets plan](../docs/plans/ipd-sheets-plan.md) §2.2 and §2.4.
Each phase adds its own scenario here (due board, escalation sweep, detector runs, family page) as it
ships, and must meet its budgets before rollout.

## Run

1. **A load database, never a real one.** The generator refuses any database not named `qurio_load*`
   or `qurio_scratch`. Create one beside your dev database, migrate it, and point both URLs at it:

   ```bash
   createdb -h localhost -U postgres qurio_load
   DATABASE_ADMIN_URL=postgres://postgres:…@localhost:5432/qurio_load npm run db:migrate:v2
   ```

2. **Synthetic data**: `tiny` on a laptop (seconds), `small` for a quick check (about 2 minutes,
   1.1 M bedside entries), `design` on staging hardware only (about 250 M entries; hours at the
   ~11k entries/s a laptop manages). The app role needs table grants in the new database:
   `DATABASE_ADMIN_URL=…/qurio_load npm run db:bootstrap`.

   ```bash
   DATABASE_ADMIN_URL=…/qurio_load npx tsx scripts/synth/generate.ts --profile small
   ```

   It writes `loadtest/.sessions.json` (git-ignored): a session token for one owner and one nurse per
   synthetic hospital, plus current admission and medicine ids. The tokens work only in that database.

3. **Start the app against the same database** (`DATABASE_URL=…/qurio_load`), ideally as a production
   build (`npm run build && npm start`), then run a scenario with [k6](https://k6.io/docs/get-started/installation/):

   ```bash
   k6 run loadtest/shift-change.js
   k6 run -e BASE_URL=https://staging.example -e NURSES=400 loadtest/shift-change.js
   ```

   k6 exits non-zero when a threshold (the §2.2 budget) fails. Save the summary with
   `--summary-export loadtest/results/<scenario>-<date>.json` and attach it to the phase's PR.

## Scenarios

| File | What it models | Budgets checked |
|---|---|---|
| `shift-change.js` | 8 am peak: nurses post bedside entries while census pages refresh every 15 s | write p95 ≤ 250 ms, p99 ≤ 600 ms; page p95 ≤ 400 ms, p99 ≤ 1 s; < 0.1% errors |
