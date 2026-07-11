import { todayJst } from '../../lib/date';
import { GoogleHealthApiError } from '../../lib/errors';
import type {
  ActivityResourceT,
  DailySummary,
  ExerciseLog,
  LogActivityInput,
  TimeSeries,
} from '../types';
import type { GoogleHealthClient } from './client';
import {
  addDays,
  batchDeleteDataPoints,
  createDataPoint,
  dataPointDate,
  dataPointLogId,
  epochToJstRfc3339,
  jstDayEnd,
  jstDayStart,
  jstInterval,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  payloadOf,
  pickNumber,
  pickString,
  stripUndefined,
  subRecord,
  toJstLocalIso,
} from './datapoints';

/**
 * Fitbit time-series resources with a Google Health data-type equivalent.
 * Floors/elevation and the sedentary/active minute buckets have no
 * documented counterpart (Active Zone Minutes replaced the latter but with
 * different semantics), so those resources reject with a clear error
 * instead of returning silently-wrong numbers.
 */
const RESOURCE_DATA_TYPE: Partial<Record<ActivityResourceT, string>> = {
  steps: 'steps',
  distance: 'distance',
  calories: 'total-calories',
  activityCalories: 'active-energy-burned',
};

const RESTING_HR_KEYS = ['beatsPerMinute', 'restingHeartRate', 'bpm', 'avg', 'average'] as const;

/**
 * Per-data-point numeric contribution, read from the dataType's nested payload.
 * The aggregate interval types report string-valued numbers that pickNumber
 * coerces: steps as `count`, distance as `millimeters` (→ km via /1e6), and
 * active-energy as `kcal`.
 */
function pointValue(payload: LooseRecord, dataType: string): number | undefined {
  switch (dataType) {
    case 'steps':
      return pickNumber(payload, ['count', 'steps']);
    case 'distance': {
      const mm = pickNumber(payload, ['millimeters', 'distanceMillimeters']);
      if (mm !== undefined) return mm / 1_000_000;
      const m = pickNumber(payload, ['meters', 'distanceMeters']);
      return m !== undefined ? m / 1000 : undefined;
    }
    case 'active-energy-burned':
      return pickNumber(payload, ['kcal', 'energyKcal', 'calories']);
    default:
      return pickNumber(payload, ['value']);
  }
}

/** Sum each day's data points into a `YYYY-MM-DD → total` map. */
async function sumByDay(
  client: GoogleHealthClient,
  dataType: string,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const dps = await listDataPoints(client, dataType, {
    startTime: jstDayStart(start),
    endTime: jstDayEnd(end),
  });
  const totals = new Map<string, number>();
  for (const dp of dps) {
    const payload = payloadOf(dp, dataType);
    const day = dataPointDate(payload) ?? dataPointDate(dp);
    const value = pointValue(payload, dataType);
    if (!day || value === undefined) continue;
    totals.set(day, (totals.get(day) ?? 0) + value);
  }
  return totals;
}

export async function getDailySummary(
  client: GoogleHealthClient,
  date: string,
): Promise<DailySummary> {
  // `steps` is the canary: its failure (auth, scope) propagates. The others
  // degrade to an empty map so one missing data type doesn't blank the
  // whole summary. total-calories has no working retrieval path on the v4
  // API, so caloriesOut is intentionally left undefined.
  const optional = (dataType: string): Promise<Map<string, number>> =>
    sumByDay(client, dataType, date, date).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[google-health] ${dataType} list failed (skipping): ${reason}`);
      return new Map<string, number>();
    });

  const [steps, distance, activeCalories, restingHr] = await Promise.all([
    sumByDay(client, 'steps', date, date),
    optional('distance'),
    optional('active-energy-burned'),
    getHeartRateForDay(client, date),
  ]);

  const distKm = distance.get(date);
  return {
    summary: {
      steps: steps.get(date),
      activityCalories: activeCalories.get(date),
      distances: distKm !== undefined ? [{ activity: 'total', distance: distKm }] : undefined,
      restingHeartRate: restingHr,
    },
  };
}

/** Single-day resting HR from the daily-resting-heart-rate list. */
async function getHeartRateForDay(
  client: GoogleHealthClient,
  date: string,
): Promise<number | undefined> {
  try {
    const dps = await listDataPoints(client, 'daily-resting-heart-rate', {
      startTime: jstDayStart(date),
      endTime: jstDayEnd(date),
    });
    for (const dp of dps) {
      const bpm = pickNumber(payloadOf(dp, 'daily-resting-heart-rate'), RESTING_HR_KEYS);
      if (bpm !== undefined) return bpm;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[google-health] daily-resting-heart-rate list failed (skipping): ${reason}`);
  }
  return undefined;
}

