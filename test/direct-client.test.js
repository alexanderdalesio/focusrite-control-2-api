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

test('Auto Gain treats nonzero firmware states as active, not just raw one', async () => {
  const deviceMap = structuredClone(map);
  deviceMap.structs.APP_SPACE.members.autogainInProgress = { type: 'uint8', offset: 25, size: 2, 'array-shape': [2], 'notify-device': 13 };
  deviceMap['device-specification'].sources[0].controls['auto-gain'] = { struct: 'APP_SPACE', member: 'autogainInProgress', index: 0 };
  const { client, memory } = simulatedClient(deviceMap, { 25: 3 });
  assert.deepEqual(await client.read(['input1-auto-gain']), { 'input1-auto-gain': true });
  client.transport.notify = async () => { if (memory.get(25)) memory.set(25, 3); };
  assert.deepEqual(await client.apply([{ control: 'input1-auto-gain', value: true }]), { applied: 1, values: { 'input1-auto-gain': true } });
  assert.deepEqual(await client.apply([{ control: 'input1-auto-gain', value: false }]), { applied: 1, values: { 'input1-auto-gain': false } });
});

test('USB peak reads work with the device-map metering flag cleared', async () => {
  const deviceMap = structuredClone(map);
  deviceMap.structs.APP_SPACE.members.meteringEnabled = { type: 'uint8', offset: 28, size: 1, 'notify-device': 20 };
  deviceMap['device-specification'].sources[0]['peak-index'] = 1;
  const { client, writes } = simulatedClient(deviceMap, { 28: 0 });
  client.transport.meterInfo = async () => 3;
  client.transport.readMeters = async (count) => { assert.equal(count, 3); return [0, 4095, 0]; };
  client.transport.notify = async () => { throw new Error('A peak read must not enable metering.'); };
  const meters = await client.meterState();
  assert.equal(meters.count, 3);
  assert.equal(meters.channels[0].raw, 4095);
  assert.equal(meters.channels[0].dbfs, 0);
  assert.deepEqual(writes, []);
});

test('metering uses the ESP32 feed field and leaves the legacy flag untouched', async () => {
  const deviceMap = structuredClone(map);
  Object.assign(deviceMap.structs.APP_SPACE.members, {
    meteringEnabled: { type: 'uint8', offset: 28, size: 1, 'notify-device': 20 },
    meterDataToESP32: { type: 'uint8', offset: 29, size: 1, 'notify-device': 27 },
  });
  const { client, memory, writes } = simulatedClient(deviceMap, { 28: 0, 29: 1 });
  const notifications = [];
  client.transport.notify = async (event) => { notifications.push(event); };
  assert.deepEqual(await client.read(['metering-enabled']), { 'metering-enabled': true });
  assert.deepEqual(await client.apply([{ control: 'front-panel-metering', value: false }]), { applied: 1, values: { 'metering-enabled': false } });
  assert.deepEqual(writes, [29]);
  assert.deepEqual(notifications, [27]);
  assert.equal(memory.get(28), 0);
});

