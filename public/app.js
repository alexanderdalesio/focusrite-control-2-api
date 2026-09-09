const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let values = {};
let definitions = {};
let backend = null;
let busy = false;
let switchingBackend = false;
let lastPairingState = null;
let polling = false;
let definitionFingerprint = '';
let developerFingerprint = '';
let controlRevision = 0;
const initialUrl = new URL(window.location.href);
const accessToken = initialUrl.searchParams.get('access_token') || sessionStorage.getItem('focusriteApiAccessToken') || '';
if (initialUrl.searchParams.has('access_token')) {
  sessionStorage.setItem('focusriteApiAccessToken', accessToken);
  initialUrl.searchParams.delete('access_token');
  history.replaceState(null, '', initialUrl);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showMessage(text, kind = '') {
  const element = $('#message');
  element.textContent = text;
  element.className = `message ${kind}`;
}

function setText(selector, text) {
  const element = $(selector);
  if (element.textContent !== text) element.textContent = text;
}

function setFieldValue(selector, value) {
  const element = $(selector);
  const next = String(value ?? '');
  if (document.activeElement !== element && element.value !== next) element.value = next;
}

function setPairPanelOpen(open) {
  const panel = $('#pairPanel');
  const button = $('#pairButton');
  panel.classList.toggle('show', open);
  button.classList.toggle('active', open);
  button.textContent = open ? 'Close pairing' : 'Pair this computer';
  button.setAttribute('aria-expanded', String(open));
}

function groupName(name) {
  if (/^input\d+-/.test(name)) return `Input ${name.match(/^input(\d+)/)[1]}`;
  const monitorPair = name.match(/^monitor-(\d+)-(\d+)-/);
  if (monitorPair) return `Monitor ${monitorPair[1]}–${monitorPair[2]}`;
  const monitorChannel = name.match(/^monitor-(\d+)-/);
  if (monitorChannel) {
    const channel = Number(monitorChannel[1]);
    const first = Math.floor((channel - 1) / 2) * 2 + 1;
    return `Monitor ${first}–${first + 1}`;
  }
  const headphone = name.match(/^headphone-(\d+)(?:[lr])?-/);
  if (headphone) return `Headphone ${headphone[1]}`;
  if (['dim', 'alt', 'monitor-mute', 'monitor-gain', 'dim-level'].includes(name)) return 'Monitor';
  if (name === 'selected-input' || name.startsWith('autogain-')) return 'Auto Gain';
  if (['talkback-enabled', 'talkback', 'alt-talkback-enabled'].includes(name)) return 'Talkback';
  if (['output-switch', 'output-relay-mute'].includes(name)) return 'Output control';
  return 'Interface';
}

function groupDescription(group) {
  if (/^Input /.test(group)) return 'Analogue input';
  if (/^(Monitor|Headphone) \d/.test(group)) return 'Output';
  if (group === 'Monitor') return 'Main monitoring';
  if (group === 'Auto Gain') return 'Automatic level setup';
  if (group === 'Talkback') return 'Communication controls';
  if (group === 'Output control') return 'Hardware switching';
  return 'Interface settings';
}

function groupOrder(group) {
  if (group === 'Monitor') return 0;
  if (/^Input /.test(group)) return 10 + Number(group.match(/\d+/)?.[0] ?? 0);
  if (/^Monitor \d/.test(group)) return 20 + Number(group.match(/\d+/)?.[0] ?? 0);
  if (/^Headphone /.test(group)) return 30 + Number(group.match(/\d+/)?.[0] ?? 0);
  return { 'Auto Gain': 40, Talkback: 50, 'Output control': 60, Interface: 70 }[group] ?? 90;
}

function controlOrder(group, name) {
  const orders = {
    Monitor: ['monitor-gain', 'dim-level', 'monitor-mute', 'dim', 'alt'],
    'Auto Gain': ['selected-input', 'autogain-use-peak', 'autogain-mean-target', 'autogain-peak-target', 'autogain-maximum-gain'],
    Talkback: ['talkback', 'talkback-enabled', 'alt-talkback-enabled'],
    'Output control': ['output-switch', 'output-relay-mute'],
    Interface: ['metering-enabled', 'standalone', 'phantom-persistence', 'adat-expansion-mode'],
  };
  if (orders[group]) {
    const position = orders[group].indexOf(name);
    return position < 0 ? 100 : position;
  }
  if (/^Input /.test(group)) {
    const suffix = name.replace(/^input\d+-/, '');
    const position = ['gain', 'mute', 'air', 'phantom-power', 'instrument', 'clip-safe', 'auto-gain', 'auto-gain-exit-status', 'channel-link'].indexOf(suffix);
    return position < 0 ? 100 : position;
  }
  const monitor = name.match(/^monitor-(\d+)-(level|mute|hardware-control)$/);
  if (monitor) {
    const first = Number(group.match(/\d+/)?.[0] ?? 1);
    const side = Number(monitor[1]) - first;
    if (monitor[2] === 'hardware-control') return 4 + side;
    return side * 2 + (monitor[2] === 'mute' ? 1 : 0);
  }
  if (/^monitor-\d+-\d+-mono$/.test(name)) return 6;
  const headphone = name.match(/^headphone-\d+([lr])-(level|mute|hardware-control)$/);
  if (headphone) {
    const side = headphone[1] === 'r' ? 1 : 0;
    if (headphone[2] === 'hardware-control') return 4 + side;
    return side * 2 + (headphone[2] === 'mute' ? 1 : 0);
  }
  if (/^headphone-\d+-mono$/.test(name)) return 6;
  return 100;
}

function displayControlLabel(group, label) {
  if (/^Input \d+$/.test(group)) return label.replace(new RegExp(`^${group}\\s+`, 'i'), '');
  if (/^Monitor \d/.test(group)) return label.replace(/^Monitor\s+/i, '');
  if (/^Headphone \d/.test(group)) return label.replace(/^Headphone\s+/i, '');
  return label;
}

function formatValue(name, value) {
  const unit = definitions[name]?.unit;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return `${value}${unit ? ` ${unit}` : ''}`;
}

function createControl(name, definition, group) {
  const displayLabel = displayControlLabel(group, definition.label);
  if (definition.kind === 'boolean') {
    const row = document.createElement('div');
    row.className = 'switchrow';
    const label = document.createElement('span');
    label.textContent = displayLabel;
    const button = document.createElement('button');
    button.className = 'switch';
    button.dataset.toggle = name;
    button.setAttribute('aria-label', `Toggle ${definition.label}`);
    button.textContent = 'OFF';
    row.append(label, button);
    return row;
  }
  if (definition.kind === 'enum') {
    const row = document.createElement('label');
    row.className = 'enumrow';
    const label = document.createElement('span');
    label.textContent = displayLabel;
    const select = document.createElement('select');
    select.dataset.enum = name;
    select.disabled = definition.access === 'read-only';
    for (const value of definition.values ?? []) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.replaceAll('-', ' ');
      select.append(option);
    }
    row.append(label, select);
    return row;
  }
  const row = document.createElement('div');
  row.className = 'rotary-control';
  const label = document.createElement('span');
  label.className = 'rotary-label';
  label.textContent = displayLabel;
  const knob = document.createElement('button');
  knob.type = 'button';
  knob.className = 'knob';
  knob.dataset.knob = name;
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', definition.label);
  knob.setAttribute('aria-valuemin', definition.min);
  knob.setAttribute('aria-valuemax', definition.max);
  const marker = document.createElement('span');
  marker.className = 'knob-marker';
  knob.append(marker);
  const current = document.createElement('strong');
  current.className = 'knob-value';
  current.dataset.value = name;
  current.textContent = '—';
  const help = document.createElement('small');
  help.className = 'knob-help';
  help.textContent = 'Drag up or down';
  row.append(label, knob, current, help);
  return row;
}

