// Zod-free limits shared by the widget (browser bundle) and the wire contract.
// The widget may import VALUES from here; from contract.ts it imports types only.

/** Host context (window.FeedbackKitContext): max keys, key shape, string length. */
export const MAX_CONTEXT_KEYS = 20;
export const CONTEXT_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
export const MAX_CONTEXT_VALUE = 200;
