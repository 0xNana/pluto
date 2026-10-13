# Pluto

Pluto is a vulnerability disclosure workspace built on Nillion Covenants.
Independent researchers prepare encrypted reports and choose an immutable public
release window. Protocol teams receive private notices and can sponsor submission
without gaining control of the report key or deadline. Public readers can verify
accepted disclosures against on-chain records and decrypt the published report.

**Development status:** Sepolia submission is available through explicit
configuration and opt-in. Production release acceptance is incomplete; this
repository does not establish mainnet readiness or a disclosure-time guarantee.

## Contents

- [How it works](#how-it-works)
- [Capabilities and limits](#capabilities-and-limits)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Architecture](#architecture)
- [Testing and verification](#testing-and-verification)
- [Security and recovery](#security-and-recovery)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## How it works

1. **Prepare locally.** The researcher encrypts a report in the browser with a
   random 32-byte key. Private recovery includes the independent report author key.
2. **Store ciphertext.** The client uploads encrypted bytes to separately configured
   providers and retrieves each copy to verify its hash. Pluto's server receives
   neither report plaintext nor its decryption key.
3. **Seal a release.** The client seals only `K || reportId` to a live Covenants
   committee. The condition is a public time window; the report remains encrypted.
4. **Review and submit.** The researcher saves recovery, reviews current fees,
   escrow and transaction gas, then confirms the irreversible deadline. Submission
   registers the commitments, posts the trigger and binds it to the registry.
5. **Notify the protocol.** A signed notice and optionally a client-encrypted
   attachment identify the report and its verified binding. Contact fingerprint
   confirmation precedes private sharing.
6. **Verify disclosure.** When the committee reveals, the registry authenticates
   the caller, posting author, binding and key commitment. Its accepted disclosure
   event and state provide the basis for public verification and local decryption.

The opening window is immutable after posting. Committee health, the gas ceiling
and chain conditions affect liveness. A market acknowledgement alone is not proof
that the registry accepted a disclosure.

## Capabilities and limits

| Area | Current implementation |
| --- | --- |
| Researcher workspace | Local WebCrypto encryption, SDK sealing, recovery export/import, IndexedDB persistence, ciphertext retrieval checks and reviewed self-funded submission. |
| Protocol workspace | Wallet-based staff authentication, protocol ownership verification, scoped contact/inbox controls and funding request review. Full staff access requires the HTTPS portal. |
| Sponsorship | Signed researcher authorization, dedicated payer, durable budget reservations, exact signed upload retry and existing-post binding recovery. Requires configured portal funding. |
| Public verifier | Chain-derived disclosure checks, commitment validation, ciphertext retrieval and local authenticated decryption. |
| Monitoring | Read-only archive watcher, durable scan cursor and local alert queue. External alert delivery is pending. |
| Contracts | DisclosureRegistry, signed registry authorizations and a synthetic HelloRevealHook used for feasibility checks. |

The current local test suite covers these components with local cryptography,
SQLite, EVM execution and injected transports. Real-market acceptance for the
current application, live costs/refunds/hook gas, latest Next browser acceptance,
external storage operations, contact email delivery, backup restoration and
independent release reviews remain incomplete. Pluto does not judge report
severity, guarantee a bounty or provide protection from committee collusion.
Clean-install acceptance and an online dependency advisory review also remain open.

## Quick start

### Requirements

- **Node.js 24.x**, as required by the root `engines` field. The project uses
  native erasable TypeScript and Node's SQLite API.
- **npm** and the committed root `package-lock.json`. Run commands from the
  repository root; `apps/web` is an npm workspace.
- **Chrome or Chromium** for real-browser acceptance. It is not required for the
  local Node test suite.

Solidity compiles through the pinned `solc` npm package. A separate Foundry or
Hardhat installation is not required.

### Install and start

```bash
git clone git@github.com:0xNana/pluto.git
cd pluto
npm ci --ignore-scripts
cp .env.example .env
npm run dev
```

Copy the environment template only on a fresh checkout; preserve an existing
configured `.env`. Install scripts and implicit npm audit are disabled by the
repository's `.npmrc`. Dependency security review is a separate explicit check.

Open **http://localhost:3000**. The landing's **Get started** action opens
`/workspace#researcher`. Protocol intake and public verification use
`/workspace#protocol` and `/workspace#verifier`.

With the empty environment template, development runs as an offline preview.
Local report preparation is available, and wallet connection can be configured
separately. Chain planning, submission and staff authentication require the
configuration described below. `npm run dev` prepares browser assets before
starting Next; restart it after changing configuration or `packages/` controller
source.

## Configuration

Keep credentials in local `.env` or the process environment. Commands that load
`.env` preserve already supplied shell values. `.env.example` is the public
template; private environment files are ignored by Git.

### Connected Sepolia workspace

Configure all five fields to connect the Next development planner:

| Variable | Purpose |
| --- | --- |
| `RPC_URL` | Server-side Sepolia RPC. Use archive access for historical verification and `eth_simulateV1` support for sequential cost simulation. |
| `PUBLIC_RPC_URL` | Explicitly public HTTPS RPC delivered to the browser. It must support browser CORS and contain no private credentials. |
| `EXPECTED_MARKET` | Current published TriggerMarket address used to check C0-resolved routing. |
| `REGISTRY_ADDRESS` | Existing Pluto **DisclosureRegistry** deployment matching the compiled contract and current market. This is not Covenants' NodeRegistry. |
| `REGISTRY_FIRST_BLOCK` | Unsigned decimal deployment block of that DisclosureRegistry, used for complete event scans. |

Addresses are supplied operationally. Source code pins ProtocolConfig C0 and
resolves protocol modules through the SDK; do not add a cached deployment-address
file. Check the current [Nillion contract documentation](https://docs.nillion.com/blacklight/l1/contracts)
before selecting an expected market.

`SEPOLIA_SUBMISSIONS=false` is the default. Set it to `true` explicitly to allow
guarded Sepolia submission. Missing fields with opt-in enabled fail startup.
Without opt-in, incomplete development configuration keeps the preview offline.
Startup and planning send no transactions; the submission action does.

Development binds HTTP loopback only. `DEV_ORIGIN` defaults to
`http://localhost:3000`; it can select another loopback host/port. The local backend
exposes only runtime and planning through `/api/runtime` and `/api/plan`.
It does not implement staff authentication or sponsored execution. The Next child
does not inherit `RPC_URL`, `AUTHOR_KEY` or `RELAYER_KEY`.

### Wallet connection and report funding

Set `PROJECT_ID` to your public Reown project identifier and allow the actual app
origin in that project's dashboard. Restart development or rebuild after changing
it. The header prioritizes installed MetaMask/Rabby and provides AppKit selection
for other wallets. A wrong network triggers a Sepolia switch request; a refusal
keeps dependent wallet actions blocked.

**The header wallet and the report author are separate identities.** Self-funded
reports use the independent author retained in private browser recovery. Fund the
report author address with Sepolia ETH and the canonical NIL token resolved from
C0. The submission flow checks funds and fresh SDK quotes, uses reviewed gas/fee
caps, and requires saved recovery plus both deadline confirmations.

### HTTPS portal and sponsorship

Build and serve the exported application with the existing portal API:

```bash
npm run build
npm run serve
```

Configure `PORTAL_ORIGIN` as the public HTTPS origin and `PORTAL_DATA_DIR` as an
existing absolute private directory owned by the service user, with mode `700`.
The listener binds `127.0.0.1`; `PORT` defaults to `8080`. Supply TLS through a
separately managed reverse proxy that preserves the configured public origin.
The portal serves the static Next export and its APIs from that same HTTPS origin.
`next start` is not this repository's production serving path.

Chain-connected portal operation needs the Sepolia configuration above. Staff
sign-in uses signed wallet challenges and secure sessions; wallet connection alone
does not grant protocol membership. Sponsored execution additionally needs
`RELAYER_KEY` and `MAX_CEILING_WEI`, the explicit submission opt-in, authenticated
protocol setup and verified funding deposits. The dedicated payer holds ETH/NIL;
never share its key with a browser or spend from that payer outside its ledger.

`PRIVATE_RETENTION_DAYS` defaults to `90`. Private retention/deletion does not
delete permanent chain commitments or change an already posted deadline.
Email confirmation transport, external alerts and complete operational backup
integration still require implementation and acceptance.

## Commands

### Local development and checks

| Command | Purpose |
| --- | --- |
| `npm run dev` | Prepare browser assets and start the loopback Next development app. Connected planning is configuration-dependent. |
| `npm run check` | Check source syntax/imports and strict root/Next TypeScript. |
| `npm run typecheck` | Run both TypeScript checks. |
| `npm run lint` | Enforce AST checks for explicit `any`, empty catches and direct secret output. |
| `npm run safety` | Run static deployment, SDK interface/import and server-secret boundary checks. |
| `npm test` | Run the local Node test suite. |
| `npm run build` | Compile Solidity, export Next, and verify allowlisted assets/CSP through the portal handler. |
| `npm run build:next` | Build the Next/browser export. |
| `npm run test:next` | Build Next and check its exported portal assets. |
| `npm run verify` | Run check, lint, safety, tests and both production builds. |
| `npm run test:browser` | Build and run isolated Chrome acceptance with synthetic reports/funding and real IndexedDB; no chain sends or `.env` loading. |
| `npm audit --json` | Request dependency advisory results. Network failure is an unavailable result, not a clean audit. |

Set `CHROME_BIN` if Chrome's executable is not discovered automatically. Browser
acceptance saves its public result under `artifacts/browser-acceptance/result.json`.

### Chain tools

| Command | Behavior |
| --- | --- |
| `npm run probe:sepolia` | Read-only SDK/deployment/committee/limits/escrow/event probe; records sanitized evidence. |
| `npm run observe:sepolia -- EVIDENCE.json` | Read-only observation of an existing report; `--trace-hook` requests callback tracing. |
| `npm run keeper -- --help` | Show the read-only archive watcher options. Requires `MARKET_FIRST_BLOCK` for scans; alerts are queued locally. |
| `npm run researcher -- --help` | Show offline preparation, read/status/verification and transaction commands. |
| `npm run settlement -- --help` | Show independent retry/reconstruction commands that spend a local signer's Sepolia ETH. |
| `npm run spike:sepolia -- hello` / `sponsored` | Synthetic feasibility runs that deploy and submit transactions using `AUTHOR_KEY`. |
| `npm run compare:tlock -- --help` | Show the isolated tlock comparison workflow; its prototype dependency is installed separately. |

Researcher `deploy-registry`, `post`, `retry` and `bind`, settlement execution,
spikes and observer `--settle-expired` **send transactions**. Their explicit CLI
invocation is separate from the browser/portal `SEPOLIA_SUBMISSIONS` flag.
Use dedicated testnet keys and review the installed command's help before running
them. CLI preparation saves local ciphertext; it does not upload or pin it.
No command above establishes permission or readiness for mainnet.

## Architecture

```text
apps/web/            Next.js App Router landing, shell and React workspaces
contracts/           DisclosureRegistry, authorization contracts and hello hook
config/              C0 deployment anchor and product policy defaults
packages/client/     Browser crypto, recovery, notices, sealing and posting
packages/planner/    Stateless live planning and sequential gas-cost simulation
packages/portal/     Wallet sessions, ownership/contact checks, inbox and HTTP API
packages/relayer/    Sponsored requests, spending reservations and reconciliation
packages/keeper/     Archive monitoring, canonical cursor and queued alerts
packages/verifier/   Public chain/commitment/decryption verification
packages/web/        Typed browser controller and migration reference assets
packages/cli/        Guarded independent SDK settlement wrappers
src/                 Shared protocol helpers and CLI chain workflows
scripts/             Build/check tools, executables and acceptance observers
test/                Local SDK, SQLite, EVM, UI and adversarial checks
prototypes/tlock/    Isolated official tlock dependency for comparison
```

The root package is ESM. The browser imports `@nillion/covenants-sdk/browser`;
server-side ABI assets come from the SDK root entry. Solidity compilation uses
solc `0.8.30`, optimizer `200`, and Cancun. Protocol fees, limits and hook settings
come from live reads; admission margins and UX defaults live in
`config/policy.mjs`. Build outputs under `artifacts/`, generated browser assets,
private reports, internal planning documents and agent configuration are ignored.

See the [frontend guide](apps/web/README.md) for shell/component organization.

## Testing and verification

Run `npm run verify` before proposing a behavior change. Use a focused Node test
while iterating, for example:

```bash
node --test --test-isolation=none test/registry.test.mjs
```

The latest recorded local verification on **2026-10-13** passed **215 tests**, strict
type checks, AST lint, protocol static checks, Solidity compilation and a Next
export with 122 manifested assets. This is local evidence, not live acceptance.
The suite uses local WebCrypto/SDK WASM, SQLite and EVM execution, with injected
RPC/HTTP/provider fixtures; it does not send transactions to a live chain.

The latest browser attempt in the restricted workspace stopped at an HTTPS
listener `EPERM` before Chrome started. An earlier external browser run passed its
named storage/recovery checks, but does not establish acceptance of the current
Next revision. Fresh RPC reads in that workspace failed `EAI_AGAIN`. Real-market
acceptance and operational/release review remain separate requirements.

## Security and recovery

- Keep plaintext, decryption keys, author keys, recipient private keys and recovery
  bundles local. Do not upload them to Pluto, include them in issues or send them
  to telemetry/logging providers. Public metadata and encrypted attachments have
  different handling rules.
- Keep a private recovery export and update it after submitted hashes. Browser
  storage can be cleared; IndexedDB is not a substitute for an independent backup.
- Never repeat an unknown transaction to resolve uncertainty. Reconcile its
  canonical receipt and retained journal before completing a missing binding.
- A failed sponsorship upload retains the exact signed request. Retry those bytes;
  do not generate a replacement authorization merely because a response was lost.
- A protocol sponsor cannot cancel, extend or amend a posted deadline. Expired,
  undisclosed reports may be re-armed as a new linked immutable record; the old
  record is not changed.
- Committee threshold collusion can expose the key early. Public shares can enable
  reconstruction before a registry callback. Pluto provides no front-running
  resistance or guaranteed reveal SLA.
- There is no zero-knowledge proof that a privately shared key equals the sealed
  key. Commitment checks do not remove this trust limit.

For a suspected vulnerability, request a private channel from the maintainer or
use GitHub private vulnerability reporting if enabled. Do not publish exploit
details, live reports or credentials in a public issue.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Local encryption works but planning is unavailable | Configure all five chain fields; verify RPC reachability and the application registry; restart `npm run dev`. |
| Submission remains disabled | Check explicit `SEPOLIA_SUBMISSIONS=true`, saved recovery, current costs and both confirmations. The author needs Sepolia ETH/NIL. |
| Staff sign-in unavailable on localhost | Next development has no staff API. Use the configured same-origin HTTPS portal. |
| Wallet connection fails | Check `PROJECT_ID`, allowed origin, extension permissions and actual Sepolia network. A connected wallet is not a staff session. |
| Cost review fails | The RPC must support sequential `eth_simulateV1`; quote/simulation failure blocks posting. Do not replace it with hardcoded gas or escrow. |
| Historical observation is incomplete | Use archive-capable RPC access and the correct deployment start blocks. Use a tracing-capable provider for hook gas measurement. |
| Browser acceptance fails with `EPERM` | Run the command in a browser/socket-capable local terminal or configured runner. No browser acceptance passed if Chrome never started. |
| Output file already exists | Evidence/recovery commands refuse overwrite. Preserve it and use a fresh path; do not erase transaction history to retry. |

## Contributing

Read [CONTRIBUTION.md](CONTRIBUTION.md) for setup, coding rules, verification,
security boundaries and the pull request process. Open an issue for ordinary bugs
or proposals with reproducible, sanitized evidence. Do not attach private reports
or recovery exports.

## License

The project's [package metadata](package.json) declares the **MIT** license.
