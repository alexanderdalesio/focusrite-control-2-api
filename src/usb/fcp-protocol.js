export const FCP_HEADER_SIZE = 16;
export const FCP_NOTIFICATION_ACK = 1;

export const USB_REQUEST = Object.freeze({
  step0: 0,
  commandTransmit: 2,
  commandReceive: 3,
});

export const OPCODE = Object.freeze({
  init1: 0x000000,
  capabilityRead: 0x000001,
  init2: 0x000002,
  meterInfo: 0x001000,
  meterRead: 0x001001,
  mixInfo: 0x002000,
  mixRead: 0x002001,
  mixWrite: 0x002002,
  muxInfo: 0x003000,
  muxRead: 0x003001,
  muxWrite: 0x003002,
  dataRead: 0x800000,
  dataWrite: 0x800001,
  dataNotify: 0x800002,
  deviceMapInfo: 0x80000c,
  deviceMapRead: 0x80000d,
});

const PERMITTED_OPCODES = new Set(Object.values(OPCODE));

export function assertPermittedOpcode(opcode) {
  if (!PERMITTED_OPCODES.has(opcode)) {
    throw new RangeError(`FCP opcode 0x${opcode.toString(16).padStart(8, '0')} is not permitted.`);
  }
}

export function encodePacket(opcode, sequence, data = new Uint8Array()) {
  assertPermittedOpcode(opcode);
  const payload = Uint8Array.from(data);
  if (payload.byteLength > 0xffff) throw new RangeError('FCP payload exceeds 65535 bytes.');
  const packet = new Uint8Array(FCP_HEADER_SIZE + payload.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, opcode, true);
  view.setUint16(4, payload.byteLength, true);
  view.setUint16(6, sequence, true);
  packet.set(payload, FCP_HEADER_SIZE);
  return packet;
}

export function decodePacket(packet) {
  const bytes = Uint8Array.from(packet ?? []);
  if (bytes.byteLength < FCP_HEADER_SIZE) throw new Error(`FCP response is only ${bytes.byteLength} bytes.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint16(4, true);
  if (bytes.byteLength !== FCP_HEADER_SIZE + size) {
    throw new Error(`FCP response declares ${size} data bytes but contains ${bytes.byteLength - FCP_HEADER_SIZE}.`);
  }
  return {
    opcode: view.getUint32(0, true),
    size,
    sequence: view.getUint16(6, true),
    error: view.getUint32(8, true),
    padding: view.getUint32(12, true),
    data: bytes.slice(FCP_HEADER_SIZE),
  };
}

export function validateResponse(packet, { opcode, sequence, responseSize }) {
  const response = decodePacket(packet);
  if (response.opcode !== opcode) throw new Error(`FCP opcode mismatch: expected 0x${opcode.toString(16)}, received 0x${response.opcode.toString(16)}.`);
  if (response.sequence !== sequence) throw new Error(`FCP sequence mismatch: expected ${sequence}, received ${response.sequence}.`);
  if (response.error !== 0) throw new Error(`The Scarlett returned FCP error ${response.error} for opcode 0x${opcode.toString(16)}.`);
  if (response.size !== responseSize) throw new Error(`FCP response size mismatch: expected ${responseSize}, received ${response.size}.`);
  return response.data;
}

export function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

export function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function dataRequest(offset, size) {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('FCP data offset must be a non-negative integer.');
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new RangeError('FCP data size must be between 1 and 4096 bytes.');
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, offset, true);
  view.setUint32(4, size, true);
  return bytes;
}

export function dataWriteRequest(offset, data) {
  const payload = Uint8Array.from(data ?? []);
  const request = new Uint8Array(8 + payload.byteLength);
  request.set(dataRequest(offset, payload.byteLength));
  request.set(payload, 8);
  return request;
}

function assertIndex(value, description, maximum = 0xffff) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${description} must be an integer between 0 and ${maximum}.`);
  }
}

export function mixReadRequest(mix, count) {
  assertIndex(mix, 'Mixer output');
  assertIndex(count, 'Mixer input count');
  const request = new Uint8Array(4);
  const view = new DataView(request.buffer);
  view.setUint16(0, mix, true);
  view.setUint16(2, count, true);
  return request;
}

export function meterReadRequest(count) {
  assertIndex(count, 'Meter count');
  const request = new Uint8Array(8);
  new DataView(request.buffer).setUint16(2, count, true);
  return request;
}

export function mixWriteRequest(mix, values) {
  assertIndex(mix, 'Mixer output');
  const coefficients = [...values];
  assertIndex(coefficients.length, 'Mixer input count');
  const request = new Uint8Array(2 + coefficients.length * 2);
  const view = new DataView(request.buffer);
  view.setUint16(0, mix, true);
  coefficients.forEach((value, index) => {
    assertIndex(value, `Mixer coefficient ${index}`);
    view.setUint16(2 + index * 2, value, true);
  });
  return request;
}

export function muxReadRequest(mux, count) {
  assertIndex(mux, 'Routing table', 0xff);
  assertIndex(count, 'Routing entry count', 0xff);
  return Uint8Array.of(0, 0, count, mux);
}

export function muxWriteRequest(mux, values) {
  assertIndex(mux, 'Routing table');
  const routes = [...values];
  const request = new Uint8Array(4 + routes.length * 4);
  const view = new DataView(request.buffer);
  view.setUint16(2, mux, true);
  routes.forEach((value, index) => {
    assertIndex(value, `Routing entry ${index}`, 0xffffffff);
    view.setUint32(4 + index * 4, value, true);
  });
  return request;
}

export function decodeUint16Array(data) {
  const bytes = Uint8Array.from(data);
  if (bytes.byteLength % 2) throw new Error('Expected an even number of bytes for 16-bit values.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getUint16(index * 2, true));
}

export function decodeUint32Array(data) {
  const bytes = Uint8Array.from(data);
  if (bytes.byteLength % 4) throw new Error('Expected a multiple of four bytes for 32-bit values.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 4 }, (_, index) => view.getUint32(index * 4, true));
}
