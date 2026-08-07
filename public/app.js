const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let values = {};
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showMessage(text, kind = '') {
  const element = $('#message');
  element.textContent = text;
  element.className = `message ${kind}`;
}

function showGainValue(input, value, preview = false) {
  const label = $(`[data-value="${input.dataset.gain}"]`);
  label.textContent = `${Number(value).toFixed(1)} dB`;
  label.classList.toggle('preview', preview);
  input.setAttribute('aria-valuetext', `${Number(value).toFixed(1)} decibels`);
}

function renderControls() {
  $$('[data-control]').forEach((button) => {
    const value = values[button.dataset.control];
    button.classList.toggle('on', value === true);
    button.setAttribute('aria-pressed', String(value === true));
    button.disabled = busy || value === undefined;
  });
  $$('[data-gain]').forEach((input) => {
    const value = values[input.dataset.gain];
    if (Number.isFinite(value)) {
      input.value = value;
      showGainValue(input, value);
    }
    input.disabled = busy || !Number.isFinite(value);
  });
}

function renderDeveloperInfo(info, connection) {
  const rows = [
    ['Product', info?.productName || 'Unavailable'],
    ['Firmware', info?.firmwareVersion || 'Unavailable'],
    ['Serial', info?.serialNumber || 'Unavailable'],
    ['Protocol', connection.protocol],
    ['Endpoint', `ws://${connection.host}:${connection.securePort}/<client-public-key>`],
    ['Server public key', connection.serverPublicKey || 'Not configured'],
    ['Client public key', connection.clientPublicKey || 'Not paired'],
    ['Config', connection.configPath],
    ['Private identity', connection.keyPath],
  ];
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

async function refreshControls() {
  if (busy) return;
  busy = true;
  renderControls();
  showMessage('Reading controls…');
  try {
    values = (await api('/api/v1/state')).values;
    showMessage('Controls are connected.', 'good');
  } catch (error) {
    showMessage(error.message, 'bad');
  } finally {
    busy = false;
    renderControls();
  }
}

async function refreshDevice() {
  try {
    const [{ device: info, connection }, { config }] = await Promise.all([
      api('/api/v1/device'),
      api('/api/v1/config'),
    ]);
    $('#deviceName').textContent = info?.productName || 'Focusrite interface';
    document.title = `${$('#deviceName').textContent} Control`;
    $('#dot').className = `dot ${connection.connected ? 'ok' : connection.fc2Running ? 'wait' : ''}`;
    $('#statusText').textContent = connection.connected
      ? 'Connected'
      : connection.fc2Running ? 'Focusrite Control 2 available' : 'Focusrite Control 2 is closed';
    $('#securePort').value = connection.securePort;
    $('#onboardingPort').value = connection.onboardingPort;
    $('#serverKey').value = connection.serverPublicKey;
    $('#clientName').value = config.clientName;
    renderDeveloperInfo(info, connection);
  } catch {
    $('#dot').className = 'dot';
    $('#statusText').textContent = 'Unavailable';
  }
}

async function poll() {
  await refreshDevice();
  try {
    const { pairing } = await api('/api/v1/pair');
    $('#pairMessage').textContent = pairing.message;
    if (['approval', 'qr', 'verifying'].includes(pairing.state)) $('#pairPanel').classList.add('show');
    if (pairing.state === 'complete') {
      showMessage('Pairing completed.', 'good');
      await refreshControls();
    }
  } catch {}
}

$$('[data-control]').forEach((button) => {
  button.addEventListener('click', async () => {
    const name = button.dataset.control;
    busy = true;
    renderControls();
    try {
      const result = await api(`/api/v1/control/${name}/toggle`);
      values[name] = result.value;
      showMessage(`${name} ${result.value ? 'enabled' : 'disabled'}.`, 'good');
    } catch (error) {
      showMessage(error.message, 'bad');
    } finally {
      busy = false;
      renderControls();
    }
  });
});

$$('[data-gain]').forEach((input) => {
  input.addEventListener('input', () => {
    showGainValue(input, Number(input.value), true);
  });
  input.addEventListener('change', async () => {
    const name = input.dataset.gain;
    const requestedValue = Number(input.value);
    const previousValue = values[name];
    values[name] = requestedValue;
    busy = true;
    renderControls();
    try {
      const result = await api(`/api/v1/control/${name}/set`, {
        method: 'POST',
        body: JSON.stringify({ value: requestedValue }),
      });
      values[name] = result.value;
      showMessage(`${name} set to ${result.value.toFixed(1)} dB.`, 'good');
    } catch (error) {
      values[name] = previousValue;
      showMessage(error.message, 'bad');
    } finally {
      busy = false;
      renderControls();
    }
  });
});

$('#refresh').addEventListener('click', refreshControls);
$('#pairButton').addEventListener('click', () => $('#pairPanel').classList.toggle('show'));
$('#pairStart').addEventListener('click', async () => {
  try {
    await api('/api/v1/pair/start', { method: 'POST', body: '{}' });
    $('#pairPanel').classList.add('show');
    showMessage('Approve the request in Focusrite Control 2.', 'good');
  } catch (error) { showMessage(error.message, 'bad'); }
});
$('#qrFile').addEventListener('change', () => {
  const file = $('#qrFile').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', async () => {
    try {
      await api('/api/v1/pair/qr', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) });
      showMessage('QR screenshot submitted.', 'good');
    } catch (error) { showMessage(error.message, 'bad'); }
  });
  reader.readAsDataURL(file);
});
$('#saveConfig').addEventListener('click', async () => {
  try {
    await api('/api/v1/config', {
      method: 'POST',
      body: JSON.stringify({
        securePort: Number($('#securePort').value),
        onboardingPort: Number($('#onboardingPort').value),
        serverPublicKey: $('#serverKey').value.trim(),
        clientName: $('#clientName').value.trim(),
      }),
    });
    showMessage('Connection settings saved.', 'good');
    await refreshDevice();
  } catch (error) { showMessage(error.message, 'bad'); }
});

poll().then(refreshControls);
setInterval(poll, 3000);
