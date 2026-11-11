# Evidence: moving a Cloudflare gateway into the standalone server (journey J19)

Run on 2026-11-11 on a developer Mac with Node 26.12 and wrangler 4.136.3. No Cloudflare account was involved: D1 and R2 were the local ones that `wrangler dev --local` keeps in `.wrangler/state`, and every row and file is fictional. The same flow runs as `test/server-migrate-e2e.test.mjs`.

## What the Worker held

A Worker, started with `wrangler dev --local`, was filled through its own HTTP API:

- Two projects. `harborline` delivers to the local inbox and stores attachments in R2. `pantry-planner` delivers to GitHub issues and has no token, so its one report ended as `issue_failed`.
- Six reports for `harborline` (five from the widget API and one test report), two of them with an attachment: a 180 kB file with a PNG signature and a 60 kB file with a WebP signature, both random bytes.
- A settings revision (`harborline` at version 2), one report marked done with a note, one dismissed, and four funnel events.

## Export, with the real wrangler

```
Reading D1 database "feedbackkit" (local). A remote export briefly blocks requests to that database, so run it when the gateway is quiet.
D1: schema 4, 2 projects, 7 feedback, 2 assets, 4 events, 6 dedup.
Downloading 2 attachments from bucket "fk-local-bucket"...
Attachments: 2 downloaded (234.4 kB).
```

The bucket name came from `wrangler.toml`. `wrangler d1 export --local` wrote plain SQL: `PRAGMA defer_foreign_keys=TRUE`, `CREATE TABLE`, one `INSERT` per row, `sqlite_sequence`, the indexes, and wrangler's own `d1_migrations` table. SQLite loads it as it is. `wrangler d1 export` has no `--persist-to`, so it reads the state next to the config file.

## Dry run and import

```
Source: schema 4, delivery capability 3.
Moves: 2 projects, 7 feedback, 2 assets, 4 events, 6 dedup; 2 attachments (234.4 kB).
Stays behind: counters (rate limits and the daily AI budget), d1_migrations.
Set these on the new host, they are not in D1: ADMIN_TOKEN, GITHUB_PAT_pantry.
Dry run: <data dir>/feedbackkit.sqlite is empty. Nothing was written.
```

The dry run created no data directory. The import then wrote `feedbackkit.sqlite` (mode 600, directory mode 700) and printed the same lines, then `Imported into ... and checked: row counts and checksums of every table, and the checksum of every attachment.`

## The standalone server on the result

`scripts/server.mjs` was started on that data directory and asked as the admin:

| Question | Answer |
|---|---|
| `/diag` | schema ok, at version 4 |
| Projects and public keys | `harborline` `fk_pub_4ab1d747...` at settings revision 2, `pantry-planner` `fk_pub_a645293a...` at 1: the keys the Worker had |
| `/api/config?project=<old key>` | `theme: dark`, `accent: #7c3aed`, `heading: Tell us what happened`: the widget config an embedded snippet loads |
| Inbox of `harborline` | six reports: one done with its note, one dismissed, the test report marked as a test, three open, all `delivery: local` |
| The two attachments | `/admin/assets/<key>` answered 200 with `image/png` (180,008 bytes) and `image/webp` (60,012 bytes) |
| `pantry-planner` | `issue_failed`, delivery state `failed`, retryable |
| System page data | the GitHub token shows as missing, as expected: secrets are not in D1 |

The automated test goes further: it reads the answers of the Worker before it stops and requires that the standalone server returns exactly the same project list, the same stored settings, the same report lists (delivery state, error, disposition, note, attachments), the same funnel and the same public config, and that both attachments download byte for byte.

## Refusals, as run

A second import into the same directory:

```
Refused: <data dir>/feedbackkit.sqlite already holds data (projects, feedback, assets, _fk_objects). Import into an empty data directory, or pass --replace-existing to replace it (a copy of the old database is kept next to it).
```

An export with one line appended to `d1.sql`:

```
Refused: d1.sql does not match the checksum in manifest.json. The export is damaged or was edited.
```

Both exit with code 2, and the second created no data directory. `--replace-existing --dry-run` said that the directory holds data and would be replaced with a copy kept, and wrote nothing. The unit tests cover the other refusals: a newer schema, a newer delivery capability, an edited attachment, a missing attachment, an image whose bytes do not match its name, a key with a path in it, an unknown manifest format, and an attachment that the database lists but the export does not account for.

## What this does not cover

- A remote export. `wrangler d1 export --remote` and `wrangler r2 object get --remote` were not run, because the tests never touch a Cloudflare account. The import works from plain SQL, and Cloudflare documents the remote export as a `.sql` file too, so a remote dump of the same schema should load the same way. Run `--dry-run` on a real export first.
- Size. The run moved two attachments and 21 rows. Attachments download one `wrangler` call each, four at a time, so a gateway with thousands of them takes minutes.
- The cut-over on a live gateway: reports sent to Cloudflare after the export are not in it.

Co-created by Michel with NORA (AI Agent)
