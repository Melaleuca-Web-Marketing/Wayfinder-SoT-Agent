import { build } from 'esbuild';
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const entryPoint = path.resolve(__dirname, '../src/app.ts');
const outDir = path.resolve(__dirname, '../dist/serverless');
const outFile = path.join(outDir, 'app.mjs');
const clientDist = path.resolve(__dirname, '../client/dist');
const serverlessClientDir = path.join(outDir, 'client');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const buildResult = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  outfile: outFile,
  packages: 'external',
  sourcemap: false,
  logLevel: process.env.ESBUILD_LOG_LEVEL ?? 'info',
  write: false,
});

const bundledOutput = buildResult.outputFiles?.[0];
if (!bundledOutput) {
  throw new Error('Failed to generate serverless bundle.');
}

let source = bundledOutput.text.replace(
  /export\s*\{\s*createApp,\s*app_default as default\s*\};/,
  'export { createApp };',
);

const augmentedSource = `${source}\nconst app = createApp();\nconst handler = (req, res) => app(req, res);\nexport default handler;\n`;
await writeFile(outFile, augmentedSource, 'utf8');

try {
  await access(clientDist, fsConstants.F_OK);
  await cp(clientDist, serverlessClientDir, { recursive: true });
  console.log(`Copied client assets -> ${path.relative(process.cwd(), serverlessClientDir)}`);
} catch (error) {
  if ((error?.code ?? '') === 'ENOENT') {
    console.warn('Client build output not found; skipping copy to serverless bundle.');
  } else {
    throw error;
  }
}

const demoDir = path.resolve(__dirname, '../demo');
const serverlessDemoDir = path.join(outDir, 'demo');
try {
  await access(demoDir, fsConstants.F_OK);
  await cp(demoDir, serverlessDemoDir, { recursive: true });
  console.log(`Copied demo assets -> ${path.relative(process.cwd(), serverlessDemoDir)}`);
} catch (error) {
  if ((error?.code ?? '') === 'ENOENT') {
    console.warn('Demo directory not found; skipping copy to serverless bundle.');
  } else {
    throw error;
  }
}

console.log(`Bundled serverless entry -> ${path.relative(process.cwd(), outFile)}`);