function buildControls() {
  const groups = new Map();
  for (const [name, definition] of Object.entries(definitions)) {
    const group = groupName(name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([name, definition]);
  }
  const grid = $('#controlsGrid');
  grid.replaceChildren();
  for (const [group, controls] of [...groups].sort(([left], [right]) => groupOrder(left) - groupOrder(right))) {
    const card = document.createElement('details');
    card.className = `channel${group === 'Monitor' ? ' primary' : ''}`;
    card.open = true;
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'channel-title';
    const heading = document.createElement('h2');
    heading.textContent = group;
    const description = document.createElement('small');
    description.textContent = groupDescription(group);
    title.append(heading, description);
    summary.append(title);
    const body = document.createElement('div');
    body.className = 'channel-body';
    const orderedControls = [...controls].sort(([left], [right]) => controlOrder(group, left) - controlOrder(group, right));
    const stereoOutput = /^(Monitor \d|Headphone \d)/.test(group);
    if (stereoOutput) {
      const columns = [document.createElement('div'), document.createElement('div')];
      columns.forEach((column) => { column.className = 'control-column'; });
      const remaining = [];
      const firstMonitorChannel = Number(group.match(/\d+/)?.[0] ?? 1);
      for (const [name, definition] of orderedControls) {
        const monitor = name.match(/^monitor-(\d+)-(?:level|mute|hardware-control)$/);
        const headphone = name.match(/^headphone-\d+([lr])-(?:level|mute|hardware-control)$/);
        const column = monitor ? Number(monitor[1]) - firstMonitorChannel : headphone ? (headphone[1] === 'r' ? 1 : 0) : -1;
        if (column === 0 || column === 1) columns[column].append(createControl(name, definition, group));
        else remaining.push([name, definition]);
      }
      body.append(...columns);
      for (const [name, definition] of remaining) {
        const control = createControl(name, definition, group);
        control.classList.add('full-width-control');
        body.append(control);
      }
    } else {
      for (const [name, definition] of orderedControls) body.append(createControl(name, definition, group));
    }
    card.append(summary, body);
    grid.append(card);
  }
  bindControlEvents();
}

function renderControls() {
  $$('[data-toggle]').forEach((button) => {
    const value = values[button.dataset.toggle];
    button.classList.toggle('on', value === true);
    button.setAttribute('aria-pressed', String(value === true));
    button.textContent = value === true ? 'ON' : 'OFF';
    button.disabled = busy || value === undefined;
  });
  $$('[data-knob]').forEach((knob) => {
    const name = knob.dataset.knob;
    const value = values[name];
    if (Number.isFinite(value) && !knob.classList.contains('dragging')) updateKnob(knob, name, value);
    const output = $(`[data-value="${name}"]`);
    if (output && Number.isFinite(value) && !knob.classList.contains('dragging')) output.textContent = formatValue(name, value);
    knob.disabled = busy || !Number.isFinite(value) || definitions[name]?.access === 'read-only';
  });
  $$('[data-enum]').forEach((select) => {
    const name = select.dataset.enum;
    if (values[name] !== undefined && document.activeElement !== select) select.value = values[name];
    select.disabled = busy || values[name] === undefined || definitions[name]?.access === 'read-only';
  });
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stepPrecision(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

function quantize(name, value) {
  const definition = definitions[name];
  const step = definition.step ?? 1;
  const stepped = definition.min + Math.round((value - definition.min) / step) * step;
  return Number(clamp(stepped, definition.min, definition.max).toFixed(stepPrecision(step)));
}

function updateKnob(knob, name, value, preview = false) {
  const definition = definitions[name];
  const normalized = (value - definition.min) / (definition.max - definition.min);
  const angle = -135 + normalized * 270;
  knob.style.setProperty('--angle', `${angle}deg`);
  knob.setAttribute('aria-valuenow', value);
  knob.setAttribute('aria-valuetext', formatValue(name, value));
  const output = $(`[data-value="${name}"]`);
  if (output) {
    output.textContent = formatValue(name, value);
    output.classList.toggle('preview', preview);
  }
}

async function setControl(name, value) {
  controlRevision += 1;
  const previous = values[name];
  values[name] = value;
  busy = true;
  renderControls();
  try {
    const result = await api(`/api/v1/control/${encodeURIComponent(name)}/set`, { method: 'POST', body: JSON.stringify({ value }) });
    values[result.control] = result.value;
    showMessage(`${definitions[result.control]?.label ?? result.control} set to ${formatValue(result.control, result.value)}.`, 'good');
  } catch (error) {
    values[name] = previous;
    showMessage(error.message, 'bad');
  } finally {
    busy = false;
    renderControls();
  }
}

function bindControlEvents() {
  $$('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.toggle;
    controlRevision += 1;
    busy = true;
    renderControls();
    try {
      const result = await api(`/api/v1/control/${encodeURIComponent(name)}/toggle`);
      values[result.control] = result.value;
      showMessage(`${definitions[result.control]?.label ?? result.control} ${result.value ? 'enabled' : 'disabled'}.`, 'good');
    } catch (error) { showMessage(error.message, 'bad'); }
    finally { busy = false; renderControls(); }
  }));
  $$('[data-knob]').forEach((knob) => {
    let drag = null;
    knob.addEventListener('pointerdown', (event) => {
      if (knob.disabled || event.button > 0) return;
      const name = knob.dataset.knob;
      drag = { pointerId: event.pointerId, startY: event.clientY, startValue: values[name], value: values[name] };
      knob.setPointerCapture(event.pointerId);
      knob.classList.add('dragging');
      event.preventDefault();
    });
    knob.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const name = knob.dataset.knob;
      const definition = definitions[name];
      const sensitivity = event.shiftKey ? 720 : 240;
      drag.value = quantize(name, drag.startValue + (drag.startY - event.clientY) / sensitivity * (definition.max - definition.min));
      updateKnob(knob, name, drag.value, true);
    });
    const finishDrag = async (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const name = knob.dataset.knob;
      const next = drag.value;
      drag = null;
      knob.classList.remove('dragging');
      if (knob.hasPointerCapture(event.pointerId)) knob.releasePointerCapture(event.pointerId);
      if (next === values[name]) updateKnob(knob, name, values[name]);
      else await setControl(name, next);
    };
    knob.addEventListener('pointerup', finishDrag);
    knob.addEventListener('pointercancel', finishDrag);
    knob.addEventListener('keydown', async (event) => {
      const name = knob.dataset.knob;
      const definition = definitions[name];
      const step = definition.step ?? 1;
      let next;
      if (['ArrowUp', 'ArrowRight'].includes(event.key)) next = values[name] + step;
      else if (['ArrowDown', 'ArrowLeft'].includes(event.key)) next = values[name] - step;
      else if (event.key === 'PageUp') next = values[name] + step * 10;
      else if (event.key === 'PageDown') next = values[name] - step * 10;
      else if (event.key === 'Home') next = definition.min;
      else if (event.key === 'End') next = definition.max;
      else return;
      event.preventDefault();
      await setControl(name, quantize(name, next));
    });
  });
  $$('[data-enum]').forEach((select) => select.addEventListener('change', () => setControl(select.dataset.enum, select.value)));
}

