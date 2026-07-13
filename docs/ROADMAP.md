# FeedbackKit — Entwicklungs-Fahrplan

> **Status:** Entwurf zur Team-Diskussion · konsolidiert nach 2× /autoplan-Review (Cross-Model, 2026-07-08/13) · Single-Source-Regel: **Epics sind die lebende Wahrheit**, dieses Dokument wird an Phase-Exits aktualisiert.
> Offene Entscheidungen: siehe Issues mit Label [`decision`](../../issues?q=is%3Aissue+label%3Adecision).

## Das Problem

User geben gern Feedback — aber sie wissen oft nicht *wie*, nutzen verschiedene Kanäle und liefern unvollständige Meldungen. Gerade Nicht-Techniker sind frustriert, wenn Devs/PMs/Testmanager zurückfragen, weil Details fehlen; Devs verbrennen Zeit damit, Feedback erst zu *verstehen*. **FeedbackKit verkürzt diese Loops:** Betreiber definieren die Projekt-Anforderungen vorab; User geben schnell Feedback; das LLM strukturiert das Unstrukturierte und stellt Rückfragen, wenn etwas fehlt — **bevor** das Issue zum Dev-Team geht.

## Positionierung — „Complete at the source"

Der verteidigbare Kern ist NICHT „LLM formatiert Issues" (kommoditisierbar — BugDrop hat inzwischen Annotationen + GitHub-App, Marker.io hat AI-Features, Copilot bewegt sich Richtung Issue-to-PR). Der Moat ist die **Kombination**:

1. **Synchrone LLM-Rückfrage im Moment des Feedbacks** — der User ist noch auf der Seite; Post-hoc-Triage kann fehlende Infos nie rekonstruieren.
2. **Session-Kontext automatisch** — Browser, OS, Viewport, Console-Errors, URL, Screenshot (mit Vision-Extraktion).
3. **Privacy-first** — self-hosted, kein Session-Replay, keine Surveillance, local-LLM-fähig, Kill-Switch „LLM aus".
4. **Agent-ready Issues** — strukturiert genug, dass Coding-Agents direkt damit arbeiten können.

**Primärziel:** Konsolidierung der zwei bestehenden Implementierungen (SCTT, VOS) auf eine kanonische Codebasis (Drift = 0). **Sekundärziel:** OSS-Adoption (eigenes Announce-Gate + Kill-Kriterium).

## Ziel-Architektur

```
  Website des Betreibers                          FeedbackKit Gateway (self-hosted,
  (beliebiger Stack, auch React/Next)             EIN `pnpm deploy`)
 ┌───────────────────────────────┐               ┌──────────────────────────────────────────┐
 │ <script                       │               │        Cloudflare Worker (Hono)          │
 │   src="https://fb.acme.dev/   │  GET /widget.js──►  Loader (short-TTL) + Hash-Chunks     │
 │        widget.js"             │               │     (immutable, dynamic import)          │
 │   data-project="fk_pub_x7q2"> │  GET /api/config (no-store/ETag, public projection)      │
 │  ┌─────────────────────────┐  │◄──────────────┤                                          │
 │  │  Widget (Shadow DOM,    │  │  POST /api/feedback  (wire contract v:1, 2-POST)        │
 │  │  vanilla TS)            ├──┼──────────────►│  validate → rate-limit → dedupe →        │
 │  │  • Type-Picker+Freitext │  │  need_fields  │  LLM-Extract (1 Call) → create           │
 │  │  • Rückfrage-Felder     │◄─┼───────────────┤                                          │
 │  │    (LLM-vorbefüllt)     │  │  POST /api/upload · POST /api/events (Enum-only)         │
 │  │  • Screenshot-Capture   │  │  GET /t/<key> (Testseite, Dry-Run) · GET /diag           │
 │  │  • Console-Buffer (PII) │  │  GET /admin + /api/admin/* (ab P2)                       │
 │  └─────────────────────────┘  │               └───┬──────────┬──────────┬────────────────┘
 └───────────────────────────────┘                   │          │          │
                                          ┌──────────▼─┐ ┌──────▼──────┐ ┌─▼──────────────────┐
  Betreiber: P1 Seed-JSON-Config,         │  D1        │ │ LLM-Endpoint│ │ GitHub REST/GraphQL│
  ab P2 Admin-UI (Wizard, Projekt-CRUD,   │ projects,  │ │ OpenAI-komp.│ │ • Issues (REST),   │
  Feld-Editor, Feedback-Verlauf+Funnel,   │ counters,  │ │ OpenRouter→ │ │   Anhänge inline   │
  Theming, Snippet mit Live-Status)       │ events,    │ │ LiteLLM/    │ │   via R2-URL       │
                                          │ assets,    │ │ Ollama (P5) │ │ • Projects v2 (P3) │
                                          │ dedup      │ │ multimodal+ │ │ GitLab/Jira/Trello │
                                          └────────────┘ │ Budget-Cap  │ │ (P4, gated)        │
                                          ┌────────────┐ └─────────────┘ └────────────────────┘
                                          │ R2 (free   │  Attachments: unguessbare URLs,
                                          │ tier)      │  App-Level-Retention + Delete
                                          └────────────┘
```

