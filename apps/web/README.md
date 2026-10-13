# Pluto Next.js frontend

Actual Next.js App Router application, scaffolded with create-next-app.
The root `/` is a public product landing with a disclosure flow, role entry points
and an FAQ. **Get started** opens `/workspace#researcher`; protocol intake and public
verification open `/workspace#protocol` and `/workspace#verifier`. The landing is a
Server Component and does not mount wallet, report or private workflow controls.
Native links load the workspace document without requiring client-side routing.
A small compatibility component redirects known old root workspace fragments,
including signed notices pointing at `/#verifier`, to `/workspace`. Unknown
fragments are never forwarded. New notices use `/workspace#verifier`.
React renders the researcher, protocol customer and public verifier workspaces.
The existing typed browser controller retains the cryptographic and recovery
workflows; it mounts after hydration and disposes listeners and pending UI work.
Workspace hashes preserve private state while moving between areas.

From the repository root, install the locked dependencies with `npm ci`, then:

```bash
npm run dev
```

Open http://localhost:3000 for the landing, then choose **Get started**, or go
directly to http://localhost:3000/workspace. The command loads root `.env` and prepares
SDK ABI/registry/WASM assets. With incomplete chain configuration it retains the
offline preview with local encryption and wallet connection. Configure `RPC_URL`,
`PUBLIC_RPC_URL`, `EXPECTED_MARKET`, `REGISTRY_ADDRESS` and `REGISTRY_FIRST_BLOCK`
to connect a local planner. Startup verifies Sepolia/current C0 routing and the
compiled application registry; the browser receives only public chain configuration.
Only `/api/runtime` and `/api/plan` are proxied to a loopback backend. The Next child
does not inherit private RPC_URL, AUTHOR_KEY or RELAYER_KEY.

