// Extraction eval corpus. SYNTHETIC, realistic German feedback (the shape of real
// SCTT reports) — real anonymized samples drop in here later. These drive the
// deterministic contract eval (mock LLM); live model-quality eval needs a real key.
export interface Fixture {
  name: string;
  message: string;
  // What a correct extraction returns for the bug template (repro/expected/actual).
  llmReturns: Record<string, string>;
  expectMissing: string[];
}

export const BUG_FIXTURES: Fixture[] = [
  {
    name: "complete bug",
    message: "Beim Klick auf Speichern passiert nichts. Ich erwarte, dass das Formular gespeichert wird, stattdessen bleibt die Seite hängen.",
    llmReturns: {
      repro: "Auf Speichern klicken",
      expected: "Formular wird gespeichert",
      actual: "Seite bleibt hängen, nichts passiert",
    },
    expectMissing: [],
  },
  {
    name: "missing expected+actual",
    message: "Der Login-Button geht nicht.",
    llmReturns: { repro: "Login-Button klicken", expected: "", actual: "" },
    expectMissing: ["expected", "actual"],
  },
  {
    name: "vague — nothing extractable",
    message: "Funktioniert alles nicht!!",
    llmReturns: { repro: "", expected: "", actual: "" },
    expectMissing: ["repro", "expected", "actual"],
  },
];