function renderDeveloperInfo(info, connection) {
  const rows = [
    ['Product', info?.productName || 'Unavailable'],
    ['Firmware', info?.firmwareVersion || info?.fcpFirmware || 'Unavailable'],
    ['Backend', connection.backend],
    ['Protocol', connection.protocol],
  ];
  if (connection.backend === 'usb') {
    rows.push(['USB ID', `${info?.vendorId || '?'}:${info?.productId || '?'}`], ['Control interface', info?.interfaceNumber ?? 'Unavailable']);
  } else {
    rows.push(
      ['Endpoint', `ws://${connection.host}:${connection.securePort}/<client-public-key>`],
      ['Server public key', connection.serverPublicKey || 'Not configured'],
      ['Client public key', connection.clientPublicKey || 'Not paired'],
      ['Private identity', connection.keyPath],
    );
  }
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === developerFingerprint) return;
  developerFingerprint = fingerprint;
  const list = $('#developerInfo');
  list.replaceChildren();
  for (const [name, value] of rows) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = name;
    description.textContent = value;
    list.append(term, description);
  }
}

async function refreshControls({ background = false } = {}) {
  if (busy || switchingBackend || !Object.keys(definitions).length) return;
  const revision = controlRevision;
  if (!background) {
    busy = true;
    renderControls();
    showMessage('Reading controls…');
  }
  try {
    const next = (await api('/api/v1/state')).values;
    if (background && revision !== controlRevision) return;
    const changed = Object.keys(next).length !== Object.keys(values).length
      || Object.entries(next).some(([name, value]) => values[name] !== value);
    values = next;
    if (changed) renderControls();
    if (!background) showMessage('Controls are connected.', 'good');
  } catch (error) {
    if (!background) showMessage(error.message, 'bad');
  } finally {
    if (!background) {
      busy = false;
      renderControls();
    }
  }
}

