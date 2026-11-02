// Preloaded into the proxy process by test/stdio.test.ts (NODE_OPTIONS=--import) as a stand-in for whatever might keep it
// running after its connection to the remote is closed: an open handle that only process.exit() ends. It is not set in the
// process of tsx that starts the proxy, which has to exit when the proxy does.
if (process.argv[1]?.endsWith('index.ts')) setInterval(() => {}, 60_000);
