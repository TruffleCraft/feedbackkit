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
  | "attachFile"
  | "analyzing"
  | "sendNow"
  | "followUpPlaceholder"
  | "sendAnyway"
  | "doneTitle"
  | "doneMsg"
  | "viewIssue"
  | "failed"
  | "retry";

const STR: Record<Locale, Record<Key, string>> = {
  en: {
    trigger: "Feedback",
    title: "Send feedback",
    close: "Close",
    textLabel: "What's on your mind?",
    textPlaceholder: "Tell us anything — a bug, an idea, something that felt off…",
    send: "Send",
    attachScreenshot: "Attach a screenshot of this page",
    attachFile: "Attach a file",
    analyzing: "Analyzing…",
    sendNow: "Send now",
    followUpPlaceholder: "Your answer…",
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
    textLabel: "Was möchtest du uns sagen?",
    textPlaceholder: "Sag uns alles — ein Bug, eine Idee, etwas das sich falsch angefühlt hat…",
    send: "Senden",
    attachScreenshot: "Screenshot dieser Seite anhängen",
    attachFile: "Datei anhängen",
    analyzing: "Wird analysiert…",
    sendNow: "Jetzt senden",
    followUpPlaceholder: "Deine Antwort…",
    sendAnyway: "Trotzdem senden",
    doneTitle: "Danke!",
    doneMsg: "Dein Feedback ist angekommen.",
    viewIssue: "Zum Ticket",
    failed: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    retry: "Erneut versuchen",
  },
};

export function t(locale: Locale, key: Key): string {
  return (STR[locale] ?? STR.en)[key];
}
