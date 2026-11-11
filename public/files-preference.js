// Settings → Files → "Internet in HTML previews": whether an HTML file shown
// from Files may load from the internet (a CDN's scripts, styles, fonts and
// pictures) besides its own folder. Off unless chosen: with it on, a page could
// send what it reads from its folder to a site (src/site-preview.mjs). Kept
// per browser, and sent with each page opened.
export const HTML_INTERNET_STORAGE_KEY = "herdrbridge-html-internet";

export function readHtmlInternet(storage) {
  try {
    return storage?.getItem(HTML_INTERNET_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeHtmlInternet(storage, on) {
  if (!storage) return false;
  try {
    if (on) storage.setItem(HTML_INTERNET_STORAGE_KEY, "on");
    else storage.removeItem(HTML_INTERNET_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
