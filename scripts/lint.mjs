import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';

const problems = [];
let count = 0;
for (const directory of ['config', 'src', 'scripts', 'packages', 'test', 'apps']) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (/(?:^|\/)(?:node_modules|\.next|out|generated)(?:\/|$)/.test(entry.parentPath)) continue;
    if (!entry.isFile() || !/\.(mjs|mts|ts|tsx)$/.test(entry.name)) continue;
    const path = `${entry.parentPath}/${entry.name}`, source = await readFile(path, 'utf8');
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const report = (node, rule) => { const position = tree.getLineAndCharacterOfPosition(node.getStart(tree)); problems.push(`${path}:${position.line + 1}: ${rule}`); };
    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'Explicit any is forbidden; validate unknown instead');
      if (ts.isCatchClause(node) && node.block.statements.length === 0) report(node, 'Empty catch hides a failure');
      if (ts.isCallExpression(node) && /^(?:console\.(?:log|warn|error|debug|info)|print|diagnostic|process\.(?:stdout|stderr)\.write)$/.test(node.expression.getText(tree))) {
        for (const argument of node.arguments) {
          function secret(child) {
            if (ts.isIdentifier(child) && /^(?:K|plaintext|recipientPrivateKey|recoveryBundle|AUTHOR_KEY|privateKey)$/.test(child.text)) {
              const reference = ts.isPropertyAccessExpression(child.parent) && child.parent.name === child ? child.parent : child;
              const lengthOnly = ts.isPropertyAccessExpression(reference.parent) && reference.parent.expression === reference && reference.parent.name.text === 'length';
              if (!lengthOnly) report(child, 'Secret identifier passed to an output sink');
            }
            ts.forEachChild(child, secret);
          }
          secret(argument);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree); count++;
  }
}
for (const problem of problems) console.error(problem);
console.log(`AST lint: ${count} modules; ${problems.length} violations (explicit any, empty catch, direct secret output)`);
if (problems.length) process.exitCode = 1;
