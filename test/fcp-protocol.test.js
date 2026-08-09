import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeDeviceMap, flattenDeviceMap, resolveMember } from '../src/usb/device-map.js';
import {
  FCP_HEADER_SIZE,
  OPCODE,
  dataRequest,
  decodePacket,
  decodeUint16Array,
  decodeUint32Array,
  encodePacket,
  meterReadRequest,
  mixReadRequest,
  mixWriteRequest,
  muxReadRequest,
  muxWriteRequest,
  validateResponse,
} from '../src/usb/fcp-protocol.js';
import { meterRawToDbfs, mixerDbToRaw, mixerRawToDb } from '../src/usb/direct-client.js';

test('encodes and decodes little-endian FCP packets', () => {
  const encoded = encodePacket(OPCODE.dataRead, 0x1234, Uint8Array.of(1, 2, 3));
  assert.equal(encoded.byteLength, FCP_HEADER_SIZE + 3);
  assert.deepEqual(decodePacket(encoded), {
    opcode: OPCODE.dataRead,
    size: 3,
    sequence: 0x1234,
    error: 0,
    padding: 0,
    data: Uint8Array.of(1, 2, 3),
  });
});

test('rejects destructive or unknown FCP opcodes', () => {
  assert.throws(() => encodePacket(0x000003, 0), /not permitted/);
  assert.throws(() => encodePacket(0x004004, 0), /not permitted/);
});

test('validates FCP response identity and error status', () => {
  const response = encodePacket(OPCODE.deviceMapInfo, 4, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(validateResponse(response, { opcode: OPCODE.deviceMapInfo, sequence: 4, responseSize: 4 }), Uint8Array.of(1, 2, 3, 4));
  assert.throws(() => validateResponse(response, { opcode: OPCODE.deviceMapInfo, sequence: 5, responseSize: 4 }), /sequence mismatch/);
});

test('encodes data reads as offset and size', () => {
  const request = dataRequest(0x12345678, 4);
  const view = new DataView(request.buffer);
  assert.equal(view.getUint32(0, true), 0x12345678);
  assert.equal(view.getUint32(4, true), 4);
});

test('decodes and resolves a compressed device map', () => {
  const expected = {
    structs: {
      APP_SPACE: { members: { input: { offset: 16, type: 'INPUT' }, dim: { offset: 4, type: 'bool' } } },
      INPUT: { members: { gain: { offset: 2, type: 'uint16' } } },
    },
  };
  const encoded = Buffer.from(deflateSync(Buffer.from(JSON.stringify(expected))).toString('base64'));
  const map = decodeDeviceMap(Buffer.concat([encoded, Buffer.of(0)]));
  assert.deepEqual(map, expected);
  assert.deepEqual(resolveMember(map, 'input.gain'), {
    path: 'input.gain',
    offset: 18,
    type: 'uint16',
    width: 2,
    member: { offset: 2, type: 'uint16' },
  });
  assert.ok(flattenDeviceMap(map).some(({ path, offset }) => path === 'input.gain' && offset === 18));
});

test('encodes mixer and routing requests in FCP wire format', () => {
  assert.deepEqual([...mixReadRequest(2, 36)], [2, 0, 36, 0]);
  assert.deepEqual([...meterReadRequest(64)], [0, 0, 64, 0, 0, 0, 0, 0]);
  assert.deepEqual([...mixWriteRequest(2, [0, 0x1234])], [2, 0, 0, 0, 0x34, 0x12]);
  assert.deepEqual([...muxReadRequest(1, 74)], [0, 0, 74, 1]);
  assert.deepEqual([...muxWriteRequest(1, [0x12345678])], [0, 0, 1, 0, 0x78, 0x56, 0x34, 0x12]);
});

test('decodes little-endian FCP value arrays', () => {
  assert.deepEqual(decodeUint16Array(Uint8Array.of(0x34, 0x12, 0xcd, 0xab)), [0x1234, 0xabcd]);
  assert.deepEqual(decodeUint32Array(Uint8Array.of(0x78, 0x56, 0x34, 0x12)), [0x12345678]);
});

test('converts mixer coefficients to and from decibels', () => {
  assert.equal(mixerDbToRaw('mute'), 0);
  assert.equal(mixerRawToDb(0), -80);
  assert.equal(mixerDbToRaw(12), 32613);
  assert.equal(mixerRawToDb(mixerDbToRaw(0)), 0);
  assert.throws(() => mixerDbToRaw(13), /between -80 and 12/);
  assert.equal(meterRawToDbfs(4095), 0);
  assert.equal(meterRawToDbfs(0), -120);
});
