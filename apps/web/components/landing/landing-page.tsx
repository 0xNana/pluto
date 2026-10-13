import { LegacyWorkspaceLinks } from './legacy-workspace-links';

const steps = [
  { title: 'Prepare in private', text: 'Encrypt your report locally and save your recovery file. Your report has its own author identity, independent of your wallet.' },
  { title: 'Commit to a window', text: 'Choose the release window, review costs and confirm the deadline. Once posted and bound, the record cannot be changed.' },
  { title: 'Notify, then verify', text: 'Share a signed notice with a verified protocol contact. After disclosure, anyone can check the public record and decrypt the report.' },
];

export function LandingPage() {
  return (
    <div className="landing-page" id="top">
      <LegacyWorkspaceLinks />
      <a className="skip" href="#landing-main">Skip to content</a>
      <header className="landing-header landing-width">
        <a className="brand" href="/" aria-label="Pluto home">pluto<span className="orbit" aria-hidden="true">◌</span></a>
        <nav aria-label="Landing navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#for-teams">For teams</a>
          <a href="#questions">FAQ</a>
        </nav>
        <a className="landing-button landing-button-outline" href="/workspace#researcher">Open app <span aria-hidden="true">↗</span></a>
      </header>
      <main id="landing-main" tabIndex={-1}>
        <section className="landing-hero landing-width" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="eyebrow">Verifiable vulnerability disclosure</p>
            <h1 id="landing-title">Time to fix.<br /><span>A record to trust.</span></h1>
            <p className="landing-lead">Bring researchers and protocol teams together through encrypted reports, clear release windows and independent verification.</p>
            <div className="landing-actions">
              <a className="landing-button" href="/workspace#researcher">Get started <span aria-hidden="true">↗</span></a>
              <a className="landing-text-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
            </div>
            <p className="landing-caption">Start locally. No account or wallet needed to encrypt a report.</p>
          </div>
          <figure className="landing-lifecycle" aria-labelledby="lifecycle-caption">
            <figcaption id="lifecycle-caption"><span>From private report to public proof</span><span className="landing-diagram-label">Disclosure flow</span></figcaption>
            <ol>
              <li><span className="landing-marker" aria-hidden="true">01</span><div><strong>Encrypted report</strong><p>Prepare locally. Keep your recovery keys.</p></div><span className="landing-flow-tag">Private</span></li>
              <li><span className="landing-marker" aria-hidden="true">02</span><div><strong>Committed release window</strong><p>Post and bind an immutable record.</p></div></li>
              <li><span className="landing-marker" aria-hidden="true">03</span><div><strong>Verified private notice</strong><p>Give the protocol team time to respond.</p></div></li>
              <li><span className="landing-marker" aria-hidden="true">04</span><div><strong>Public disclosure</strong><p>Check the commitment and released report.</p></div><span className="landing-flow-tag">Public</span></li>
            </ol>
            <p className="landing-diagram-note">Protocol funding does not give the payer control of the report or its posted deadline.</p>
          </figure>
        </section>

        <section id="how-it-works" className="landing-section landing-width" aria-labelledby="how-title">
          <div className="landing-section-heading"><p className="eyebrow">How it works</p><h2 id="how-title">A clear path from finding to disclosure.</h2></div>
          <ol className="landing-process">
            {steps.map((step, index) => <li key={step.title}><span className="landing-process-number">0{index + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}
          </ol>
        </section>

        <section id="for-teams" className="landing-section landing-width" aria-labelledby="teams-title">
          <div className="landing-section-heading"><p className="eyebrow">One protocol. Independent roles.</p><h2 id="teams-title">Choose where you come in.</h2></div>
          <div className="landing-role"><div><p className="landing-role-label">01 / Researchers</p><h3>Keep authorship. Set the terms.</h3></div><p>Prepare a report, choose its release window and keep a recovery copy. Disclose independently through self-funding, or request protocol funding.</p><a className="landing-text-link" href="/workspace#researcher">Prepare a report <span aria-hidden="true">↗</span></a></div>
          <div className="landing-role"><div><p className="landing-role-label">02 / Protocol teams</p><h3>Build a trusted intake channel.</h3></div><p>Verify your protocol identity, publish a contact key and manage private notices and funding requests. Paying for intake never buys control of a posted deadline.</p><a className="landing-text-link" href="/workspace#protocol">Open protocol intake <span aria-hidden="true">↗</span></a></div>
          <div className="landing-role"><div><p className="landing-role-label">03 / Public verifiers</p><h3>Check the record yourself.</h3></div><p>Inspect the registry and disclosure events, verify the report commitment and decrypt the released ciphertext without a protocol account.</p><a className="landing-text-link" href="/workspace#verifier">Verify a report <span aria-hidden="true">↗</span></a></div>
        </section>

        <section className="landing-principles" aria-labelledby="principles-title">
          <div className="landing-width landing-principles-inner"><div><p className="eyebrow">Independent by design</p><h2 id="principles-title">Funding supports the process.<br />It does not control the outcome.</h2></div><ul><li>Pluto never receives your plaintext report or encryption key.</li><li>A posted deadline cannot be cancelled, extended or amended.</li><li>Public verification checks chain evidence, not a platform promise.</li></ul></div>
        </section>

        <section id="questions" className="landing-section landing-width landing-faq" aria-labelledby="questions-title">
          <div className="landing-section-heading"><p className="eyebrow">Before you begin</p><h2 id="questions-title">A few things to know.</h2></div>
          <div className="landing-answers">
            <details><summary>Do I need a wallet or account?</summary><p>You can encrypt a report and save private recovery without either. Protocol staff connect a wallet and sign in to manage intake. Each report uses an independent author key.</p></details>
            <details><summary>Can a protocol stop a posted disclosure?</summary><p>No. Once the trigger is posted and bound, protocol funding, account changes and billing cannot cancel, extend or amend it. Review the release window carefully before submitting.</p></details>
            <details><summary>What are the trust assumptions?</summary><p>Pluto does not hold your report key. A threshold committee holds the sealed key and participates in its release. Committee operators must be trusted not to release it early; Pluto does not guarantee privacy against those operators or protection from front-running.</p></details>
            <details><summary>What does it cost?</summary><p>Costs depend on live protocol fees, escrow and transaction gas. The workspace itemizes costs and identifies the payer before you confirm. A funding request needs protocol approval.</p></details>
            <details><summary>How do I submit a report?</summary><p>Prepare your report, save private recovery and review the live costs in the workspace. Confirm the immutable deadline before submitting on Sepolia. Self-funded reports use the report author address; protocol funding requires approval. Pluto does not judge severity or guarantee a bounty.</p></details>
          </div>
        </section>

        <section className="landing-start landing-width" aria-labelledby="start-title"><div><p className="eyebrow">Your next step</p><h2 id="start-title">Start with your report.</h2><p>Explore every step before committing to a release window.</p></div><a className="landing-button" href="/workspace#researcher">Get started <span aria-hidden="true">↗</span></a></section>
      </main>
      <footer className="landing-footer landing-width"><a className="brand" href="/" aria-label="Pluto home">pluto<span className="orbit" aria-hidden="true">◌</span></a><p>Independent reports. Verifiable disclosure.</p><a href="/workspace#verifier">Public verifier</a><a href="#top">Back to top ↑</a></footer>
    </div>
  );
}
