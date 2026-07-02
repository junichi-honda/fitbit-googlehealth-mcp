import { z } from 'zod';
import type { Device } from '../types';
import type { GoogleHealthClient } from './client';
import { type LooseRecord, LooseRecordSchema, pickNumber, pickString } from './datapoints';

// users.pairedDevices — accept either a bare array or a wrapped object,
// since the envelope key is not pinned down by the migration guide.
const PairedDevicesSchema = z.union([z.array(LooseRecordSchema), LooseRecordSchema]);

export async function listDevices(client: GoogleHealthClient): Promise<Device[]> {
  const raw = await client.requestJson(PairedDevicesSchema, {
    path: '/v4/users/me/pairedDevices',
  });
  const list = Array.isArray(raw) ? raw : unwrapDevices(raw);
  return list.map((d, index) => ({
    id: pickString(d, ['id', 'deviceId']) ?? `device-${index}`,
    deviceVersion: pickString(d, ['deviceVersion', 'model', 'displayName']),
    type: pickString(d, ['type', 'deviceType']),
    battery: pickString(d, ['battery', 'batteryStatus']),
    batteryLevel: pickNumber(d, ['batteryLevel', 'batteryPercent']),
    lastSyncTime: pickString(d, ['lastSyncTime', 'lastSyncedTime', 'lastSeenTime']),
    mac: pickString(d, ['mac', 'macAddress']),
  }));
}

function unwrapDevices(raw: LooseRecord): LooseRecord[] {
  for (const key of ['devices', 'pairedDevices']) {
    const v = raw[key];
    if (Array.isArray(v)) {
      return v.filter((x): x is LooseRecord => !!x && typeof x === 'object' && !Array.isArray(x));
    }
  }
  return [];
}
