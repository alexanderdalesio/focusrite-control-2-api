function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function definition(kind, label, path, extra = {}) {
  return Object.freeze({ kind, label, path, aliases: Object.freeze(extra.aliases ?? []), ...extra });
}

const GLOBAL_CONTROLS = Object.freeze({
  'monitor-mute': definition('boolean', 'Monitor mute', 'muteSwitch', { aliases: ['mute', 'monitor.mute'] }),
  dim: definition('boolean', 'Monitor dim', 'dimSwitch', { aliases: ['monitor.dim'] }),
  alt: definition('boolean', 'Alternate monitors', 'altSwitch', { aliases: ['monitor.alt'] }),
  'monitor-gain': definition('integer', 'Monitor level', 'masterVolume', { aliases: ['volume', 'monitor.level'], min: -127, max: 0, step: 1, unit: 'dB' }),
  'dim-level': definition('integer', 'Dim attenuation', 'dimLevel', { min: -127, max: 0, step: 1, unit: 'dB' }),
  'selected-input': definition('enum', 'Selected preamp', 'selectedInput', { values: ['input-1', 'input-2'] }),
  standalone: definition('boolean', 'Standalone mode', 'enableStandalone', { save: true }),
  'phantom-persistence': definition('boolean', 'Phantom power persistence', 'enablePhantomPersist', { save: true }),
  'talkback-enabled': definition('boolean', 'Talkback enabled', 'talkbackEnable', { notify: 32 }),
  talkback: definition('boolean', 'Talkback', 'talkSwitch', { notify: 32 }),
  'output-switch': definition('boolean', 'Output switch', 'outputSwitch', { notify: 33 }),
  'output-relay-mute': definition('boolean', 'Output relay mute', 'outputRelayMute', { notify: 1 }),
  'alt-talkback-enabled': definition('boolean', 'Alternate-monitor talkback enabled', 'altMonitorTalkbackEnable', { notify: 9 }),
  'autogain-mean-target': definition('integer', 'Auto Gain mean target', 'meanTargetNegDBFS', { min: 0, max: 69, step: 1, unit: 'dB below full scale' }),
  'autogain-peak-target': definition('integer', 'Auto Gain peak target', 'peakTargetNegDBFS', { min: 0, max: 69, step: 1, unit: 'dB below full scale' }),
  'autogain-use-peak': definition('boolean', 'Auto Gain uses peak target', 'autogainUsePeak'),
  'autogain-maximum-gain': definition('integer', 'Auto Gain maximum gain', 'autogainSetMaxGain', { min: 1, max: 70, step: 1, unit: 'dB' }),
  'metering-enabled': definition('boolean', 'Front-panel metering', 'meteringEnabled'),
  'adat-expansion-mode': definition('boolean', 'ADAT expansion mode', 'adatExpansionMode', { save: true }),
});

const SOURCE_KINDS = Object.freeze({
  air: { kind: 'enum', values: ['off', 'presence', 'presence-drive'], label: 'Air mode' },
  'phantom-power': { kind: 'boolean', label: 'Phantom power' },
  instrument: { kind: 'boolean', label: 'Instrument mode' },
  'clip-safe': { kind: 'boolean', label: 'Clip Safe' },
  'preamp-gain': { kind: 'integer', label: 'Preamp gain', min: 0, max: 70, step: 1, unit: 'dB' },
  'auto-gain': { kind: 'boolean', label: 'Auto Gain' },
  'auto-gain-exit-status': { kind: 'enum', label: 'Auto Gain result', access: 'read-only', values: ['success', 'dynamic-range-over', 'minimum-gain', 'dynamic-range-under', 'maximum-gain', 'clipped', 'cancelled', 'root'] },
  'channel-link': { kind: 'boolean', label: 'Channel link' },
});

