import { toJstDateString } from '../../lib/date';
import type { BodyFatLog, BodyLog, LogBodyFatInput, LogWeightInput, WeightLog } from '../types';
import type { GoogleHealthClient } from './client';
import {
  batchDeleteDataPoints,
  dataPointLogId,
  jstDayEnd,
  jstDayStart,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  patchDataPoints,
  pickNumber,
  pickString,
  toJstClockTime,
} from './datapoints';

function weightFromDataPoint(dp: LooseRecord): WeightLog | undefined {
  const t = pickString(dp, ['startTime', 'endTime', 'time']);
  const grams = pickNumber(dp, ['weightGrams', 'grams']);
  const kg = grams !== undefined ? grams / 1000 : pickNumber(dp, ['weightKg', 'weight', 'kg']);
  if (kg === undefined || !t) return undefined;
  return {
    logId: dataPointLogId(dp),
    date: toJstDateString(t),
    time: toJstClockTime(t),
    weight: kg,
    bmi: pickNumber(dp, ['bmi']),
    fat: pickNumber(dp, ['fat', 'bodyFat', 'percentage']),
    source: pickString(dp, ['source', 'dataOrigin', 'origin']),
  };
}

function bodyFatFromDataPoint(dp: LooseRecord): BodyFatLog | undefined {
  const t = pickString(dp, ['startTime', 'endTime', 'time']);
  const fat = pickNumber(dp, ['percentage', 'fat', 'bodyFat', 'percent']);
  if (fat === undefined || !t) return undefined;
  return {
    logId: dataPointLogId(dp),
    date: toJstDateString(t),
    time: toJstClockTime(t),
    fat,
    source: pickString(dp, ['source', 'dataOrigin', 'origin']),
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
  const echoed = await patchDataPoints(client, 'weight', [
    { startTime: t, endTime: t, value: { weightKg: input.weightKg } },
  ]);
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
  const echoed = await patchDataPoints(client, 'body-fat', [
    { startTime: t, endTime: t, value: { percentage: input.fatPercent } },
  ]);
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
