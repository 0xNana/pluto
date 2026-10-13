// Allowlist public identifiers; never return event payloads or raw log data.
const fields = Object.freeze(['reportId', 'triggerId', 'parentReportId', 'rootReportId',
  'researcher', 'author', 'payer', 'caller', 'reconstructor', 'reason', 'ok', 'amount',
  'cipherHash', 'keyCommit', 't1', 't2']);

export function publicEventMetadata(log) {
  return { event: log.eventName, transactionHash: log.transactionHash, block: log.blockNumber,
    args: Object.fromEntries(fields.filter(name => Object.hasOwn(log.args ?? {}, name))
      .map(name => [name, log.args[name]])) };
}
