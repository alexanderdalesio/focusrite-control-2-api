import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function platformAppDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'focusrite-control-2-api');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'focusrite-control-2-api');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'focusrite-control-2-api');
}

export const APP_DIRECTORY = process.env.FOCUSRITE_DATA_DIR || platformAppDirectory();
export const CONFIG_PATH = join(APP_DIRECTORY, 'config.json');
export const KEY_PATH = join(APP_DIRECTORY, 'client-key.json');

export const DEFAULT_CONFIG = Object.freeze({
  backend: 'fc2',
  host: '127.0.0.1',
  securePort: 58322,
  onboardingPort: 58323,
  dashboardHost: '127.0.0.1',
  dashboardPort: 41780,
  apiAccessToken: '',
  serverPublicKey: '',
  clientName: 'Focusrite Command API',
  usbVendorId: 0x1235,
  usbProductId: 0x821b,
  usbTimeout: 5000,
});

export async function loadConfig() {
  let stored = {};
  try { stored = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${CONFIG_PATH}: ${error.message}`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    ...(process.env.FOCUSRITE_SERVER_PUBLIC_KEY ? { serverPublicKey: process.env.FOCUSRITE_SERVER_PUBLIC_KEY } : {}),
    ...(process.env.FOCUSRITE_SECURE_PORT ? { securePort: Number(process.env.FOCUSRITE_SECURE_PORT) } : {}),
  };
}

export async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
}

export function validateConfig(config) {
  if (!['fc2', 'usb'].includes(config.backend)) throw new Error('backend must be fc2 or usb.');
  if (config.backend === 'fc2' && !/^[0-9a-f]{64}$/i.test(config.serverPublicKey ?? '')) throw new Error('The Focusrite Control 2 server public key must be 64 hexadecimal characters.');
  for (const field of ['securePort', 'onboardingPort', 'dashboardPort']) {
    if (!Number.isInteger(Number(config[field])) || Number(config[field]) < 1 || Number(config[field]) > 65535) throw new Error(`${field} must be a valid TCP port.`);
  }
  for (const field of ['usbVendorId', 'usbProductId']) {
    if (!Number.isInteger(Number(config[field])) || Number(config[field]) < 0 || Number(config[field]) > 0xffff) throw new Error(`${field} must be a 16-bit USB identifier.`);
  }
  if (!Number.isInteger(Number(config.usbTimeout)) || Number(config.usbTimeout) < 250 || Number(config.usbTimeout) > 60000) throw new Error('usbTimeout must be between 250 and 60000 milliseconds.');
  if (typeof config.dashboardHost !== 'string' || !config.dashboardHost.trim()) throw new Error('dashboardHost must be a hostname or IP address.');
  if (config.dashboardHost !== '127.0.0.1' && String(config.apiAccessToken ?? '').length < 32) throw new Error('Network API access requires an apiAccessToken of at least 32 characters.');
}
