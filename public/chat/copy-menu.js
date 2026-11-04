// The copy button under an agent's answer: a small menu beside it with the
// answer's markdown, as the agent wrote it, and its plain text, as the chat
// reads (markdown.js). The two copies follow Ovis's answer footer
// (https://github.com/devswha/ovis, src/components/ChatView.tsx); the code is
// HerdRabbit's own.
//
// The menu opens in the top layer, so the chat's scrolling box cannot cut it
// off; a scroll anywhere closes it rather than leave it beside nothing.

import { COPY_ICONS, markdownText } from "./markdown.js?v=1.4.35";
import { placeFloatingMenu } from "../app/dom.js?v=1.4.35";

// What the menu offers for an answer, in order.
export function answerCopies(markdown) {
  return [
    { format: "markdown", label: "Copy as Markdown", text: markdown },
    { format: "text", label: "Copy as text", text: markdownText(markdown) },
  ];
}

// The menu: `details.ui-menu` with the copy icon as its summary. Each item
// carries its text in `data-copy` for the chat's click handler
// (`data-action="copy-choice"`), which copies it and closes the menu.
export function copyMenu(document, markdown, label = "Copy answer") {
  const details = document.createElement("details");
  details.className = "ui-menu chat-copy-menu";
  const summary = document.createElement("summary");
  summary.className = "chat-copy";
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.innerHTML = COPY_ICONS;
  const panel = document.createElement("div");
  panel.className = "ui-menu-panel chat-copy-panel";
  panel.setAttribute("popover", "auto");
  for (const choice of answerCopies(markdown)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ui-menu-item";
    item.dataset.action = "copy-choice";
    item.dataset.format = choice.format;
    item.dataset.copy = choice.text;
    item.textContent = choice.label;
    panel.append(item);
  }
  const close = () => { details.open = false; };
  // clicking away closes the popover without telling the details element
  panel.addEventListener("toggle", (event) => { if (event.newState === "closed") close(); });
  details.addEventListener("toggle", () => {
    if (details.open) {
      placeFloatingMenu(panel, summary);
      document.addEventListener("scroll", close, { capture: true, once: true, passive: true });
    } else {
      document.removeEventListener("scroll", close, { capture: true });
      if (panel.matches(":popover-open")) panel.hidePopover();
    }
  });
  details.append(summary, panel);
  return details;
}
