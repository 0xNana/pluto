export function ReportPreparation() {
  return (
    <section className="card" aria-labelledby="prepare-title"><h3 id="prepare-title" tabIndex={-1}>1. Encrypt your report</h3>
          <p>Create a fresh author identity. Keep the private recovery file; Pluto cannot restore it.</p>
          <label htmlFor="report-file">Report file or archive <small>Up to 1 MiB. Padded before encryption.</small></label><input id="report-file" type="file" required />
          <button id="encrypt" type="button" data-requires="report-file">Create author &amp; encrypt</button>
          <label htmlFor="author">Author address</label><input id="author" readOnly autoComplete="off" />
        </section>
  );
}