## Architektur-Invarianten (gelten ab P1)

1. **Zero-Touch-Code:** Betreiber editieren nie Repo-Dateien. Repo committet nur `wrangler.template.toml`; die echte `wrangler.toml` ist gitignored und wird von `pnpm deploy` aus Variablen generiert (`CLOUDFLARE_ACCOUNT_ID`, `FK_D1_ID`, `FK_R2_BUCKET` — als Workers-Builds-Build-Variablen). Fork bleibt commit-identisch mit Upstream → **„Sync fork" = konfliktfreies Update**.
2. **Auto-Migrationen:** `pnpm deploy` = `build:widget && build:admin && wrangler d1 migrations apply --remote && wrangler deploy`. Worker prüft beim Boot `schema_version` (→ `/diag` rot statt kryptisch). Migrationen expand/contract (eine Release-Breite abwärtskompatibel). Rollback = Fork auf Tag pinnen + `pnpm deploy`, nie D1-Rollback.
3. **LLM-Client = OpenAI-kompatible Chat Completions** mit konfigurierbarer `baseUrl`+`model`+`apiKey` — OpenRouter ist nur der Default; LiteLLM/Ollama/vLLM/lokale Modelle brauchen keinen neuen Client. Kill-Switch „LLM aus" pro Projekt (reine Pflichtfeld-Formulare) ab P1.
4. **Snippet = exakt 2 Attribute** (`src` + `data-project`) — alle Config kommt aus `/api/config`, das Snippet wird nie stale.
5. **Create-anyway:** Kein Ausfall (LLM, D1, Provider) darf Feedback verlieren. LLM-Fehler → Issue unangereichert (`ai-failed`); D1-Fehler → Issue trotzdem (`d1-degraded`); Provider-Fehler → Payload persistiert + `issue_failed` + Retry im Admin.
6. **Privacy:** `data_collection:deny` beim LLM; Funnel-Events sind Enum-only (nie Inhalt, nie IP persistiert); R2-Assets mit App-Level-Retention + Delete-Endpoint (DSGVO Art. 17; camo-Restrisiko dokumentiert); README-Absatz „Was das Widget misst".
7. **Semver-Releases** + CHANGELOG + Update-Banner im Admin (ab P2); `VERSION` in `/diag`.

## Phasen

**Committed sind P0–P2.** P3–P5 sind deklarierte Richtung mit Outcome-Gates — sie starten nur, wenn ihr Gate wahr ist (Epics tragen Label `gated`).

### P0 — Validierungs-Spike (1–2 Tage) · [Epic #P0]

Kernthese „LLM-Rückfragen verkürzen Loops" mit Daten prüfen, **bevor** gebaut wird: bestehende SCTT-Feedbacks (11+ Issues) + VOS-Alt-Feedbacks durch einen Wegwerf-Extract-Prototyp (1 Datei, OpenRouter). Messen: Extraktionsqualität, welche Felder wirklich fehlen, p90-Latenz (Text vs. multimodal), Kosten/Report. Nebenprodukt = Eval-Fixtures für P1. Plus 0,5 PT **BugDrop-Fork-Check** (was ist als Code importierbar?) → docs/DECISIONS.md.
**Exit:** Eval-Baseline dokumentiert; p90 < 8 s erreichbar; Go/No-Go für Vision-im-Call.

### P1 — MVP „unstrukturiertes Feedback → strukturiertes GitHub Issue" (16–22 PT · AI 6–8 Tage)

**Ziel:** Operator deployt Gateway mit Seed-Config, klebt Snippet in die Seite → User rantet Freitext + Screenshot, LLM strukturiert (inkl. Vision) + fragt Fehlendes nach → vollständiges Issue. **SCTT läuft produktiv drauf (P1-Exit).**

