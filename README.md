# Pluto

Pluto gives protocol security teams a verifiable intake path for timed vulnerability disclosures. Protocols pay for the service; researchers control the report, signing key and disclosure window.

## Implementation status

The owner authorized M2/M3 development while retaining live acceptance as a release blocker. The repository now includes browser crypto/sealing/storage/posting/verifier code, a planner, wallet-authenticated private portal, verified-contact encrypted notice delivery, durable sponsored budgets and submission libraries, an archive watcher and independent settlement CLI. These are locally tested components; production integration remains incomplete. Configured Next development and the HTTPS portal support explicit Sepolia submission opt-in (`SEPOLIA_SUBMISSIONS=true`); the default is read-only. See [configuration and funding](docs/operations.md).

The current [coverage and evidence report](internal-docs/production-status.md) maps every SRS requirement and T-01–T-17, including mocked and unrun integrations. The latest local verification is recorded in [raw output](internal-docs/evidence/production-verify-observer-rpc15-final-20261012.txt). The UI has separate researcher, protocol and verifier workspaces, saved-seal cost refresh after withdrawal, finalized funded-binding recovery, scoped contact/account/inbox controls and structured funding review. Failed uploads preserve the exact signed request; lost approval responses require fresh review. `npm run test:browser` now runs isolated real Chrome/IndexedDB acceptance without chain transactions or `.env`. The owner's external Chrome 155 run passed all 13 automated browser checks, including native skip-link focus, real IndexedDB persistence/cross-tab claims and exact signed-request recovery; the [public result](internal-docs/evidence/browser-acceptance-local-pass-20261012.json) retains `releaseAccepted:false` and explicit synthetic committee/funding fixtures. Remaining manual and live UI checks are open. Follow [ordered acceptance](docs/acceptance-runbook.md) and the [remaining UI matrix](docs/ui-acceptance.md). Live Sepolia, operational acceptance, clean installation and dependency audit remain blockers. See [operations](docs/operations.md), [checklist](tasks/production-todo.md), [decisions](DECISIONS.md), and the authoritative [SRS](SRS.md).

## Development

Use Node 24.x. The root package is ESM; `.mjs` entry points also support embedding in a CommonJS host. SDK/viem and build tools use exact locked versions. See D38/D44 in [DECISIONS.md](DECISIONS.md).

```sh
npm ci --ignore-scripts
npm run verify
npm audit --json
```

Tests use Node's built-in runner with isolation disabled to display every test by name; each EVM fixture has independent state. Tests use local SDK/WebCrypto/SQLite/registry execution and injected RPC/provider transports, not live chain calls. Native JavaScript and erasable TypeScript run on Node 24. `build` compiles Solidity with solc 0.8.30, optimizer 200 and Cancun, and exports the Next.js App Router UI under `artifacts/web/`. The market interface and public ABI assets come from SDK ABIs. `check` verifies syntax/imports and strict types; `lint`/`safety` enforce their documented static rules. Generated artifacts and private environment files are ignored.

For the portal, configure a private data directory and HTTPS public origin from `.env.example`, then run `npm run build` and `npm run serve` behind a separately configured TLS proxy. See the [runbook](docs/operations.md) before operation. `npm run keeper -- --help` describes read-only monitoring; `npm run settlement -- --help` describes independent local SDK settlement. A help result is not live execution evidence.

## Sepolia probe

