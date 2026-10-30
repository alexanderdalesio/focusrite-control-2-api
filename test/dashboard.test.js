import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const createFunction = source.slice(source.indexOf('function createControl('), source.indexOf('function buildControls('));
const renderFunction = source.slice(source.indexOf('function renderControls('), source.indexOf('function clamp('));

class Element {
  constructor() {
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.classList = { toggle() {}, contains() { return false; } };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
}

test('FC2 mute definitions create a toggle, not a rotary control', () => {
  const context = { document: { createElement: () => new Element() }, displayControlLabel: (_group, label) => label };
  vm.createContext(context);
  const row = vm.runInContext(`${createFunction}\ncreateControl('monitor-mute', { kind: 'mute', label: 'Monitor mute' }, 'Monitor')`, context);
  assert.equal(row.className, 'switchrow');
  assert.equal(row.children[1].dataset.toggle, 'monitor-mute');
});

test('hardware-controlled knobs are disabled with a clear explanation', () => {
  const knob = new Element();
  knob.dataset.knob = 'monitor-1-level';
  const context = {
    definitions: { 'monitor-1-level': { disabledWhen: { control: 'monitor-1-hardware-control', value: true }, disabledReason: 'Follows hardware volume.' } },
    values: { 'monitor-1-level': -30, 'monitor-1-hardware-control': true },
    busy: false,
    $$: (selector) => selector === '[data-knob]' ? [knob] : [],
    $: () => null,
    updateKnob() {},
  };
  vm.createContext(context);
  vm.runInContext(`${renderFunction}\nrenderControls()`, context);
  assert.equal(knob.disabled, true);
  assert.equal(knob.title, 'Follows hardware volume.');
  context.values['monitor-1-hardware-control'] = false;
  vm.runInContext('renderControls()', context);
  assert.equal(knob.disabled, false);
});

test('background read failure clears stale controls and the next successful poll clears the error', async () => {
  const refreshFunction = source.slice(source.indexOf('async function refreshControls('), source.indexOf('function updateBackendFields('));
  const messages = [];
  let fail = true;
  const context = {
    values: { dim: false }, definitions: { dim: {} }, busy: false, switchingBackend: false,
    controlRevision: 0, controlReadFailed: false,
    renderControls() {}, showMessage: (message) => messages.push(message),
    api: async () => { if (fail) throw new Error('USB transport lost'); return { values: { dim: false } }; },
  };
  vm.createContext(context);
  await vm.runInContext(`${refreshFunction}\nrefreshControls({ background: true })`, context);
  assert.equal(Object.keys(context.values).length, 0);
  assert.equal(context.controlReadFailed, true);
  fail = false;
  await vm.runInContext('refreshControls({ background: true })', context);
  assert.equal(context.values.dim, false);
  assert.equal(messages.at(-1), 'Controls are connected.');
  assert.equal(context.controlReadFailed, false);
});

test('firmware-rejected optional switches are disabled and explain their read-only status', () => {
  const button = new Element();
  button.dataset.toggle = 'metering-enabled';
  const context = {
    definitions: { 'metering-enabled': { access: 'read-only', disabledReason: 'Device rejected notification 27.' } },
    values: { 'metering-enabled': false }, busy: false,
    $$: (selector) => selector === '[data-toggle]' ? [button] : [],
  };
  vm.createContext(context);
  vm.runInContext(`${renderFunction}\nrenderControls()`, context);
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'Device rejected notification 27.');
});

test('experimental controls stay usable and show their verification limits', () => {
  const button = new Element();
  button.dataset.toggle = 'autogain-use-peak';
  const context = {
    definitions: { 'autogain-use-peak': { experimental: true, description: 'DSP effect not validated.' } },
    values: { 'autogain-use-peak': false }, busy: false,
    $$: (selector) => selector === '[data-toggle]' ? [button] : [],
  };
  vm.createContext(context);
  vm.runInContext(`${renderFunction}\nrenderControls()`, context);
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'DSP effect not validated.');
});

test('setting warnings remain visible without undoing a verified value', async () => {
  const setter = source.slice(source.indexOf('async function setControl('), source.indexOf('function bindControlEvents('));
  const messages = [];
  const context = {
    values: { 'autogain-maximum-gain': 52 }, definitions: {}, controlRevision: 0, busy: false,
    renderControls() {}, formatValue: (_name, value) => String(value),
    showMessage: (message, kind) => messages.push({ message, kind }),
    api: async () => ({ control: 'autogain-maximum-gain', value: 51, warnings: [{ message: 'DSP effect remains experimental.' }] }),
  };
  vm.createContext(context);
  await vm.runInContext(`${setter}\nsetControl('autogain-maximum-gain', 51)`, context);
  assert.equal(context.values['autogain-maximum-gain'], 51);
  assert.equal(messages[0].kind, 'warn');
  assert.match(messages[0].message, /experimental/);
});
