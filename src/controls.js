export const CONTROLS = Object.freeze({
  dim: control('boolean', 4117, 'Monitor Dim', ['monitor.dim']),
  'monitor-mute': control('mute', 4116, 'Monitor Mute', ['mute', 'monitor.mute']),
  'monitor-gain': control('gain', 4118, 'Monitor Level', ['volume', 'monitor.level'], { min: -80, max: 6, step: 0.5, unit: 'dB' }),
  'input1-gain': control('gain', 4127, 'Input 1 Gain', ['input1.gain', 'input.1.gain'], { min: 0, max: 69, step: 0.5, unit: 'dB' }),
  'input1-air': control('boolean', 4134, 'Input 1 Air', ['input1.air', 'input.1.air']),
  'input1-phantom': control('boolean', 4132, 'Input 1 Phantom Power', ['input1.48v', 'input.1.phantom', 'input.1.48v']),
  'input1-instrument': control('boolean', 4136, 'Input 1 Instrument Mode', ['input1.inst', 'input.1.instrument']),
  'input2-gain': control('gain', 4145, 'Input 2 Gain', ['input2.gain', 'input.2.gain'], { min: 0, max: 69, step: 0.5, unit: 'dB' }),
  'input2-air': control('boolean', 4152, 'Input 2 Air', ['input2.air', 'input.2.air']),
  'input2-phantom': control('boolean', 4150, 'Input 2 Phantom Power', ['input2.48v', 'input.2.phantom', 'input.2.48v']),
  'input2-instrument': control('boolean', 4154, 'Input 2 Instrument Mode', ['input2.inst', 'input.2.instrument']),
});

function control(kind, objectNumber, label, aliases = [], extra = {}) {
  return Object.freeze({ kind, objectNumber, label, aliases: Object.freeze(aliases), ...extra });
}

const ALIASES = new Map(
  Object.entries(CONTROLS).flatMap(([name, definition]) =>
    [name, ...definition.aliases].map((alias) => [alias.toLowerCase(), name]),
  ),
);

export function normalizeControlName(value) {
  const name = ALIASES.get(String(value ?? '').trim().toLowerCase());
  if (!name) throw new TypeError(`Unknown control: ${value}`);
  return name;
}

export function normalizeControlValue(name, value) {
  const definition = CONTROLS[normalizeControlName(name)];
  if (definition.kind === 'boolean' || definition.kind === 'mute') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(text)) return true;
    if (['off', 'false', '0', 'no'].includes(text)) return false;
    throw new TypeError(`${name} expects on or off.`);
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < definition.min || number > definition.max) {
    throw new RangeError(`${name} expects ${definition.min} to ${definition.max} ${definition.unit}.`);
  }
  const steps = Math.round((number - definition.min) / definition.step);
  return Number((definition.min + steps * definition.step).toFixed(4));
}

export function publicControlDefinitions() {
  return Object.fromEntries(Object.entries(CONTROLS).map(([name, { objectNumber: _objectNumber, ...definition }]) => [name, definition]));
}
