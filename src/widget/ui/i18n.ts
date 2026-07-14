// Minimal widget i18n. de/en in P1; more locales drop in here. Falls back to en.
export type Locale = "de" | "en";

type Key =
  | "trigger"
  | "title"
  | "close"
  | "textLabel"
  | "textPlaceholder"
  | "send"
  | "attachScreenshot"
  | "analyzing"
  | "sendNow"
  | "almostDone"
  | "autoDetected"
  | "sendAnyway"
  | "doneTitle"
  | "doneMsg"
  | "viewIssue"
  | "failed"
  | "retry";

const STR: Record<Locale, Record<Exclude<Key, "almostDone">, string> & { almostDone: (n: number) => string }> = {
  en: {
    trigger: "Feedback",
    title: "Send feedback",
    close: "Close",
    textLabel: "What happened?",
    textPlaceholder: "Describe it like you'd tell a colleague…",
    send: "Send",
    attachScreenshot: "Attach a screenshot of this page",
    analyzing: "Analyzing…",
    sendNow: "Send now",
    almostDone: (n) => `Almost done — ${n} detail${n === 1 ? "" : "s"} missing`,
    autoDetected: "auto-detected",
    sendAnyway: "Send anyway",
    doneTitle: "Thanks!",
    doneMsg: "Your feedback was received.",
    viewIssue: "View issue",
    failed: "Something went wrong. Please try again.",
    retry: "Try again",
  },
  de: {
    trigger: "Feedback",
    title: "Feedback geben",
    close: "Schließen",
    textLabel: "Was ist passiert?",
    textPlaceholder: "Beschreibe es, als würdest du es einem Kollegen erzählen…",
    send: "Senden",
    attachScreenshot: "Screenshot dieser Seite anhängen",
    analyzing: "Wird analysiert…",
    sendNow: "Jetzt senden",
    almostDone: (n) => `Fast fertig — noch ${n} Angabe${n === 1 ? "" : "n"}`,
    autoDetected: "automatisch erkannt",
    sendAnyway: "Trotzdem senden",
    doneTitle: "Danke!",
    doneMsg: "Dein Feedback ist angekommen.",
    viewIssue: "Zum Ticket",
    failed: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    retry: "Erneut versuchen",
  },
};

export function t(locale: Locale, key: Key, n = 0): string {
  const table = STR[locale] ?? STR.en;
  const v = table[key];
  return typeof v === "function" ? v(n) : v;
}
