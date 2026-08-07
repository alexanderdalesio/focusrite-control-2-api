import { env, stderr, stdout } from 'node:process';

function supportsColor(stream) {
  if ('FORCE_COLOR' in env) return env.FORCE_COLOR !== '0';
  if ('NO_COLOR' in env) return false;
  return Boolean(stream.isTTY);
}

export function createStyler(stream = stdout) {
  const enabled = supportsColor(stream);
  const wrap = (codes) => (value) => enabled ? `\u001b[${codes}m${value}\u001b[0m` : String(value);

  return Object.freeze({
    accent: wrap('36'),
    command: wrap('1;36'),
    error: wrap('31'),
    heading: wrap('1'),
    label: wrap('2'),
    success: wrap('32'),
    value: wrap('33'),
    warning: wrap('33'),
  });
}

export const outputStyle = createStyler(stdout);
export const errorStyle = createStyler(stderr);
