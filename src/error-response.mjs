import { AiAccountError } from "./ai-accounts.mjs";
import { ConversationError } from "./conversation/pages.mjs";
import { FileAccessError } from "./file-browser.mjs";
import { HerdrCommandError, InputValidationError } from "./herdr-client.mjs";
import { HttpError } from "./http-basics.mjs";
import { PasskeyError } from "./passkey-auth.mjs";
import { PushValidationError } from "./web-push-service.mjs";

// What a thrown error says to a client: status, code and message, the same on
// the page's server and on the Connect PC port, which shares nothing else.
export function errorResponse(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // File and SFTP failures already carry a status; without this they would
  // surface as 500s from the paths that throw outside a route's own handling.
  if (error instanceof FileAccessError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof InputValidationError) {
    return { status: 400, code: "invalid_input", message: error.message };
  }
  if (error instanceof PushValidationError) {
    return { status: 400, code: "invalid_push_subscription", message: error.message };
  }
  if (error instanceof PasskeyError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // Messages and details are written by the account manager itself and name
  // no credential; details only ever lists the panes a switch would affect.
  if (error instanceof AiAccountError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  // A conversation that cannot be shown says why (details.reason) for the
  // page to word it; a stale cursor is a 409 the page reloads on.
  if (error instanceof ConversationError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof HerdrCommandError) {
    return {
      status: error.code === "herdr_timeout" ? 504
        : error.code === "split_session" || error.code === "pane_split_failed" || error.code === "stale_content" || error.code === "input_not_empty" ? 409
          : error.code === "link_unsupported" ? 501 : 502,
      code: error.code,
      message: error.message,
    };
  }

  return { status: 500, code: "internal_error", message: "Internal server error" };
}
