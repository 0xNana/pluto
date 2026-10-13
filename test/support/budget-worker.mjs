import { parentPort, workerData } from 'node:worker_threads';
import { PortalStore } from '../../packages/portal/store.mts';
import { SponsorBudget } from '../../packages/relayer/budget.mts';

const store = new PortalStore(workerData.path, 'https://pluto.example', 11155111);
const authority = Symbol('trusted-service'), ledger = new SponsorBudget(store, authority);
const gate = new Int32Array(workerData.gate);
Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
Atomics.wait(gate, 1, 0);
try {
  if (workerData.action === 'configure') ledger.configure(workerData.session, 'alpha.example', { ethWei: 500n, nilUnits: 100n, perPostWei: 1000n, perPostNil: 100n });
  else ledger.reserve(authority, workerData.protocolId ?? 'alpha.example', workerData.intent, workerData.pool);
  parentPort.postMessage({ ok: true });
} catch (error) { parentPort.postMessage({ ok: false, reason: error.message }); }
finally { store.close(); }
