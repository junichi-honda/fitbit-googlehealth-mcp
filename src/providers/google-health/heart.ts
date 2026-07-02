import type { HeartRateDay, HeartRateIntraday, IntradayDetailLevelT } from '../types';
import type { GoogleHealthClient } from './client';
import {
  dataPointDate,
  jstDayEnd,
  jstDayStart,
  type LooseRecord,
  listDataPoints,
  payloadOf,
  pickNumber,
  pickString,
  subRecord,
  toJstClockTime,
} from './datapoints';

const RESTING_HR_KEYS = ['beatsPerMinute', 'restingHeartRate', 'bpm', 'avg', 'average'] as const;

/** Resting HR per day from the daily-resting-heart-rate list (bpm as string). */
export async function getHeartRateRange(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HeartRateDay[]> {
  const dps = await listDataPoints(client, 'daily-resting-heart-rate', {
    startTime: jstDayStart(start),
    endTime: jstDayEnd(end),
  });
  return dps
    .flatMap((dp) => {
      const payload = payloadOf(dp, 'daily-resting-heart-rate');
      const dateTime = dataPointDate(payload) ?? dataPointDate(dp);
      if (!dateTime) return [];
      return [{ dateTime, value: { restingHeartRate: pickNumber(payload, RESTING_HR_KEYS) } }];
    })
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

const DETAIL_LEVEL_SEC: Record<IntradayDetailLevelT, number> = {
  '1sec': 1,
  '1min': 60,
  '5min': 300,
  '15min': 900,
};

/** Instant a heart-rate sample was taken: `heartRate.sampleTime.physicalTime`. */
function sampleTime(dp: LooseRecord): string | undefined {
  const hr = payloadOf(dp, 'heart-rate');
  const st = subRecord(hr, 'sampleTime');
  return (
    pickString(st, ['physicalTime']) ??
    pickString(hr, ['sampleTime', 'startTime', 'time']) ??
    pickString(dp, ['startTime', 'time', 'endTime'])
  );
}

/**
 * Google Health has no server-side detail-level buckets: `heart-rate`
 * returns native ~5-second samples under `dp.heartRate.beatsPerMinute`, so
 * the Fitbit detail levels are reproduced by averaging within fixed windows
 * client-side ('1sec' passes the native cadence through unchanged).
 */
export async function getHeartRateIntraday(
  client: GoogleHealthClient,
  date: string,
  detailLevel: IntradayDetailLevelT,
): Promise<HeartRateIntraday> {
  const [samples, restingDays] = await Promise.all([
    listDataPoints(client, 'heart-rate', {
      startTime: jstDayStart(date),
      endTime: jstDayEnd(date),
    }),
    getHeartRateRange(client, date, date).catch(() => [] as HeartRateDay[]),
  ]);

  const stepSec = DETAIL_LEVEL_SEC[detailLevel];
  const windows = new Map<number, { sum: number; n: number }>();
  for (const dp of samples) {
    const t = sampleTime(dp);
    const bpm = pickNumber(payloadOf(dp, 'heart-rate'), ['beatsPerMinute', 'bpm', 'heartRate']);
    if (!t || bpm === undefined) continue;
    const epochSec = Math.floor(new Date(t).getTime() / 1000);
    const windowStart = Math.floor(epochSec / stepSec) * stepSec;
    const agg = windows.get(windowStart) ?? { sum: 0, n: 0 };
    agg.sum += bpm;
    agg.n += 1;
    windows.set(windowStart, agg);
  }
  const points = [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sec, { sum, n }]) => ({
      time: toJstClockTime(sec * 1000),
      value: Math.round(sum / n),
    }));

  return {
    date,
    detailLevel,
    restingHeartRate: restingDays[0]?.value.restingHeartRate,
    points,
  };
}
