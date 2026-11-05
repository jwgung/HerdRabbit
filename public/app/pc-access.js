import { createElement } from "./dom.js?v=1.4.38";

// Settings → PCs → "Let other PCs connect": this PC's Connect PC port, which
// other PCs' HerdRabbit pages use to show this PC's sessions. Choose PCs…
// lists the devices on this tailnet; the ones ticked may connect, none ticked
// closes the port. Saving asks for the password, writes the plugin's settings
// and restarts HerdRabbit (src/connect-pc-access.mjs); the row waits for it to
// answer again. Shown with sign-in on, where the server offers it.
const POLL_MS = 1_500;
const WAIT_MS = 45_000;
const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

export function createPcAccess({ api, shown }) {
  const card = document.querySelector("#settings-pc-access");
  const hint = document.querySelector("#settings-pc-access-hint");
  const changeButton = document.querySelector("#settings-pc-access-change");
  const dialog = document.querySelector("#pc-access-dialog");
  const form = document.querySelector("#pc-access-form");
  const list = document.querySelector("#pc-access-list");
  const password = document.querySelector("#pc-access-password");
  const feedback = document.querySelector("#pc-access-feedback");
  const submit = document.querySelector("#pc-access-save");
  const cancel = document.querySelector("#pc-access-cancel");
  const page = { visible: false, state: null, error: null, waiting: false, asked: 0 };

  const say = (node, text, error = false) => {
    node.textContent = text;
    node.dataset.error = String(error);
  };

  function summary(state) {
    if (!state.supported) return "This PC runs HerdRabbit as a systemd service: run npm run install-service here to open its Connect PC port.";
    if (!state.tailnet) return "Tailscale is not running on this PC, so other PCs cannot reach it.";
    if (!state.open) return "Closed. No other PC can show this PC's sessions.";
    const names = state.peers.filter((peer) => peer.allowed).map((peer) => peer.name);
    const who = names.length > 0 ? names.join(", ") : state.logins > 0 ? "the tailnet accounts in its settings" : "nobody yet";
    return `Open at ${state.address} to ${who}.`;
  }

  function render() {
    card.hidden = !shown();
    if (card.hidden) return;
    if (page.waiting) {
      say(hint, "Saved. HerdRabbit is restarting to take it up…");
      changeButton.disabled = true;
      return;
    }
    if (page.error) say(hint, page.error, true);
    else if (!page.state) say(hint, "Reading…");
    else say(hint, summary(page.state));
    changeButton.disabled = !page.state?.supported || !page.state?.tailnet;
  }

  async function load() {
    const asked = ++page.asked;
    try {
      const state = await api("/api/connect-pc/access");
      if (asked !== page.asked) return null;
      page.state = state;
      page.error = null;
      return state;
    } catch (error) {
      if (asked === page.asked) page.error = error.message;
      return null;
    } finally {
      if (asked === page.asked) render();
    }
  }

  function choice(peer) {
    const input = createElement("input");
    input.type = "checkbox";
    input.value = peer.address;
    input.checked = peer.allowed;
    const label = createElement("label", { className: "pc-access-choice" });
    const text = createElement("span", { className: "pc-access-choice-text" });
    text.append(createElement("strong", { text: peer.name }), createElement("small", { text: peer.address }));
    label.append(input, text);
    if (!peer.online) label.append(createElement("span", { className: "ui-badge", text: "Offline" }));
    const item = createElement("li");
    item.append(label);
    return item;
  }

  function openDialog() {
    const state = page.state;
    if (!state?.supported || !state.tailnet) return;
    form.reset();
    list.replaceChildren(...state.peers.map(choice));
    if (state.peers.length === 0) list.append(createElement("li", { className: "settings-row-hint", text: "No other devices on this tailnet." }));
    say(feedback, "");
    dialog.showModal();
    (list.querySelector("input") ?? password).focus();
  }

  // After a save the server restarts; it is asked again until it answers.
  async function waitForRestart() {
    page.waiting = true;
    render();
    const started = Date.now();
    await sleep(POLL_MS);
    while (Date.now() - started < WAIT_MS) {
      try {
        page.state = await api("/api/connect-pc/access");
        page.error = null;
        break;
      } catch {
        await sleep(POLL_MS);
      }
    }
    if (Date.now() - started >= WAIT_MS) page.error = "HerdRabbit did not answer after restarting. Check it on this PC: herdr plugin action invoke herdrabbit.status";
    page.waiting = false;
    render();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const addresses = [...list.querySelectorAll("input:checked")].map((input) => input.value);
    const controls = [submit, cancel, password, ...list.querySelectorAll("input")];
    for (const control of controls) control.disabled = true;
    say(feedback, addresses.length ? "Opening the port…" : "Closing the port…");
    try {
      await api("/api/connect-pc/access", {
        method: "POST",
        body: { open: addresses.length > 0, addresses, password: password.value },
      });
      dialog.close();
      void waitForRestart();
    } catch (error) {
      say(feedback, error.message, true);
    } finally {
      for (const control of controls) control.disabled = false;
    }
  });

  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { password.value = ""; });
  changeButton.addEventListener("click", openDialog);

  // Read as the page comes into view.
  function sync({ visible }) {
    const was = page.visible;
    page.visible = visible;
    render();
    if (visible && !was && shown() && !page.waiting) void load();
  }

  return { sync };
}
