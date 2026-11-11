// Settings → Files: what an HTML page opened from Files may do. Kept per
// browser, and sent with each page opened (src/site-preview.mjs).
// - "Run scripts in HTML previews": off unless chosen. A script can read the
//   page's folder and its subfolders and, whatever else is allowed, send what
//   it reads to any site by moving its own frame there.
// - "Internet in HTML previews": off unless chosen. Lets the page load styles,
//   fonts and pictures (and scripts, where they run) from the internet.
export const HTML_INTERNET_STORAGE_KEY = "herdrbridge-html-internet";
export const HTML_SCRIPTS_STORAGE_KEY = "herdrbridge-html-scripts";

function readSwitch(storage, key) {
  try {
    return storage?.getItem(key) === "on";
  } catch {
    return false;
  }
}

function writeSwitch(storage, key, on) {
  if (!storage) return false;
  try {
    if (on) storage.setItem(key, "on");
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const readHtmlInternet = (storage) => readSwitch(storage, HTML_INTERNET_STORAGE_KEY);
export const writeHtmlInternet = (storage, on) => writeSwitch(storage, HTML_INTERNET_STORAGE_KEY, on);
export const readHtmlScripts = (storage) => readSwitch(storage, HTML_SCRIPTS_STORAGE_KEY);
export const writeHtmlScripts = (storage, on) => writeSwitch(storage, HTML_SCRIPTS_STORAGE_KEY, on);
