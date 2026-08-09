import { FocusriteClient } from './client.js';
import { KEY_PATH } from './config.js';
import { DirectFocusriteClient } from './usb/direct-client.js';

export function createClient(config, { logger = console } = {}) {
  if (config.backend === 'usb') {
    return new DirectFocusriteClient({
      vendorId: Number(config.usbVendorId),
      productId: Number(config.usbProductId),
      timeout: Number(config.usbTimeout),
    });
  }
  return new FocusriteClient(config, { keyPath: KEY_PATH, logger });
}
