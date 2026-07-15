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
  | "finalizing"
  | "sendNow"
  | "followUpPlaceholder"
  | "sendAnyway"
  | "doneTitle"
  | "doneMsg"
  | "viewIssue"
  | "sendAnother"
  | "failed"
  | "retry"
  | "editShot"
  | "captureFailed"
  | "captureStarted"
  | "capturing"
  | "shotReady"
  | "screenshotChip"
  | "removeShot"
  | "restoreShot"
  | "dropTitle"
  | "dropTitleAccent"
  | "dropSub"
  | "addImages"
  | "uploadFailed"
  | "uploadLimit"
  | "privacy"
  | "annotateTitle"
  | "annotateHint"
  | "toolCrop"
  | "toolRect"
  | "toolArrow"
  | "toolText"
  | "textSmaller"
  | "textLarger"
  | "textSize"
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
    analyzing: "AI is structuring your feedback…",
    finalizing: "Finishing without a follow-up…",
    sendNow: "Skip follow-up",
    followUpPlaceholder: "Your answer…",
    sendAnyway: "Send anyway",
    doneTitle: "Thanks!",
    doneMsg: "Your feedback was received.",
    viewIssue: "View issue",
    sendAnother: "Send more feedback",
    failed: "Something went wrong. Please try again.",
    retry: "Try again",
    editShot: "Mark up",
    captureStarted: "Capturing the visible page…",
    capturing: "Capturing…",
    captureFailed: "Could not capture this page — you can still send your feedback.",
    shotReady: "edited ✓",
    screenshotChip: "Screenshot",
    removeShot: "Remove screenshot",
    restoreShot: "Restore screenshot",
    dropTitleAccent: "Drop images here",
    dropTitle: " or add them",
    dropSub: "PNG, JPG, WebP or GIF · up to 4 files",
    addImages: "Add images",
    uploadFailed: "upload failed",
    uploadLimit: "limit reached",
    privacy: "Screenshot may be included with page context",
    annotateTitle: "Mark up screenshot",
    annotateHint: "Drag to crop, or pick a tool to mark things up.",
    toolCrop: "Crop",
    toolRect: "Rectangle",
    toolArrow: "Arrow",
    toolText: "Text",
    textSmaller: "Smaller text",
    textLarger: "Larger text",
    textSize: "Text size",
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
    analyzing: "AI strukturiert dein Feedback…",
    finalizing: "Wird ohne Rückfrage abgeschlossen…",
    sendNow: "Rückfrage überspringen",
    followUpPlaceholder: "Deine Antwort…",
    sendAnyway: "Trotzdem senden",
    doneTitle: "Danke!",
    doneMsg: "Dein Feedback ist angekommen.",
    viewIssue: "Zum Ticket",
    sendAnother: "Weiteres Feedback",
    failed: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    retry: "Erneut versuchen",
    editShot: "Markieren",
    captureStarted: "Sichtbaren Bereich aufnehmen…",
    capturing: "Aufnahme…",
    captureFailed: "Seite konnte nicht aufgenommen werden — dein Feedback kannst du trotzdem senden.",
    shotReady: "bearbeitet ✓",
    screenshotChip: "Screenshot",
    removeShot: "Screenshot entfernen",
    restoreShot: "Screenshot wiederherstellen",
    dropTitleAccent: "Bilder hierher ziehen",
    dropTitle: " oder hinzufügen",
    dropSub: "PNG, JPG, WebP oder GIF · bis zu 4 Dateien",
    addImages: "Bilder hinzufügen",
    uploadFailed: "Upload fehlgeschlagen",
    uploadLimit: "Limit erreicht",
    privacy: "Screenshot kann Seitenkontext enthalten",
    annotateTitle: "Screenshot markieren",
    annotateHint: "Ziehen zum Zuschneiden, oder ein Werkzeug zum Markieren wählen.",
    toolCrop: "Zuschneiden",
    toolRect: "Rechteck",
    toolArrow: "Pfeil",
    toolText: "Text",
    textSmaller: "Text verkleinern",
    textLarger: "Text vergrößern",
    textSize: "Textgröße",
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