export async function getActivityTimeSeries(
  client: GoogleHealthClient,
  resource: ActivityResourceT,
  start: string,
  end: string,
): Promise<TimeSeries> {
  const dataType = RESOURCE_DATA_TYPE[resource];
  if (!dataType) {
    throw new GoogleHealthApiError(
      400,
      `resource "${resource}" has no Google Health data type; available on this provider: ${Object.keys(RESOURCE_DATA_TYPE).join(', ')}`,
      'get_activity_timeseries',
    );
  }
  if (dataType === 'total-calories') {
    throw new GoogleHealthApiError(
      400,
      'total-calories has no working retrieval path on the Google Health v4 API',
      'get_activity_timeseries',
    );
  }
  const totals = await sumByDay(client, dataType, start, end);
  const points = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateTime, value]) => ({ dateTime, value }));
  return { resource, points };
}

const EXERCISE_LOOKBACK_DAYS = 90;

export async function getExerciseList(
  client: GoogleHealthClient,
  opts: { beforeDate?: string; limit?: number } = {},
): Promise<ExerciseLog[]> {
  // `beforeDate` is exclusive (Fitbit semantics); default includes today.
  const before = opts.beforeDate ?? addDays(todayJst(), 1);
  const dps = await listDataPoints(client, 'exercise', {
    startTime: jstDayStart(addDays(before, -EXERCISE_LOOKBACK_DAYS)),
    endTime: jstDayStart(before),
  });
  const limit = Math.min(opts.limit ?? 10, 100);
  return dps
    .map(exerciseFromDataPoint)
    .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
    .slice(0, limit);
}

/**
 * Exercise sessions nest under `dp.exercise`: the window is in
 * `exercise.interval.{startTime,endTime}`, the activity in
 * `exercise.exerciseType`/`displayName`, and aggregates in
 * `exercise.metricsSummary.*` (distance in millimeters → km via /1e6).
 */
function exerciseFromDataPoint(dp: LooseRecord): ExerciseLog {
  const exercise = payloadOf(dp, 'exercise');
  const interval = subRecord(exercise, 'interval');
  const start = pickString(interval, ['startTime']) ?? pickString(exercise, ['startTime']);
  const end = pickString(interval, ['endTime']) ?? pickString(exercise, ['endTime']);
  const durationMs = start && end ? new Date(end).getTime() - new Date(start).getTime() : undefined;
  const metrics = subRecord(exercise, 'metricsSummary');
  const mm = pickNumber(metrics, ['distanceMillimeters', 'millimeters']);
  const km = mm !== undefined ? mm / 1_000_000 : undefined;
  return {
    logId: dataPointLogId(dp),
    activityName: pickString(exercise, ['displayName', 'exerciseType', 'activityType']),
    activityTypeId: pickNumber(exercise, ['exerciseType', 'activityTypeId', 'exerciseTypeId']),
    startTime: start ? toJstLocalIso(start) : undefined,
    duration: durationMs ?? pickNumber(exercise, ['durationMillis', 'durationMs']),
    calories: pickNumber(metrics, ['caloriesKcal', 'energyKcal', 'calories']),
    steps: pickNumber(metrics, ['steps']),
    distance: km,
    distanceUnit: km !== undefined ? 'Kilometer' : undefined,
    averageHeartRate: pickNumber(metrics, [
      'averageHeartRateBeatsPerMinute',
      'averageHeartRate',
      'avgHeartRate',
    ]),
  };
}

export async function logActivity(
  client: GoogleHealthClient,
  input: LogActivityInput,
): Promise<ExerciseLog> {
  const startMs = new Date(jstRfc3339(input.date, input.startTime)).getTime();
  // `displayName` is the free-text label the read side maps to activityName;
  // `exerciseType` is a fixed enum, so a caller's arbitrary activityId can't
  // be written there. Metrics nest under `metricsSummary` (caloriesKcal,
  // distanceMillimeters = km × 1e6), matching exerciseFromDataPoint.
  const metricsSummary = stripUndefined({
    caloriesKcal: input.manualCalories,
    distanceMillimeters: input.distanceKm !== undefined ? input.distanceKm * 1_000_000 : undefined,
  });
  const echoed = await createDataPoint(client, 'exercise', {
    exercise: stripUndefined({
      interval: jstInterval(
        epochToJstRfc3339(startMs),
        epochToJstRfc3339(startMs + input.durationMs),
      ),
      displayName: input.activityName,
      metricsSummary: Object.keys(metricsSummary).length ? metricsSummary : undefined,
    }),
  });
  const dp = echoed[0];
  if (dp) return exerciseFromDataPoint(dp);
  return {
    activityName: input.activityName,
    startTime: toJstLocalIso(startMs),
    duration: input.durationMs,
    calories: input.manualCalories,
    distance: input.distanceKm,
    distanceUnit: input.distanceKm !== undefined ? 'Kilometer' : undefined,
  };
}

export async function deleteActivityLog(client: GoogleHealthClient, logId: string): Promise<void> {
  await batchDeleteDataPoints(client, 'exercise', [logId]);
}
