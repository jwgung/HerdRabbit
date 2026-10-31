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
function createRecognizer(Recognition, { onInterim, onFinal, onEnd, onError }) {
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
  };
  recognition.onend = () => onEnd();
  recognition.onerror = (event) => onError(event.error);
  return recognition;
}

// `Recognition` is the browser's recognizer class; a test passes its own.
// `onTextChange` hears of each change made to the text without an input
// event (the words shown while still being heard).
export function createSpeechButton({ button, textarea, onStateChange = () => {}, onTextChange = () => {}, Recognition = SpeechRecognition }) {
  let recognition = null;
  let listening = false;
  let shown = "";

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
  // `heard` is the last final put in the box (its words and what was added for
  // them), while no interim came after it: Android sends no interim results,
  // and each better hearing of the same words as one more final, the words so
  // far and then some. A final that goes on from it takes its place. A final
  // after an interim (the desktop's way) is new words.
  let heard = null;
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
    heard = null;
    recognition = createRecognizer(Recognition, {
      onInterim: (text) => {
        if (text.trim()) heard = null;
        const base = withoutShown();
        const next = appended(base, text.trim());
        shown = next.slice(base.length);
        textarea.value = next;
        onTextChange();
      },
      onFinal: (text) => {
        const words = text.trim();
        if (!words) return;
        // The final result replaces the interim that was shown for it, or
        // the final it hears better.
        let base = withoutShown();
        if (heard && words.startsWith(heard.words) && heard.added && base.endsWith(heard.added)) {
          base = base.slice(0, -heard.added.length);
        }
        textarea.value = appended(base, words);
        heard = { words, added: textarea.value.slice(base.length) };
        shown = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      },
      onEnd: () => {
        // Chrome stops after a silence or a network hiccup; restart while the
        // user is still dictating. The next words are new ones.
        heard = null;
        if (listening) {
          try { recognition.start(); } catch { stop(); }
        } else {
          stop();
        }
      },
      onError: (error) => {
        if (error === "not-allowed" || error === "service-not-allowed") stop();
        // "no-speech" and "aborted" are normal; the onEnd handler restarts.
      },
    });
    try {
      recognition.start();
      listening = true;
    } catch {
      recognition = null;
      listening = false;
    }
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
