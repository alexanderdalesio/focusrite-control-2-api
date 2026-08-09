#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../src/backend.js';
import { CONTROLS } from '../src/controls.js';
import { APP_DIRECTORY, CONFIG_PATH, KEY_PATH, loadConfig, saveConfig, validateConfig } from '../src/config.js';
import { discoverLocalPorts } from '../src/discovery.js';
import { errorStyle, outputStyle as style } from '../src/terminal.js';
import { UsbApiClient } from '../src/usb/api-client.js';
import { searchDeviceMap } from '../src/usb/device-map.js';
import { DirectFocusriteClient, SCARLETT_16I16_4TH_GEN_PRODUCT_ID, listFocusriteUsbDevices } from '../src/usb/direct-client.js';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;
const apiBase = process.env.FOCUSRITE_API_URL || 'http://127.0.0.1:41780';
const jsonOutput = process.argv.includes('--json');
const args = process.argv.slice(2).filter((argument) => argument !== '--json');

function help() {
  console.log(`${style.heading('Focusrite Control API')}

Control a Scarlett through direct USB/FCP or a paired Focusrite Control 2 session.
Ordinary commands use the communication method selected with ${style.command('focusrite backend')}.

${style.heading('Control')}
  ${style.command('focusrite list')}
  ${style.command('focusrite status')} [--json]
  ${style.command('focusrite device')} [--json]
  ${style.command('focusrite get')} CONTROL [--json]
  ${style.command('focusrite set')} CONTROL VALUE [--json]
  ${style.command('focusrite toggle')} CONTROL [--json]
  ${style.command('focusrite batch')} CONTROL=VALUE [CONTROL=VALUE ...] [--json]
  ${style.command('focusrite preset')} FILE.json [--json]
  ${style.command('focusrite url')} CONTROL ACTION

${style.heading('Connection')}
  ${style.command('focusrite backend')} [fc2|usb] [--json]
  ${style.command('focusrite gui')}
  ${style.command('focusrite pair')}
  ${style.command('focusrite doctor')}
  ${style.command('focusrite ports')}
  ${style.command('focusrite reconnect')}

${style.heading('Maintenance')}
  ${style.command('focusrite logs')} [LINES]
  ${style.command('focusrite support-bundle')} [FILE]
  ${style.command('focusrite config show')}
  ${style.command('focusrite config set')} KEY VALUE
  ${style.command('focusrite api')}
  ${style.command('focusrite service')} install|start|restart|status|uninstall

${style.heading('Direct USB')}
  ${style.command('focusrite usb')} list|status|device|doctor
  ${style.command('focusrite usb devices')} [--json]
  ${style.command('focusrite usb get')} CONTROL [--json]
  ${style.command('focusrite usb set')} CONTROL VALUE [--json]
  ${style.command('focusrite usb toggle')} CONTROL [--json]
  ${style.command('focusrite usb batch')} CONTROL=VALUE [CONTROL=VALUE ...] [--json]
  ${style.command('focusrite usb map')} [SEARCH] [--json]
  ${style.command('focusrite usb led info')} [--json]
  ${style.command('focusrite usb routing list')} [--json]
  ${style.command('focusrite usb routing set')} DESTINATION SOURCE [--json]
  ${style.command('focusrite usb mixer list')} [--json]
  ${style.command('focusrite usb mixer get')} OUTPUT [--json]
  ${style.command('focusrite usb mixer set')} OUTPUT INPUT DB|mute [--json]
  ${style.command('focusrite usb meters')} [--json]

${style.heading('Examples')}
  ${style.command('focusrite backend fc2')}
  ${style.command('focusrite toggle dim')}
  ${style.command('focusrite set monitor-gain -24')}
  ${style.command('focusrite batch dim=on monitor-gain=-30 input1-air=on')}
  ${style.command('focusrite get input.1.gain --json')}
  ${style.command('focusrite usb set input1-air presence-drive')}
  ${style.command('focusrite usb routing set "Monitor 3" "USB 3"')}
  ${style.command('focusrite usb mixer set "Mixer 1" "Analogue 1" -6')}`);
}

