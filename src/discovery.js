import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function discoverLocalPorts() {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    const ports = [...new Set(
      stdout.split('\n')
        .filter((line) => /^Focusrite\s/.test(line))
        .flatMap((line) => [...line.matchAll(/TCP (?:\*|127\.0\.0\.1):(\d+)/g)].map((match) => Number(match[1]))),
    )].sort((left, right) => left - right);
    return { running: ports.length > 0, ports, securePort: ports[0], onboardingPort: ports[1] };
  } catch {
    return { running: false, ports: [] };
  }
}
