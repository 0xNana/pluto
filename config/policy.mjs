// Product defaults; chain limits and protocol fees must still be read live.
export const policy = Object.freeze({
  marginSecs: 600,
  minimumWindowSecs: 3600,
  defaultWindowSecs: 86400,
  ceilingMultiplier: 2,
  gasHeadroomBps: 12500,
  bindingAttempts: 3,
  privateRetentionDays: 90,
  reportBuckets: Object.freeze([4096, 16384, 65536, 262144, 1048576]),
  committee: Object.freeze({
    1: Object.freeze({ m: 5, k: 3 }),
    11155111: Object.freeze({ m: 3, k: 2 }),
  }),
});
