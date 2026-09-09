import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectControlDefinitions, normalizeDirectControlName, normalizeDirectControlValue } from '../src/usb/direct-controls.js';
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
