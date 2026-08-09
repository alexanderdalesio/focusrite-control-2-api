import { usb as legacyUsb } from 'usb';
import { decodeDeviceMap, decodePrimitive, encodePrimitive, resolveMember, resolveMemberElement } from './device-map.js';
import {
  buildDirectControlDefinitions,
  normalizeDirectControlName,
  normalizeDirectControlValue,
  publicDirectControlDefinitions,
} from './direct-controls.js';
import {
  FCP_HEADER_SIZE,
  FCP_NOTIFICATION_ACK,
  OPCODE,
  USB_REQUEST,
  dataRequest,
  dataWriteRequest,
  decodeUint16Array,
  decodeUint32Array,
  encodePacket,
  mixReadRequest,
  mixWriteRequest,
  meterReadRequest,
  muxReadRequest,
  muxWriteRequest,
  uint32,
  validateResponse,
} from './fcp-protocol.js';

export const FOCUSRITE_VENDOR_ID = 0x1235;
export const SCARLETT_16I16_4TH_GEN_PRODUCT_ID = 0x821b;

export function listFocusriteUsbDevices(vendorId = FOCUSRITE_VENDOR_ID) {
  return legacyUsb.getDeviceList()
    .filter(({ deviceDescriptor }) => deviceDescriptor.idVendor === vendorId)
    .map((device) => ({
      vendorId: hex(device.deviceDescriptor.idVendor),
      productId: hex(device.deviceDescriptor.idProduct),
      bus: device.busNumber,
      address: device.deviceAddress,
      ports: [...(device.portNumbers ?? [])],
    }));
}

const CONTROL_SETUP = Object.freeze({ requestType: 'class', recipient: 'interface', value: 0 });
const MIXER_MAX_RAW = 32613;
const MIXER_MIN_DB = -80;
const MIXER_MAX_DB = 12;
const METER_MAX_RAW = 4095;

export function mixerRawToDb(raw) {
  if (!Number.isInteger(raw) || raw < 0 || raw > MIXER_MAX_RAW) throw new RangeError(`Mixer coefficient must be between 0 and ${MIXER_MAX_RAW}.`);
  if (raw === 0) return MIXER_MIN_DB;
  const db = Math.max(MIXER_MIN_DB, Math.round((20 * Math.log10(raw / MIXER_MAX_RAW) + MIXER_MAX_DB) * 10) / 10);
  return Object.is(db, -0) ? 0 : db;
}

export function mixerDbToRaw(value) {
  if (String(value).trim().toLowerCase() === 'mute') return 0;
  const db = Number(value);
  if (!Number.isFinite(db) || db < MIXER_MIN_DB || db > MIXER_MAX_DB) throw new RangeError(`Mixer level must be between ${MIXER_MIN_DB} and ${MIXER_MAX_DB} dB, or "mute".`);
  if (db === MIXER_MIN_DB) return 0;
  return Math.min(MIXER_MAX_RAW, Math.max(1, Math.round(MIXER_MAX_RAW * (10 ** ((db - MIXER_MAX_DB) / 20)))));
}

export function meterRawToDbfs(raw) {
  if (!Number.isInteger(raw) || raw < 0 || raw > METER_MAX_RAW) throw new RangeError(`Meter value must be between 0 and ${METER_MAX_RAW}.`);
  if (raw === 0) return -120;
  return Math.max(-120, Math.round(20 * Math.log10(raw / METER_MAX_RAW) * 10) / 10);
}

