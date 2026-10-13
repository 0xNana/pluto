// Keep SDK ABIs and liveness logic; adapt only the provider's log-range limit.
export function withPaginatedEvents(client, { blockSpan = 10n, minimumIntervalMs = 350 } = {}) {
  if (typeof blockSpan !== 'bigint' || blockSpan <= 0n) {
    throw new RangeError('RPC log block span must be a positive bigint');
  }
  if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new RangeError('RPC log request interval must be a nonnegative integer');
  }
  let queue = Promise.resolve();
  const readPage = args => {
    const result = queue.then(() => client.getContractEvents(args));
    const pause = () => new Promise(resolve => setTimeout(resolve, minimumIntervalMs));
    queue = result.then(pause, pause);
    return result;
  };
  return {
    ...client,
    async getContractEvents(args) {
      if (typeof args.fromBlock !== 'bigint' || typeof args.toBlock !== 'bigint') {
        return client.getContractEvents(args);
      }
      const pages = [];
      for (let start = args.fromBlock; start <= args.toBlock; start += blockSpan) {
        const end = start + blockSpan - 1n;
        pages.push(...await readPage({ ...args, fromBlock: start,
          toBlock: end < args.toBlock ? end : args.toBlock }));
      }
      return pages;
    },
  };
}
