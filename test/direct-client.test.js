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

const optionalFields = {
  'autogain-mean-target': ['meanTargetNegDBFS', 30, 36, 'eMSG_AG_MEAN_TARGET', 18],
  'autogain-peak-target': ['peakTargetNegDBFS', 31, 37, 'eMSG_AG_PEAK_TARGET', 12],
  'autogain-use-peak': ['autogainUsePeak', 32, 35, 'eMSG_AUTOGAIN_PEAKS', 0],
  'autogain-maximum-gain': ['autogainSetMaxGain', 33, 34, 'eMSG_AUTOGAIN_MAX_GAIN', 52],
  'metering-enabled': ['meteringEnabled', 34, 20, 'eMSG_METERING', 0],
};

function optionalClient({ reject = false, fields = optionalFields } = {}) {
  const deviceMap = structuredClone(map);
  deviceMap.enums = { eDEV_FCP_USER_MESSAGE_TYPE: { enumerators: {} } };
  const initial = { 2: 0 };
  for (const [member, offset, event, enumName, value] of Object.values(fields)) {
    deviceMap.structs.APP_SPACE.members[member] = { type: 'uint8', offset, size: 1, 'notify-device': event };
    deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators[enumName] = event;
    initial[offset] = value;
  }
  const result = simulatedClient(deviceMap, initial);
  result.client.deviceMap = null;
  result.client.controls = null;
  const notifications = [];
  let mapReads = 0;
  result.client.transport.readDeviceMap = async () => { mapReads++; return { map: deviceMap, encoded: null }; };
  result.client.transport.notify = async (event) => {
    notifications.push(event);
    if (reject) throw new FcpDeviceError(7, OPCODE.dataNotify);
  };
  return { ...result, deviceMap, notifications, mapReads: () => mapReads };
}

test('rejected optional notifications make controls read-only before any data writes', async () => {
  const { client, notifications, writes } = optionalClient({ reject: true });
  const definitions = await client.controlDefinitions();
  assert.deepEqual(notifications, [36, 37, 35, 34, 20]);
  for (const name of Object.keys(optionalFields)) {
    assert.equal(definitions[name].access, 'read-only');
    assert.equal(definitions[name].notificationSupport.errorCode, 7);
    assert.match(definitions[name].disabledReason, /No setting was written/);
    assert.equal('probeNotification' in definitions[name], false);
  }
  await assert.rejects(client.apply([{ control: 'dim', value: true }, { control: 'autogain-mean-target', value: 17 }]), /read-only on this connection/);
  assert.deepEqual(writes, []);
  assert.equal((await client.read())['autogain-mean-target'], 18);
  await client.controlDefinitions();
  assert.equal(notifications.length, 5);
});

test('firmware that accepts an optional event retains writable controls', async () => {
  const { client, memory, writes } = optionalClient();
  assert.notEqual((await client.controlDefinitions())['autogain-mean-target'].access, 'read-only');
  assert.deepEqual(await client.apply([{ control: 'autogain-mean-target', value: 17 }]), { applied: 1, values: { 'autogain-mean-target': 17 } });
  assert.deepEqual(writes, [30]);
  assert.equal(memory.get(30), 17);
});

test('unsafe or ambiguous notification metadata is never probed', async () => {
  const fields = { 'autogain-mean-target': optionalFields['autogain-mean-target'] };
  const { client, deviceMap, notifications, writes } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.meanTargetNegDBFS['notify-device'] = 13;
  const definition = (await client.controlDefinitions())['autogain-mean-target'];
  assert.equal(definition.access, 'read-only');
  assert.match(definition.disabledReason, /metadata/);
  assert.deepEqual(notifications, []);
  await assert.rejects(client.apply([{ control: 'autogain-mean-target', value: 17 }]), /metadata/);
  assert.deepEqual(writes, []);
});

test('one malformed field cannot reuse another field\'s supported notification result', async () => {
  const fields = {
    'autogain-mean-target': optionalFields['autogain-mean-target'],
    'autogain-peak-target': optionalFields['autogain-peak-target'],
  };
  const { client, deviceMap, notifications, writes } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.peakTargetNegDBFS['notify-device'] = 36;
  const definitions = await client.controlDefinitions();
  assert.notEqual(definitions['autogain-mean-target'].access, 'read-only');
  assert.equal(definitions['autogain-peak-target'].access, 'read-only');
  assert.deepEqual(notifications, [36]);
  await assert.rejects(client.apply([{ control: 'autogain-peak-target', value: 11 }]), /metadata/);
  assert.deepEqual(writes, []);
});

test('an event that aliases a capture or reset enum is not safe to probe', async () => {
  const fields = { 'autogain-mean-target': optionalFields['autogain-mean-target'] };
  const { client, deviceMap, notifications } = optionalClient({ fields });
  deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators.eMSG_RESET = 36;
  assert.equal((await client.controlDefinitions())['autogain-mean-target'].access, 'read-only');
  assert.deepEqual(notifications, []);
});

test('read-only firmware fields do not need a notification probe', async () => {
  const fields = { 'autogain-mean-target': optionalFields['autogain-mean-target'] };
  const { client, deviceMap, notifications } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.meanTargetNegDBFS['access-policy'] = 'read-only';
  assert.equal((await client.controlDefinitions())['autogain-mean-target'].access, 'read-only');
  assert.deepEqual(notifications, []);
});

test('concurrent discovery waits for the single notification-capability check', async () => {
  const { client, mapReads } = optionalClient({ reject: true });
  const results = await Promise.all(Array.from({ length: 12 }, () => client.controlDefinitions()));
  assert.equal(mapReads(), 1);
  for (const result of results) assert.equal(result['metering-enabled'].access, 'read-only');
});

test('closing a connection discards its optional notification capability results', async () => {
  const { client } = optionalClient({ reject: true });
  await client.controlDefinitions();
  assert.equal(client.notificationCapabilities.size, 5);
  await client.close();
  assert.equal(client.notificationCapabilities.size, 0);
  assert.equal(client.deviceMap, null);
});

test('probe transport errors propagate instead of disguising a failed connection as unsupported controls', async () => {
  const { client } = optionalClient();
  client.transport.notify = async () => { throw new FcpTransportError('USB disconnected'); };
  await assert.rejects(client.controlDefinitions(), /USB disconnected/);
  assert.equal(client.notificationCapabilities.size, 0);
});
