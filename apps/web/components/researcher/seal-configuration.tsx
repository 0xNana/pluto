export function SealConfiguration() {
  return (
    <section className="card" aria-labelledby="seal-title"><h3 id="seal-title" tabIndex={-1}>2. Store ciphertext &amp; seal the key</h3>
          <fieldset><legend>Disclosure window</legend>
          <div className="field-pair"><div><label htmlFor="release-time">Disclosure opens (UTC)</label><input id="release-time" type="datetime-local" required /></div>
          <div><label htmlFor="window-hours">Window length (hours)</label><input id="window-hours" type="number" min="1" max="8760" defaultValue="24" required /></div></div>
          </fieldset>
          <details open><summary>Two independent ciphertext providers</summary><p>Browser uploads contain ciphertext only. Each provider must allow CORS and retain your file through public disclosure.</p>
            <div className="researcher-providers">
            <fieldset><legend>Provider A</legend><label htmlFor="upload-a">Upload URL</label><input id="upload-a" type="url" required placeholder="https://…" /><label htmlFor="read-a">Retrieval URL</label><input id="read-a" type="url" required placeholder="https://…" /></fieldset>
            <fieldset><legend>Provider B</legend><label htmlFor="upload-b">Upload URL</label><input id="upload-b" type="url" required placeholder="https://…" /><label htmlFor="read-b">Retrieval URL</label><input id="read-b" type="url" required placeholder="https://…" /></fieldset>
            </div>
          </details>
          <fieldset><legend>Funding path</legend>
          <label htmlFor="funding-method">Funding path</label><select id="funding-method" defaultValue="self"><option value="self">Self-funded · independent of enrollment</option><option value="protocol">Protocol-funded · customer approval</option></select>
          <p className="hint">Self-funding uses the report author address from Prepare, independently of the header wallet. That address needs Sepolia ETH and the NIL token resolved in the cost review.</p>
          <div id="sponsor-fields" hidden><label htmlFor="sponsor-domain">Sponsoring protocol domain</label><input id="sponsor-domain" autoComplete="off" placeholder="protocol.example" /><p>Researcher prepayment is zero. A funding request is not a live deadline; finalized binding is required.</p></div>
          </fieldset>
          <div className="actions"><button id="plan" type="button" disabled data-requires="release-time,window-hours,upload-a,read-a,upload-b,read-b">Upload, verify &amp; seal</button>
          <button id="refresh-costs" className="secondary" type="button" disabled>Refresh costs for saved seal</button></div>
          <p className="hint">Refreshing costs preserves the saved seal and window. An active funding request must be withdrawn before choosing self-funding.</p>
        </section>
  );
}
