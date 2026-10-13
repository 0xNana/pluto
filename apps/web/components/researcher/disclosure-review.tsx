export function DisclosureReview() {
  return (
    <section className="card" aria-labelledby="review-title"><h3 id="review-title" tabIndex={-1}>3. Review before signing</h3>
          <div id="costs" className="facts"><p className="empty">Live cost estimates are required before signing.</p></div>
          <p>Nodes pause above the selected basefee ceiling. Committee operators can read the sealed key while pending; public shares can expose it before hook acceptance.</p>
          <p>Download the latest private recovery from the Current report panel before confirming below.</p>
          <label className="check"><input id="recovery-saved" type="checkbox" />I downloaded and securely saved my private recovery file.</label>
          <button id="review" type="button" disabled>Review immutable deadline</button>
          <div id="final-review" hidden><p className="critical">Once posted, this deadline cannot be cancelled, extended or amended.</p>
            <label className="check"><input id="irreversible" type="checkbox" />I understand and confirm this immutable deadline.</label>
            <div className="actions"><button id="post" type="button" disabled>Sign &amp; post self-funded</button><button id="request-sponsorship" type="button" disabled>Release signed funding request</button></div>
          </div>
        </section>
  );
}