function hex(value, width = 4) {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

function asBytes(value, description) {
  if (value == null) throw new Error(`${description} timed out.`);
  return Uint8Array.from(value);
}

function transferError(error, operation) {
  return new Error(`${operation} failed: ${error.message}`, { cause: error });
}

class LibusbDeviceAdapter {
  constructor(device) {
    this.raw = device;
    this.opened = false;
    this.claimedInterface = null;
    this.interruptEndpoint = null;
    this.productName = null;
  }

  get vendorId() { return this.raw.deviceDescriptor.idVendor; }
  get productId() { return this.raw.deviceDescriptor.idProduct; }
  get deviceVersion() { return this.raw.deviceDescriptor.bcdDevice; }
  get usbVersion() { return this.raw.deviceDescriptor.bcdUSB; }

  async open() {
    try {
      this.raw.open();
      this.opened = true;
      const productIndex = this.raw.deviceDescriptor.iProduct;
      if (productIndex) {
        this.productName = await new Promise((resolve) => {
          this.raw.getStringDescriptor(productIndex, (error, value) => resolve(error ? null : value));
        });
      }
    } catch (error) {
      throw transferError(error, 'Opening the USB device');
    }
  }

  findControlInterface() {
    const controlInterface = this.raw.interfaces?.find(({ descriptor, endpoints }) =>
      descriptor.bInterfaceClass === legacyUsb.LIBUSB_CLASS_VENDOR_SPEC
      && endpoints.some(({ direction, transferType }) => direction === 'in' && transferType === legacyUsb.LIBUSB_TRANSFER_TYPE_INTERRUPT),
    );
    if (!controlInterface) return null;
    const endpoint = controlInterface.endpoints.find(({ direction, transferType }) =>
      direction === 'in' && transferType === legacyUsb.LIBUSB_TRANSFER_TYPE_INTERRUPT,
    );
    return {
      interfaceNumber: controlInterface.interfaceNumber,
      endpointNumber: endpoint.address & 0x0f,
      packetSize: endpoint.descriptor.wMaxPacketSize,
      rawInterface: controlInterface,
      endpoint,
    };
  }

  async claimInterface(controlInterface) {
    try {
      controlInterface.rawInterface.claim();
      controlInterface.endpoint.timeout = 0;
      this.claimedInterface = controlInterface.rawInterface;
      this.interruptEndpoint = controlInterface.endpoint;
    } catch (error) {
      throw transferError(error, 'Claiming the USB control interface');
    }
  }

  async releaseInterface() {
    if (!this.claimedInterface) return;
    const claimedInterface = this.claimedInterface;
    this.claimedInterface = null;
    this.interruptEndpoint = null;
    await new Promise((resolve, reject) => {
      claimedInterface.release(true, (error) => error ? reject(transferError(error, 'Releasing the USB control interface')) : resolve());
    });
  }

  async close() {
    if (!this.opened) return;
    this.raw.close();
    this.opened = false;
  }

  async nativeControlTransferIn(setup, timeout, length) {
    this.raw.timeout = timeout;
    return new Promise((resolve, reject) => {
      this.raw.controlTransfer(0xa1, setup.request, setup.value, setup.index, length, (error, data) => {
        if (error) reject(transferError(error, `USB control read request ${setup.request}`));
        else resolve(data);
      });
    });
  }

  async nativeControlTransferOut(setup, timeout, data) {
    this.raw.timeout = timeout;
    const payload = Buffer.from(data);
    return new Promise((resolve, reject) => {
      this.raw.controlTransfer(0x21, setup.request, setup.value, setup.index, payload, (error, written) => {
        if (error) reject(transferError(error, `USB control write request ${setup.request}`));
        else resolve(typeof written === 'number' ? written : payload.byteLength);
      });
    });
  }

  async nativeTransferIn(_endpointNumber, timeout, length) {
    if (!this.interruptEndpoint) throw new Error('The USB interrupt endpoint is not claimed.');
    this.interruptEndpoint.timeout = timeout;
    return new Promise((resolve, reject) => {
      this.interruptEndpoint.transfer(length, (error, data) => {
        if (error) reject(transferError(error, 'USB interrupt read'));
        else resolve(data);
      });
    });
  }
}

export class FcpUsbTransport {
  constructor(device, { interfaceNumber, interruptEndpoint, packetSize = 64, timeout = 1500 } = {}) {
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.interruptEndpoint = interruptEndpoint;
    this.packetSize = packetSize;
    this.timeout = timeout;
    this.sequence = 0;
    this.events = [];
    this.queue = Promise.resolve();
  }

  #setup(request) {
    return { ...CONTROL_SETUP, request, index: this.interfaceNumber };
  }

  async step0(responseSize = 24) {
    return asBytes(
      await this.device.nativeControlTransferIn(this.#setup(USB_REQUEST.step0), this.timeout, responseSize),
      'FCP step-zero request',
    );
  }

  async #waitForAck() {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = asBytes(
        await this.device.nativeTransferIn(this.interruptEndpoint, remaining, this.packetSize),
        'FCP interrupt notification',
      );
      if (message.byteLength !== 8) throw new Error(`Expected an 8-byte FCP notification, received ${message.byteLength}.`);
      const bits = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0, true);
      const event = bits & ~FCP_NOTIFICATION_ACK;
      if (event) this.events.push(event);
      if (bits & FCP_NOTIFICATION_ACK) return;
    }
    throw new Error('FCP command acknowledgement timed out.');
  }

  command(opcode, requestData = new Uint8Array(), responseSize = 0) {
    const result = this.queue.then(() => this.#command(opcode, requestData, responseSize));
    this.queue = result.catch(() => {});
    return result;
  }

  async #command(opcode, requestData, responseSize) {
    const sequence = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff;
    const packet = encodePacket(opcode, sequence, requestData);
    const acknowledgement = this.#waitForAck();
    acknowledgement.catch(() => {});
    const written = await this.device.nativeControlTransferOut(
      this.#setup(USB_REQUEST.commandTransmit),
      this.timeout,
      packet,
    );
    if (written !== packet.byteLength) throw new Error(`FCP command wrote ${written} of ${packet.byteLength} bytes.`);
    await acknowledgement;
    const response = asBytes(
      await this.device.nativeControlTransferIn(
        this.#setup(USB_REQUEST.commandReceive),
        this.timeout,
        FCP_HEADER_SIZE + responseSize,
      ),
      'FCP command response',
    );
    return validateResponse(response, { opcode, sequence, responseSize });
  }

  async initialize() {
    const step0 = await this.step0(24);
    this.sequence = 0;
    await this.command(OPCODE.init1);
    const step2 = await this.command(OPCODE.init2, new Uint8Array(), 84);
    const firmware = new DataView(step2.buffer, step2.byteOffset, step2.byteLength).getUint32(8, true);
    return { step0, step2, firmware };
  }

  readData(offset, size) {
    return this.command(OPCODE.dataRead, dataRequest(offset, size), size);
  }

  writeData(offset, data) {
    return this.command(OPCODE.dataWrite, dataWriteRequest(offset, data));
  }

  async notify(event) {
    await this.command(OPCODE.dataNotify, uint32(event));
  }

  async readDeviceMap() {
    const info = await this.command(OPCODE.deviceMapInfo, new Uint8Array(), 4);
    const encodedSize = new DataView(info.buffer, info.byteOffset, info.byteLength).getUint16(2, true);
    if (encodedSize < 1 || encodedSize > 0xffff) throw new Error(`Invalid device-map size: ${encodedSize}.`);
    const encoded = new Uint8Array(encodedSize);
    const blockSize = 1024;
    for (let offset = 0; offset < encodedSize; offset += blockSize) {
      const responseSize = Math.min(blockSize, encodedSize - offset);
      const block = await this.command(OPCODE.deviceMapRead, uint32(offset / blockSize), responseSize);
      encoded.set(block, offset);
    }
    return { encoded, map: decodeDeviceMap(encoded) };
  }

  async mixInfo() {
    const response = await this.command(OPCODE.mixInfo, new Uint8Array(), 8);
    const outputs = response[0];
    const inputs = response[1];
    if (!outputs || !inputs) throw new Error(`Invalid mixer dimensions: ${outputs} outputs by ${inputs} inputs.`);
    return { outputs, inputs };
  }

  async meterInfo() {
    const response = await this.command(OPCODE.meterInfo, new Uint8Array(), 4);
    const count = response[0];
    if (!count) throw new Error('The Scarlett reported no meter slots.');
    return count;
  }

  async readMeters(count) {
    return decodeUint32Array(await this.command(OPCODE.meterRead, meterReadRequest(count), count * 4));
  }

  async readMix(mix, count) {
    return decodeUint16Array(await this.command(OPCODE.mixRead, mixReadRequest(mix, count), count * 2));
  }

  async writeMix(mix, values) {
    await this.command(OPCODE.mixWrite, mixWriteRequest(mix, values));
  }

  async muxInfo() {
    const values = decodeUint16Array(await this.command(OPCODE.muxInfo, new Uint8Array(), 12));
    const sizes = values.slice(0, 3);
    if (sizes.some((size) => size < 1 || size > 0xff)) throw new Error(`Invalid routing table sizes: ${sizes.join(', ')}.`);
    return sizes;
  }

  async readMux(mux, count) {
    return decodeUint32Array(await this.command(OPCODE.muxRead, muxReadRequest(mux, count), count * 4));
  }

  async writeMux(mux, values) {
    await this.command(OPCODE.muxWrite, muxWriteRequest(mux, values));
  }
}

