# Agent Instructions

## Iron Law: Arbeit landen, nicht nur berichten

Vor jedem Session-Ende, jedem „ich stoppe hier" und jeder Blockiert-Meldung gilt: **erst committen und pushen, dann berichten.** Ein Handover-Text ersetzt keinen Commit — der Text verdampft mit der Session, der ungesicherte Working-Tree bleibt liegen.

- **Fertig heißt gepusht.** Eine Aufgabe ist erst abgeschlossen, wenn `git status` sauber und `git log @{u}..HEAD` leer ist.
- **Unfertiges als WIP-Commit sichern.** Ein Commit, dessen Message benennt was noch ungeprüft ist, schlägt einen verlorenen Working-Tree.
- **Bei langen „weiter"-Ketten zwischenlanden**, nicht erst am Schluss.
- **Rate-Limit-, `overloaded`- und Kompaktierungs-Meldungen sind Vorboten eines harten Abbruchs** — sofort sichern.

## Arbeitsregeln aus Erfahrung

- **PRs mit UI, nutzersichtbaren Texten oder inhaltlichen Weichenstellungen merged der Maintainer, nicht der Agent.** Der Agent liefert Test-Zugang und Checkliste; API- und Infra-Interna testet er selbst. Grüne CI prüft weder Tonalität noch UX.
- **PR-Kommentare bleiben neutral.** Das Repo ist öffentlich, persönliche Testanweisungen gehören nicht hinein.
- **Ein Milestone nur pro committeter Phase** (Beschreibung: Epic-Link, Kernscope, Exit-Kriterium). Ist der Exit erreicht, Milestone und Epic sofort schließen. Keine erfundenen Due-Dates, keine Milestones für Ad-hoc-Arbeit — sonst lügt die Fortschrittsanzeige.
