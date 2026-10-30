import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectFocusriteClient } from '../src/usb/direct-client.js';
import { buildDirectControlDefinitions } from '../src/usb/direct-controls.js';

const map = {
  structs: {
    APP_SPACE: {
      members: {
        dimSwitch: { type: 'uint8', offset: 2, size: 1, 'array-shape': null, range: { min: 0, max: 1 } },
        inputAir: { type: 'uint8', offset: 10, size: 2, 'array-shape': [2], range: { min: 0, max: 2 } },
      },
    },
  },
  'device-specification': {
    sources: [
      { name: 'Analogue 1', type: 'analogue', controls: { air: { struct: 'APP_SPACE', member: 'inputAir', index: 0 } } },
      { name: 'Analogue 2', type: 'analogue', controls: { air: { struct: 'APP_SPACE', member: 'inputAir', index: 1 } } },
    ],
    destinations: [],
  },
};

test('full state reads isolate a control that firmware exposes but cannot read', async () => {
  const client = new DirectFocusriteClient();
  client.device = { opened: true };
  client.deviceMap = map;
  client.controls = buildDirectControlDefinitions(map);
  client.transport = {
    queue: Promise.resolve(),
    async readData(offset, width) {
      if (offset === 11) throw new Error('simulated firmware read failure');
      return new Uint8Array(width).fill(offset === 2 ? 1 : 0);
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.deepEqual(await client.read(), { dim: true, 'input1-air': 'off' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /input2-air/);
    await client.read();
    assert.equal(warnings.length, 1);
    await assert.rejects(client.read(['input2-air']), /simulated firmware read failure/);
  } finally {
    console.warn = originalWarn;
  }
});
