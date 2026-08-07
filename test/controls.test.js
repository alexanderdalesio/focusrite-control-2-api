import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControlName, normalizeControlValue, publicControlDefinitions } from '../src/controls.js';

test('normalizes canonical names and aliases', () => {
  assert.equal(normalizeControlName('dim'), 'dim');
  assert.equal(normalizeControlName('MONITOR.DIM'), 'dim');
  assert.equal(normalizeControlName('input.1.48v'), 'input1-phantom');
});

test('rejects unknown controls', () => {
  assert.throws(() => normalizeControlName('headphones-9'), /Unknown control/);
});

test('normalizes boolean values', () => {
  assert.equal(normalizeControlValue('dim', 'on'), true);
  assert.equal(normalizeControlValue('dim', '0'), false);
  assert.throws(() => normalizeControlValue('dim', 'maybe'), /expects on or off/);
});

test('validates and rounds gain values to supported steps', () => {
  assert.equal(normalizeControlValue('monitor-gain', '-23.8'), -24);
  assert.equal(normalizeControlValue('input1-gain', 28.26), 28.5);
  assert.throws(() => normalizeControlValue('input1-gain', 80), /0 to 69/);
});

test('does not expose device object numbers through the public schema', () => {
  for (const definition of Object.values(publicControlDefinitions())) assert.equal('objectNumber' in definition, false);
});
