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
  | "retry"
  | "editShot"
  | "captureFailed"
  | "shotReady"
  | "annotateHint"
  | "toolCrop"
  | "toolRect"
  | "toolArrow"
  | "toolText"
  | "toolPen"
  | "undo"
  | "clear"
  | "useShot"
  | "cancel";

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
    editShot: "Mark up screenshot",
    captureFailed: "Could not capture this page — you can still send your feedback.",
    shotReady: "Screenshot edited ✓",
    annotateHint: "Drag to crop, or pick a tool to mark things up.",
    toolCrop: "Crop",
    toolRect: "Rectangle",
    toolArrow: "Arrow",
    toolText: "Text",
    toolPen: "Draw",
    undo: "Undo",
    clear: "Clear all",
    useShot: "Use screenshot",
    cancel: "Cancel",
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
    editShot: "Screenshot markieren",
    captureFailed: "Seite konnte nicht aufgenommen werden — dein Feedback kannst du trotzdem senden.",
    shotReady: "Screenshot bearbeitet ✓",
    annotateHint: "Ziehen zum Zuschneiden, oder ein Werkzeug zum Markieren wählen.",
    toolCrop: "Zuschneiden",
    toolRect: "Rechteck",
    toolArrow: "Pfeil",
    toolText: "Text",
    toolPen: "Zeichnen",
    undo: "Rückgängig",
    clear: "Alles löschen",
    useShot: "Screenshot übernehmen",
    cancel: "Abbrechen",
  },
};

export function t(locale: Locale, key: Key): string {
  return (STR[locale] ?? STR.en)[key];
}
