import { createElement } from "./dom.js?v=1.4.53";

// Settings → PCs → "Let other PCs connect": this PC's Connect PC port, which
// other PCs' HerdRabbit pages use to show this PC's sessions. Choose PCs…
// lets in all of the person's PCs (every device signed in to Tailscale as
// this PC's account), only the tailnet devices ticked, or no other PC, which
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
  const modes = [...document.querySelectorAll('input[name="pc-access-mode"]')];
  const choices = document.querySelector("#pc-access-choices");
  const mineHint = document.querySelector("#pc-access-mine-hint");
  const mode = () => modes.find((input) => input.checked)?.value ?? "none";
  const page = { visible: false, state: null, error: null, waiting: false, asked: 0 };

  const say = (node, text, error = false) => {
    node.textContent = text;
    node.dataset.error = String(error);
  };

  function summary(state) {
    if (!state.supported) return "This PC runs HerdRabbit as a systemd service: run npm run install-service here to open its Connect PC port.";
    if (!state.tailnet) return "Tailscale is not running on this PC, so other PCs cannot reach it.";
    if (!state.open) return "Closed. No other PC can show this PC's sessions.";
    if (state.mine) return `Open at ${state.address} to all your PCs (${state.self?.login ?? "your tailnet account"}).`;
    const names = state.peers.filter((peer) => peer.allowed).map((peer) => peer.name);
    const who = names.length > 0 ? names.join(", ") : "the PCs in its settings";
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

  // The device list counts only with "Only these".
  function showMode() {
    const some = mode() === "some";
    choices.hidden = !some;
    for (const input of list.querySelectorAll("input")) input.disabled = !some;
  }

  function openDialog() {
    const state = page.state;
    if (!state?.supported || !state.tailnet) return;
    form.reset();
    list.replaceChildren(...state.peers.map(choice));
    if (state.peers.length === 0) list.append(createElement("li", { className: "settings-row-hint", text: "No other devices on this tailnet." }));
    mineHint.textContent = `Every device signed in to Tailscale as ${state.self?.login || "you"}, those added later too`;
    // A closed port opens to all of them unless something else is chosen.
    const current = !state.open ? "mine" : state.mine ? "mine" : "some";
    for (const input of modes) input.checked = input.value === current;
    showMode();
    say(feedback, "");
    dialog.showModal();
    (modes.find((input) => input.checked) ?? password).focus();
  }

  for (const input of modes) input.addEventListener("change", showMode);

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
    const chosen = mode();
    const addresses = chosen === "some" ? [...list.querySelectorAll("input:checked")].map((input) => input.value) : [];
    if (chosen === "some" && addresses.length === 0) {
      say(feedback, "Tick the devices that may connect, or choose No other PC.", true);
      return;
    }
    const open = chosen !== "none";
    const controls = [submit, cancel, password, ...modes];
    for (const control of controls) control.disabled = true;
    say(feedback, open ? "Opening the port…" : "Closing the port…");
    try {
      await api("/api/connect-pc/access", {
        method: "POST",
        body: { open, mine: chosen === "mine", addresses, password: password.value },
      });
      dialog.close();
      void waitForRestart();
    } catch (error) {
      say(feedback, error.message, true);
    } finally {
      for (const control of controls) control.disabled = false;
      showMode();
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
