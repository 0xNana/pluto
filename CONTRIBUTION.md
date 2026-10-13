# Contributing to Pluto

Thank you for contributing. Pluto handles encrypted vulnerability reports,
immutable on-chain deadlines and sponsored spending. Changes need reproducible
evidence and must preserve the boundaries between researchers, protocol customers
and public readers.

This guide is self-contained for a public checkout. Internal requirements,
decision records and agent files are intentionally excluded from Git. If a change
depends on unavailable product requirements or release decisions, ask the
maintainer for the relevant context rather than inventing it.

## Start here

1. Read the [README](README.md), particularly configuration, security and the
   distinction between local tests and live acceptance.
2. Review the code and tests for the feature you intend to change. For protocol
   signatures, consult the installed SDK `.d.ts` and exported ABIs before using
   external examples.
3. Open an issue for substantial scope, dependencies, contract changes,
   authentication changes or spending-policy changes. Agree on the intended
   behavior and acceptance evidence before implementing them.
4. Work in a short-lived branch with one coherent purpose.

Protocols are the customers. Researchers are independent authors, and must retain
an unenrolled self-funded path. Pluto does not adjudicate severity or promise
bounties. Do not introduce cancellation or protocol approval over an already
posted release.

## Development setup

Use Node.js **24.x**, npm and the root lockfile:

```bash
git clone git@github.com:0xNana/pluto.git
cd pluto
npm ci --ignore-scripts
cp .env.example .env
git switch -c fix/describe-the-change
npm run dev
```

For a fork, clone your fork's SSH URL instead. Copy the environment template only
when `.env` does not already contain configuration. Root npm commands coordinate
the Next workspace and shared packages; do not create a separate frontend lockfile.

Offline development requires no signing key. Connect the planner or HTTPS portal
using the README's environment instructions when needed. Keep submission disabled
unless your task explicitly requires a reviewed Sepolia send. Mainnet use requires
separate maintainer authorization and release review.

Generated files, local reports, environment secrets and agent directories must
stay out of commits. README files and this contribution guide are public Markdown
exceptions in `.gitignore`. Do not force-add private internal documents.

## Coding conventions

- Use ESM and the established `.mjs`, `.mts` and `.tsx` module boundaries. Keep
  TypeScript erasable where Node executes it directly.
- Use the project's existing abstractions before adding a dependency. Pin any
  approved dependency exactly and update the root lockfile with its review rationale.
- Keep changes focused. Avoid unrelated refactors, mass formatting and generated
  artifacts in the same pull request.
- Preserve strict typing. Do not introduce explicit `any`, suppressions or weaker
  checks to hide a failure.
- Make failure paths observable without exposing secrets. Empty catches are
  prohibited; sanitize RPC/provider errors before presenting or logging them.
- Document consequential decisions and changed behavior in the pull request.
  For maintainers with internal decision records, update those records locally.
  Public documentation must not rely on links to files excluded from the checkout.

## Protocol invariants

### Deployment and SDK interfaces

- Pin only ProtocolConfig **C0** in protocol source. Resolve other protocol modules
  through `resolveAddresses`; do not cache deployment addresses in committed files.
- Before posting, check Sepolia chain ID, the expected current market, the
  compiled application registry and nonempty live candidates. The application
  registry is distinct from the protocol's NodeRegistry.
- Import Covenants ABIs from the SDK. Generate any necessary Solidity market
  interface from those ABIs rather than transcribing signatures.
- Browser code imports `@nillion/covenants-sdk/browser`. Keep SDK root modules
  and signing secrets out of browser bundles; use supported exports only.
- Read protocol fees, limits, hook budgets and retry windows live. Product policy
  belongs in `config/policy.mjs`, with clear separation from chain parameters.

### Sealing and hooks

- Quote escrow with SDK `quoteEscrow`; never replace it with local escrow math.
- Derive the live node pin, filter candidates and use SDK `selectCommittee`.
  Preserve operator diversity and `m > k`; do not build key lists by hand or cache
  the node set.
- Use a time-only PUBLIC condition, `ttl = 0`, and `t1`/`t2` equal to its compiled
  window. Seal the key and report ID, not report plaintext.
- Hook changes must preserve market caller gating, posting-author authentication,
  bound-trigger checks, removal of the final 32-byte nonce, key commitment checks
  and a single accepted disclosure per lineage.
- Preserve non-reverting/idempotent hook behavior, in-contract ACK computation
  and registry acceptance/rejection events. Do not transfer external tokens in
  the hook or treat `HookInvoked.ok` as disclosure success.
- A posted record is immutable. A permitted expiry retry creates a new linked
  record after undisclosed expiry; it never edits or cancels its parent.

### Funding and recovery

- Protocol-funded submission must require no researcher prepayment. Bind the
  author, report terms, hook, payer, authorization nonce and expiry; verify actual
  recorded parties and refund destination.
