// Preloaded into the proxy process by test/stdio.test.ts (NODE_OPTIONS=--import). fetch() reports the request it was asked
// for on stderr and then fails, so a test can see where the proxy goes without the network being involved.
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  process.stderr.write(`[record-fetch] ${init?.method ?? 'GET'} ${url}\n`);
  throw new TypeError('fetch is stubbed by the test');
};
