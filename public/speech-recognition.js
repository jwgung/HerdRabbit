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
function createRecognizer({ onInterim, onFinal, onEnd, onError }) {
  const recognition = new SpeechRecognition();
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

export function createSpeechButton({ button, textarea, onStateChange = () => {} }) {
  let recognition = null;
  let listening = false;
  let interim = "";

  function updateButton() {
    button.classList.toggle("listening", listening);
    button.title = listening ? "Stop dictation" : "Dictate";
    button.setAttribute("aria-label", listening ? "Stop dictation" : "Dictate");
  }

  function stop() {
    listening = false;
    interim = "";
    if (recognition) {
      try { recognition.stop(); } catch { /* already stopped */ }
      recognition = null;
    }
    updateButton();
    onStateChange(false);
  }

  function start() {
    if (!speechSupported()) return;
    // Remove the previous interim from the textarea before starting fresh.
    const value = textarea.value;
    const suffix = value.slice(-interim.length);
    if (interim && suffix === interim) textarea.value = value.slice(0, -interim.length);
    interim = "";
    recognition = createRecognizer({
      onInterim: (text) => {
        interim = text;
        const base = textarea.value;
        textarea.value = base + (base.endsWith(" ") || base === "" ? "" : " ") + text;
      },
      onFinal: (text) => {
        // The final result replaces the interim that was shown for it.
        const value = textarea.value;
        const suffix = value.slice(-interim.length);
        const base = suffix === interim ? value.slice(0, -interim.length) : value;
        textarea.value = base + (base.endsWith(" ") || base === "" ? "" : " ") + text.trim();
        interim = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      },
      onEnd: () => {
        // Chrome stops after a silence or a network hiccup; restart while the
        // user is still dictating.
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
