# Architecture Decision Records

Ein Absatz pro Entscheidung, inkl. verworfener Alternative. Neue Beschlüsse kommen aus [`decision`-Issues](../../issues?q=is%3Aissue+label%3Adecision) hierher.

## ADR-001 · 2026-07-13 · Name „feedbackkit" (Arbeitsname, Rename-Fenster bis Announce)

Repo heißt `TruffleCraft/feedbackkit`. npm-Bare-Name und GitHub-User `feedbackkit` sind extern vergeben (Branding-Kollision beim Public-Announce möglich); `feedbridge` wäre überall frei. Da v1 weder npm noch Domain braucht (self-hosted, Script-Tag), bleibt der etablierte Arbeitsname — Rename ist bis zum Announce gratis und danach teuer. Finale Namensentscheidung: Decision-Issue #9 vor P2-Exit.

## ADR-002 · 2026-07-13 · Seed-JSON-Config in P1, Admin-UI komplett in P2 (UC1)

P1 konfiguriert per Zod-validierter Seed-JSON (identisches Schema wie der spätere Admin-Config-Import — kein Wegwerf-Artefakt); die SCTT-Migration wird P1-Exit-Kriterium (Konsolidierung = Primärziel zuerst). Verworfen: Minimal-Admin im MVP (+3–4 PT, ADMIN_TOKEN-Fläche im kritischen Pfad, Operator-Population in P1 = 1). Das Admin-Erlebnis (Michels Produktvision) kommt vollständig und gehärtet in P2.

## ADR-003 · 2026-07-13 · P4-Provider demand-gated; Webhook-Sink als universeller Zwischenschritt (UC2)

GitLab→Jira→Trello starten erst, wenn ≥1 externer Operator einen zweiten Provider nachfragt. Bis dahin deckt ein normalisierter JSON-Webhook-Sink (P2, ~1 PT) via n8n/Zapier/Actions jedes Tool ab. Verworfen: P4 als festes Kalender-Commitment (12–17 PT Adapter-Pflege vor Buyer-Klarheit).

## ADR-004 · 2026-07-13 · wrangler.template.toml-Invariante (Fork-Update-Pfad)

Repo committet nur `wrangler.template.toml`; die echte `wrangler.toml` (operator-spezifische database_id/Bucket) ist gitignored und wird von `pnpm deploy` aus Build-Variablen generiert. Verworfen: echte wrangler.toml im Repo (hätte „Sync fork = konfliktfrei" gebrochen, da Upstream die Datei regelmäßig ändert — Cron-Triggers, compatibility_date).

## ADR-005 · 2026-07-13 · Extract-then-Form statt Multi-Turn-Chat (übernommen aus Review 2026-07-08)

EIN LLM-Call extrahiert gegen per-Type-Pflichtfelder; Fehlendes wird als vorbefüllte Formularfelder nachgereicht; der zweite POST ist deterministisch (Server re-validiert, re-derived Titel — kein Client-Trust). Verworfen: Multi-Turn-Chat-Loop (turnToken-Protokoll, unbegrenzte LLM-Kosten, größtes UX-Risiko; bleibt Backlog falls Daten Bedarf zeigen).

## ADR-006 · 2026-07-13 · R2 mit App-Level-Retention statt BugDrop-Orphan-Branch

Screenshots/Anhänge liegen in R2 (unguessbare Keys, per-Projekt-Prefix, `assets`-Tabelle mit expires_at + Cron-Delete + admin-authed Delete-Endpoint). Verworfen: BugDrops Orphan-Branch im Ziel-Repo (Bilder in Git-Historie praktisch unlöschbar — DSGVO; Repo-Bloat; GitHub-only) und R2-Lifecycle-Regeln als Retention-Mechanik (Bucket-Level, per-Projekt nicht steuerbar). Bekanntes Restrisiko: GitHubs camo-Proxy cached Inline-Bilder — dokumentiert in SECURITY.md, Issue-Edit ist Teil des Löschprozesses.

## ADR-007 · 2026-07-13 · OpenAI-kompatibler LLM-Client als Architektur-Invariante

Ein Client (konfigurierbare baseUrl+model+apiKey) deckt OpenRouter (Default), LiteLLM, Ollama, vLLM und lokale Modelle ab. Verworfen: Provider-spezifische LLM-Adapter (unnötige Fläche; OpenAI-kompatibel ist der De-facto-Standard).