function updateBackendFields(selected) {
  $$('.fc2-field').forEach((element) => { element.hidden = selected !== 'fc2'; });
  $$('.usb-field').forEach((element) => { element.hidden = selected !== 'usb'; });
  $('#pairButton').hidden = selected !== 'fc2';
  if (selected !== 'fc2') setPairPanelOpen(false);
}

async function refreshDevice() {
  if (switchingBackend) return;
  try {
    const [{ device: info, connection }, { config }, controls] = await Promise.all([
      api('/api/v1/device'), api('/api/v1/config'), api('/api/v1/controls'),
    ]);
    const nextDefinitionFingerprint = JSON.stringify(controls.controls);
    if (backend !== connection.backend || definitionFingerprint !== nextDefinitionFingerprint) {
      backend = connection.backend;
      definitions = controls.controls;
      definitionFingerprint = nextDefinitionFingerprint;
      buildControls();
    }
    const deviceName = info?.productName || 'Focusrite interface';
    setText('#deviceName', deviceName);
    const title = `${deviceName} Control`;
    if (document.title !== title) document.title = title;
    const dotClass = `dot ${connection.connected ? 'ok' : connection.backend === 'fc2' && connection.fc2Running ? 'wait' : ''}`;
    if ($('#dot').className !== dotClass) $('#dot').className = dotClass;
    setText('#statusText', connection.connected ? `Connected · ${connection.backend === 'usb' ? 'Direct USB' : 'Focusrite Control 2'}` : 'Disconnected');
    if (document.activeElement !== $('#backend')) {
      setFieldValue('#backend', config.backend);
      updateBackendFields(config.backend);
    }
    setFieldValue('#usbProductId', `0x${Number(config.usbProductId).toString(16).padStart(4, '0')}`);
    setFieldValue('#usbTimeout', config.usbTimeout);
    setFieldValue('#securePort', connection.securePort);
    setFieldValue('#onboardingPort', connection.onboardingPort);
    setFieldValue('#serverKey', connection.serverPublicKey);
    setFieldValue('#clientName', config.clientName);
    renderDeveloperInfo(info, connection);
  } catch (error) {
    $('#dot').className = 'dot';
    $('#statusText').textContent = 'Unavailable';
    showMessage(error.message, 'bad');
  }
}

