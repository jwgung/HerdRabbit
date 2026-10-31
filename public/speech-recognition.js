// Voice input for the composer: a microphone button that dictation into the
// textarea. Uses the browser's speech recognition (Chrome's, backed by
// Google's service, free and keyless). The words land in the textarea so the
// user reviews them before sending.

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export function speechSupported() {
  return Boolean(SpeechRecognition);
}

// One recognizer: continuous, interim results on, the user's language.
function createRecognizer(Recognition, { onInterim, onFinal, onEnd, onError, onLog }) {
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "ko-KR";
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) onFinal(result[0].transcript);
      else interim += result[0].transcript;
    }
    onInterim(interim);
    onLog({
      type: "result",
      resultIndex: event.resultIndex,
      results: Array.from(event.results, (result) => ({ final: Boolean(result.isFinal), text: result[0]?.transcript ?? "" })),
    });
  };
  recognition.onend = () => { onLog({ type: "end" }); onEnd(); };
  recognition.onerror = (event) => { onLog({ type: "error", error: event.error, message: event.message || "" }); onError(event.error); };
  return recognition;
}

// `Recognition` is the browser's recognizer class; a test passes its own.
// `onTextChange` hears of each change made to the text without an input
// event (the words shown while still being heard). `onLog` hears what the
// recognizer said (each result event as the browser gave it, its end and its
// errors) and what the text box held after it: Settings → Speech log shows it.
export function createSpeechButton({ button, textarea, onStateChange = () => {}, onTextChange = () => {}, onLog = () => {}, Recognition = SpeechRecognition }) {
  let recognition = null;
  let listening = false;
  let shown = "";
  // what the recognizer said, with the box after it; a log that throws must
  // never stop dictation
  const note = (entry) => {
    try { onLog({ ...entry, box: textarea.value }); } catch { /* the log is only for looking */ }
  };

  function updateButton() {
    button.classList.toggle("listening", listening);
    button.title = listening ? "Stop dictation" : "Dictate";
    button.setAttribute("aria-label", listening ? "Stop dictation" : "Dictate");
  }

  function stop() {
    listening = false;
    shown = "";
    if (recognition) {
      try { recognition.stop(); } catch { /* already stopped */ }
      recognition = null;
    }
    updateButton();
    onStateChange(false);
  }

  // `shown` is the interim text this box holds at its end right now (with the
  // space put before it), so the next result can take it out first. Without
  // that every interim update would be added after the last one.
  function withoutShown() {
    const value = textarea.value;
    return shown && value.endsWith(shown) ? value.slice(0, -shown.length) : value;
  }
  function appended(base, text) {
    return text ? base + (base === "" || /\s$/u.test(base) ? "" : " ") + text : base;
  }

  function start() {
    if (!Recognition) return;
    textarea.value = withoutShown();
    shown = "";
    recognition = createRecognizer(Recognition, {
      onInterim: (text) => {
        const base = withoutShown();
        const next = appended(base, text.trim());
        shown = next.slice(base.length);
        textarea.value = next;
        onTextChange();
      },
      onFinal: (text) => {
        // The final result replaces the interim that was shown for it.
        textarea.value = appended(withoutShown(), text.trim());
        shown = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      },
      onEnd: () => {
        // Chrome stops after a silence or a network hiccup; restart while the
        // user is still dictating.
        if (listening) {
          try {
            recognition.start();
            note({ type: "restart" });
          } catch {
            note({ type: "restart-failed" });
            stop();
          }
        } else {
          stop();
        }
      },
      onError: (error) => {
        if (error === "not-allowed" || error === "service-not-allowed") stop();
        // "no-speech" and "aborted" are normal; the onEnd handler restarts.
      },
      onLog: note,
    });
    try {
      recognition.start();
      listening = true;
    } catch {
      recognition = null;
      listening = false;
    }
    note({ type: listening ? "start" : "start-failed" });
    updateButton();
    onStateChange(listening);
  }

  button.addEventListener("click", () => (listening ? stop() : start()));
  updateButton();

  return {
    get listening() { return listening; },
    stop,
  };
}
