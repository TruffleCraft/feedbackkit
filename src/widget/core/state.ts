import type { FeedbackResponse } from "../../shared/contract.js";

// Pure state machine for the extract-then-form flow (design review §2b). The
// reducer is side-effect-free and unit-tested; index.ts owns the async calls and
// the DOM, reacting to state transitions.

export type WidgetState =
  | { name: "closed" }
  | { name: "form"; type: string; text: string }
  | { name: "extracting"; sendNow: boolean } // sendNow=true after the 4s slow-hint → "Send now" goes primary
  | { name: "completing"; missing: string[]; values: Record<string, string> }
  | { name: "submitting" }
  | { name: "done"; issueUrl?: string; soft: boolean } // soft = accepted/received but no issue link yet
  | { name: "failed"; reason: string };

export type WidgetEvent =
  | { t: "open"; type: string }
  | { t: "close" }
  | { t: "setType"; type: string }
  | { t: "setText"; text: string }
  | { t: "submit" } // form → extracting (index fires POST-1)
  | { t: "slowHint" } // 4s elapsed while extracting
  | { t: "sendNow" } // user forces send during extracting → submitting
  | { t: "completeSubmit" } // completing → submitting (index fires POST-2)
  | { t: "response"; res: FeedbackResponse } // POST-1/POST-2 result
  | { t: "retry" };

function fromResponse(res: FeedbackResponse): WidgetState {
  switch (res.status) {
    case "need_fields":
      return { name: "completing", missing: res.missing, values: { ...res.extracted } };
    case "created":
      return { name: "done", issueUrl: res.issueUrl, soft: false };
    case "accepted_incomplete":
      return { name: "done", issueUrl: res.issueUrl, soft: true };
    case "issue_failed":
      // Feedback IS saved server-side; the tracker call failed. Don't alarm the
      // user — their report landed and will be retried by the operator.
      return { name: "done", soft: true };
    case "error":
      return { name: "failed", reason: res.error };
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
    case "completeSubmit":
      return state.name === "completing" ? { name: "submitting" } : state;
    case "response":
      // A response is only meaningful while a call is in flight.
      return state.name === "extracting" || state.name === "submitting" ? fromResponse(event.res) : state;
    case "retry":
      return state.name === "failed" ? { name: "form", type: "", text: "" } : state;
  }
}