- Preserve reviewed fee/value/gas caps, fresh fund checks, durable reservations
  and replay protection. Never authorize a send by deleting or weakening ledger
  evidence.
- Persist attempted transitions before broadcast and hashes before waiting for
  receipts. Unknown, unfinalized or orphaned outcomes cannot authorize reposting.
- Preserve the exact signed sponsorship request after upload failure. Lost
  responses require status reconciliation, not replacement authorizations.
- Self-funded reports retain their independent local author. Header wallet
  connection must not silently replace that identity.
- Keep saved-recovery, live-cost review and both irreversible-deadline
  confirmations as independent submission gates.

## Privacy, authentication and UI

Plaintext, `K`, private recovery, author keys and recipient private keys must never
reach Pluto servers, logs, analytics, errors, public issues or pull requests. Use
synthetic reports and fixture keys in tests. The portal stores signed notices,
client-encrypted attachments and permitted metadata; it does not decrypt them.

Every private portal request must authenticate staff and authorize the enrolled
protocol. Treat client-supplied protocol IDs as untrusted. Test cross-tenant
access, contact rotation, stale sessions and ambiguous funding outcomes. Billing
or account disablement must not change existing on-chain disclosure.

The production UI is `apps/web`; shared cryptographic/workflow state lives in
`packages/web` and `packages/client`. Preserve control IDs used by the browser
controller and mounted workspace state while navigating. Validate keyboard access,
focus, accessibility names, narrow layouts and error states when changing UI.
Do not add third-party scripts, analytics or insecure authentication fallbacks.

Notice wording must not demand payment or tie payment to non-disclosure. Changes
to the signed notice template require explicit maintainer review; do not bundle
them into unrelated copy edits.

## Tests and acceptance

During implementation, run focused tests for the affected behavior:

```bash
node --test --test-isolation=none test/registry.test.mjs
npm run typecheck
```

Before requesting review, run:

```bash
npm run verify
```

This includes syntax/import checks, strict types, AST lint, static protocol checks,
local tests, contract compilation, Next export and portal asset/CSP verification.
Use real behavioral assertions rather than tests that only restate implementation.
Do not skip tests, delete assertions or reduce thresholds to make checks pass.
For documentation-only changes, verify paths, commands, links and ignore behavior;
a full application rebuild is not required unless executable behavior changed.

For browser behavior changes, run in a Chrome/socket-capable environment:

```bash
npm run test:browser
```

Set `CHROME_BIN` if required. This command uses synthetic reports/funding HTTP,
real WebCrypto/SDK WASM and IndexedDB; it does not load `.env` or send transactions.
It does not replace real wallet, staff portal, storage-provider or Sepolia acceptance.

Contract tests must cover caller gating, author mismatch, unbound triggers,
tampered keys, wrong lengths, duplicate disclosure, retry lineage, signature
tampering/replay/expiry and gas. Authentication/funding changes need adversarial
scope, reservation, replay and recovery checks.

Any live Sepolia work must be agreed separately and use dedicated funded testnet
keys. Build/test commands do not authorize a deployment or transaction. Record
chain, contract identity, receipt/hash/block references, actual costs/refunds,
latency and callback gas where relevant; do not label mocked EVM results as live
chain evidence. Never use mainnet in automated tests.

## Commits and pull requests

Use descriptive, focused commits, for example:

```text
fix: preserve signed sponsorship request after upload failure
docs: clarify Sepolia workspace configuration
```

Inspect `git diff` and `git status` before committing. Confirm `.env`, private
reports, recovery exports, databases, agent files and generated artifacts are
excluded. Do not force-push a shared branch or mix unrelated changes into the PR.

A pull request should describe:

1. The concrete problem and resulting behavior.
2. Scope, relevant requirement/test IDs when provided, and material trade-offs.
3. Exact commands run and their results, identifying fixtures versus live checks.
4. Unrun checks, remaining limitations and any operational/configuration changes.
5. Sanitized evidence needed to review recovery, access or spending behavior.

Do not claim a feature or milestone is complete from local tests alone when it
requires live acceptance. Write **not run** or **unknown** where evidence is absent.
Independent contract, access and operational reviews remain part of release
acceptance; merging a pull request is not deployment authorization.

## Reporting issues and security concerns

Ordinary bug reports should include the affected revision, Node/npm/browser
versions, reproducible steps, expected versus observed behavior and sanitized
errors. Never include credential-bearing RPC URLs, signing keys, report contents
or recovery files. Screenshots must also exclude sensitive data.

For vulnerabilities, use GitHub private vulnerability reporting if enabled, or
ask the maintainer for a private contact channel without publishing exploit
details. No dedicated security inbox or response SLA is established by this guide.

## License

The repository's package metadata declares MIT. Ensure contributed code and
dependencies can be distributed under the project's declared license; disclose
any incompatible or unclear licensing for maintainer review.
