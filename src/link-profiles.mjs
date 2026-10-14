import { InputValidationError } from "./herdr-client.mjs";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// A linked server runs its own HerdRabbit, so the only thing worth storing is
// where to reach it. There is no credential here: the leaf identifies its
// caller from the tailnet, so a link profile holds no secret at all.
export function validateLinkProfile(input) {
  const name = input?.name ?? "";
  if (typeof name !== "string" || name.length > 80 ||
      CONTROL_CHARACTERS.test(name) || name.trim() === "") {
    throw new InputValidationError("Enter a name for this server.");
  }

  const address = input?.address ?? "";
  if (typeof address !== "string" || address.length > 512 ||
      CONTROL_CHARACTERS.test(address)) {
    throw new InputValidationError("Enter the HerdRabbit address.");
  }

  let url;
  try {
    url = new URL(address.trim());
  } catch {
    throw new InputValidationError("Enter a full address, such as https://box.tailnet.ts.net:38787");
  }

  // Only the origin is kept. Credentials in the URL would be a secret we said
  // we would not store, and a path or query would silently change every route
  // the client builds on top of it.
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/")) {
    throw new InputValidationError("Enter a full address, such as https://box.tailnet.ts.net:38787");
  }

  return { name: name.trim(), address: url.origin };
}
