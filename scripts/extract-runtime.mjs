import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export function extractionCommand(archive, destination, platform = process.platform, env = process.env) {
  let file = 'tar';
  if (platform === 'win32') {
    // Git Bash can put GNU tar first on PATH. It treats D: as a remote host
    // and cannot unpack ZIPs. Windows' bundled bsdtar supports both.
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('An absolute SystemRoot is required to locate Windows tar.exe.');
    file = win32.join(systemRoot, 'System32', 'tar.exe');
  }
  return { file, args: ['-xf', archive, '-C', destination] };
}

export function extractRuntime(archive, destination) {
  const { file, args } = extractionCommand(archive, destination);
  execFileSync(file, args, { stdio: 'inherit' });
}
