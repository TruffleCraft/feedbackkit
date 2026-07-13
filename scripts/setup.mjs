#!/usr/bin/env node
// One-time bootstrap (full flow lands with P1 DX): creates D1/R2, asks for
// secrets (LLM key skippable), prints the build variables + URLs. For now it
// documents the manual steps honestly rather than pretending to automate them.
console.log(`FeedbackKit setup (foundation stub)

The automated bootstrap arrives with the P1 DX work. For now, manually:

  1. wrangler d1 create feedbackkit          # copy the database_id → FK_D1_ID
  2. wrangler r2 bucket create feedbackkit-uploads   # → FK_R2_BUCKET
  3. export CLOUDFLARE_ACCOUNT_ID=…  FK_D1_ID=…  FK_R2_BUCKET=feedbackkit-uploads
  4. wrangler secret put ADMIN_TOKEN
  5. wrangler secret put GITHUB_PAT_default   # fine-grained PAT: Issues R/W + Metadata (one owner!)
  6. wrangler secret put LLM_API_KEY          # optional — skip to run in "LLM off" mode
  7. pnpm deploy

Then open  https://<your-worker>/diag  to verify.`);
