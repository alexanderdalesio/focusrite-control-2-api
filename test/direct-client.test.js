import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectFocusriteClient } from '../src/usb/direct-client.js';
import { buildDirectControlDefinitions } from '../src/usb/direct-controls.js';
import { FcpDeviceError, FcpTransportError, OPCODE } from '../src/usb/fcp-protocol.js';

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
      if (offset === 11) throw new FcpDeviceError(7, OPCODE.dataRead);
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
    assert.match(client.unavailableControls.get('input2-air'), /FCP error 7/);
    await assert.rejects(client.read(['input2-air']), /FCP error 7/);
  } finally {
    console.warn = originalWarn;
  }
});

function simulatedClient(deviceMap, initial) {
  const client = new DirectFocusriteClient();
  client.device = { opened: true };
  client.deviceMap = deviceMap;
  client.controls = buildDirectControlDefinitions(deviceMap);
  const memory = new Map(Object.entries(initial).map(([offset, value]) => [Number(offset), value]));
  const writes = [];
  client.transport = {
    queue: Promise.resolve(),
    async readData(offset, width) { return new Uint8Array(width).fill(memory.get(offset) ?? 0); },
    async writeData(offset, bytes) { writes.push(offset); memory.set(offset, bytes[0]); },
    async notify() {},
  };
  return { client, memory, writes };
}

test('transport failures abort full-state reads instead of returning a partial success', async () => {
  const { client } = simulatedClient(map, { 2: 0 });
  client.transport.readData = async () => { throw new FcpTransportError('sequence mismatch'); };
  await assert.rejects(client.read(), /sequence mismatch/);
  assert.equal(client.unavailableControls.size, 0);
});

test('hardware-controlled levels fail before any writes, including in a batch', async () => {
  const deviceMap = structuredClone(map);
  deviceMap.structs.APP_SPACE.members.outputVol = { type: 'int8', offset: 20, size: 1 };
  deviceMap.structs.APP_SPACE.members.outputCtrl = { type: 'uint8', offset: 21, size: 1 };
  deviceMap['device-specification'].destinations.push({ name: 'Monitor 1', controls: { level: { member: 'outputVol', index: 0 } } });
  const { client, writes } = simulatedClient(deviceMap, { 20: 0, 21: 1 });
  await assert.rejects(client.apply([{ control: 'dim', value: true }, { control: 'monitor-1-level', value: -10 }]), /hardware volume control/);
  assert.deepEqual(writes, []);
});

test('failed write verification restores original values', async () => {
  const { client, memory, writes } = simulatedClient(map, { 2: 0 });
  client.transport.writeData = async (offset, bytes) => {
    writes.push(offset);
    if (bytes[0] === 0) memory.set(offset, 0);
  };
  await assert.rejects(client.apply([{ control: 'dim', value: true }]), /verification failed/);
  assert.deepEqual(writes, [2, 2]);
  assert.equal(memory.get(2), 0);
});
