function jsonPost(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Adapts the local HTTP API to the same operations used by the direct USB CLI.
// This lets a managed API service retain exclusive ownership of the USB interface.
export class UsbApiClient {
  constructor(request) {
    this.request = request;
  }

  async close() {}

  async deviceInfo() {
    return (await this.request('/api/v1/device')).device;
  }

  async controlDefinitions() {
    return (await this.request('/api/v1/controls')).controls;
  }

  async read(names) {
    if (!names?.length) return (await this.request('/api/v1/state')).values;
    const entries = await Promise.all(names.map(async (name) => {
      const result = await this.request(`/api/v1/control/${encodeURIComponent(name)}/get`);
      return [result.control, result.value];
    }));
    return Object.fromEntries(entries);
  }

  apply(operations) {
    return this.request('/api/v1/batch', jsonPost({ operations }));
  }

  async deviceMapMatches(search) {
    return (await this.request(`/api/v1/usb/device-map?search=${encodeURIComponent(search)}`)).matches;
  }

  ledInfo() {
    return this.request('/api/v1/usb/led');
  }

  setLed(index, color) {
    return this.request('/api/v1/usb/led', jsonPost({ index, color }));
  }

  routingState() {
    return this.request('/api/v1/usb/routing');
  }

  setRouting(destination, source) {
    return this.request('/api/v1/usb/routing', jsonPost({ destination, source }));
  }

  mixerInfo() {
    return this.request('/api/v1/usb/mixer/info');
  }

  mixerState(output) {
    const query = output ? `?output=${encodeURIComponent(output)}` : '';
    return this.request(`/api/v1/usb/mixer${query}`);
  }

  setMixerLevel(output, input, value) {
    return this.request('/api/v1/usb/mixer', jsonPost({ output, input, value }));
  }

  meterState() {
    return this.request('/api/v1/usb/meters');
  }
}
