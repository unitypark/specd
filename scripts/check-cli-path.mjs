import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `go install` drops the binary in GOBIN (or GOPATH/bin). That directory is
 * often not on PATH, and a CLI you cannot type is a CLI that does not work —
 * so say exactly what to do rather than leaving the user to discover it.
 */
const gobin =
  execSync('go env GOBIN', { encoding: 'utf8' }).trim() ||
  join(execSync('go env GOPATH', { encoding: 'utf8' }).trim(), 'bin');

const binary = join(gobin, 'specd');

if (!existsSync(binary)) {
  console.error(`go install finished but ${binary} is missing.`);
  process.exit(1);
}

let onPath = false;
try {
  const resolved = execSync('command -v specd', { encoding: 'utf8', shell: '/bin/sh' }).trim();
  onPath = resolved.length > 0;
  console.log(`installed → ${binary}`);
  if (resolved !== binary) {
    console.log(`note: \`specd\` on your PATH resolves to ${resolved}`);
  }
} catch {
  onPath = false;
}

if (!onPath) {
  console.log(`installed → ${binary}`);
  console.log('');
  console.log(`\`specd\` is not on your PATH yet. Add it:`);
  console.log('');
  console.log(`  export PATH="${gobin}:$PATH"`);
  console.log('');
  console.log('Add that line to your shell profile to make it stick, or run the');
  console.log('binary directly as ./bin/specd after `pnpm cli:build`.');
}
