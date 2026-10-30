import test from 'node:test';
import assert from 'node:assert/strict';
import { FcpUsbTransport } from '../src/usb/direct-client.js';
import { FcpDeviceError, FcpTransportError, OPCODE, decodePacket, encodePacket } from '../src/usb/fcp-protocol.js';

function transportWith(responses) {
  const sent = [];
  let acknowledgements = 0;
  const transport = new FcpUsbTransport({
    async nativeTransferIn() { acknowledgements++; return Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0); },
    async nativeControlTransferOut(_setup, _timeout, packet) { sent.push(decodePacket(packet)); return packet.length; },
    async nativeControlTransferIn(_setup, _timeout, length) { return responses.shift().slice(0, length); },
  }, { interfaceNumber: 3, interruptEndpoint: 1 });
  return { transport, sent, acknowledgements: () => acknowledgements };
}

test('consumes an older response without retransmitting a write, including sequence wrap', async () => {
  const { transport, sent, acknowledgements } = transportWith([
    encodePacket(OPCODE.dataRead, 0xffff, Uint8Array.of(1, 2, 3, 4)),
    encodePacket(OPCODE.dataWrite, 0),
  ]);
  await transport.command(OPCODE.dataWrite);
  assert.equal(sent.length, 1);
  assert.equal(acknowledgements(), 2);
  assert.equal(transport.failure, null);
});

test('unexpected future response invalidates the transport and blocks queued commands', async () => {
  const { transport, sent } = transportWith([encodePacket(OPCODE.dataWrite, 1)]);
  const first = transport.command(OPCODE.dataWrite);
  const second = transport.command(OPCODE.dataWrite);
  await assert.rejects(first, FcpTransportError);
  await assert.rejects(second, /sequence mismatch/);
  assert.equal(sent.length, 1);
});

test('device-rejected notification does not poison transport synchronization', async () => {
  const rejected = encodePacket(OPCODE.dataNotify, 0);
  new DataView(rejected.buffer).setUint32(8, 7, true);
  const { transport, sent } = transportWith([rejected, encodePacket(OPCODE.dataRead, 1, Uint8Array.of(42))]);
  await assert.rejects(transport.command(OPCODE.dataNotify), FcpDeviceError);
  assert.deepEqual(await transport.command(OPCODE.dataRead, new Uint8Array(), 1), Uint8Array.of(42));
  assert.equal(sent.length, 2);
  assert.equal(transport.failure, null);
});

test('stale replies are bounded instead of causing an unending recovery loop', async () => {
  const { transport, sent } = transportWith(Array.from({ length: 4 }, () => encodePacket(OPCODE.dataRead, 0xffff)));
  await assert.rejects(transport.command(OPCODE.dataWrite), /did not synchronize/);
  assert.equal(sent.length, 1);
  assert(transport.failure);
});
