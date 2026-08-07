#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROLS, normalizeControlName, publicControlDefinitions } from '../src/controls.js';
import { FocusriteClient } from '../src/client.js';
import { APP_DIRECTORY, CONFIG_PATH, KEY_PATH, loadConfig, saveConfig, validateConfig } from '../src/config.js';
import { discoverLocalPorts } from '../src/discovery.js';
import { errorStyle, outputStyle as style } from '../src/terminal.js';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiBase = process.env.FOCUSRITE_API_URL || 'http://127.0.0.1:41780';
const jsonOutput = process.argv.includes('--json');
const args = process.argv.slice(2).filter((argument) => argument !== '--json');

function help() {
  console.log(`${style.heading('Focusrite Control 2 API')}

${style.heading('Usage:')}
  ${style.command('focusrite list')}
  ${style.command('focusrite status')} [--json]
  ${style.command('focusrite device')} [--json]
  ${style.command('focusrite get')} CONTROL [--json]
  ${style.command('focusrite set')} CONTROL VALUE [--json]
  ${style.command('focusrite toggle')} CONTROL [--json]
  ${style.command('focusrite batch')} CONTROL=VALUE [CONTROL=VALUE ...] [--json]
  ${style.command('focusrite preset')} FILE.json [--json]
  ${style.command('focusrite url')} CONTROL ACTION
  ${style.command('focusrite gui')}
  ${style.command('focusrite pair')}
  ${style.command('focusrite doctor')}
  ${style.command('focusrite ports')}
  ${style.command('focusrite reconnect')}
  ${style.command('focusrite logs')} [LINES]
  ${style.command('focusrite support-bundle')} [FILE]
  ${style.command('focusrite config show')}
  ${style.command('focusrite config set')} KEY VALUE
  ${style.command('focusrite api')}
  ${style.command('focusrite service')} install|start|restart|status|uninstall

${style.heading('Examples:')}
  ${style.command('focusrite toggle dim')}
  ${style.command('focusrite set monitor-gain -24')}
  ${style.command('focusrite batch dim=on monitor-gain=-30 input1-air=on')}
  ${style.command('focusrite get input.1.gain --json')}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `API request failed (${response.status}).`);
  return body;
}

async function apiAvailable() {
  try { await request('/api/v1/health', { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
}

async function directClient() {
  const config = await loadConfig();
  const discovery = await discoverLocalPorts();
  if (discovery.securePort) config.securePort = discovery.securePort;
  if (discovery.onboardingPort) config.onboardingPort = discovery.onboardingPort;
  validateConfig(config);
  return new FocusriteClient(config, { keyPath: KEY_PATH, logger: { warn() {} } });
}

async function readState(names) {
  if (await apiAvailable()) {
    if (names?.length === 1) {
      const name = normalizeControlName(names[0]);
      const result = await request(`/api/v1/control/${encodeURIComponent(name)}/get`);
      return { [name]: result.value };
    }
    return (await request('/api/v1/state')).values;
  }
  const client = await directClient();
  try { return await client.read(names); } finally { client.close(); }
}

async function apply(operations) {
  if (await apiAvailable()) {
    return request('/api/v1/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations }),
    });
  }
  const client = await directClient();
  try { return { ok: true, ...await client.apply(operations) }; } finally { client.close(); }
}

function display(result) {
  if (jsonOutput) { console.log(JSON.stringify(result)); return; }
  const values = result.values ?? result;
  for (const [name, value] of Object.entries(values)) {
    if (!(name in CONTROLS)) continue;
    const formatted = typeof value === 'boolean'
      ? value ? style.success('on') : style.label('off')
      : style.value(`${value} dB`);
    console.log(`${style.accent(name.padEnd(20))} ${formatted}`);
  }
}

function parseAssignments(assignments) {
  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error(`Expected CONTROL=VALUE, received ${assignment}.`);
    const control = normalizeControlName(assignment.slice(0, separator));
    const value = assignment.slice(separator + 1);
    return value.toLowerCase() === 'toggle' ? { control, action: 'toggle' } : { control, value };
  });
}

async function runService(action = 'status') {
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

async function main() {
  const [command, first, second, ...rest] = args;
  if (!command || ['help', '-h', '--help'].includes(command)) { help(); return; }

  if (command === 'list') {
    const definitions = publicControlDefinitions();
    if (jsonOutput) { console.log(JSON.stringify({ controls: definitions })); return; }
    for (const [name, definition] of Object.entries(definitions)) {
      console.log(`${style.accent(name.padEnd(20))} ${style.label(definition.kind.padEnd(8))} ${definition.label}`);
    }
    return;
  }
  if (command === 'status') { display({ values: await readState() }); return; }
  if (command === 'get') { const name = normalizeControlName(first); display({ values: await readState([name]) }); return; }
  if (command === 'set') { if (second === undefined) throw new Error('Usage: focusrite set CONTROL VALUE'); display(await apply([{ control: first, value: second }])); return; }
  if (command === 'toggle') { display(await apply([{ control: first, action: 'toggle' }])); return; }
  if (command === 'batch') { display(await apply(parseAssignments([first, second, ...rest].filter(Boolean)))); return; }
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
      const direct = await directClient();
      try { result = { ok: true, device: await direct.deviceInfo(), connection: { connected: true } }; } finally { direct.close(); }
    }
    if (jsonOutput) console.log(JSON.stringify(result));
    else console.log(`${style.heading(result.device?.productName ?? 'Unknown Focusrite device')}\n${style.label('Firmware:')} ${style.value(result.device?.firmwareVersion ?? 'unknown')}\n${style.label('Serial:')} ${result.device?.serialNumber ?? 'unknown'}\n${style.label('Connected:')} ${result.connection.connected ? style.success('yes') : style.error('no')}`);
    return;
  }
  if (command === 'url') {
    const control = normalizeControlName(first);
    console.log(`${apiBase}/api/v1/control/${encodeURIComponent(control)}/${encodeURIComponent(second || 'toggle')}`);
    return;
  }
  if (command === 'gui' || command === 'dashboard') {
    if (!await apiAvailable()) {
      const child = spawn(process.execPath, [join(projectRoot, 'src', 'server.js')], { cwd: projectRoot, detached: true, stdio: 'ignore' });
      child.unref();
      for (let attempt = 0; attempt < 20 && !await apiAvailable(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await execFileAsync('open', [`${apiBase}/`]);
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
      if (health) device = (await request('/api/v1/device')).device;
      else if (discovery.running && existsSync(KEY_PATH) && config.serverPublicKey) {
        const direct = await directClient();
        try { device = await direct.deviceInfo(); } finally { direct.close(); }
      }
    } catch (error) { connectionError = error.message; }
    const checks = {
      nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
      fc2Running: discovery.running,
      portsDiscovered: Boolean(discovery.securePort && discovery.onboardingPort),
      serverKeyConfigured: /^[0-9a-f]{64}$/i.test(config.serverPublicKey),
      pairedIdentityPresent: existsSync(KEY_PATH),
      apiServiceRunning: Boolean(health),
      secureConnectionWorking: Boolean(device),
    };
    const report = { checks, node: process.version, platform: `${process.platform} ${process.arch}`, ports: discovery.ports, device, connectionError, configPath: CONFIG_PATH, keyPath: KEY_PATH };
    if (jsonOutput) console.log(JSON.stringify(report));
    else {
      for (const [name, passed] of Object.entries(checks)) {
        console.log(`${passed ? style.success('✓') : style.error('✗')} ${name}`);
      }
      if (device) console.log(`\n${style.heading(device.productName)} ${style.label('· firmware')} ${style.value(device.firmwareVersion)}`);
      if (connectionError) console.log(`\n${style.error('Connection error:')} ${connectionError}`);
    }
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
    try { recentLog = (await readFile(join(APP_DIRECTORY, 'service.log'), 'utf8')).trimEnd().split('\n').slice(-200); } catch {}
    const bundle = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      fc2: discovery,
      paired: existsSync(KEY_PATH),
      configuration: { host: config.host, securePort: config.securePort, onboardingPort: config.onboardingPort, dashboardPort: config.dashboardPort, serverKeyConfigured: Boolean(config.serverPublicKey) },
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
    config[key] = /Port$/.test(key) ? Number(rawValue) : rawValue;
    validateConfig(config); await saveConfig(config); console.log(`${style.success('Updated')} ${style.accent(key)}.`);
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
