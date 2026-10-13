import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { SEPOLIA_CONFIG } from '../config/deployment.mjs';

const failures = [];
let files = 0;
for (const directory of ['config', 'src', 'scripts', 'packages', 'contracts', 'apps']) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (/(?:^|\/)(?:node_modules|\.next|out|generated)(?:\/|$)/.test(entry.parentPath)) continue;
    if (!entry.isFile() || !/\.(mjs|mts|ts|tsx|sol)$/.test(entry.name)) continue;
    const path = `${entry.parentPath}/${entry.name}`, source = await readFile(path, 'utf8'); files++;
    if (entry.name.endsWith('.sol')) {
      if (/\b(?:event|function)\s+(?:SharePosted|TriggerPosted|TriggerResolved|HookInvoked|postingParties|triggerMeta|hookMeta)\s*\(/.test(source)) failures.push(`${path}: hand-declared SDK interface`);
      continue;
    }
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (/^0x[a-fA-F0-9]{40}$/.test(node.text) && !(path.endsWith('config/deployment.mjs') && node.text === SEPOLIA_CONFIG)) failures.push(`${path}: deployment address literal`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['parseAbi', 'parseAbiItem'].includes(node.expression.text)) failures.push(`${path}: hand-parsed ABI`);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const name = node.moduleSpecifier.text;
        if (name.startsWith('@nillion/covenants-sdk/') && !['@nillion/covenants-sdk/browser', '@nillion/covenants-sdk/package.json'].includes(name)) failures.push(`${path}: unsupported SDK deep entry`);
        if (/packages\/(?:portal|planner|relayer|keeper)\//.test(path) && /report-crypto|sealing\.mts/.test(name)) failures.push(`${path}: server imports report secrets`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
for (const failure of failures) console.error(failure);
console.log(`Protocol static checks: ${files} source files; ${failures.length} violations (C0 literals, SDK interfaces/entries, server secret imports)`);
console.log('Scope: source literals and imports only; private environment, live protocol values, data flow, escrow, committee and window behavior require separate tests/review.');
if (failures.length) process.exitCode = 1;
