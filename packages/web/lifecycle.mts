// Keep delayed browser work from starting HTTP after its screen has unmounted.
export function scopedFetch(screen: AbortSignal, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    screen.throwIfAborted();
    const signals = [screen];
    if (init?.signal) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    const response = await fetcher(input, { ...init, signal: AbortSignal.any(signals) });
    screen.throwIfAborted();
    return response;
  };
}
