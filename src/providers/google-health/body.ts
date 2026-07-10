import { toJstDateString } from '../../lib/date';
import type { BodyFatLog, BodyLog, LogBodyFatInput, LogWeightInput, WeightLog } from '../types';
import type { GoogleHealthClient } from './client';
import {
  batchDeleteDataPoints,
  createDataPoint,
  dataPointLogId,
  jstDayEnd,
  jstDayStart,
  jstRfc3339,
  jstSampleTime,
  type LooseRecord,
  listDataPoints,
  payloadOf,
  pickNumber,
  pickString,
  subRecord,
  toJstClockTime,
} from './datapoints';

/** Sample instant for a body point: `<payload>.sampleTime.physicalTime`. */
function sampleTime(payload: LooseRecord): string | undefined {
  const st = subRecord(payload, 'sampleTime');
  return (
    pickString(st, ['physicalTime']) ??
    pickString(payload, ['sampleTime', 'startTime', 'endTime', 'time'])
  );
}

function weightFromDataPoint(dp: LooseRecord): WeightLog | undefined {
  const payload = payloadOf(dp, 'weight');
  const t = sampleTime(payload);
  const grams = pickNumber(payload, ['weightGrams', 'grams']);
  const kg =
    grams !== undefined
      ? grams / 1000
      : pickNumber(payload, ['kilograms', 'weightKg', 'weight', 'kg', 'value']);
  if (kg === undefined || !t) return undefined;
  return {
    logId: dataPointLogId(dp),
    date: toJstDateString(t),
    time: toJstClockTime(t),
    weight: kg,
    bmi: pickNumber(payload, ['bmi']),
    fat: pickNumber(payload, ['fat', 'bodyFat', 'percentage']),
    source: pickString(payload, ['source', 'dataOrigin', 'origin']),
  };
}

function bodyFatFromDataPoint(dp: LooseRecord): BodyFatLog | undefined {
  const payload = payloadOf(dp, 'body-fat');
  const t = sampleTime(payload);
  const fat = pickNumber(payload, ['percentage', 'fat', 'bodyFat', 'percent', 'value']);
  if (fat === undefined || !t) return undefined;
  return {
    logId: dataPointLogId(dp),
    date: toJstDateString(t),
    time: toJstClockTime(t),
    fat,
    source: pickString(payload, ['source', 'dataOrigin', 'origin']),
  };
}

export async function getBodyLog(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<BodyLog> {
  const range = { startTime: jstDayStart(start), endTime: jstDayEnd(end) };
  const [weightPoints, fatPoints] = await Promise.all([
    listDataPoints(client, 'weight', range),
    listDataPoints(client, 'body-fat', range),
  ]);
  return {
    weight: weightPoints.flatMap((dp) => {
      const log = weightFromDataPoint(dp);
      return log ? [log] : [];
    }),
    fat: fatPoints.flatMap((dp) => {
      const log = bodyFatFromDataPoint(dp);
      return log ? [log] : [];
    }),
  };
}

function normalizeTime(time: string | undefined): string {
  if (!time) return '12:00:00';
  return time.length === 5 ? `${time}:00` : time;
}

export async function logWeight(
  client: GoogleHealthClient,
  input: LogWeightInput,
): Promise<WeightLog> {
  const time = normalizeTime(input.time);
  const t = jstRfc3339(input.date, time);
  const echoed = await createDataPoint(client, 'weight', {
    weight: { sampleTime: jstSampleTime(t), weightGrams: Math.round(input.weightKg * 1000) },
  });
  const dp = echoed[0];
  const mapped = dp ? weightFromDataPoint(dp) : undefined;
  return (
    mapped ?? {
      logId: dp ? dataPointLogId(dp) : undefined,
      date: input.date,
      time,
      weight: input.weightKg,
    }
  );
}

export async function logBodyFat(
  client: GoogleHealthClient,
  input: LogBodyFatInput,
): Promise<BodyFatLog> {
  const time = normalizeTime(input.time);
  const t = jstRfc3339(input.date, time);
  const echoed = await createDataPoint(client, 'body-fat', {
    bodyFat: { sampleTime: jstSampleTime(t), percentage: input.fatPercent },
  });
  const dp = echoed[0];
  const mapped = dp ? bodyFatFromDataPoint(dp) : undefined;
  return (
    mapped ?? {
      logId: dp ? dataPointLogId(dp) : undefined,
      date: input.date,
      time,
      fat: input.fatPercent,
    }
  );
}

export async function deleteWeightLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'weight', [logId]);
}

export async function deleteBodyFatLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'body-fat', [logId]);
}