const optionalFields = {
  'metering-enabled': ['meterDataToESP32', 34, 27, 'eMSG_ENABLE_METERING', 0],
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

const targetFields = {
  'autogain-mean-target': ['meanTargetNegDBFS', 30, 36, 'eMSG_AG_MEAN_TARGET', 18],
  'autogain-peak-target': ['peakTargetNegDBFS', 31, 37, 'eMSG_AG_PEAK_TARGET', 12],
};

test('Auto Gain target writes retain verified values despite the vendor notification error', async () => {
  const { client, notifications, writes } = optionalClient({ reject: true, fields: targetFields });
  const definitions = await client.controlDefinitions();
  assert.deepEqual(notifications, []);
  for (const name of Object.keys(targetFields)) {
    assert.notEqual(definitions[name].access, 'read-only');
    assert.equal('optionalNotification' in definitions[name], false);
  }
  const result = await client.apply([{ control: 'autogain-mean-target', value: 12 }, { control: 'autogain-peak-target', value: 6 }]);
  assert.deepEqual(result.values, { 'autogain-mean-target': 12, 'autogain-peak-target': 6 });
  assert.deepEqual(writes, [30, 31]);
  assert.deepEqual(notifications, [36, 37]);
});

test('target notification errors other than the verified vendor status still fail', async () => {
  const { client, memory } = optionalClient({ fields: targetFields });
  client.transport.notify = async () => { throw new FcpDeviceError(8, OPCODE.dataNotify); };
  await assert.rejects(client.apply([{ control: 'autogain-mean-target', value: 12 }]), /FCP error 8/);
  assert.equal(memory.get(30), 18);
});

test('target notifications cannot hide write errors, transport failures, or mismatched metadata', async () => {
  for (const mode of ['write', 'transport', 'metadata', 'alias']) {
    const { client, deviceMap } = optionalClient({ reject: true, fields: targetFields });
    if (mode === 'write') client.transport.writeData = async () => { throw new FcpDeviceError(7, OPCODE.dataWrite); };
    if (mode === 'transport') client.transport.notify = async () => { throw new FcpTransportError('Transport lost'); };
    if (mode === 'metadata') deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators.eMSG_AG_MEAN_TARGET = 99;
    if (mode === 'alias') deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators.eMSG_RESET = 36;
    await assert.rejects(client.apply([{ control: 'autogain-mean-target', value: 12 }]), mode === 'transport' ? /Transport lost/ : ['metadata', 'alias'].includes(mode) ? /metadata/ : /FCP error 7/);
  }
});

test('a target acknowledgment exception never bypasses stored-value verification', async () => {
  const { client, memory } = optionalClient({ reject: true, fields: targetFields });
  client.transport.writeData = async () => {};
  await assert.rejects(client.apply([{ control: 'autogain-mean-target', value: 12 }]), /verification failed/);
  assert.equal(memory.get(30), 18);
});

test('a later target batch failure restores both original fields', async () => {
  const { client, memory } = optionalClient({ reject: true, fields: targetFields });
  const write = client.transport.writeData.bind(client.transport);
  client.transport.writeData = async (offset, bytes) => {
    if (offset === 31 && bytes[0] === 6) throw new FcpDeviceError(8, OPCODE.dataWrite);
    return write(offset, bytes);
  };
  await assert.rejects(client.apply([{ control: 'autogain-mean-target', value: 12 }, { control: 'autogain-peak-target', value: 6 }]), /FCP error 8/);
  assert.equal(memory.get(30), 18);
  assert.equal(memory.get(31), 12);
});

test('undocumented Auto Gain settings allow verified writes with explicit experimental warnings', async () => {
  const fields = {
    'autogain-use-peak': ['autogainUsePeak', 32, 35, 'eMSG_AUTOGAIN_PEAKS', 0],
    'autogain-maximum-gain': ['autogainSetMaxGain', 33, 34, 'eMSG_AUTOGAIN_MAX_GAIN', 52],
  };
  for (const reject of [false, true]) {
    const { client, notifications } = optionalClient({ reject, fields });
    const definitions = await client.controlDefinitions();
    assert.equal(definitions['autogain-use-peak'].experimental, true);
    assert.equal(definitions['autogain-maximum-gain'].experimental, true);
    assert.deepEqual(notifications, []);
    const result = await client.apply([{ control: 'autogain-use-peak', value: true }, { control: 'autogain-maximum-gain', value: 51 }]);
    assert.deepEqual(result.values, { 'autogain-use-peak': true, 'autogain-maximum-gain': 51 });
    assert.equal(result.warnings.length, 2);
    assert(result.warnings.every(({ verification, message }) => verification === 'stored-value' && /experimental/.test(message)));
    if (reject) assert(result.warnings.every(({ status, code }) => status === 7 && code === 'notification-rejected'));
  }
});

test('a missing expected configuration enum blocks writes before a batch starts', async () => {
  const { client, deviceMap, writes } = optionalClient({ fields: targetFields });
  delete deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators.eMSG_AG_MEAN_TARGET;
  await assert.rejects(client.apply([{ control: 'dim', value: true }, { control: 'autogain-mean-target', value: 12 }]), /metadata/);
  assert.deepEqual(writes, []);
});

test('rejected optional notifications make controls read-only before any data writes', async () => {
  const { client, notifications, writes } = optionalClient({ reject: true });
  const definitions = await client.controlDefinitions();
  assert.deepEqual(notifications, [27]);
  for (const name of Object.keys(optionalFields)) {
    assert.equal(definitions[name].access, 'read-only');
    assert.equal(definitions[name].notificationSupport.errorCode, 7);
    assert.match(definitions[name].disabledReason, /No setting was written/);
    assert.equal('probeNotification' in definitions[name], false);
  }
  await assert.rejects(client.apply([{ control: 'dim', value: true }, { control: 'metering-enabled', value: true }]), /read-only on this connection/);
  assert.deepEqual(writes, []);
  assert.equal((await client.read())['metering-enabled'], false);
  await client.controlDefinitions();
  assert.equal(notifications.length, 1);
});

test('firmware that accepts an optional event retains writable controls', async () => {
  const { client, memory, writes } = optionalClient();
  assert.notEqual((await client.controlDefinitions())['metering-enabled'].access, 'read-only');
  assert.deepEqual(await client.apply([{ control: 'metering-enabled', value: true }]), { applied: 1, values: { 'metering-enabled': true } });
  assert.deepEqual(writes, [34]);
  assert.equal(memory.get(34), 1);
});

test('unsafe or ambiguous notification metadata is never probed', async () => {
  const fields = optionalFields;
  const { client, deviceMap, notifications, writes } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.meterDataToESP32['notify-device'] = 13;
  const definition = (await client.controlDefinitions())['metering-enabled'];
  assert.equal(definition.access, 'read-only');
  assert.match(definition.disabledReason, /metadata/);
  assert.deepEqual(notifications, []);
  await assert.rejects(client.apply([{ control: 'metering-enabled', value: true }]), /metadata/);
  assert.deepEqual(writes, []);
});

test('a malformed data-backed field fails a batch before earlier writes', async () => {
  const fields = {
    'autogain-maximum-gain': ['autogainSetMaxGain', 33, 34, 'eMSG_AUTOGAIN_MAX_GAIN', 52],
    'autogain-use-peak': ['autogainUsePeak', 32, 35, 'eMSG_AUTOGAIN_PEAKS', 0],
  };
  const { client, deviceMap, notifications, writes } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.autogainUsePeak['notify-device'] = 34;
  const definitions = await client.controlDefinitions();
  assert.notEqual(definitions['autogain-maximum-gain'].access, 'read-only');
  assert.equal(definitions['autogain-use-peak'].access, 'read-only');
  assert.deepEqual(notifications, []);
  await assert.rejects(client.apply([{ control: 'dim', value: true }, { control: 'autogain-use-peak', value: true }]), /metadata/);
  assert.deepEqual(writes, []);
});

test('an event that aliases a capture or reset enum is not safe to probe', async () => {
  const fields = optionalFields;
  const { client, deviceMap, notifications } = optionalClient({ fields });
  deviceMap.enums.eDEV_FCP_USER_MESSAGE_TYPE.enumerators.eMSG_RESET = 27;
  assert.equal((await client.controlDefinitions())['metering-enabled'].access, 'read-only');
  assert.deepEqual(notifications, []);
});

test('read-only firmware fields do not need a notification probe', async () => {
  const fields = optionalFields;
  const { client, deviceMap, notifications } = optionalClient({ fields });
  deviceMap.structs.APP_SPACE.members.meterDataToESP32['access-policy'] = 'read-only';
  assert.equal((await client.controlDefinitions())['metering-enabled'].access, 'read-only');
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
  assert.equal(client.notificationCapabilities.size, 1);
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