Set `RPC_URL` to your Sepolia endpoint and `EXPECTED_MARKET` to the current market from the [Nillion Contracts page](https://docs.nillion.com/blacklight/l1/contracts). Run:

```sh
npm run probe:sepolia
npm run probe:sepolia -- --out artifacts/p02/my-probe.json
npm run probe:sepolia -- --event-tx 0xCURRENT_MARKET_TRANSACTION_HASH
```

The script checks the installed SDK version, supported root/browser functions and SDK ABI getters/events. It resolves module addresses from C0, refuses a wrong chain or market and an empty candidate set, checks deployed bytecode and market module consistency, reads live limits, validates public/private wire overhead, selects an SDK committee from the live pin, seals a synthetic 64-byte payload locally, and requests a no-hook escrow quote. The quote is a baseline for M0. It needs no author key and submits no transactions. Probe commands load `.env` through Node; shell variables take precedence. Log scans are paginated for providers with small range limits.

Each run saves per-check evidence under a fresh `artifacts/p02/probe-<uuid>.json`, or a fresh `--out` path, before each stage. Existing output files are refused. Errors preserve completed checks and sanitized error codes, excluding RPC URLs and credentials. The wrong-chain control tests the local guard before any address read; the mismatched-market control compares against live C0 resolution. These controls are labeled separately from actual network inspection.

The probe decodes raw current-market logs from the SDK's bounded liveness scan using the SDK ABI. It verifies recorded public-window fields against their compiled condition and expiry, and saves event names, block/transaction references and IDs without copying layers, shares or revealed plaintext. An empty scan leaves event acceptance pending. Supply `--event-tx` with a successful transaction on the **current** market to verify its receipt's logs; an earlier deployment's transaction cannot satisfy this check. A pruned or missing receipt fails. Exit codes are `0` for passed probe checks, `1` for a failure, and `2` for incomplete event evidence.

Live TTL and hook-retry limits are recorded. `maxTTL` applies to public price-only posts; the SDK ABI exposes no dedicated maximum public time-window getter. The probe roundtrips the product window through SDK compilation and can check an emitted window, while active chain boundary simulations remain P-04 work. A passing read-only probe does not establish sponsorship, release latency, hook execution gas or refunds.

## M0 transaction probes

These commands use synthetic data only. Set `AUTHOR_KEY` to a dedicated Sepolia payer with ETH and NIL on the token resolved from C0. The commands deploy contracts, approve the exact quoted NIL fee, and spend testnet funds:

```sh
npm run spike:sepolia -- hello
npm run spike:sepolia -- sponsored
# Optional: select a fresh evidence file; existing files are refused.
npm run spike:sepolia -- sponsored --out artifacts/m0/sponsored-proof.json
```

`hello` posts a 64-byte payload through `HelloRevealHook`. Both commands first check live deployment/committee/limits, verify deployed runtime against compiled bytecode and the immutable market, then simulate valid posting and invalid windows, TTL, ciphertext size, hook gas and retry limits. Simulations submit no transaction; unexpected reverts or RPC errors fail the proof.

Read-only width probes also record whether a one-second PUBLIC window and a window ending at the uint64 wire boundary are accepted. These probes bypass the product's one-hour minimum only for simulation. A rejected extreme does not establish the exact maximum, and `maxTTL` is not interpreted as a PUBLIC-window width limit.

`sponsored` generates a fresh zero-ETH, zero-NIL researcher locally. It signs registry registration/binding grants and the SDK market grant, rejects changed commitments, windows, identities, payer, hook, nonce, deadline and minimum ceiling, and checks replay rejection after each action. Successful receipts must come from the payer; decoded `Registered`/`Bound` events and registry state must match the researcher and report. The command records the researcher's unchanged funds/transaction count and the actual payer NIL debit. The SDK signs a minimum ceiling; the command separately caps the posted ceiling. Refunds follow the signed payer. The fixed sample report key is public fixture data and must never encrypt a real report. The synthetic author credential is not saved; this command is not a researcher recovery workflow.

Each run writes a fresh mode-600 `artifacts/m0/<mode>-<uuid>.json` before connecting, preserving partial checks and sanitized failure codes even when RPC access fails. Submitted hashes are saved before receipt waits; evidence records gas costs, compiler/SDK versions, commitments, window, committee, escrow and NIL fee. Evidence excludes signing keys, signatures and plaintext. The window opens after 15 minutes and lasts one hour. Posting leaves status `posted-awaiting-observation` and the FR-211 funding decision pending.

Read the output's evidence-file path with:

```sh
npm run observe:sepolia -- artifacts/m0/hello-<uuid>.json
npm run observe:sepolia -- artifacts/m0/hello-<uuid>.json --trace-hook
npm run observe:sepolia -- artifacts/m0/hello-<uuid>.json --settle-expired
```

The observer runs once and independently verifies the post transaction, source block, escrow deposit, current deployment, parties, window and registry receipts. Bounded SDK log scans reject removed/foreign events, check the reveal commitment and hook acceptance, and record share/reveal/acceptance timing against NFR-4's ten-minute target. Refund accounting separates allocation, actual payment, outstanding debt and spent escrow, including later `RefundClaimed` events without counting their allocation twice. These are RPC observations, not finalized chain proofs or an itemized node-fee ledger.

`--trace-hook` requests `debug_traceTransaction` with `callTracer` on the accepted callback transaction, verifies its payload/ACK and records callback execution gas separately from transaction gas. Unsupported tracing is saved as unavailable and exits `2`; use an RPC with tracing to complete that measurement. Retried hooks are measured as retries, whose forwarded gas is uncapped; they do not pass the initial default-budget measurement. Pending reveal and unsettled expiry also exit `2`; failed verification exits `1`.

`--settle-expired` pays gas to settle an expired, unresolved trigger using the recorded payer. Rerun the observer on both reveal and expiry cases. A sponsored proof records an FR-211 `go` only after verified zero-prepayment registration/post/binding, payer receipts and NIL debit, a terminal trigger and a paid refund to that payer. Missing evidence leaves it pending. This synthetic feasibility decision does not pass G1 or authorize product/mainnet rollout; live P-03–P-05 acceptance still requires successful Sepolia evidence.

## M1 researcher CLI

Run `npm run researcher -- --help` for all commands. Preparation is offline and accepts arbitrary report bytes up to 1,048,572 bytes. Supply the public address of the researcher who will register and pay:

```sh
npm run researcher -- prepare --report report.txt --researcher 0xRESEARCHER --out local-reports/report.recovery.json --ciphertext local-reports/report.bin
```

This encrypts locally with AES-256-GCM and fixed-size padding, then prints public commitments. Keep the recovery file private: it contains `K`. Files are created with mode 600 and existing files are refused. Only the ciphertext and public journal metadata belong with a public reader. Preserve the ciphertext separately; this CLI does not yet upload or pin it. See [ADR-0003](docs/adr/0003-local-report-envelope-and-recovery.md) for the versioned format.

Set `RPC_URL`, `EXPECTED_MARKET`, and the researcher's `AUTHOR_KEY` in the environment or `.env`. Transaction commands spend Sepolia ETH and NIL. Deploy the registry once, then use its printed address for future reports:

```sh
npm run researcher -- deploy-registry --journal local-reports/deploy.jsonl
npm run researcher -- post --bundle local-reports/report.recovery.json --registry 0xREGISTRY --t1 UNIX_START --t2 UNIX_END --journal local-reports/report.jsonl
npm run researcher -- status --registry 0xREGISTRY --report-id 0xREPORT_ID
```

Replace placeholders with the deployment address, public report ID and unsigned Unix seconds. Choose `t1` at least 600 seconds after the latest Sepolia block and `t2` at least 3,600 seconds after `t1`; leave extra time for approval, registration, posting and binding to mine. The CLI verifies C0 resolution, current market, live limits/committee and funds, registers, seals only `K || reportId`, approves the finite NIL fee, posts, checks the recorded hook/parties/window/commitment, and binds. It saves transaction hashes before waiting for receipts. The on-chain deadline becomes active only once binding succeeds.

If posting succeeded but the receipt wait or binding failed, recover before `t1` using the same files:

```sh
npm run researcher -- bind --bundle local-reports/report.recovery.json --journal local-reports/report.jsonl
```

`bind` recovers the existing post from its receipt, including trigger ID zero, and submits only a missing binding. It never reposts. Inspect any journaled hash after a failure; do not start a second `post` to resolve an uncertain submission. A run with no submitted post cannot use `bind`; registration/approval recovery remains manual. The linked immutable expiry retry command below still needs live P-08 evidence.

After disclosure, a reader needs only the public journal metadata and ciphertext. No author wallet or recovery file is required:

```sh
npm run researcher -- verify --journal local-reports/report.jsonl --ciphertext local-reports/report.bin --out local-reports/disclosed-report.txt
```

Verification checks the registry's accepted event, bound trigger, ciphertext and key commitments, then authenticates and decrypts locally into a fresh mode-600 output file. Pending disclosure, changed ciphertext and missing/pruned logs fail. Status and verification describe the RPC's observed chain head; this CLI does not claim finalized, independently proven chain state. Journal metadata is unsigned operational evidence, separate from the product's signed notice schema.

After an undisclosed report expires, re-arm it with a new immutable window and a fresh journal:

```bash
npm run researcher -- retry --bundle local-reports/report.recovery.json --parent-journal local-reports/report.jsonl --t1 NEW_START --t2 NEW_END --journal local-reports/retry.jsonl
```

The CLI preserves the original record and ciphertext, seals the linked retry ID, and binds the new trigger. Active or disclosed lineages and altered parent journals are refused. An interrupted retry post can use `bind` with the original recovery bundle and the retry journal; it never registers or posts again.

Measure a bound researcher flow using the observer, including registry receipt verification, release latency, callback gas and refund accounting:

```bash
npm run observe:sepolia -- --journal local-reports/report.jsonl --out local-reports/core-observation.json --trace-hook
```

The journal stays unchanged; subsequent observations use the JSON output as a positional argument. See [core acceptance](internal-docs/core-acceptance.md) for the live scenario matrix and expiry procedure, and [G1 comparison](internal-docs/g1-comparison.md) for the isolated official tlock command. RPC/trace availability and real tlock installation remain acceptance requirements.

## Layout

- `config/policy.mjs`: product defaults, separate from live chain parameters.
- `src/shared/disclosure.mjs`: browser-compatible report ID, payload and time-window helpers.
- `src/shared/report-crypto.mjs`: local report encryption, padding, recovery validation and decryption.
- `src/chain/researcher-flow.mjs`: self-funded posting, binding recovery, status and public verification.
- `src/chain/deployment.mjs`: Sepolia deployment checks.
- `src/chain/deployment-probe.mjs`: staged P-02 compatibility, deployment, quote and event evidence.
- `src/chain/feasibility.mjs`: live limits, SDK committee selection and feasibility checks.
- `src/shared/registry-authorization.mjs`: browser-compatible signed registry grants.
- `contracts/`: immutable registry, authorization validation and synthetic hello-world hook.
- `packages/client/`: browser crypto/sealing/posting, signed notices and encrypted delivery.
- `packages/planner/`: stateless live planning and sequential gas-cost quoting.
- `packages/portal/`: private SQLite, wallet/DNS/contact verification, inbox and HTTP application.
- `packages/relayer/`: signed sponsored submission, durable budgets and final cost/refund accounting.
- `packages/keeper/`: canonical archive cursor, alert queue and guarded settlement library.
- `packages/verifier/`: browser-compatible chain/commitment/decryption checks.
- `apps/web/`: actual Next.js App Router UI with React researcher, protocol and public-verifier components.
- `packages/web/`: typed browser workflow controller and migration HTML/CSS reference.
- `packages/cli/`: independent installed SDK settlement passthroughs.
- `scripts/`: builds/checks, portal/read-only keeper executables, researcher CLI and Sepolia probes/observation.
- `test/`: deterministic helper, SDK sealing, event decoding, authorization and local EVM adversarial tests.
- `docs/adr/`: architecture decisions.
- `internal-docs/`: current coverage/evidence and historical plans/acceptance records; authoritative requirements are at root `SRS.md`.

See [ADR-0002](docs/adr/0002-registry-sponsorship.md) for signed registry grants and [current coverage](internal-docs/production-status.md) for the implemented boundaries and gaps. Expiry retries create linked immutable records under the selected SRS policy. Sponsorship and market-facing features still need live Sepolia proof before production release.

## References

- [Nillion SDK](https://docs.nillion.com/blacklight/l1/sdk) and installed SDK 0.6.1 declarations.
- [Node 24 test runner](https://nodejs.org/docs/latest-v24.x/api/test.html).

## Next.js UI

The frontend is at [`apps/web`](apps/web/README.md). From the repository root:

```sh
npm run dev
```

Open http://localhost:3000 for the Pluto landing. **Get started** opens the
Next development workspace at http://localhost:3000/workspace. Local encryption
remains available offline; complete chain configuration connects the local planner.
Explicit `SEPOLIA_SUBMISSIONS=true` permits guarded self-funded Sepolia submission.
Staff access and sponsored funding require the same-origin HTTPS portal.
`npm run build` exports the Next
app and checks its actual assets through the portal handler. `npm run serve`
serves the exported UI and existing private API together; see
[operations](docs/operations.md). Mainnet and production release acceptance remain gated.

Fresh Next.js browser acceptance requires `npm run test:browser`. Earlier
static-frontend browser results do not establish acceptance of this migration.

Shared framing and navigation live in `apps/web/components/shell`. Feature screens
compose inside the shell and stay mounted when switching workspaces. See the
[frontend organization guide](apps/web/README.md#app-shell-organization).
