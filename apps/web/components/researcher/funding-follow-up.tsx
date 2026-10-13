export function FundingFollowUp() {
  return (
    <details className="card" id="funding-recovery"><summary>Funding request status &amp; recovery</summary>
            <p>Save updated recovery after every step. Retry upload uses the exact signed request. Withdrawal applies only before submission.</p>
            <div className="actions"><button id="sponsorship-status" className="secondary" type="button" disabled>Check request status</button><button id="retry-funding-upload" className="secondary" type="button" disabled>Retry exact saved upload</button>
            <button id="withdraw-sponsorship" className="secondary" type="button" disabled>Withdraw unsubmitted request</button></div>
            <label className="check"><input id="withdraw-confirmed" type="checkbox" />Withdraw this unsubmitted funding request so I can review self-funded continuation.</label>
            <button id="inspect-funded-binding" className="secondary" type="button" disabled>Verify &amp; price missing funded binding</button>
            <div id="funded-binding-costs" className="facts"><p className="empty">Check request status to inspect a funded post.</p></div>
            <label className="check"><input id="funded-recovery-saved" type="checkbox" />I saved the current private recovery file and reviewed the payer’s binding cost.</label>
            <button id="review-funded-binding" className="secondary" type="button" disabled>Review existing funded deadline</button>
            <div id="funded-binding-confirmation" hidden><p className="critical">Only the existing trigger will be bound. No new report is registered or posted, and its deadline cannot change.</p><label className="check"><input id="funded-binding-confirmed" type="checkbox" />I confirm this missing binding and its reviewed cost cap.</label><button id="complete-funded-binding" type="button" disabled>Authorize funded binding</button></div>
          </details>
  );
}
