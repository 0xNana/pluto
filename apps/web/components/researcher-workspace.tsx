import { ReportPreparation } from './researcher/report-preparation';
import { SealConfiguration } from './researcher/seal-configuration';
import { DisclosureReview } from './researcher/disclosure-review';
import { PrivateRecovery } from './researcher/private-recovery';
import { FundingFollowUp } from './researcher/funding-follow-up';
import { PrivateNoticeDelivery } from './researcher/private-notice-delivery';
import { RESEARCHER_STAGES } from '../../../packages/web/researcher-steps';

export function ResearcherWorkspace() {
  return (
    <section id="researcher" className="workspace" aria-labelledby="researcher-title">
      <div className="researcher-heading">
        <div className="section-heading">
          <h2 id="researcher-title" tabIndex={-1}>Researcher workspace</h2>
          <p>Encrypt your report, review costs and share a verified notice.</p>
        </div>
        <div className="researcher-tools" role="group" aria-label="Researcher tasks">
          <button id="researcher-new" type="button" aria-pressed="true">New disclosure</button>
          <button id="researcher-saved" type="button" aria-pressed="false">Saved report</button>
        </div>
      </div>
      <ol className="researcher-steps" aria-label="Disclosure steps">
        {RESEARCHER_STAGES.map((stage, index) => (
          <li key={stage.id} id={stage.progress}>
            <button id={`researcher-${stage.id}`} type="button" aria-current={index === 0 ? 'step' : undefined}
              aria-controls={`researcher-${stage.id}-panel`}>
              <span className="researcher-step-number" aria-hidden="true">{index + 1}</span>
              <span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
            </button>
          </li>
        ))}
      </ol>
      <div className="researcher-layout">
        <div className="researcher-flow">
          <div id="researcher-prepare-panel" className="researcher-stage" aria-labelledby="prepare-title"><ReportPreparation /></div>
          <div id="researcher-seal-panel" className="researcher-stage" aria-labelledby="seal-title" hidden><SealConfiguration /></div>
          <div id="researcher-review-panel" className="researcher-stage" aria-labelledby="review-title" hidden><DisclosureReview /></div>
          <div id="researcher-share-panel" className="researcher-stage" aria-labelledby="delivery-title" hidden><PrivateNoticeDelivery /></div>
          <div id="researcher-recovery-panel" className="researcher-stage" aria-labelledby="researcher-recovery-title" hidden>
            <div className="section-heading">
              <h3 id="researcher-recovery-title" tabIndex={-1}>Continue a saved report</h3>
              <p>Restore a private file or a report saved in this browser. Inspect existing attempts before sending anything again.</p>
            </div>
            <div className="researcher-recovery-grid"><PrivateRecovery /><FundingFollowUp /></div>
          </div>
          <div id="researcher-stage-controls" className="researcher-stage-controls">
            <p id="researcher-task-status" className="hint" role="status" aria-live="polite">Browse any section. Encrypt your report before storing and sealing.</p>
            <div className="actions">
              <button id="researcher-back" className="secondary" type="button" hidden>Back</button>
              <button id="researcher-next" type="button">Continue to store &amp; seal</button>
            </div>
          </div>
        </div>
        <aside className="researcher-support card" aria-label="Current report">
          <p className="eyebrow">Current report</p>
          <p id="researcher-report-state">Choose a report to begin.</p>
          <dl className="researcher-report-facts"><dt>Report ID</dt><dd id="researcher-report-id">No report prepared</dd></dl>
          <button id="save-recovery" className="secondary" type="button" disabled>Download private recovery</button>
          <p className="hint">Save the latest file after each step. Pluto cannot restore your keys.</p>
          <button id="researcher-continue" className="secondary" type="button">Prepare a report</button>
          <p id="report-status" className="status" role="status" aria-live="polite" tabIndex={-1}>No report prepared.</p>
          <p id="posting-status" className="status" role="status" aria-live="polite" tabIndex={-1}>Prepare and review your report before submitting.</p>
        </aside>
      </div>
    </section>
  );
}