function printRows(rows) {
  if (!rows.length) return;
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, value] of rows) console.log(`${style.accent(name.padEnd(width))}  ${value}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `API request failed (${response.status}).`);
  return body;
}

async function apiHealth(timeout = 500) {
  try { return await request('/api/v1/health', { signal: AbortSignal.timeout(timeout) }); } catch { return null; }
}

async function ensureApiConfiguration() {
  const initial = await apiHealth();
  if (!initial) return null;
  const config = await loadConfig();
  if (initial.api === packageVersion && initial.backend === config.backend) return initial;

  try {
    await request('/api/v1/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch {}

  const reloaded = await apiHealth();
  if (reloaded?.api === packageVersion && reloaded.backend === config.backend) return reloaded;

  if (process.platform === 'darwin') {
    const target = `gui/${process.getuid()}/local.focusrite.control2-api`;
    try {
      await execFileAsync('launchctl', ['kickstart', '-k', target]);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const restarted = await apiHealth(1000);
        if (restarted?.api === packageVersion && restarted.backend === config.backend) return restarted;
      }
    } catch {}
  }

  throw new Error(`A stale Focusrite API service is running on ${apiBase}. Stop it and run "focusrite api", or reinstall the managed service with "focusrite service install".`);
}

async function apiAvailable() {
  return Boolean(await ensureApiConfiguration());
}

async function configuredClient() {
  const config = await loadConfig();
  if (config.backend === 'fc2') {
    const discovery = await discoverLocalPorts();
    if (discovery.securePort) config.securePort = discovery.securePort;
    if (discovery.onboardingPort) config.onboardingPort = discovery.onboardingPort;
  }
  validateConfig(config);
  return createClient(config, { logger: { warn() {} } });
}

async function readState(names) {
  if (await apiAvailable()) {
    if (names?.length === 1) {
      const result = await request(`/api/v1/control/${encodeURIComponent(names[0])}/get`);
      return { [result.control]: result.value };
    }
    return (await request('/api/v1/state')).values;
  }
  const client = await configuredClient();
  try { return await client.read(names); } finally { await client.close(); }
}

async function apply(operations) {
  if (await apiAvailable()) {
    return request('/api/v1/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations }),
    });
  }
  const client = await configuredClient();
  try { return { ok: true, ...await client.apply(operations) }; } finally { await client.close(); }
}

function display(result, definitions = CONTROLS) {
  if (jsonOutput) { console.log(JSON.stringify(result)); return; }
  const values = result.values ?? result;
  const rows = Object.entries(values).map(([name, value]) => {
    const definition = definitions[name] ?? {};
    const formatted = typeof value === 'boolean'
      ? value ? style.success('on') : style.label('off')
      : style.value(`${value}${definition.unit ? ` ${definition.unit}` : ''}`);
    return [name, formatted];
  });
  printRows(rows);
}

function parseAssignments(assignments) {
  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error(`Expected CONTROL=VALUE, received ${assignment}.`);
    const control = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    return value.toLowerCase() === 'toggle' ? { control, action: 'toggle' } : { control, value };
  });
}

function parseRawAssignments(assignments) {
  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error(`Expected CONTROL=VALUE, received ${assignment}.`);
    const control = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    return value.toLowerCase() === 'toggle' ? { control, action: 'toggle' } : { control, value };
  });
}

function redactDiagnosticLine(line) {
  return String(line)
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-key]')
    .replace(/(serial(?: number)?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .replace(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[redacted]');
}

async function runUsb(command = 'status', parameters = []) {
  const config = await loadConfig();
  let client;
  try {
    if (command === 'devices') {
      const devices = listFocusriteUsbDevices(Number(config.usbVendorId));
      if (jsonOutput) console.log(JSON.stringify({ ok: true, devices }));
      else if (!devices.length) console.log(style.warning('No Focusrite USB devices were found.'));
      else for (const device of devices) console.log(`${style.accent(`${device.vendorId}:${device.productId}`)} ${style.label(`bus ${device.bus}, address ${device.address}, ports ${device.ports.join('.') || 'direct'}`)}`);
      return;
    }
    const health = await ensureApiConfiguration();
    client = health?.backend === 'usb'
      ? new UsbApiClient(request)
      : new DirectFocusriteClient({
          vendorId: Number(config.usbVendorId),
          productId: process.env.FOCUSRITE_USB_PRODUCT_ID ? Number(process.env.FOCUSRITE_USB_PRODUCT_ID) : Number(config.usbProductId ?? SCARLETT_16I16_4TH_GEN_PRODUCT_ID),
          timeout: Number(process.env.FOCUSRITE_USB_TIMEOUT) || Number(config.usbTimeout),
        });
    if (command === 'device' || command === 'doctor') {
      const device = await client.deviceInfo();
      const controls = await client.controlDefinitions();
      const result = { ok: true, backend: 'direct-fcp', device, controls: Object.keys(controls).length };
      if (jsonOutput) console.log(JSON.stringify(result));
      else console.log(`${style.heading(device.productName)}\n${style.label('FCP firmware:')} ${style.value(device.fcpFirmware)}\n${style.label('USB ID:')} ${device.vendorId}:${device.productId}\n${style.label('Control interface:')} ${style.value(device.interfaceNumber)}\n${style.label('Discovered controls:')} ${style.value(result.controls)}`);
      return;
    }
    const definitions = await client.controlDefinitions();
    if (command === 'list') {
      if (jsonOutput) console.log(JSON.stringify({ ok: true, backend: 'direct-fcp', controls: definitions }));
      else printRows(Object.entries(definitions).map(([name, item]) => [name, `${style.label(item.kind.padEnd(9))} ${item.label}`]));
      return;
    }
    if (command === 'status') { display({ values: await client.read() }, definitions); return; }
    if (command === 'get') {
      if (!parameters[0]) throw new Error('Usage: focusrite usb get CONTROL');
      display({ values: await client.read([parameters[0]]) }, definitions);
      return;
    }
    if (command === 'set') {
      if (parameters[1] === undefined) throw new Error('Usage: focusrite usb set CONTROL VALUE');
      display(await client.apply([{ control: parameters[0], value: parameters[1] }]), definitions);
      return;
    }
    if (command === 'toggle') {
      if (!parameters[0]) throw new Error('Usage: focusrite usb toggle CONTROL');
      display(await client.apply([{ control: parameters[0], action: 'toggle' }]), definitions);
      return;
    }
    if (command === 'batch') {
      if (!parameters.length) throw new Error('Usage: focusrite usb batch CONTROL=VALUE [CONTROL=VALUE ...]');
      display(await client.apply(parseRawAssignments(parameters)), definitions);
      return;
    }
    if (command === 'map') {
      const search = parameters[0] || '.';
      const matches = client instanceof UsbApiClient
        ? await client.deviceMapMatches(search)
        : searchDeviceMap((await client.readDeviceMap()).map, search).map(({ path, offset, type, width, member }) => ({
            path,
            offset,
            type,
            width,
            size: member.size ?? null,
            shape: member['array-shape'],
            access: member['access-policy'] ?? 'read-write',
            notifyDevice: member['notify-device'],
          }));
      if (jsonOutput) console.log(JSON.stringify({ ok: true, matches }));
      else for (const item of matches) console.log(`${style.accent(item.path.padEnd(38))} ${style.label(item.type.padEnd(10))} ${style.value(`@ ${item.offset}`)}${item.shape ? ` [${item.shape.join('×')}]` : ''}`);
      return;
    }
    if (command === 'led') {
      const info = await client.ledInfo();
      const action = parameters[0] ?? 'info';
      if (action === 'info') {
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...info }));
        else {
          console.log(`${style.label('Visible LED control:')} ${info.supported ? style.success('supported') : style.warning('not supported')}`);
          console.log(info.reason);
          const panel = info.frontPanelController;
          if (panel) {
            const version = panel.firmwareFields;
            console.log(`${style.label('Front-panel controller:')} ${style.value(`${panel.type} ${version.major}.${version.minor}.${version.build}.${version.patch}`)}`);
            console.log(`${style.label('IPC / model:')} ${style.value(`${panel.ipcProtocolVersion} / ${panel.modelId}`)}`);
            console.log(`${style.label('Encryption:')} ${style.value(panel.encryption)}`);
            console.log(`${style.label('Last ESP reset:')} ${style.value(panel.lastReset)}`);
            console.log(`${style.label('ESP state:')} ${style.value(panel.superState)}${panel.dead ? style.error(' (dead)') : ''}`);
          }
        }
        return;
      }
      if (jsonOutput) throw new Error(info.reason);
      else {
        console.log(`${style.label('Visible LED control:')} ${info.supported ? style.success('supported') : style.warning('not supported')}`);
        console.log(info.reason);
      }
      throw new Error('Only "focusrite usb led info" is available for this firmware.');
    }
    if (command === 'routing') {
      const [action = 'list', destination, source] = parameters;
      if (action === 'list') {
        const result = await client.routingState();
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
        else printRows(result.destinations.map((route) => [
          route.name,
          route.writable ? style.value(route.source ?? 'Unavailable') : style.label(`${route.source} (fixed)`),
        ]));
        return;
      }
      if (action === 'set') {
        if (!destination || !source) throw new Error('Usage: focusrite usb routing set DESTINATION SOURCE');
        const result = await client.setRouting(destination, source);
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`${style.success('Routed')} ${style.accent(result.source)} ${style.label('to')} ${style.value(result.destination)} ${style.label(`across ${result.changedTables} changed sample-rate table(s).`)}`);
        return;
      }
      throw new Error('Usage: focusrite usb routing list | focusrite usb routing set DESTINATION SOURCE');
    }
    if (command === 'mixer') {
      const [action = 'list', output, input, value] = parameters;
      if (action === 'list') {
        const result = await client.mixerInfo();
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
        else {
          console.log(`${style.label('Outputs:')} ${result.outputs.map(({ name }) => name).join(', ')}`);
          console.log(`${style.label('Inputs:')} ${result.inputs.map(({ name }) => name).join(', ')}`);
        }
        return;
      }
      if (action === 'get') {
        if (!output) throw new Error('Usage: focusrite usb mixer get OUTPUT');
        const result = await client.mixerState(output);
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
        else printRows(result.channels[0].inputs.map((channel) => [channel.name, channel.muted ? style.label('mute') : style.value(`${channel.db} dB`)]));
        return;
      }
      if (action === 'set') {
        if (!output || !input || value === undefined) throw new Error('Usage: focusrite usb mixer set OUTPUT INPUT DB|mute');
        const result = await client.setMixerLevel(output, input, value);
        if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`${style.success('Set')} ${style.accent(`${result.output} · ${result.input}`)} ${style.label('to')} ${result.muted ? style.label('mute') : style.value(`${result.db} dB`)}.`);
        return;
      }
      throw new Error('Usage: focusrite usb mixer list|get|set');
    }
    if (command === 'meters') {
      const result = await client.meterState();
      if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
      else printRows(result.channels.map((channel) => [channel.name, `${style.label(channel.direction.padEnd(12))} ${style.value(`${channel.dbfs.toFixed(1)} dBFS`)}`]));
      return;
    }
    throw new Error(`Unknown USB command: ${command}. Run "focusrite help".`);
  } finally {
    await client?.close();
  }
}

async function runService(action = 'status') {
  if (process.platform !== 'darwin') throw new Error('The managed login service is currently available only on macOS. Run "focusrite api" under your preferred process manager on this platform.');
  const label = 'local.focusrite.control2-api';
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const directory = join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(directory, `${label}.plist`);
  const log = join(APP_DIRECTORY, 'service.log');

  if (action === 'install') {
    await mkdir(directory, { recursive: true });
    await mkdir(APP_DIRECTORY, { recursive: true, mode: 0o700 });
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(projectRoot, 'src', 'server.js')}</string></array>
<key>WorkingDirectory</key><string>${projectRoot}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>\n`);
    try { await execFileAsync('launchctl', ['bootout', target]); } catch {}
    await execFileAsync('launchctl', ['bootstrap', domain, plist]);
    console.log(style.success('Installed and started the Focusrite API login service.'));
    return;
  }
  if (action === 'uninstall') {
    try { await execFileAsync('launchctl', ['bootout', target]); } catch {}
    if (existsSync(plist)) await unlink(plist);
    console.log(style.success('Uninstalled the Focusrite API login service.'));
    return;
  }
  if (action === 'start' || action === 'restart') {
    await execFileAsync('launchctl', ['kickstart', '-k', target]);
    console.log(style.success('Focusrite API service started.'));
    return;
  }
  if (action === 'status') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['print', target]);
      const details = stdout.match(/state = .*|pid = .*/g)?.join('\n') ?? 'Installed';
      console.log(style.success(details));
    } catch { console.log(style.warning('The Focusrite API service is not installed.')); }
    return;
  }
  throw new Error('Use service install, start, restart, status, or uninstall.');
}

