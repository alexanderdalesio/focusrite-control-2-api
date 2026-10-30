import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectControlDefinitions, directControlCompatibilityDiagnostics, normalizeDirectControlName, normalizeDirectControlValue } from '../src/usb/direct-controls.js';
import { decodePrimitive, encodePrimitive, resolveMemberElement } from '../src/usb/device-map.js';

const map = {
  structs: {
    APP_SPACE: {
      members: {
        dimSwitch: { type: 'uint8', offset: 2, size: 1, 'array-shape': null, range: { min: 0, max: 1 } },
        inputAir: { type: 'uint8', offset: 10, size: 2, 'array-shape': [2], range: { min: 0, max: 2 } },
        input48V: { type: 'uint8', offset: 12, size: 2, 'array-shape': [2], range: { min: 0, max: 1 } },
        inputInst: { type: 'uint8', offset: 14, size: 2, 'array-shape': [2], range: { min: 0, max: 1 } },
        outputVol: { type: 'int16', offset: 20, size: 4, 'array-shape': [2], range: { min: -127, max: 0 } },
      },
    },
  },
  'device-specification': {
    sources: [
      { name: 'Analogue 1', type: 'analogue', controls: {
        air: { struct: 'APP_SPACE', member: 'inputAir', index: 0 },
        'phantom-power': { struct: 'APP_SPACE', member: 'input48V', index: 0 },
        instrument: { struct: 'APP_SPACE', member: 'inputInst', index: 0 },
      } },
      { name: 'Analogue 2', type: 'analogue', controls: { air: { struct: 'APP_SPACE', member: 'inputAir', index: 1 } } },
    ],
    destinations: [
      { name: 'Monitor 1', controls: { level: { struct: 'APP_SPACE', member: 'outputVol', index: 0 } } },
      { name: 'Monitor 2', controls: { level: { struct: 'APP_SPACE', member: 'outputVol', index: 1 } } },
    ],
  },
};

test('builds direct controls from device-provided channel locations', () => {
  const controls = buildDirectControlDefinitions(map);
  assert.equal(controls.dim.path, 'dimSwitch');
  assert.equal(controls['input2-air'].index, 1);
  assert.equal(controls['monitor-2-level'].index, 1);
  assert.equal(normalizeDirectControlName(controls, 'input.1.air'), 'input1-air');
  assert.equal(normalizeDirectControlName(controls, 'input1-phantom'), 'input1-phantom-power');
  assert.equal(normalizeDirectControlName(controls, 'input.1.48v'), 'input1-phantom-power');
  assert.equal(normalizeDirectControlName(controls, 'input1.inst'), 'input1-instrument');
  assert.equal(controls['input1-phantom-power'].label, 'Input 1 Phantom power');
  assert.equal(controls['input1-instrument'].label, 'Input 1 Instrument mode');
  assert.equal(normalizeDirectControlValue(controls, 'input1-air', 'presence-drive'), 2);
});

test('resolves array elements and encodes signed values', () => {
  assert.equal(resolveMemberElement(map, 'outputVol', 1).offset, 22);
  assert.equal(decodePrimitive('int16', encodePrimitive('int16', -24)), -24);
  assert.throws(() => resolveMemberElement(map, 'inputAir', 2), /outside dimension/);
});

test('does not synthesize controls beyond firmware-reported array dimensions', () => {
  const firmware4Map = structuredClone(map);
  Object.assign(firmware4Map.structs.APP_SPACE.members, {
    inputMutes: { type: 'uint8', offset: 30, size: 2, 'array-shape': [2] },
    outputMute: { type: 'uint8', offset: 32, size: 1, 'array-shape': [1] },
    outputCtrl: { type: 'uint8', offset: 33, size: 1, 'array-shape': [1] },
    outputMono: { type: 'uint8', offset: 34, size: 2, 'array-shape': [2] },
  });
  for (let input = 3; input <= 6; input += 1) {
    firmware4Map['device-specification'].sources.push({
      name: `Analogue ${input}`,
      type: 'analogue',
      controls: { unsupported: { struct: 'APP_SPACE', member: 'inputAir', index: 0 } },
    });
  }

  const controls = buildDirectControlDefinitions(firmware4Map);
  assert.ok(controls['input1-mute']);
  assert.ok(controls['input2-mute']);
  assert.equal(controls['input3-mute'], undefined);
  assert.equal(controls['input6-mute'], undefined);
  assert.ok(controls['monitor-1-mute']);
  assert.equal(controls['monitor-2-mute'], undefined);
  assert.ok(controls['monitor-1-hardware-control']);
  assert.equal(controls['monitor-2-hardware-control'], undefined);
  assert.ok(controls['monitor-1-2-mono']);
  assert.ok(controls['monitor-3-4-mono']);
  assert.equal(controls['headphone-1-mono'], undefined);
});

test('filters malformed controls and adapts ranges to the live device map', () => {
  const changedMap = structuredClone(map);
  changedMap.structs.APP_SPACE.members.inputAir.range = { min: 0, max: 1 };
  changedMap.structs.APP_SPACE.members.outputVol.range = { min: -40, max: -10 };
  changedMap['device-specification'].sources[1].controls.air.index = 5;

  const controls = buildDirectControlDefinitions(changedMap);
  assert.deepEqual(controls['input1-air'].values, ['off', 'presence']);
  assert.equal(controls['input2-air'], undefined);
  assert.equal(controls['monitor-1-level'].min, -40);
  assert.equal(controls['monitor-1-level'].max, -10);
  assert.deepEqual(directControlCompatibilityDiagnostics(controls), [
    { control: 'input2-air', reason: 'inputAir index 5 is outside dimension 2.' },
  ]);
});
