// Runs src/index.mjs as a child that ends itself when its parent lets go of
// the IPC channel, so a test can stop a whole HerdRabbit without a signal.
process.on("disconnect", () => process.exit(0));
await import("../../src/index.mjs");