**IN:**
- Ein-Worker-Deploy (Hono + D1 + Assets); Invarianten 1–6 komplett
- **Vanilla-Widget** (Shadow DOM): Trigger, Type-Picker (optional, LLM klassifiziert sonst) + Freitext, Screenshot (html-to-image, Fidelity-Spike als ERSTE Aufgabe inkl. Browser-Matrix + Cross-Origin-Bilder), Auto-Kontext (DeviceInfo, URL, Console-Buffer mit PII-Filter)
- **Vanilla-Invarianten:** `shadowRoot.activeElement`-Focus (Initial-Focus + Restore in P1), persistente aria-live-Region, Host an `document.body` + `100dvh` + Scroll-Lock, **Re-Render-Verbot** für Formular-Subtrees; E2E „feindliche Host-Seite" + „Tippen überlebt Validierung"
- **LLM-Extract-then-Form:** 1 Call (multimodal, Screenshot ~800px). **Strukturierte Ausgabe erzwungen:** Template-Zod-Schema → JSON-Schema, dem LLM als `response_format: json_schema` bzw. via Function-Calling übergeben (verhindert halluzinierte Felder/ignorierte required-Flags). **Schema-Enforcement ist best-effort** (Ollama/vLLM in P5 können es unterschiedlich gut) — der harte Gate ist die **serverseitige Zod-Validierung** der LLM-Antwort. Bei Invalid-JSON/Refusal greift der Fallback **sofort und nahtlos** (reines Freitext-/Pflichtfeld-Formular, kein Retry-Loop, der den User in der Ladeschleife fängt). Flow: `need_fields` → `extracting` (nach 4 s wird „Jetzt senden" **primärer Button**; 15 s Hard-Timeout) → `completing_fields` (alle Pflichtfelder, Extrahiertes vorbefüllt+editierbar+markiert; „Trotzdem senden"-Textlink; Close = auto-Trotzdem via keepalive; Feld-Ceiling >3 → direkt accepted_incomplete); 2. POST deterministisch, Server re-validiert + re-derived Titel
- **Create-anyway-Matrix** inkl. D1-degraded-Zeile + `issue_failed`-Terminal-State (Payload persistiert, Retry ab P2 im Admin); LLM-Tagesbudget-Cap; Not-Kill-Switch
- **Seed-JSON-Config** (Zod-validiert; Schema = P2-Import-Format): Types Bug/Idea/Improvement **vorkonfiguriert** mit Feldern + Hints (`required` vs. `nice-to-extract`), Origins, Theming-Tokens
- GitHub via **N benannte fine-grained-PAT-Secrets** (`GITHUB_PAT_<name>`; Ein-Owner-Grenze dokumentiert; Projekt-Anlage validiert Repo-Zugriff); Issue-Template + Labels; Anhänge inline (R2-URLs)
- **R2 ab MVP** mit App-Level-Retention (`assets`-Tabelle + Cron-Delete) + admin-authed Delete-Endpoint
- **Feedback-Journey-Datenschicht** (Event-Taxonomie `received→…→issue_created|issue_failed|ai-failed`, Correlation-ID, 90-Tage-Rollups) + `/api/events` (Enum-only, Sampling, server-derived `abandoned`) — **Completion-Funnel ist die Kern-KPI**
- Hardening-Baseline: **anchored Origin-Regex** (`^https://…$`, Punkte escaped, Wildcard-Subdomain `*` auf `[^./]+` begrenzt — VOS-Bug nicht kopieren!) mit **bounded-TTL-Isolate-Cache der Origin-Allowlist (≤60 s, keyed auf config-version-Row)** statt D1-Read pro Feedback-POST (Hot-Path-Durchsatz; 60 s Propagation beim Origin-Add ist unkritisch), Honeypot, Length-Caps, serverseitige Type-Validierung, per-IP-Rate-Limit (atomarer D1-Upsert), Upload-Allowlist + Magic-Byte + Caps, benannte Fehlerklassen, CORS reflektiert (nie `*` auf APIs)
- **DX:** `pnpm setup` (idempotent, LLM-Key überspringbar → Modus „LLM noch nicht konfiguriert", ADMIN_TOKEN generiert, druckt URLs), `pnpm dev` (lokale D1/R2, Mock-LLM/GitHub, Seed), `pnpm test-issue`, `/diag` (LLM-Ping, PAT je Projekt + Ablaufdatum, D1-Schreibpfad, R2-Roundtrip, schema_version), Testseite `/t/<key>` (**Dry-Run-Default**), wörtliche Fehler-Copy (Top 5), `console.warn` + `?fkdebug=1` im Widget, secret-freie CI, Bundle-Gate ≤10 kB gz (Loader+Trigger)
- Docs ab Tag 1: README, QUICKSTART (PAT-Rezept, Reihenfolge „erst lokal setup, dann Fork verbinden"), SECURITY.md (Screenshot-PII, camo), CONTRIBUTING

**OUT:** Admin-UI (→ P2), Annotation (→ P2), GitHub-App (→ P2), Theming-Editor (Tokens via Seed-Config), Board-Felder, i18n, Duplikat-Erkennung, alles außer GitHub.

**Exit:** Playwright-E2E grün (happy + need_fields + alle Degrade-Pfade mit Mocks) · `/diag` grün auf frischem Deploy · Fork→Sync→Migration-Realtest (inkl. wrangler.template.toml-Änderung) · **SCTT 1 Woche produktiv** · Funnel-Daten fließen · p90 < 8 s · Security-Checkliste als CI-Gate. **→ Drift = 0 für den ersten Konsumenten.**

### P2 — Admin-UI, Annotation & Onboarding (15–20 PT · AI 6–7 Tage)

**Ziel:** Das Gateway-Backend wird erlebbar; Fremde schaffen die Installation ohne Support; Widget bekommt Annotation.

**IN:**
- **Admin-UI komplett:** 3-Screen-IA (Token-Login → Projektliste mit Zero-State-Create-Flow → Projektdetail-Tabs Setup/Snippet · Types & Felder · Theming · Feedback-Verlauf); Instanz-Seite „System" (read-only: /diag, PAT-Status, Budget-Gauge, Version); First-Run-Wizard; **Feld-Editor** (Presets editieren, geführte Hint-Eingaben „beschreibe es wie einem Kollegen", **Probelauf-Button**, Ceiling-Warnung >3, Extraktions-Statistik pro Feld); **Feedback-Verlauf-Ansicht + Funnel-Dashboard** (opened→…→issue_created, Timeout-/Trotzdem-Zähler) + Retry-Button für `issue_failed`; **Snippet-Screen** („Letzter Config-Abruf vor 2 min", Origin-Rejects mit One-Click-Add, CSP-Hinweise); ADMIN_TOKEN-Härtung (Auth-Header, constant-time, 401-Rate-Limit, CSP, Cloudflare-Access-Empfehlung)
- **Config-Import/Export** (Seed-JSON aus P1 nahtlos einlesen)
- **Annotation-Overlay** (rect/arrow/text/freehand — VOS-Port nach Canvas im Shadow DOM; SCTT bekommt sein Feature zurück)
- **GitHub-App via Manifest-Flow** (App-Auth-1-Pager: state-Binding, atomarer Persist + Rollback, PKCS#1→#8-Util, Installation-Token-Cache; Credentials in D1 mit Envelope `keyVersion‖iv‖ciphertext‖tag` + AAD, KEK-Rotation lazy; PAT bleibt Fallback)
- **Theming-Editor** (8 Tokens, Color-Picker, echtes Widget-Bundle als iframe-Preview mit State-Switcher, Kontrast-Validierung, Default-Theme first)
- **Webhook-Sink** (~1 PT: normalisierter JSON-POST pro Feedback → n8n/Zapier/Actions binden JEDES Tool an). **HMAC-SHA256-Signatur ab Tag 1** (pro-Projekt-Secret, `X-FeedbackKit-Signature: sha256=…`-Header + Timestamp gegen Replay) — ohne Signatur ist der Sink ein offenes Scheunentor für gefälschte Events.
- Update-Story komplett (Release-Pipeline, Update-Banner, UPGRADING.md) · Degrade-Canary (+ Board-Skip-Zählung ab P3) · SELF_HOSTING.md · budget-gecappte **Demo-Instanz**

**Exit:** TTHW ≤ 15 min (CF-Bestandskunde) / ≤ 45 min (cold) im Fremdtest · Annotation auf iOS Safari · SCTT nutzt Admin statt Seed-File · Canary grün. **→ Announce** („v0.x, GitHub-only") mit Messgröße: ≥ 3 externe Deploys oder ≥ 5 externe Issues/PRs in 4 Wochen, sonst bewusst Maintenance-Modus.

### P3 — Widget deluxe + GitHub-Vollausbau (9–13 PT) · `gated`

**Gate:** SCTT läuft 2+ Wochen UND Completion-KPI zeigt, dass der Rückfrage-Loop trägt.
**IN:** Datei-Attachments (PDF/Log/Text) · Draft-Persistence · volle a11y (axe) · i18n de/en · **GitHub Projects v2 Board-Felder** (VOS-Port, by-name + Cache, create-anyway) · Trusted-Submitter-Hook · **Migration VOS**.
**Exit:** VOS produktiv, alter Worker archiviert · axe ohne Criticals.

### P4 — Provider-Ökosystem (12–17 PT) · `gated`

**Gate:** ≥ 1 externer Operator fragt nach einem zweiten Provider (bis dahin: Webhook-Sink).
**IN:** ProviderPort härten · **GitLab** (erster Adapter — API nah an GitHub, Privacy-Zielgruppe) · **Jira Cloud** · **Trello** · AssetStore-Strategie pro Provider (native Attachments) · Provider-Wahl pro Projekt im Admin.
**Exit:** Gleiches Feedback wahlweise in GitHub/GitLab/Jira/Trello, E2E pro Adapter · Adapter-Guide.

### P5 — LLM-Ausbau + lokale Modelle (6–9 PT) · `gated`

**Gate:** LLM-Kern-KPIs stabil (Completion-Rate, ai-failed-Rate).
**IN:** **Custom-LLM-Endpoints im Admin** (LiteLLM-Proxy-Rezept als empfohlener Privacy-Pfad, Ollama/vLLM direkt, Cloudflare-Tunnel-Hinweis, Vision-Degrade-Flag, Connectivity-Test in `/diag`, „Vollständig lokal"-Rezept: self-hosted GitLab + lokales LLM) · Duplikat-Hinweis · annotations-bewusste Extraktion · `promptPreamble` pro Projekt · Eval-Suite als Regression-Gate · Modell-Wahl pro Projekt.
**Exit:** E2E gegen LiteLLM-Endpoint · Modellwechsel ohne Qualitätsregression nachweisbar.

### Backlog (bewusst ohne Phase)

React-Wrapper-Package · Session-Recordings · Slack/E-Mail-Notifications · **Node/SQLite-Runtime** (Docker-Checkpoint: fragen ≥ N Externe nach Docker → zieht vor) · Gitea · Hosted-Angebot · Multi-Turn-Chat-Rückfragen (nur falls Extract-then-Form-Daten Bedarf zeigen) · signierte R2-URLs/private Bucket.

**Gesamt:** P0–P2 committed ≈ 33–45 PT (AI: ~3–4 Wochen) · P3–P5 gated ≈ +27–39 PT.

## KPIs

- **Completion-Rate** (Rückfrage ausgefüllt vs. „Trotzdem senden" vs. Abbruch) — validiert die Kernthese
- ai-failed-Rate + degrade-Gründe · p90-Extraktionslatenz (< 8 s) · TTHW pro Persona · Announce-Messgröße (P2-Exit)

## Risiken (Top 6)

| Risiko | Schwere | Mitigation |
|---|---|---|
| Rückfragen nerven statt helfen (Loop-UX = DAS Produktrisiko) | hoch | P0-Spike vor Build; Feld-Ceiling; „Jetzt senden" primär im Wartezustand; Completion-Funnel als KPI |
| LLM-Kosten-Abuse (öffentlicher Endpoint + in-request LLM) | hoch | 1-Call-Design, Tagesbudget-Cap, Rate-Limit, Honeypot, /t-Dry-Run; Provider-Spend-Limit in QUICKSTART |
| Vanilla-Port unterschätzt (State-Machine, Shadow DOM, iOS) | hoch | 4 Vanilla-Invarianten spezifiziert; Fidelity-Spike zuerst; Annotation strikt P2 |
| Security-Regression durch Code-Reuse (VOS-Origin-Bug beweist es) | hoch | Hardening als CI-Gate + Testfall pro Finding |
| Update-Pfad bricht (Sync-fork ohne Migration / wrangler.toml-Konflikt) | hoch → mitigiert | wrangler.template.toml-Invariante; pnpm-deploy-Contract; Realtest in P1 |
| AI-generierter Code ohne Review-Netz (Solo-Builder) | hoch | Playwright-E2E ab P1, Canary ab P2, /diag, secret-freie CI für Fork-PRs |

## Was existiert schon (Reuse)

| Quelle | Wird zu |
|---|---|
| `MiMoVentures/vos-bench/workers/feedback/src/github.ts` | GitHub-Provider (Issues P1, Board P3) |
| `…/llm.ts` | OpenAI-kompatibler LLM-Client + Vision-Muster |
| `…/templates.ts`, `registry.ts`, `auth.ts` (Origin-Fix!) | Issue-Renderer, D1-Schema-Vorlage, Origin-Check |
| `vos-bench-zero/lib/feedback-widget/` | State-Machine-Logik + pii-filter/ua-parse/resize (Vanilla-Port) |
| `sctt-website/src/app/api/feedback/route.js` | Zod-Validierung; erster Migrationskandidat (P1-Exit) |
| BugDrop (MIT) | Struktur-Referenz; Fork-Check in P0 |