async function openDashboard(url) {
  if (process.platform === 'darwin') return execFileAsync('open', [url]);
  if (process.platform === 'win32') return execFileAsync('cmd', ['/c', 'start', '', url]);
  return execFileAsync('xdg-open', [url]);
}

async function main() {
  const [command, first, second, ...rest] = args;
  if (!command || ['help', '-h', '--help'].includes(command)) { help(); return; }

  if (command === 'usb') { await runUsb(first, [second, ...rest].filter((value) => value !== undefined)); return; }

  if (command === 'backend') {
    if (!first) {
      const health = await apiHealth();
      const config = await loadConfig();
      const result = {
        ok: true,
        backend: health?.backend ?? config.backend,
        serviceRunning: Boolean(health),
        connected: Boolean(health?.connected),
      };
      if (jsonOutput) console.log(JSON.stringify(result));
      else printRows([
        ['Communication', result.backend === 'usb' ? 'Direct USB/FCP' : 'Focusrite Control 2'],
        ['API service', result.serviceRunning ? 'Running' : 'Not running'],
        ['Control connection', result.connected ? 'Connected' : 'Not connected'],
      ]);
      return;
    }
    if (!['fc2', 'usb'].includes(first)) throw new Error('Usage: focusrite backend [fc2|usb]');
    let result;
    const health = await apiHealth();
    if (health) {
      result = await request('/api/v1/backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: first }),
      });
    } else {
      const config = await loadConfig();
      config.backend = first;
      validateConfig(config);
      await saveConfig(config);
      result = { ok: true, backend: first, connected: false, error: 'The local API service is not running; this backend will be used when it starts.' };
    }
    if (jsonOutput) console.log(JSON.stringify(result));
    else {
      console.log(`${style.success('Backend:')} ${style.accent(result.backend === 'usb' ? 'Direct USB' : 'Focusrite Control 2')}`);
      if (result.connected) console.log(`${style.success('Connected')} to ${style.heading(result.device?.productName ?? 'Focusrite interface')}.`);
      else console.log(style.warning(result.error));
    }
    return;
  }

  if (command === 'list') {
    let definitions;
    if (await apiAvailable()) definitions = (await request('/api/v1/controls')).controls;
    else {
      const activeClient = await configuredClient();
      try { definitions = await activeClient.controlDefinitions(); } finally { await activeClient.close(); }
    }
    if (jsonOutput) { console.log(JSON.stringify({ controls: definitions })); return; }
    printRows(Object.entries(definitions).map(([name, definition]) => [name, `${style.label(definition.kind.padEnd(9))} ${definition.label}`]));
    return;
  }
  if (command === 'status') { display({ values: await readState() }); return; }
  if (command === 'get') {
    if (!first) throw new Error('Usage: focusrite get CONTROL');
    display({ values: await readState([first]) });
    return;
  }
  if (command === 'set') { if (second === undefined) throw new Error('Usage: focusrite set CONTROL VALUE'); display(await apply([{ control: first, value: second }])); return; }
  if (command === 'toggle') {
    if (!first) throw new Error('Usage: focusrite toggle CONTROL');
    display(await apply([{ control: first, action: 'toggle' }]));
    return;
  }
  if (command === 'batch') {
    const assignments = [first, second, ...rest].filter(Boolean);
    if (!assignments.length) throw new Error('Usage: focusrite batch CONTROL=VALUE [CONTROL=VALUE ...]');
    display(await apply(parseAssignments(assignments)));
    return;
  }
  if (command === 'preset') {
    if (!first) throw new Error('Usage: focusrite preset FILE.json');
    const preset = JSON.parse(await readFile(first, 'utf8'));
    const operations = Array.isArray(preset) ? preset : Object.entries(preset).map(([control, value]) => ({ control, value }));
    display(await apply(operations));
    return;
  }
  if (command === 'device') {
    let result;
    if (await apiAvailable()) result = await request('/api/v1/device');
    else {
      const activeClient = await configuredClient();
      try { result = { ok: true, device: await activeClient.deviceInfo(), connection: { connected: true, backend: activeClient.backend } }; } finally { await activeClient.close(); }
    }
    if (jsonOutput) console.log(JSON.stringify(result));
    else console.log(`${style.heading(result.device?.productName ?? 'Unknown Focusrite device')}\n${style.label('Firmware:')} ${style.value(result.device?.firmwareVersion ?? result.device?.fcpFirmware ?? 'unknown')}\n${result.device?.serialNumber ? `${style.label('Serial:')} ${result.device.serialNumber}\n` : ''}${style.label('Connected:')} ${result.connection.connected ? style.success('yes') : style.error('no')}`);
    return;
  }
  if (command === 'url') {
    if (!first) throw new Error('Usage: focusrite url CONTROL ACTION');
    console.log(`${apiBase}/api/v1/control/${encodeURIComponent(first)}/${encodeURIComponent(second || 'toggle')}`);
    return;
  }
  if (command === 'gui' || command === 'dashboard') {
    if (!await apiAvailable()) {
      const child = spawn(process.execPath, [join(projectRoot, 'src', 'server.js')], { cwd: projectRoot, detached: true, stdio: 'ignore' });
      child.unref();
      for (let attempt = 0; attempt < 20 && !await apiAvailable(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await openDashboard(`${apiBase}/`);
    return;
  }
  if (command === 'pair') {
    const child = spawn(process.execPath, [join(projectRoot, 'src', 'pair.js')], { cwd: projectRoot, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    if (code !== 0) throw new Error(`Pairing exited with code ${code}.`);
    return;
  }
  if (command === 'doctor') {
    const discovery = await discoverLocalPorts();
    const config = await loadConfig();
    const health = await apiAvailable() ? await request('/api/v1/health') : null;
    let device = null;
    let connectionError = null;
    try {
      if (health) {
        await request('/api/v1/state');
        device = (await request('/api/v1/device')).device;
      }
      else if (config.backend === 'usb' || (discovery.running && existsSync(KEY_PATH) && config.serverPublicKey)) {
        const activeClient = await configuredClient();
        try { device = await activeClient.deviceInfo(); } finally { await activeClient.close(); }
      }
    } catch (error) { connectionError = error.message; }
    const checks = {
      nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
      backendConfigured: ['fc2', 'usb'].includes(config.backend),
      fc2Running: discovery.running,
      portsDiscovered: Boolean(discovery.securePort && discovery.onboardingPort),
      serverKeyConfigured: /^[0-9a-f]{64}$/i.test(config.serverPublicKey),
      pairedIdentityPresent: existsSync(KEY_PATH),
      apiServiceRunning: Boolean(health),
      controlConnectionWorking: Boolean(device),
    };
    if (config.backend === 'usb') {
      delete checks.fc2Running;
      delete checks.portsDiscovered;
      delete checks.serverKeyConfigured;
      delete checks.pairedIdentityPresent;
    }
    const report = { checks, backend: config.backend, node: process.version, platform: `${process.platform} ${process.arch}`, ports: discovery.ports, device, connectionError, configPath: CONFIG_PATH, keyPath: config.backend === 'fc2' ? KEY_PATH : null };
    if (jsonOutput) console.log(JSON.stringify(report));
    else {
      const checkLabels = {
        nodeSupported: 'Node.js version supported',
        backendConfigured: 'Communication backend configured',
        fc2Running: 'Focusrite Control 2 running',
        portsDiscovered: 'FC2 ports discovered',
        serverKeyConfigured: 'FC2 server key configured',
        pairedIdentityPresent: 'Paired client identity present',
        apiServiceRunning: 'Local API service running',
        controlConnectionWorking: 'Control connection working',
      };
      for (const [name, passed] of Object.entries(checks)) {
        console.log(`${passed ? style.success('✓') : style.error('✗')} ${checkLabels[name] ?? name}`);
      }
      if (device) console.log(`\n${style.heading(device.productName)} ${style.label('· firmware')} ${style.value(device.firmwareVersion ?? device.fcpFirmware ?? 'unknown')}`);
      if (connectionError) console.log(`\n${style.error('Connection error:')} ${connectionError}`);
    }
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
    return;
  }
  if (command === 'ports') {
    const discovery = await discoverLocalPorts();
    const result = { running: discovery.running, securePort: discovery.securePort ?? null, onboardingPort: discovery.onboardingPort ?? null, ports: discovery.ports };
    if (jsonOutput) console.log(JSON.stringify(result));
    else if (result.running) console.log(`${style.label('Secure:')} ${style.value(result.securePort)}\n${style.label('Onboarding:')} ${style.value(result.onboardingPort)}\n${style.label('All listening ports:')} ${result.ports.join(', ')}`);
    else console.log(style.warning('Focusrite Control 2 is not running or has no listening ports.'));
    return;
  }
  if (command === 'reconnect') {
    if (!await apiAvailable()) throw new Error('The API service is not running. Use "focusrite service start" first.');
    const result = await request('/api/v1/reconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (jsonOutput) console.log(JSON.stringify(result));
    else if (result.backend === 'usb') console.log(`${style.success('Reconnected')} to ${style.heading(result.device.productName)} over direct USB.`);
    else console.log(`${style.success('Reconnected')} to ${style.heading(result.device.productName)} on secure port ${style.value(result.ports[0])}.`);
    return;
  }
  if (command === 'logs') {
    const count = Math.max(1, Math.min(2000, Number(first) || 100));
    const path = join(APP_DIRECTORY, 'service.log');
    if (!existsSync(path)) throw new Error(`No service log exists at ${path}.`);
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').slice(-count);
    console.log(lines.join('\n'));
    return;
  }
  if (command === 'support-bundle') {
    const path = first || join(process.cwd(), `focusrite-support-${Date.now()}.json`);
    const discovery = await discoverLocalPorts();
    const config = await loadConfig();
    let recentLog = [];
    try { recentLog = (await readFile(join(APP_DIRECTORY, 'service.log'), 'utf8')).trimEnd().split('\n').slice(-200).map(redactDiagnosticLine); } catch {}
    const bundle = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      backend: config.backend,
      fc2: config.backend === 'fc2' ? discovery : null,
      paired: config.backend === 'fc2' ? existsSync(KEY_PATH) : null,
      configuration: config.backend === 'usb'
        ? { dashboardPort: config.dashboardPort, usbVendorId: config.usbVendorId, usbProductId: config.usbProductId, usbTimeout: config.usbTimeout }
        : { host: config.host, securePort: config.securePort, onboardingPort: config.onboardingPort, dashboardPort: config.dashboardPort, serverKeyConfigured: Boolean(config.serverPublicKey) },
      recentLog,
    };
    await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    console.log(`${style.success('Support bundle created:')} ${path}`);
    return;
  }
  if (command === 'config') {
    const config = await loadConfig();
    if (!first || first === 'show') { console.log(JSON.stringify(config, null, 2)); return; }
    if (first !== 'set' || second === undefined || rest[0] === undefined) throw new Error('Usage: focusrite config set KEY VALUE');
    const key = second; const rawValue = rest.join(' ');
    if (!(key in config)) throw new Error(`Unknown configuration key: ${key}`);
    if (key === 'backend') throw new Error('Use "focusrite backend fc2" or "focusrite backend usb" to change communication methods safely.');
    config[key] = /(Port|Id|Timeout)$/.test(key) ? Number(rawValue) : rawValue;
    validateConfig(config);
    await saveConfig(config);
    await ensureApiConfiguration();
    console.log(`${style.success('Updated')} ${style.accent(key)}.`);
    return;
  }
  if (command === 'api' || command === 'serve') {
    const child = spawn(process.execPath, [join(projectRoot, 'src', 'server.js')], { cwd: projectRoot, stdio: 'inherit' });
    await new Promise((resolve) => child.on('exit', resolve));
    return;
  }
  if (command === 'service') { await runService(first); return; }
  throw new Error(`Unknown command: ${command}. Run "focusrite help".`);
}

main().catch((error) => {
  if (jsonOutput) console.error(JSON.stringify({ ok: false, error: error.message }));
  else console.error(`${errorStyle.error('Error:')} ${error.message}`);
  process.exitCode = 1;
});