export function buildDirectControlDefinitions(deviceMap) {
  const members = deviceMap?.structs?.APP_SPACE?.members;
  const specification = deviceMap?.['device-specification'];
  if (!members || !specification) throw new Error('The Scarlett device map is missing its control specification.');
  const controls = {};

  for (const [name, item] of Object.entries(GLOBAL_CONTROLS)) {
    if (members[item.path]) controls[name] = item;
  }

  const analogueSources = (specification.sources ?? []).filter((source) => source.type === 'analogue' && Object.keys(source.controls ?? {}).length);
  for (let sourceIndex = 0; sourceIndex < analogueSources.length; sourceIndex += 1) {
    const source = analogueSources[sourceIndex];
    const inputNumber = sourceIndex + 1;
    for (const [controlName, location] of Object.entries(source.controls)) {
      const metadata = SOURCE_KINDS[controlName];
      if (!metadata || location.struct !== 'APP_SPACE' || !members[location.member]) continue;
      const canonical = `input${inputNumber}-${controlName.replace('preamp-', '')}`;
      controls[canonical] = definition(metadata.kind, `Input ${inputNumber} ${metadata.label}`, location.member, {
        ...metadata,
        index: location.index,
        aliases: [`input.${inputNumber}.${controlName}`, `input${inputNumber}.${controlName}`],
      });
    }
    if (members.inputMutes) {
      controls[`input${inputNumber}-mute`] = definition('boolean', `Input ${inputNumber} mute`, 'inputMutes', { index: sourceIndex, aliases: [`input.${inputNumber}.mute`] });
    }
  }

  const destinations = (specification.destinations ?? []).filter((destination) => destination.controls?.level);
  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    const base = slug(destination.name);
    const location = destination.controls.level;
    controls[`${base}-level`] = definition('integer', `${destination.name} level`, location.member, {
      index: location.index,
      min: -127,
      max: 0,
      step: 1,
      unit: 'dB',
    });
    if (members.outputMute) controls[`${base}-mute`] = definition('boolean', `${destination.name} mute`, 'outputMute', { index });
    if (members.outputCtrl) controls[`${base}-hardware-control`] = definition('boolean', `${destination.name} hardware control`, 'outputCtrl', { index });
  }

  const outputPairs = ['Monitor 1–2', 'Monitor 3–4', 'Headphone 1', 'Headphone 2'];
  if (members.outputMono) {
    for (let index = 0; index < outputPairs.length; index += 1) {
      const name = `${slug(outputPairs[index])}-mono`;
      controls[name] = definition('boolean', `${outputPairs[index]} mono`, 'outputMono', { index, notify: 1 });
    }
  }

  return Object.freeze(controls);
}

export function directControlAliases(definitions) {
  return new Map(Object.entries(definitions).flatMap(([name, item]) =>
    [name, ...(item.aliases ?? [])].map((alias) => [alias.toLowerCase(), name]),
  ));
}

export function normalizeDirectControlName(definitions, value) {
  const name = directControlAliases(definitions).get(String(value ?? '').trim().toLowerCase());
  if (!name) throw new TypeError(`Unknown direct USB control: ${value}`);
  return name;
}

export function normalizeDirectControlValue(definitions, name, value) {
  const canonical = normalizeDirectControlName(definitions, name);
  const item = definitions[canonical];
  if (item.access === 'read-only') throw new TypeError(`${canonical} is read-only.`);
  if (item.kind === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(text)) return true;
    if (['off', 'false', '0', 'no'].includes(text)) return false;
    throw new TypeError(`${canonical} expects on or off.`);
  }
  if (item.kind === 'enum') {
    if (Number.isInteger(value) && value >= 0 && value < item.values.length) return value;
    const index = item.values.indexOf(String(value).trim().toLowerCase());
    if (index < 0) throw new TypeError(`${canonical} expects one of: ${item.values.join(', ')}.`);
    return index;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < item.min || number > item.max) throw new RangeError(`${canonical} expects ${item.min} to ${item.max} ${item.unit ?? ''}.`.trim());
  return Math.round((number - item.min) / item.step) * item.step + item.min;
}

export function publicDirectControlDefinitions(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([name, { path: _path, index: _index, save: _save, notify: _notify, ...item }]) => [name, item]));
}
