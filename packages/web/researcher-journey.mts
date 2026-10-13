import { RESEARCHER_STAGES, type ResearcherStage } from './researcher-steps.ts';
import { node } from './view.mts';

interface Progress {
  encrypted: boolean; sealed: boolean; priced: boolean; attempted: boolean; notice: boolean;
  reportId?: string;
}
type View = ResearcherStage | 'recovery';
// Keep every control mounted. Navigation contains only public stage names and
// never persists report data, changes consent, or starts a workflow action.
export function researcherJourney() {
  // The older standalone HTML remains a regression/reference client.
  if (!document.getElementById('researcher-prepare-panel')) return undefined;
  let progress: Progress = { encrypted: false, sealed: false, priced: false, attempted: false, notice: false };
  let active: View = 'prepare';
  const cleanup: (() => void)[] = [];
  const suggested = (): View => progress.notice ? 'share' : progress.attempted ? 'recovery'
    : !progress.encrypted ? 'prepare' : progress.sealed && progress.priced ? 'review' : 'seal';
  const go = (view: View) => { location.hash = `#researcher/${view}`; };
  const activate = (focus: boolean) => {
    const route = location.hash.slice(1).split('/');
    if (route[0] === 'researcher' && route[1]) {
      const requested = route[1];
      active = requested === 'recovery' ? 'recovery' : RESEARCHER_STAGES.find(stage => stage.id === requested)?.id ?? 'prepare';
    }
    for (const view of [...RESEARCHER_STAGES.map(stage => stage.id), 'recovery']) node(`researcher-${view}-panel`).hidden = view !== active;
    for (const stage of RESEARCHER_STAGES) {
      const button = node<HTMLButtonElement>(`researcher-${stage.id}`);
      button.disabled = false;
      if (stage.id === active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    }
    node('researcher-new').setAttribute('aria-pressed', String(active !== 'recovery'));
    node('researcher-saved').setAttribute('aria-pressed', String(active === 'recovery'));
    const index = RESEARCHER_STAGES.findIndex(stage => stage.id === active);
    node('researcher-stage-controls').hidden = active === 'recovery';
    const back = node<HTMLButtonElement>('researcher-back'), next = node<HTMLButtonElement>('researcher-next');
    back.hidden = index <= 0; back.disabled = index <= 0;
    next.hidden = index === RESEARCHER_STAGES.length - 1;
    const nextStage = RESEARCHER_STAGES[index + 1];
    next.disabled = !nextStage;
    next.textContent = nextStage ? `Continue to ${nextStage.label.toLowerCase()}` : 'Complete';
    node('researcher-task-status').textContent = active === 'recovery' ? 'Restore recovery, then inspect existing attempts before continuing.'
      : active === 'prepare' ? 'Browse any section. Encrypt your report before storing and sealing.'
      : active === 'seal' ? 'A saved seal and fresh costs are required before submission.'
      : active === 'review' ? 'Save recovery and complete both confirmations before submitting.'
      : 'Sharing requires a verified bound notice and your explicit consent.';
    if (focus && route[0] === 'researcher' && route[1]) node(active === 'recovery' ? 'researcher-recovery-title' : RESEARCHER_STAGES.find(stage => stage.id === active)!.heading).focus();
  };
  const onClick = (id: string, job: () => void) => {
    const button = node<HTMLButtonElement>(id); button.addEventListener('click', job);
    cleanup.push(() => button.removeEventListener('click', job));
  };
  for (const stage of RESEARCHER_STAGES) onClick(`researcher-${stage.id}`, () => go(stage.id));
  onClick('researcher-new', () => go(progress.encrypted ? 'seal' : 'prepare'));
  onClick('researcher-saved', () => go('recovery'));
  onClick('researcher-continue', () => go(suggested()));
  onClick('researcher-back', () => { const index = RESEARCHER_STAGES.findIndex(stage => stage.id === active); if (index > 0) go(RESEARCHER_STAGES[index - 1].id); });
  onClick('researcher-next', () => { const index = RESEARCHER_STAGES.findIndex(stage => stage.id === active); if (index >= 0 && index < RESEARCHER_STAGES.length - 1) go(RESEARCHER_STAGES[index + 1].id); });
  return {
    activate,
    update(value: Progress) {
      progress = value;
      node('researcher-report-id').textContent = value.reportId ?? 'No report prepared';
      node('researcher-report-state').textContent = value.notice ? 'Binding verified; signed notice ready.'
        : value.attempted ? 'Submission recorded; inspect recovery for its finalized outcome.'
        : value.sealed ? 'Saved seal available. A live deadline requires finalized binding.'
        : value.encrypted ? 'Encrypted locally. No live deadline.' : 'Choose a report to begin.';
      const target = suggested();
      node('researcher-continue').textContent = target === 'recovery' ? 'Open recovery' : target === 'share' ? 'Share verified notice' : target === 'review' ? 'Open review' : target === 'seal' ? 'Continue preparation' : 'Prepare a report';
      node('step-shared').dataset.ready = String(value.notice);
      activate(false);
    },
    dispose() { for (const remove of cleanup) remove(); },
  };
}