async function poll() {
  if (switchingBackend || polling) return;
  polling = true;
  try {
    await refreshDevice();
    if (Object.keys(values).length) await refreshControls({ background: true });
    if (backend !== 'fc2') return;
    try {
      const { pairing } = await api('/api/v1/pair');
      setText('#pairMessage', pairing.message);
      const changed = pairing.state !== lastPairingState;
      if (['approval', 'qr', 'verifying'].includes(pairing.state)) setPairPanelOpen(true);
      if (pairing.state === 'complete' && changed) {
        setPairPanelOpen(false);
        showMessage('Pairing completed.', 'good');
        await refreshDevice();
        await refreshControls({ background: true });
      }
      lastPairingState = pairing.state;
    } catch {}
  } finally {
    polling = false;
  }
}

$('#refresh').addEventListener('click', () => refreshControls());
$('#pairButton').addEventListener('click', () => setPairPanelOpen(!$('#pairPanel').classList.contains('show')));
$('#pairStart').addEventListener('click', async () => {
  try { await api('/api/v1/pair/start', { method: 'POST', body: '{}' }); setPairPanelOpen(true); showMessage('Approve the request in Focusrite Control 2.', 'good'); }
  catch (error) { showMessage(error.message, 'bad'); }
});
$('#qrFile').addEventListener('change', () => {
  const file = $('#qrFile').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', async () => {
    try { await api('/api/v1/pair/qr', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); showMessage('QR screenshot submitted.', 'good'); }
    catch (error) { showMessage(error.message, 'bad'); }
  });
  reader.readAsDataURL(file);
});
$('#backend').addEventListener('change', async () => {
  const selected = $('#backend').value;
  updateBackendFields(selected);
  if (selected === 'fc2' && !/^[0-9a-f]{64}$/i.test($('#serverKey').value.trim())) {
    showMessage('Enter the Focusrite Control 2 server public key, then save the connection settings.');
    return;
  }
  switchingBackend = true;
  busy = true;
  $('#backend').disabled = true;
  $('#saveConfig').disabled = true;
  renderControls();
  showMessage(`Switching to ${selected === 'usb' ? 'Direct USB' : 'Focusrite Control 2'}…`);
  try {
    const result = await api('/api/v1/backend', { method: 'POST', body: JSON.stringify({ backend: selected }) });
    backend = result.backend;
    controlRevision += 1;
    values = {};
    definitions = {};
    controlRevision += 1;
    definitionFingerprint = '';
    developerFingerprint = '';
    showMessage(result.connected
      ? `Connected through ${result.backend === 'usb' ? 'Direct USB' : 'Focusrite Control 2'}.`
      : `Backend changed to ${result.backend === 'usb' ? 'Direct USB' : 'Focusrite Control 2'}. ${result.error}`, result.connected ? 'good' : 'bad');
  } catch (error) {
    $('#backend').value = backend;
    updateBackendFields(backend);
    showMessage(error.message, 'bad');
  } finally {
    switchingBackend = false;
    busy = false;
    $('#backend').disabled = false;
    $('#saveConfig').disabled = false;
    renderControls();
  }
  await refreshDevice();
  if (backend) await refreshControls();
});
$('#saveConfig').addEventListener('click', async () => {
  try {
    await api('/api/v1/config', {
      method: 'POST',
      body: JSON.stringify({
        backend: $('#backend').value,
        usbProductId: Number($('#usbProductId').value),
        usbTimeout: Number($('#usbTimeout').value),
        securePort: Number($('#securePort').value),
        onboardingPort: Number($('#onboardingPort').value),
        serverPublicKey: $('#serverKey').value.trim(),
        clientName: $('#clientName').value.trim(),
      }),
    });
    values = {};
    definitions = {};
    definitionFingerprint = '';
    developerFingerprint = '';
    showMessage('Connection settings saved.', 'good');
    await poll();
    await refreshControls();
  } catch (error) { showMessage(error.message, 'bad'); }
});
poll().then(() => refreshControls());
setInterval(poll, 2000);
