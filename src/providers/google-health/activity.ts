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
  bucketDate,
  dailyRollUp,
  dataPointLogId,
  epochToJstRfc3339,
  jstDayStart,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  patchDataPoints,
  pickNumber,
  pickString,
  stripUndefined,
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

const STEPS_KEYS = ['steps', 'count', 'total', 'sum'] as const;
const CALORIES_KEYS = ['calories', 'energyKcal', 'kcal', 'total', 'sum'] as const;
const ACTIVE_CALORIES_KEYS = ['activeEnergyBurned', ...CALORIES_KEYS] as const;
const RESTING_HR_KEYS = ['restingHeartRate', 'bpm', 'avg', 'average'] as const;

/** Google APIs report distance in meters by default; Fitbit tools expect km. */
function distanceKmFrom(record: LooseRecord): number | undefined {
  const km = pickNumber(record, ['distanceKm', 'km']);
  if (km !== undefined) return km;
  const meters = pickNumber(record, ['distanceMeters', 'meters', 'distance', 'total', 'sum']);
  return meters !== undefined ? meters / 1000 : undefined;
}

export async function getDailySummary(
  client: GoogleHealthClient,
  date: string,
): Promise<DailySummary> {
  const single = async (dataType: string): Promise<LooseRecord | undefined> =>
    (await dailyRollUp(client, dataType, date, date))[0];
  // `steps` is the canary: its failure (auth, scope) propagates. The other
  // roll-ups degrade to undefined so one missing data type doesn't blank
  // the whole summary.
  const optional = (dataType: string): Promise<LooseRecord | undefined> =>
    single(dataType).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[google-health] dailyRollUp ${dataType} failed (skipping): ${reason}`);
      return undefined;
    });

  const [steps, distance, calories, activeCalories, restingHr] = await Promise.all([
    single('steps'),
    optional('distance'),
    optional('total-calories'),
    optional('active-energy-burned'),
    optional('daily-resting-heart-rate'),
  ]);

  const distKm = distance ? distanceKmFrom(distance) : undefined;
  return {
    summary: {
      steps: steps ? pickNumber(steps, STEPS_KEYS) : undefined,
      caloriesOut: calories ? pickNumber(calories, CALORIES_KEYS) : undefined,
      activityCalories: activeCalories
        ? pickNumber(activeCalories, ACTIVE_CALORIES_KEYS)
        : undefined,
      distances: distKm !== undefined ? [{ activity: 'total', distance: distKm }] : undefined,
      restingHeartRate: restingHr ? pickNumber(restingHr, RESTING_HR_KEYS) : undefined,
    },
  };
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
  const buckets = await dailyRollUp(client, dataType, start, end);
  const points = buckets.flatMap((bucket) => {
    const dateTime = bucketDate(bucket);
    if (!dateTime) return [];
    const value =
      resource === 'distance'
        ? distanceKmFrom(bucket)
        : pickNumber(
            bucket,
            resource === 'steps'
              ? STEPS_KEYS
              : resource === 'activityCalories'
                ? ACTIVE_CALORIES_KEYS
                : CALORIES_KEYS,
          );
    return [{ dateTime, value: value ?? 0 }];
  });
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

function exerciseFromDataPoint(dp: LooseRecord): ExerciseLog {
  const start = pickString(dp, ['startTime']);
  const end = pickString(dp, ['endTime']);
  const durationMs = start && end ? new Date(end).getTime() - new Date(start).getTime() : undefined;
  const km = distanceKmFrom(dp);
  return {
    logId: dataPointLogId(dp),
    activityName: pickString(dp, ['activityName', 'exerciseType', 'activityType']),
    activityTypeId: pickNumber(dp, ['activityTypeId', 'exerciseTypeId']),
    startTime: start ? toJstLocalIso(start) : undefined,
    duration: durationMs ?? pickNumber(dp, ['durationMillis', 'durationMs']),
    calories: pickNumber(dp, ['calories', 'energyKcal', 'activeEnergyBurned']),
    steps: pickNumber(dp, ['steps']),
    distance: km,
    distanceUnit: km !== undefined ? 'Kilometer' : undefined,
    averageHeartRate: pickNumber(dp, ['averageHeartRate', 'avgHeartRate', 'averageBpm']),
  };
}

export async function logActivity(
  client: GoogleHealthClient,
  input: LogActivityInput,
): Promise<ExerciseLog> {
  const startMs = new Date(jstRfc3339(input.date, input.startTime)).getTime();
  const echoed = await patchDataPoints(client, 'exercise', [
    {
      startTime: epochToJstRfc3339(startMs),
      endTime: epochToJstRfc3339(startMs + input.durationMs),
      value: stripUndefined({
        activityName: input.activityName,
        activityTypeId: input.activityId,
        calories: input.manualCalories,
        distanceMeters: input.distanceKm !== undefined ? input.distanceKm * 1000 : undefined,
      }),
    },
  ]);
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

export async function deleteActivityLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'exercise', [logId]);
}
