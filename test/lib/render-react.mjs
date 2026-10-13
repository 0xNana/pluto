import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export async function renderComponent(entry, name, props = {}) {
  await mkdir(resolve('artifacts'), { recursive: true });
  const dir = await mkdtemp(resolve('artifacts/next-react-test-'));
  try {
    const module = join(dir, 'workspace.mjs');
    const result = await build({ entryPoints: [entry], bundle: true,
      platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', write: false,
      // Static React rendering must not initialize browser-only controllers or
      // AppKit. The real browser bundle is compiled by the Next build checker.
      external: ['../generated/controller.mjs', './appkit-modal'], logLevel: 'silent' });
    await writeFile(module, result.outputFiles[0].text);
    const component = (await import(pathToFileURL(module).href))[name];
    return renderToStaticMarkup(createElement(component, props));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

