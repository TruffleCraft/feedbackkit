// Minimal widget i18n. de/en in P1; more locales drop in here. Falls back to en.
export type Locale = "de" | "en";

type Key =
  | "trigger"
  | "title"
  | "close"
  | "heading"
  | "finish"
  | "textLabel"
  | "textPlaceholder"
  | "send"
  | "addImages"
  | "screenshotChip"
  | "editShot"
  | "whatSent"
  | "sentText"
  | "sentPage"
  | "sentBrowser"
  | "sentConsole"
  | "sentShot"
  | "sentContext"
  | "yes"
  | "no"
  | "analyzing"
  | "finalizing"
  | "sendNow"
  | "classified"
  | "followUpPlaceholder"
  | "oneQuestion"
  | "sendAnyway"
  | "doneTitle"
  | "doneMsg"
  | "understood"
  | "viewIssue"
  | "sendAnother"
  | "failed"
  | "retry"
  | "captureFailed"
  | "captureStarted"
  | "capturing"
  | "removeShot"
  | "removeFile"
  | "uploadFailed"
  | "uploadLimit"
  | "privacyLink"
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
    title: "Feedback",
    close: "Close",
    heading: "What's on your mind?",
    textLabel: "Your message",
    textPlaceholder: "Describe it in your own words. If something is missing, we'll ask.",
    send: "Send",
    addImages: "Add images",
    screenshotChip: "Screenshot",
    editShot: "Mark up screenshot {n}",
    whatSent: "What gets sent?",
    sentText: "Your text and attached images",
    sentPage: "Page",
    sentBrowser: "Browser",
    sentConsole: "Console messages",
    sentShot: "Screenshots",
    sentContext: "App context",
    yes: "yes",
    no: "no",
    analyzing: "One moment…",
    finalizing: "Sending…",
    sendNow: "Send without a follow-up",
    classified: "Filed as {type}",
    followUpPlaceholder: "Your answer",
    oneQuestion: "One question, then you're done.",
    sendAnyway: "Send without answering",
    doneTitle: "Thanks, got it.",
    doneMsg: "Your feedback was received.",
    understood: "How we understood it",
    viewIssue: "View ticket",
    sendAnother: "Report something else",
    finish: "Done",
    failed: "Something went wrong. Please try again.",
    retry: "Try again",
    captureStarted: "Capturing the visible page…",
    capturing: "Capturing…",
    captureFailed: "Could not capture this page. You can still send your feedback.",
    removeShot: "Remove screenshot {n}",
    removeFile: "Remove {name}",
    uploadFailed: "upload failed",
    uploadLimit: "limit reached",
    privacyLink: "Privacy",
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
    title: "Feedback",
    close: "Schließen",
    heading: "Was möchtest du uns sagen?",
    textLabel: "Deine Nachricht",
    textPlaceholder: "Beschreib es in deinen Worten. Wenn etwas fehlt, fragen wir nach.",
    send: "Senden",
    addImages: "Bild anhängen",
    screenshotChip: "Screenshot",
    editShot: "Screenshot {n} markieren",
    whatSent: "Was wird gesendet?",
    sentText: "Dein Text und angehängte Bilder",
    sentPage: "Seite",
    sentBrowser: "Browser",
    sentConsole: "Konsolenmeldungen",
    sentShot: "Screenshots",
    sentContext: "App-Kontext",
    yes: "ja",
    no: "nein",
    analyzing: "Einen Moment …",
    finalizing: "Wird gesendet …",
    sendNow: "Ohne Rückfrage senden",
    classified: "Als {type} eingeordnet",
    followUpPlaceholder: "Deine Antwort",
    oneQuestion: "Eine Frage, dann ist es fertig.",
    sendAnyway: "Ohne Antwort senden",
    doneTitle: "Danke, ist angekommen.",
    doneMsg: "Dein Feedback ist angekommen.",
    understood: "So haben wir es verstanden",
    viewIssue: "Ticket ansehen",
    sendAnother: "Noch etwas melden",
    finish: "Fertig",
    failed: "Etwas ist schiefgelaufen. Bitte versuch es noch einmal.",
    retry: "Erneut versuchen",
    captureStarted: "Sichtbaren Bereich aufnehmen …",
    capturing: "Aufnahme …",
    captureFailed: "Die Seite konnte nicht aufgenommen werden. Dein Feedback kannst du trotzdem senden.",
    removeShot: "Screenshot {n} entfernen",
    removeFile: "{name} entfernen",
    uploadFailed: "Upload fehlgeschlagen",
    uploadLimit: "Limit erreicht",
    privacyLink: "Datenschutz",
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
