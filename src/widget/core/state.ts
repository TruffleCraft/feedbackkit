import type { FeedbackResponse } from "../../shared/contract.js";

// Pure state machine for the freetext-first flow (ADR-012). The reducer is
// side-effect-free and unit-tested; index.ts owns the async calls and the DOM,
// reacting to state transitions. The follow-up is a SINGLE conversational
// question (state `asking`), not a multi-field form.

export type WidgetState =
  | { name: "closed" }
  | { name: "form"; type: string; text: string }
  | { name: "extracting"; sendNow: boolean } // sendNow=true after the 4s slow-hint → "Send now" goes primary
  | { name: "asking"; question: string; extracted: Record<string, string>; type?: string; typeUnclear?: boolean } // type = how the gateway classified it
  | { name: "submitting" }
  | { name: "done"; issueUrl?: string; soft: boolean; type?: string; summary?: string } // soft = accepted/received but no issue link yet
  | { name: "failed"; reason: string; retry?: RetrySnapshot }; // retry: what to resend, so nothing typed is lost

/** Everything a retry needs to resend the failed leg unchanged: the same
 * submission id and uploaded keys (no second upload), the text and type to show
 * again, and on leg 2 the follow-up answer and what POST-1 extracted. */
export interface RetrySnapshot {
  leg: 1 | 2;
  feedbackId: string;
  text: string;
  type: string;
  attachmentKeys: string[];
  answer?: string;
  extracted?: Record<string, string>;
}

export type WidgetEvent =
  | { t: "open"; type: string }
  | { t: "close" }
  | { t: "setType"; type: string }
  | { t: "setText"; text: string }
  | { t: "submit" } // form → extracting (index fires POST-1)
  | { t: "slowHint" } // 4s elapsed while extracting
  | { t: "sendNow" } // user forces send during extracting → submitting
  | { t: "answer" } // asking → submitting (index fires POST-2 with the freetext answer)
  | { t: "response"; res: FeedbackResponse; retry?: RetrySnapshot } // POST-1/POST-2 result; retry is kept if it failed
  | { t: "restart" }
  | { t: "retry" };

function fromResponse(res: FeedbackResponse, retry?: RetrySnapshot): WidgetState {
  switch (res.status) {
    case "follow_up":
      return { name: "asking", question: res.question, extracted: { ...res.extracted }, type: res.type, typeUnclear: res.typeUnclear };
    case "created":
      return { name: "done", issueUrl: res.issueUrl, soft: false, type: res.type, summary: res.summary };
    case "accepted_incomplete":
      return { name: "done", issueUrl: res.issueUrl, soft: true, type: res.type, summary: res.summary };
    case "issue_failed":
      // Feedback IS saved server-side; the tracker call failed. Don't alarm the
      // user — their report landed and will be retried by the operator.
      return { name: "done", soft: true };
    case "error":
      return { name: "failed", reason: res.error, ...(retry ? { retry } : {}) };
    default:
      // A non-conforming server/proxy response must not land us in `undefined`
      // (which would crash render). Treat anything unknown as a soft failure.
      return { name: "failed", reason: "unexpected response", ...(retry ? { retry } : {}) };
  }
}

export function reduce(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.t) {
    case "open":
      return state.name === "closed" ? { name: "form", type: event.type, text: "" } : state;
    case "close":
      return { name: "closed" };
    case "setType":
      return state.name === "form" ? { ...state, type: event.type } : state;
    case "setText":
      return state.name === "form" ? { ...state, text: event.text } : state;
    case "submit":
      return state.name === "form" ? { name: "extracting", sendNow: false } : state;
    case "slowHint":
      return state.name === "extracting" ? { name: "extracting", sendNow: true } : state;
    case "sendNow":
      return state.name === "extracting" ? { name: "submitting" } : state;
    case "answer":
      return state.name === "asking" ? { name: "submitting" } : state;
    case "response":
      // A response is only meaningful while a call is in flight.
      return state.name === "extracting" || state.name === "submitting" ? fromResponse(event.res, event.retry) : state;
    case "restart":
      return state.name === "done" ? { name: "form", type: "", text: "" } : state;
    case "retry":
      // Resend the failed leg as it was (index fires the POST). Without a
      // snapshot nothing was sent yet: back to an empty form.
      if (state.name !== "failed") return state;
      if (!state.retry) return { name: "form", type: "", text: "" };
      return state.retry.leg === 1 ? { name: "extracting", sendNow: false } : { name: "submitting" };
  }
}
