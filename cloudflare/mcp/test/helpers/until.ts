/** Polls until the condition holds, and fails if it does not within `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('until(): the condition did not become true in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
