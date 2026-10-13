export function PrivateNoticeDelivery() {
  return (
    <section className="card delivery-panel" aria-labelledby="delivery-title"><h3 id="delivery-title" tabIndex={-1}>Share a bound report privately</h3><p>After binding, you may share a decryptable copy with a verified contact. The key is encrypted locally to the selected contact; Pluto stores the signed notice and encrypted attachment.</p>
      <div className="field-pair"><div><label htmlFor="recipient-domain">Affected protocol domain</label><input id="recipient-domain" autoComplete="off" placeholder="protocol.example" /></div><div className="align-end"><button id="load-contacts" className="secondary" type="button" data-requires="recipient-domain">Load verified contacts</button></div></div>
      <label htmlFor="recipient-contact">Verified contact key</label><select id="recipient-contact" aria-describedby="contact-fingerprint"><option value="">No verified contact loaded</option></select><p id="contact-fingerprint" className="hint">Confirm the fingerprint with the recipient.</p>
      <label className="check"><input id="fingerprint-confirmed" type="checkbox" />I confirmed this contact key fingerprint.</label><label className="check"><input id="include-report" type="checkbox" />Include the report as well as its key in the encrypted attachment.</label>
      <label className="check"><input id="delivery-approved" type="checkbox" />I approve sharing a decryptable copy with this selected contact.</label>
      <div className="actions"><button id="export-delivery" className="secondary" type="button" disabled>Export encrypted notice</button><button id="send-delivery" type="button" disabled>Send to verified inbox</button></div>
      <p id="delivery-status" className="status" role="status" aria-live="polite">A bound, signed notice and explicit sharing consent are required.</p>
    </section>
  );
}
