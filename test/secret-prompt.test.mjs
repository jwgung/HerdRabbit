// Ported from herdr-web-ui (MIT).
import test from "node:test";
import { expect } from "./fixtures/expect.mjs";
import { secretPrompt } from "../src/secret-prompt.mjs";

test("recognizes only a short secret request on the last nonempty line", () => {
  for (const prompt of ["[sudo] password for alice:", "alice@server's password:", "Password:", "Password for alice:", "Enter passphrase:", "Enter passphrase for key '/tmp/key':", "Enter PIN:", "Enter PIN for token:", "Repeat password:", "Verify password:", "Confirm password:"]) {
    expect(secretPrompt(`previous output\r\n ${prompt} \r\n\n`)).toBe(prompt);
  }
  for (const screen of ["", "Password?", "Password: y/n", "Enter PIN for y/n:", "Please enter your password:", "Example: Password:", "Password:\n$ ", `Password for ${"x".repeat(120)}:`]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});


test("joins only right-edge continuations of a narrow prompt", () => {
  expect(secretPrompt("Enter passphrase for key '/tmp/my private key for testing\n':\n", 57)).toBe("Enter passphrase for key '/tmp/my private key for testing':");
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", "Enter passphrase for key ".length)).toBe("Enter passphrase for key '/tmp/key':");
  expect(secretPrompt("Enter passphrase for key\n '/tmp/key':", "Enter passphrase for key".length)).toBe("Enter passphrase for key '/tmp/key':");
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", 80)).toBeNull();
  expect(secretPrompt("This is prose that ends\nPassword?", 24)).toBeNull();
});
