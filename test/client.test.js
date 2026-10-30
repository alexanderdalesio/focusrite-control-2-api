import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusriteClient } from '../src/client.js';

function clientWithGain({ ignoreWrites = false } = {}) {
  const values = new Map([[4118, -30], [4127, 31], [4145, 12]]);
  const client = new FocusriteClient({}, { logger: { warn() {} } });
  client.session = {
    connection: { closed: false, sendCommands() {}, flush() {} },
    device: {
      async send_command(command, _returnTypes, _callback, name) {
        if (name === 'OcaGain.GetGain') return [values.get(command.target), command.target === 4118 ? -80 : 0, command.target === 4118 ? 0 : 69];
        if (name === 'OcaGain.SetGain') {
          if (!ignoreWrites) values.set(command.target, command.parameters.data[0]);
          return [];
        }
        throw new Error(`Unexpected command ${name}`);
      },
    },
  };
  return { client, values };
}

test('FC2 exposes live gain bounds and whole-dB monitor steps', async () => {
  const { client } = clientWithGain();
  const definitions = await client.controlDefinitions();
  assert.equal(definitions['monitor-gain'].min, -80);
  assert.equal(definitions['monitor-gain'].max, 0);
  assert.equal(definitions['monitor-gain'].step, 1);
  assert.equal(definitions['input1-gain'].step, 0.5);
  await assert.rejects(client.apply([{ control: 'monitor-gain', value: 1 }]), /-80 to 0/);
});

test('FC2 normalizes monitor gain to supported whole-dB values before writing', async () => {
  const { client, values } = clientWithGain();
  assert.deepEqual(await client.apply([{ control: 'monitor-gain', value: -30.5 }]), { applied: 1, values: { 'monitor-gain': -30 } });
  assert.equal(values.get(4118), -30);
});

test('FC2 rejects a setter that acknowledges but does not apply the requested value', async () => {
  const { client } = clientWithGain({ ignoreWrites: true });
  await assert.rejects(client.apply([{ control: 'monitor-gain', value: -31 }]), /verification failed: requested -31, received -30/);
});
