export function VerifierWorkspace() {
  return (
<section id="verifier" className="workspace" hidden aria-labelledby="verifier-title">
    <div className="section-heading"><p className="eyebrow">Independent verification</p><h2 id="verifier-title" tabIndex={-1}>Check a public record</h2><p>Read the author’s signed notice, verify chain acceptance and commitments, then decrypt locally after disclosure.</p></div>
    <div className="card verifier-panel"><div className="field-pair"><div><label htmlFor="report-id">Report ID</label><input id="report-id" autoComplete="off" /></div><div><label htmlFor="notice-file">Or import a signed notice</label><input id="notice-file" type="file" accept="application/json,.json" /></div></div><button id="verify" type="button">Read &amp; verify</button>
      <p id="verify-status" className="status" role="status" aria-live="polite">No record inspected.</p><dl id="record"></dl><button id="download-report" type="button" hidden>Download verified report</button>
      <p className="hint">Ciphertext URLs come from the researcher. The registry holds commitments and timing, not report files. A hook acknowledgement alone is not proof of accepted disclosure.</p>
    </div>
  </section>
  );
}