export class DirectFocusriteClient {
  constructor({ vendorId = FOCUSRITE_VENDOR_ID, productId, timeout = 1500 } = {}) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.timeout = timeout;
    this.device = null;
    this.transport = null;
    this.interfaceNumber = null;
    this.initialization = null;
    this.deviceMap = null;
    this.deviceMapPromise = null;
    this.controls = null;
    this.queue = Promise.resolve();
    this.connectPromise = null;
  }

  get connected() {
    return Boolean(this.device?.opened && this.transport);
  }

  get backend() {
    return 'usb';
  }

  async connect() {
    if (this.connected) return this;
    if (!this.connectPromise) this.connectPromise = this.#open();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async #open() {
    const devices = legacyUsb.getDeviceList().filter(({ deviceDescriptor }) =>
      deviceDescriptor.idVendor === this.vendorId && (this.productId == null || deviceDescriptor.idProduct === this.productId),
    );
    if (devices.length === 0) {
      const product = this.productId == null ? '' : ` product ${hex(this.productId)}`;
      throw new Error(`No Focusrite USB device with vendor ${hex(this.vendorId)}${product} is connected.`);
    }
    if (devices.length > 1 && this.productId == null) throw new Error('More than one Focusrite USB device is connected; select a product ID explicitly.');

    const device = new LibusbDeviceAdapter(devices[0]);
    try {
      await device.open();
      const controlInterface = device.findControlInterface();
      if (!controlInterface) throw new Error('The device has no Focusrite vendor control interface.');
      await device.claimInterface(controlInterface);
      this.device = device;
      this.interfaceNumber = controlInterface.interfaceNumber;
      this.transport = new FcpUsbTransport(device, {
        interfaceNumber: controlInterface.interfaceNumber,
        interruptEndpoint: controlInterface.endpointNumber,
        packetSize: controlInterface.packetSize,
        timeout: this.timeout,
      });
      this.initialization = await this.transport.initialize();
      return this;
    } catch (error) {
      try { if (this.interfaceNumber != null) await device.releaseInterface(); } catch {}
      try { await device.close(); } catch {}
      this.device = null;
      this.transport = null;
      this.interfaceNumber = null;
      const ownership = /claim|access|busy|exclusive|open|iokit/i.test(error.message)
        ? ' Quit Focusrite Control 2 and retry; direct USB mode needs exclusive access to the control interface.'
        : '';
      throw new Error(`Cannot open the Focusrite USB control interface: ${error.message}.${ownership}`);
    }
  }

  async close() {
    try { await this.connectPromise; } catch {}
    try { await this.queue; } catch {}
    try { await this.transport?.queue; } catch {}
    const device = this.device;
    const interfaceNumber = this.interfaceNumber;
    this.device = null;
    this.transport = null;
    this.interfaceNumber = null;
    this.initialization = null;
    this.deviceMap = null;
    this.deviceMapPromise = null;
    this.controls = null;
    try { if (device?.opened && interfaceNumber != null) await device.releaseInterface(); } catch {}
    try { if (device?.opened) await device.close(); } catch {}
  }

  async deviceInfo() {
    await this.connect();
    return {
      vendorId: hex(this.device.vendorId),
      productId: hex(this.device.productId),
      productName: this.device.productName || 'Focusrite USB interface',
      usbVersion: hex(this.device.usbVersion),
      deviceVersion: hex(this.device.deviceVersion),
      fcpFirmware: this.initialization.firmware,
      interfaceNumber: this.interfaceNumber,
      protocol: 'Focusrite Control Protocol over USB',
    };
  }

  async readDeviceMap() {
    await this.connect();
    if (this.deviceMap) return { encoded: null, map: this.deviceMap };
    if (!this.deviceMapPromise) {
      this.deviceMapPromise = this.transport.readDeviceMap().then((result) => {
        this.deviceMap = result.map;
        this.controls = buildDirectControlDefinitions(result.map);
        return result;
      }).finally(() => { this.deviceMapPromise = null; });
    }
    return this.deviceMapPromise;
  }

  async controlDefinitions() {
    await this.readDeviceMap();
    return publicDirectControlDefinitions(this.controls);
  }

  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async #readControl(name) {
    const item = this.controls[name];
    const member = resolveMemberElement(this.deviceMap, item.path, item.index);
    const raw = decodePrimitive(member.type, await this.transport.readData(member.offset, member.width));
    if (item.kind === 'boolean') return Boolean(raw);
    if (item.kind === 'enum') return item.values[raw] ?? raw;
    return raw;
  }

  async #writeControl(name, value) {
    const item = this.controls[name];
    const member = resolveMemberElement(this.deviceMap, item.path, item.index);
    const range = member.member.range;
    if (range && (value < range.min || value > range.max)) throw new RangeError(`${name} is outside the device range ${range.min} to ${range.max}.`);
    await this.transport.writeData(member.offset, encodePrimitive(member.type, item.kind === 'boolean' ? Number(value) : value));
    const notification = Number(item.notify ?? member.member['notify-device'] ?? (item.save ? 6 : 0));
    if (notification) await this.transport.notify(notification);
  }

  read(names) {
    return this.enqueue(async () => {
      await this.readDeviceMap();
      const selected = names?.length ? names.map((name) => normalizeDirectControlName(this.controls, name)) : Object.keys(this.controls);
      const entries = [];
      for (const name of selected) entries.push([name, await this.#readControl(name)]);
      return Object.fromEntries(entries);
    });
  }

  apply(operations) {
    return this.enqueue(async () => {
      await this.readDeviceMap();
      const normalized = [];
      for (const operation of operations) {
        const control = normalizeDirectControlName(this.controls, operation.control);
        let value = operation.value;
        if (operation.action === 'toggle') {
          if (this.controls[control].kind !== 'boolean') throw new TypeError(`${control} cannot be toggled.`);
          value = !await this.#readControl(control);
        }
        normalized.push({ control, value: normalizeDirectControlValue(this.controls, control, value) });
      }
      const originals = new Map();
      for (const { control } of normalized) {
        if (!originals.has(control)) {
          const value = await this.#readControl(control);
          originals.set(control, normalizeDirectControlValue(this.controls, control, value));
        }
      }
      const attempted = [];
      try {
        for (const { control, value } of normalized) {
          attempted.push(control);
          await this.#writeControl(control, value);
        }
      } catch (error) {
        const rollbackErrors = [];
        for (const control of [...new Set(attempted)].reverse()) {
          try { await this.#writeControl(control, originals.get(control)); } catch (rollbackError) { rollbackErrors.push(`${control}: ${rollbackError.message}`); }
        }
        const suffix = rollbackErrors.length ? ` Rollback also failed for ${rollbackErrors.join('; ')}.` : ' Earlier changes were rolled back.';
        throw new Error(`${error.message}.${suffix}`, { cause: error });
      }
      const values = {};
      for (const { control } of normalized) values[control] = await this.#readControl(control);
      return { applied: normalized.length, values };
    });
  }

  setLed(index, color) {
    return this.enqueue(async () => {
      const info = await this.ledInfo();
      const error = new Error(info.reason);
      error.statusCode = 501;
      throw error;
    });
  }

  async ledInfo() {
    await this.readDeviceMap();
    const capacity = Number(this.deviceMap.enums?.maximum_array_sizes?.enumerators?.kMAX_NUMBER_LEDS);
    const commandBufferPresent = Boolean(this.deviceMap.structs?.APP_SPACE?.members?.setLED);
    const readNumber = async (path) => {
      const item = resolveMember(this.deviceMap, path);
      const size = Number(item.member.size);
      const bytes = await this.transport.readData(item.offset, size);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = size === 1 ? view.getUint8(0) : size === 2 ? view.getUint16(0, true) : view.getUint32(0, true);
      const enumerators = this.deviceMap.enums?.[item.type]?.enumerators;
      const name = enumerators ? Object.entries(enumerators).find(([, candidate]) => Number(candidate) === value)?.[0] ?? null : null;
      return { value, name };
    };
    const [major, minor, build, patch, reset, modelId, ipc, encryption, superState, espIsDead, meterData] = await Promise.all([
      readNumber('espSpace.firmwareVersion.major'),
      readNumber('espSpace.firmwareVersion.minor'),
      readNumber('espSpace.firmwareVersion.build'),
      readNumber('espSpace.firmwareVersion.patch'),
      readNumber('espSpace.reasonForLastReset'),
      readNumber('espSpace.modelId'),
      readNumber('espSpace.ipcProtocolVersion'),
      readNumber('espSpace.encryption'),
      readNumber('espSpace.SuperState'),
      readNumber('espSpace.ESPIsDead'),
      readNumber('meterDataToESP32'),
    ]);
    return {
      supported: false,
      reason: 'Visible per-index LED and gain-halo colour control is not supported on the tested Scarlett 16i16 4th Gen firmware. Its mapped LED test buffers accept writes but do not reach the ESP32 front-panel renderer; their notification events caused temporary USB re-enumeration during hardware testing.',
      internalCommandBuffer: {
        present: commandBufferPresent,
        capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
      },
      frontPanelController: {
        type: 'ESP32',
        firmwareFields: { major: major.value, minor: minor.value, build: build.value, patch: patch.value },
        modelId: modelId.value,
        ipcProtocolVersion: ipc.value,
        encryption: encryption.name ?? encryption.value,
        lastReset: reset.name ?? reset.value,
        superState: superState.name ?? superState.value,
        dead: Boolean(espIsDead.value),
        meterDataEnabled: Boolean(meterData.value),
      },
    };
  }

  #deviceSpecification() {
    const specification = this.deviceMap?.['device-specification'];
    if (!specification?.sources || !specification?.destinations) throw new Error('The Scarlett device map has no routing specification.');
    return specification;
  }

  #findNamed(items, requested, description) {
    const query = String(requested ?? '').trim().toLowerCase();
    const exact = items.find(({ name }) => name.toLowerCase() === query);
    if (exact) return exact;
    const normalized = query.replace(/[^a-z0-9]/g, '');
    const match = items.find(({ name }) => name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
    if (!match) throw new TypeError(`Unknown ${description}: ${requested}.`);
    return match;
  }

  async #routingState() {
    await this.readDeviceMap();
    const specification = this.#deviceSpecification();
    const sources = [{ name: 'Off', type: 'off', 'router-pin': 0 }, ...specification.sources];
    const sourceByPin = new Map(sources.map((source) => [Number(source['router-pin']), source]));
    const sizes = await this.transport.muxInfo();
    const tables = [];
    for (let index = 0; index < sizes.length; index += 1) tables.push(await this.transport.readMux(index, sizes[index]));
    const destinations = specification.destinations.map((destination) => {
      if (destination['static-source']) {
        return {
          name: destination.name,
          type: destination.type,
          routerPin: Number(destination['router-pin']),
          writable: false,
          source: destination['static-source'],
          rates: sizes.map((size, index) => ({ table: index, entries: size, source: destination['static-source'], slot: null })),
        };
      }
      const pin = Number(destination['router-pin']);
      const rates = tables.map((table, index) => {
        const slot = table.findIndex((route) => (route & 0xfff) === pin);
        const sourcePin = slot < 0 ? null : table[slot] >>> 12;
        return { table: index, entries: sizes[index], slot: slot < 0 ? null : slot, source: sourcePin == null ? null : (sourceByPin.get(sourcePin)?.name ?? `Unknown pin ${sourcePin}`) };
      });
      return {
        name: destination.name,
        type: destination.type,
        routerPin: pin,
        writable: rates[0].slot != null,
        source: rates[0].source,
        rates,
      };
    });
    return {
      sources: sources.map(({ name, type, 'router-pin': routerPin }) => ({ name, type, routerPin: Number(routerPin) })),
      destinations,
      tableSizes: sizes,
      tables,
    };
  }

  routingState() {
    return this.enqueue(async () => {
      const { tables: _tables, ...state } = await this.#routingState();
      return state;
    });
  }

  setRouting(destinationName, sourceName) {
    return this.enqueue(async () => {
      const state = await this.#routingState();
      const specification = this.#deviceSpecification();
      const destination = this.#findNamed(specification.destinations, destinationName, 'routing destination');
      if (destination['static-source']) throw new Error(`${destination.name} is fixed to ${destination['static-source']} by the device.`);
      const source = this.#findNamed([{ name: 'Off', type: 'off', 'router-pin': 0 }, ...specification.sources], sourceName, 'routing source');
      const destinationPin = Number(destination['router-pin']);
      const sourcePin = Number(source['router-pin']);
      const originals = state.tables.map((table) => [...table]);
      let changed = 0;
      const writtenTables = [];
      try {
        for (let tableIndex = 0; tableIndex < state.tables.length; tableIndex += 1) {
          const table = state.tables[tableIndex];
          const slot = table.findIndex((route) => (route & 0xfff) === destinationPin);
          if (slot < 0) {
            if (tableIndex === 0) throw new Error(`The Scarlett has no routing slot for ${destination.name}.`);
            continue;
          }
          const next = ((sourcePin << 12) | destinationPin) >>> 0;
          if (table[slot] !== next) {
            table[slot] = next;
            writtenTables.push(tableIndex);
            await this.transport.writeMux(tableIndex, table);
            changed += 1;
          }
        }
        const verified = await this.#routingState();
        const route = this.#findNamed(verified.destinations, destination.name, 'routing destination');
        if (route.source !== source.name) throw new Error(`Routing verification failed: ${destination.name} reports ${route.source ?? 'no source'}.`);
        return { destination: destination.name, source: source.name, changedTables: changed, rates: route.rates };
      } catch (error) {
        const rollbackErrors = [];
        for (const tableIndex of writtenTables.reverse()) {
          try { await this.transport.writeMux(tableIndex, originals[tableIndex]); } catch (rollbackError) { rollbackErrors.push(`table ${tableIndex}: ${rollbackError.message}`); }
        }
        const suffix = rollbackErrors.length ? ` Rollback also failed for ${rollbackErrors.join('; ')}.` : writtenTables.length ? ' Earlier routing writes were rolled back.' : '';
        throw new Error(`${error.message}.${suffix}`, { cause: error });
      }
    });
  }

  async #mixerMetadata() {
    await this.readDeviceMap();
    const dimensions = await this.transport.mixInfo();
    const specification = this.#deviceSpecification();
    const outputs = specification.sources
      .filter((item) => Number.isInteger(item['mixer-output-index']))
      .sort((a, b) => a['mixer-output-index'] - b['mixer-output-index'])
      .slice(0, dimensions.outputs)
      .map((item) => ({ name: item.name, index: item['mixer-output-index'] }));
    const inputs = specification.destinations
      .filter((item) => Number.isInteger(item['mixer-input-index']))
      .sort((a, b) => a['mixer-input-index'] - b['mixer-input-index'])
      .slice(0, dimensions.inputs)
      .map((item) => ({ name: item['static-source'] || item.name, channel: item.name, index: item['mixer-input-index'] }));
    if (outputs.length !== dimensions.outputs || inputs.length !== dimensions.inputs) throw new Error('The mixer dimensions do not match the device specification.');
    return { ...dimensions, outputs, inputs, mixes: specification.mixes ?? [] };
  }

  mixerInfo() {
    return this.enqueue(() => this.#mixerMetadata());
  }

  mixerState(outputName) {
    return this.enqueue(async () => {
      const metadata = await this.#mixerMetadata();
      const selected = outputName ? [this.#findNamed(metadata.outputs, outputName, 'mixer output')] : metadata.outputs;
      const channels = [];
      for (const output of selected) {
        const raw = await this.transport.readMix(output.index, metadata.inputs.length);
        channels.push({
          output: output.name,
          index: output.index,
          inputs: metadata.inputs.map((input) => ({ ...input, raw: raw[input.index], db: mixerRawToDb(raw[input.index]), muted: raw[input.index] === 0 })),
        });
      }
      return { outputs: metadata.outputs, inputs: metadata.inputs, mixes: metadata.mixes, channels };
    });
  }

  setMixerLevel(outputName, inputName, value) {
    return this.enqueue(async () => {
      const metadata = await this.#mixerMetadata();
      const output = this.#findNamed(metadata.outputs, outputName, 'mixer output');
      const input = this.#findNamed(metadata.inputs, inputName, 'mixer input');
      const raw = await this.transport.readMix(output.index, metadata.inputs.length);
      const original = [...raw];
      const requested = mixerDbToRaw(value);
      raw[input.index] = requested;
      try {
        await this.transport.writeMix(output.index, raw);
        const verified = await this.transport.readMix(output.index, metadata.inputs.length);
        if (verified[input.index] !== requested) throw new Error('Mixer level verification failed.');
        return { output: output.name, input: input.name, raw: requested, db: mixerRawToDb(requested), muted: requested === 0 };
      } catch (error) {
        try {
          await this.transport.writeMix(output.index, original);
        } catch (rollbackError) {
          throw new Error(`${error.message}. Mixer rollback also failed: ${rollbackError.message}.`, { cause: error });
        }
        throw new Error(`${error.message}. The previous mixer row was restored.`, { cause: error });
      }
    });
  }

  meterState() {
    return this.enqueue(async () => {
      await this.readDeviceMap();
      const count = await this.transport.meterInfo();
      const raw = await this.transport.readMeters(count);
      const specification = this.#deviceSpecification();
      const channels = [
        ...specification.sources.map((item) => ({ ...item, direction: 'source' })),
        ...specification.destinations.map((item) => ({ ...item, direction: 'destination' })),
      ]
        .filter((item) => Number.isInteger(item['peak-index']) && item['peak-index'] >= 0 && item['peak-index'] < count)
        .map((item) => ({
          name: item.name,
          direction: item.direction,
          type: item.type,
          index: item['peak-index'],
          raw: raw[item['peak-index']],
          dbfs: meterRawToDbfs(raw[item['peak-index']]),
        }));
      return { count, channels };
    });
  }
}