Set `SEPOLIA_SUBMISSIONS=true` explicitly to allow self-funded browser submission.
The independent report author needs Sepolia ETH and canonical NIL; the header wallet
is a separate connection/staff identity. Recovery save, live cost review and both
irreversibility confirmations remain required. Startup sends no transactions.
Default is read-only; an opt-in with missing deployment fields fails closed.
Staff authentication and sponsored submission require the configured HTTPS portal,
which uses the same submission flag. See [operations](../../docs/operations.md).
Development binds HTTP loopback only (`DEV_ORIGIN`, default http://localhost:3000).
Use the production build for CSP and browser
acceptance. Restart `npm run dev` after changing controller source under
`packages/`: the preparation command regenerates its browser bundle at startup.

```bash
npm run build
npm run serve
```

`build` type-checks and exports the Next app to `apps/web/out`, copies the public
allowlisted assets to `artifacts/web`, and checks their actual portal responses
and CSP hashes without opening sockets or sending chain transactions. `serve`
uses the existing portal configuration in `.env`; see ../../docs/operations.md.
Production hosting serves UI and `/api/*` from one HTTPS origin, retaining staff
session, CSRF, tenant and release guards. The static Next runtime route is preview-only and excluded from the production
portal asset manifest. The portal serves its own `serviceMode:portal` runtime.
There is no second authentication API or Next Server Action that receives report
plaintext or recovery secrets.

```bash
npm run verify
npm run test:browser
```

`verify` covers strict types, AST lint, protocol safety, local tests and the Next
production export. `test:browser` runs actual Chrome with a fresh profile, real
WebCrypto/SDK WASM/IndexedDB and synthetic reports/funding HTTP; it sends no chain
transactions and does not load `.env`. Run it outside a sandbox that prohibits
HTTP/Chrome launches. Previous static-frontend browser evidence does not verify
this new Next build. Sepolia and independent release acceptance remain required;
enabling Sepolia development sends does not establish production acceptance.

Source: `app/page.tsx`, `app/layout.tsx`, `components/*-workspace.tsx`,
`app/globals.css`. `generated/` and SDK files in `public/` are build outputs.
No remote fonts, analytics or remotely hosted browser scripts are used. The
AppKit dependency is bundled locally and loads wallet artwork/relay access after
Connect. Next and
React versions are pinned in package.json and the root package-lock.json.
The earlier HTML/CSS in `packages/web` is a migration regression reference,
not the production frontend entry point. No production deployment was performed.

## App shell organization

```text
app/layout.tsx                         Document, metadata and global styles
app/page.tsx                           Workspace entry point
app/api/runtime/route.ts               Public, read-only standalone preview configuration
components/shell/app-shell.tsx         Header, sidebar, main slot and footer
components/shell/workspace-navigation.tsx  Native named navigation and icons
components/shell/wallet-button.tsx      Single header wallet action
components/shell/app-shell.css         Responsive shell layout using existing tokens
lib/wallet-connector.ts                Lazy AppKit transport for the controller
lib/appkit-modal.ts                    Singleton Sepolia AppKit/Wagmi setup
components/disclosure-workspace.tsx    Page heading/status, features and controller lifetime
components/researcher-workspace.tsx    Independent researcher controls
components/protocol-workspace.tsx      Customer staff intake and funding controls
components/verifier-workspace.tsx      Public verification controls
../../packages/web/workspaces.ts       Shared navigation IDs, labels and audiences
../../packages/web/app.mts             Browser-only workflow state and handlers
../../packages/web/appkit-connection.mts  Picker/account lifecycle and provider handoff
../../scripts/lib/wallet-public-env.mjs   Public-only PROJECT_ID mapping
```

Add shared layout to `AppShell` and feature controls to their workspace component.
The shell accepts `children` and renders one wallet button. Cryptography,
wallet connection, customer-session and funding logic stay in the page-owned
browser controller and its modules. Keep control IDs stable while the native controller owns them.
Use the shared workspace definitions when changing navigation.

The shell keeps the established dark green tokens, a compact header and one named
navigation. At 1024px and above navigation is a sidebar; below that it sits above
the main content. Links retain `#researcher`, `#protocol` and `#verifier`; the
funding deep link and skip link retain their focus behavior. All three workspaces
stay mounted when hidden to preserve in-progress private reports. Do not introduce
a route transition that discards that state without a separate recovery design.

## Researcher workspace organization

The researcher workspace shows one focused stage at a time:

1. **Prepare:** choose a report and create its independent author/key locally.
2. **Store & seal:** set the immutable window, two ciphertext providers and funding
   path, then seal and obtain fresh costs.
3. **Review & submit:** itemized costs, recovery-save acknowledgement and both
   irreversible confirmations.
4. **Share notice:** verified bound notice, selected contact fingerprint and explicit
   sharing consent.

**Saved report** is a separate view for private-file/browser recovery, receipt
inspection and exact funding-request follow-up. It does not start another post.
The persistent **Current report** panel provides the report ID, truthful local
state, recovery download and action messages. Attempted submissions suggest
recovery; sending a notice requires verified binding and consent. Preparation/submission
errors focus the shared status region. No transaction is started by navigation.

Each stage has a short public hash (`#researcher/prepare`, `/seal`, `/review`,
`/share`, `/recovery`). Back/Forward and keyboard activation focus its heading.
All four sections are available for browsing before preparation, including direct
links. Encryption, sealing, costs and consent govern actions within each section.
Workspace changes retain the
current stage. All inputs and consent fields remain mounted; navigation never
places report data in the URL, resets encryption, or changes consent.

`components/researcher-workspace.tsx` composes presentation sections from
`components/researcher/`. `researcher-workspace.css` provides a two-column stepper
on narrow screens, four columns at 768px+, and a report rail beside the active
stage at 1280px+. Storage provider fieldsets share a row at 768px+.
`packages/web/researcher-steps.ts` shares public stage metadata with
`packages/web/researcher-journey.mts`; that native presentation controller reads
readiness from `app.mts` for report status and suggested next actions, without
redirecting the section being browsed. It owns no keys, costs or transaction state.

Local React/DOM tests cover labeled controls, mounted state, unrestricted deep links,
stage navigation, restored-report guidance, cleanup and unchanged submission
guards. `npm run test:browser` now also checks real stage focus/history and draft
retention after synthetic encryption. Run it in a browser-capable environment;
local fixture tests do not verify the visual layout or browser accessibility.

## Wallet connection and portal sign-in

Press **Connect wallet** in the header to connect an installed MetaMask extension
first, or Rabby when MetaMask is absent. Detection uses the AppKit/Wagmi connectors,
not wallet display names. If neither is detected, AppKit opens its wallet picker
for other installed wallets or WalletConnect QR/mobile. Declining an extension
request does not open a different wallet; retry explicitly with the header button.
After connection,
the same button shows a shortened address and opens AppKit's account controls.
Closing those controls preserves the portal session; Disconnect clears the app's
connection and signs out. The header has no custom dropdown or sign-in widget.
If the wallet is on another network, Pluto automatically
requests a switch to Sepolia. Approve that network request in the wallet; it sends
no transaction and does not sign in. Already-connected Sepolia wallets receive no
extra switch request. A wallet that lacks Sepolia may ask to add it first.
If switching is declined or unsupported, press the header wallet button to retry or
switch manually in the wallet. Sign-in stays disabled until the provider confirms
Sepolia. Later account/network changes invalidate sign-in without repeatedly
opening network prompts; press the header wallet button to switch back.
In the HTTPS portal's protocol workspace, select **Sign in with staff wallet**
and approve the portal-only message. **Sign out** is in the same workspace.
Connection by itself grants no private access. Sign-in authenticates the wallet;
protocol membership or a verified domain-ownership enrollment still controls access.
The researcher can continue without connecting, and the report retains its fresh
independent author key when the staff wallet or network changes.

Set `PROJECT_ID` in the repository-root `.env` to your public Reown project ID,
then restart `npm run dev`. `NEXT_PUBLIC_REOWN_PROJECT_ID` in the environment
takes precedence. Only that identifier is exported; RPC URLs and signing keys
are excluded. Add your served origin to the project's Reown dashboard allowlist.
Without an ID, the skill's public example is restricted to loopback development;
deployed origins reject it. Production changes require a rebuild because the ID
is included at build time.

`apps/web/lib/wallet-connector.ts` loads AppKit only on Connect; its modal is
initialized once at module scope with the Wagmi adapter and Sepolia only.
The extension shortcut waits for SDK initialization and calls that same adapter's
public `connect` API; its account/provider watchers keep AppKit account controls
in sync. Existing connected wallets are reused. A connected account can wait for
a delayed provider even after the picker closes; the connection deadline remains
120 seconds. Picker closure, disposal, timeout, pending requests and rejection
have separate sanitized errors. Real extension acceptance remains unverified.
The installed packages are AppKit/adapter 1.8.24, Wagmi 2.19.5 and React Query
5.104.2; viem remains 2.57.4. Analytics, email/social, smart sessions, send/receive,
swaps, on-ramp, history, automatic reconnect and Base/Coinbase SDK connectors are
disabled. Basic connection mode prevents remote project settings from activating
optional features; Reown authentication and Pay are explicitly disabled too.
The optional MetaMask Connect SDK and Tempo account SDK are excluded
from the build; MetaMask's injected provider still connects normally.
No React Wagmi hooks or cookie hydration are used: the static Next export mounts
the existing native controller after hydration and uses AppKit's programmatic
API. `ssr:true` is retained on the adapter. Wallet state does not create a session.
Development and production use Webpack for the installed SDK's configuration.

`packages/web/wallet-discovery.mts` discovers injected providers through EIP-6963,
with an EIP-1193 `window.ethereum` fallback. Names are untrusted text. AppKit loads
wallet artwork and uses the WalletConnect relay when the picker opens; all
JavaScript stays bundled locally. `wallet-access.mts` uses existing viem for
message signing, validates the origin/account/chain/nonce/expiry before signing,
and confirms the server session after authentication. Client upper expiry bounds
allow 30 seconds of clock skew; server expiry and nonce checks remain strict. It handles declined/pending
requests, account/network changes, disconnect, expiry and controller disposal.
The header wallet action and protocol sign-in buttons share one controller instance.

This uses the existing EIP-191 challenge backend, not ERC-4361 SIWE. Only standard
EOA signatures are supported by its existing recovery verifier. ERC-1271
smart-account authentication and Supabase integration are not implemented.
There is no automatic sign-in prompt, token in browser storage or chain transaction
in this authentication flow. Disconnect clears the AppKit wallet session and the
app connection, and signs out;
extension-level permissions must be revoked through the wallet itself.

`GET /api/auth/session` returns only cookie-bound identity, chain and expiry, or
`authenticated:false`. Tokens remain in Secure/HttpOnly/SameSite=Strict cookies.
In portal mode, a reload restores the server session without prompting the wallet; returning focus
rechecks it. Session mutations are serialized, stale private responses are rejected,
and invalidated identities cannot initiate private reads even if logout fails.
The existing backend still checks tenant authorization on every private request.

`npm run dev` can connect a wallet, but full sign-in needs the configured
same-origin HTTPS portal (`npm run build`, then `npm run serve` behind the configured
HTTPS origin). A standalone Next preview has no private portal API.

The production CSP authorizes exact AppKit theme hashes captured at build time;
it adds only the required relay WebSocket hosts and wallet image origin. No
`unsafe-inline`, `unsafe-eval`, hosted script or auth iframe is allowed. Manifested
in-memory static chunks do not consume the existing API rate limit.

Local coverage uses React markup, injected/modal provider fixtures, real ECDSA verification and
SQLite/Request/Response handlers, not a wallet extension or a live chain. Run
`npm run test:browser` outside the sandbox for the updated production button, layout
and keyboard checks; separately verify connect, decline, sign-in, reload, wallet
switch, wrong network and sign-out using a dedicated test wallet in the served UI.
