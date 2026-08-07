import { OcaBooleanActuator } from 'aes70/src/controller/ControlClasses/OcaBooleanActuator.js';
import { OcaGain } from 'aes70/src/controller/ControlClasses/OcaGain.js';
import { OcaMute } from 'aes70/src/controller/ControlClasses/OcaMute.js';
import { OcaStringSensor } from 'aes70/src/controller/ControlClasses/OcaStringSensor.js';
import { CONTROLS, normalizeControlName, normalizeControlValue } from './controls.js';
import { createSecureSession, withTimeout } from './secure-transport.js';

const DEVICE_FIELDS = Object.freeze({
  productName: 4097,
  serialNumber: 4099,
  firmwareVersion: 4100,
});

function firstValue(result) {
  return typeof result?.item === 'function' ? result.item(0) : (result?.[0] ?? result);
}

export class FocusriteClient {
  constructor(config, { keyPath, logger = console } = {}) {
    this.config = config;
    this.keyPath = keyPath;
    this.logger = logger;
    this.session = null;
    this.connecting = null;
    this.queue = Promise.resolve();
  }

  get connected() {
    return Boolean(this.session && !this.session.connection.closed);
  }

  async connect() {
    if (this.connected) return this.session;
    if (this.connecting) return this.connecting;
    this.connecting = createSecureSession({
      host: this.config.host,
      port: this.config.securePort,
      serverPublicKey: this.config.serverPublicKey,
      keyPath: this.keyPath,
    }).then((session) => {
      this.session = session;
      session.connection.on('close', () => { if (this.session === session) this.session = null; });
      return session;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  close() {
    const session = this.session;
    this.session = null;
    try { session?.device.close(); } catch {}
    try { session?.connection.cleanup(); } catch {}
  }

  updateConfig(config) {
    this.config = config;
    this.close();
  }

  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async #withReconnect(operation) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await operation(await this.connect()); } catch (error) {
        lastError = error;
        this.close();
        if (attempt === 0) this.logger.warn?.(`Focusrite session lost; reconnecting: ${error.message}`);
      }
    }
    throw lastError;
  }

  #flush(session, pending, label) {
    session.connection.sendCommands();
    session.connection.flush();
    return withTimeout(Promise.all(pending), 5000, label);
  }

  #scheduleRead(session, name) {
    const definition = CONTROLS[name];
    if (definition.kind === 'boolean') return new OcaBooleanActuator(definition.objectNumber, session.device).GetSetting();
    if (definition.kind === 'mute') return new OcaMute(definition.objectNumber, session.device).GetState().then((state) => Number(state) === 1);
    return new OcaGain(definition.objectNumber, session.device).GetGain().then((result) => Number(firstValue(result)));
  }

  #scheduleWrite(session, name, value) {
    const definition = CONTROLS[name];
    if (definition.kind === 'boolean') return new OcaBooleanActuator(definition.objectNumber, session.device).SetSetting(value);
    if (definition.kind === 'mute') return new OcaMute(definition.objectNumber, session.device).SetState(value ? 1 : 2);
    return new OcaGain(definition.objectNumber, session.device).SetGain(value);
  }

  read(names = Object.keys(CONTROLS)) {
    return this.enqueue(() => this.#withReconnect(async (session) => {
      const normalized = names.map(normalizeControlName);
      const values = await this.#flush(session, normalized.map((name) => this.#scheduleRead(session, name)), 'Control read');
      return Object.fromEntries(normalized.map((name, index) => [name, values[index]]));
    }));
  }

  deviceInfo() {
    return this.enqueue(() => this.#withReconnect(async (session) => {
      const fields = Object.keys(DEVICE_FIELDS);
      const pending = fields.map((field) => new OcaStringSensor(DEVICE_FIELDS[field], session.device).GetReading());
      const values = await this.#flush(session, pending, 'Device information read');
      return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
    }));
  }

  apply(operations) {
    return this.enqueue(async () => {
      const normalized = operations.map((item) => {
        const control = normalizeControlName(item.control);
        return { control, action: item.action ?? 'set', value: item.value };
      });

      const toggleNames = [...new Set(normalized.filter((item) => item.action === 'toggle').map((item) => item.control))];
      let toggleState = {};
      if (toggleNames.length) {
        toggleState = await this.#withReconnect(async (session) => {
          const values = await this.#flush(session, toggleNames.map((name) => this.#scheduleRead(session, name)), 'Toggle state read');
          return Object.fromEntries(toggleNames.map((name, index) => [name, values[index]]));
        });
      }

      const explicit = normalized.map((item) => ({
        control: item.control,
        value: normalizeControlValue(item.control, item.action === 'toggle' ? !toggleState[item.control] : item.value),
      }));

      await this.#withReconnect(async (session) => {
        await this.#flush(session, explicit.map(({ control, value }) => this.#scheduleWrite(session, control, value)), 'Control write');
      });

      const affected = [...new Set(explicit.map((item) => item.control))];
      const verified = await this.#withReconnect(async (session) => {
        const values = await this.#flush(session, affected.map((name) => this.#scheduleRead(session, name)), 'Control verification');
        return Object.fromEntries(affected.map((name, index) => [name, values[index]]));
      });
      return { values: verified, applied: explicit.length };
    });
  }
}
