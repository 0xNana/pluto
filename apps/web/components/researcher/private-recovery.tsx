export function PrivateRecovery() {
  return (
    <details className="card recovery-panel" id="private-recovery"><summary>Restore private recovery</summary>
          <p>These files never leave this browser. Earlier browser and CLI formats require their original workflow.</p>
          <label htmlFor="recovery-file">Private browser recovery file</label><input id="recovery-file" type="file" accept="application/json,.json" /><button id="import-recovery" className="secondary" type="button" data-requires="recovery-file">Import recovery</button>
          <label htmlFor="local-report-id">Locally saved report ID</label><input id="local-report-id" autoComplete="off" /><button id="load-local-recovery" className="secondary" type="button" data-requires="local-report-id">Restore from this browser</button>
          <button id="inspect-recovery" className="secondary" type="button" disabled>Inspect self-funded receipts</button>
          <pre id="recovery-history" tabIndex={0} aria-label="Private recovery history">No attempt recorded.</pre><div id="recovery-costs" className="facts"><p className="empty">Inspect receipts before reviewing a missing binding.</p></div>
          <label className="check"><input id="recovery-resaved" type="checkbox" />I downloaded and securely saved my current recovery history.</label><button id="review-recovery" className="secondary" type="button" disabled>Review missing binding</button>
          <div id="recovery-confirmation" hidden><p className="critical">Binding completes the existing immutable deadline and never posts another report.</p><label className="check"><input id="binding-confirmed" type="checkbox" />I confirm binding this existing trigger and its deadline.</label><button id="resume-binding" type="button" disabled>Sign missing self-funded binding</button></div>
          <p id="recovery-status" className="status" role="status" aria-live="polite">No recovery restored.</p>
        </details>
  );
}
