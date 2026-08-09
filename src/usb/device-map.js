import { inflateSync } from 'node:zlib';

const PRIMITIVE_WIDTHS = Object.freeze({
  bool: 1,
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
});

export function decodeDeviceMap(encoded) {
  const text = Buffer.from(encoded).toString('ascii').replace(/\0+$/u, '').trim();
  if (!text) throw new Error('The Scarlett returned an empty device map.');
  let json;
  try { json = inflateSync(Buffer.from(text, 'base64')).toString('utf8'); } catch (error) {
    throw new Error(`Cannot decompress the Scarlett device map: ${error.message}`);
  }
  try { return JSON.parse(json); } catch (error) {
    throw new Error(`Cannot parse the Scarlett device map JSON: ${error.message}`);
  }
}

export function primitiveWidth(type) {
  return PRIMITIVE_WIDTHS[type] ?? null;
}

export function decodePrimitive(type, bytes) {
  const width = primitiveWidth(type);
  const data = Uint8Array.from(bytes ?? []);
  if (!width || data.byteLength !== width) throw new Error(`Cannot decode ${data.byteLength} bytes as ${type}.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (type === 'bool' || type === 'uint8') return view.getUint8(0);
  if (type === 'int8') return view.getInt8(0);
  if (type === 'uint16') return view.getUint16(0, true);
  if (type === 'int16') return view.getInt16(0, true);
  if (type === 'uint32') return view.getUint32(0, true);
  if (type === 'int32') return view.getInt32(0, true);
  throw new Error(`Unsupported device-map primitive: ${type}.`);
}

export function encodePrimitive(type, value) {
  const width = primitiveWidth(type);
  if (!width) throw new Error(`Unsupported device-map primitive: ${type}.`);
  const bytes = new Uint8Array(width);
  const view = new DataView(bytes.buffer);
  if (type === 'bool' || type === 'uint8') view.setUint8(0, Number(value));
  else if (type === 'int8') view.setInt8(0, Number(value));
  else if (type === 'uint16') view.setUint16(0, Number(value), true);
  else if (type === 'int16') view.setInt16(0, Number(value), true);
  else if (type === 'uint32') view.setUint32(0, Number(value), true);
  else if (type === 'int32') view.setInt32(0, Number(value), true);
  return bytes;
}

export function resolveMember(deviceMap, path) {
  const structs = deviceMap?.structs;
  if (!structs?.APP_SPACE?.members) throw new Error('Device map has no structs.APP_SPACE.members section.');
  const parts = String(path).split('.').filter(Boolean);
  let members = structs.APP_SPACE.members;
  let offset = 0;
  let member;
  for (let index = 0; index < parts.length; index += 1) {
    member = members[parts[index]];
    if (!member) throw new Error(`Device-map member not found: ${parts.slice(0, index + 1).join('.')}`);
    offset += Number(member.offset ?? 0);
    if (index < parts.length - 1) {
      members = structs[member.type]?.members;
      if (!members) throw new Error(`${parts.slice(0, index + 1).join('.')} is not a structure.`);
    }
  }
  return { path: parts.join('.'), offset, type: member.type, width: primitiveWidth(member.type), member };
}

export function resolveMemberElement(deviceMap, path, index) {
  const resolved = resolveMember(deviceMap, path);
  if (!resolved.width) throw new Error(`${resolved.path} has non-primitive type ${resolved.type}.`);
  const shape = resolved.member['array-shape'];
  if (!shape) {
    if (index != null && index !== 0) throw new RangeError(`${resolved.path} is not an array.`);
    return resolved;
  }
  const indexes = Array.isArray(index) ? index : [index];
  if (indexes.length !== shape.length || indexes.some((value) => !Number.isInteger(value))) {
    throw new RangeError(`${resolved.path} requires ${shape.length} integer array index${shape.length === 1 ? '' : 'es'}.`);
  }
  let flatIndex = 0;
  for (let dimension = 0; dimension < shape.length; dimension += 1) {
    if (indexes[dimension] < 0 || indexes[dimension] >= shape[dimension]) throw new RangeError(`${resolved.path} index ${indexes[dimension]} is outside dimension ${shape[dimension]}.`);
    flatIndex = flatIndex * shape[dimension] + indexes[dimension];
  }
  return { ...resolved, index: indexes, flatIndex, offset: resolved.offset + flatIndex * resolved.width };
}

export function flattenDeviceMap(deviceMap, { maxDepth = 12 } = {}) {
  const structs = deviceMap?.structs;
  if (!structs?.APP_SPACE?.members) throw new Error('Device map has no structs.APP_SPACE.members section.');
  const result = [];

  function visit(structName, prefix, baseOffset, ancestors) {
    if (ancestors.length >= maxDepth || ancestors.includes(structName)) return;
    const members = structs[structName]?.members;
    if (!members) return;
    for (const [name, member] of Object.entries(members)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const offset = baseOffset + Number(member.offset ?? 0);
      const item = { path, offset, type: member.type, width: primitiveWidth(member.type), member };
      result.push(item);
      if (structs[member.type]?.members) visit(member.type, path, offset, [...ancestors, structName]);
    }
  }

  visit('APP_SPACE', '', 0, []);
  return result.sort((left, right) => left.offset - right.offset || left.path.localeCompare(right.path));
}

export function searchDeviceMap(deviceMap, query) {
  const pattern = new RegExp(String(query), 'i');
  return flattenDeviceMap(deviceMap).filter(({ path, type }) => pattern.test(path) || pattern.test(type));
}
