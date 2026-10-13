// Public chain checks continue after private metadata renders. Keep concurrency
// bounded and stop scheduling when the account/page generation changes.
export async function readInboxRows<T>(rows: readonly T[], inspect: (row: T) => Promise<void>, current: () => boolean) {
  let offset = 0;
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (current() && offset < rows.length) { const row = rows[offset++]; await inspect(row); }
  }));
}
