import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const entryPoint = path.resolve(__dirname, '../src/app.ts');
const outDir = path.resolve(__dirname, '../dist/serverless');
const outFile = path.join(outDir, 'app.mjs');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  outfile: outFile,
  packages: 'external',
  sourcemap: false,
  logLevel: process.env.ESBUILD_LOG_LEVEL ?? 'info',
});

console.log(`Bundled serverless entry -> ${path.relative(process.cwd(), outFile)}`);
