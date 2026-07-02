import type { HeartRateDay, HeartRateIntraday, IntradayDetailLevelT } from '../types';
import type { GoogleHealthClient } from './client';
import {
  bucketDate,
  dailyRollUp,
  jstDayEnd,
  jstDayStart,
  listDataPoints,
  pickNumber,
  pickString,
  toJstClockTime,
} from './datapoints';

const RESTING_HR_KEYS = ['restingHeartRate', 'bpm', 'avg', 'average'] as const;

export async function getHeartRateRange(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HeartRateDay[]> {
  const buckets = await dailyRollUp(client, 'daily-resting-heart-rate', start, end);
  return buckets.flatMap((bucket) => {
    const dateTime = bucketDate(bucket);
    if (!dateTime) return [];
    return [{ dateTime, value: { restingHeartRate: pickNumber(bucket, RESTING_HR_KEYS) } }];
  });
}

const DETAIL_LEVEL_SEC: Record<IntradayDetailLevelT, number> = {
  '1sec': 1,
  '1min': 60,
  '5min': 300,
  '15min': 900,
};

/**
 * Google Health has no server-side detail-level buckets: `heart-rate`
 * returns native ~5-second samples, so the Fitbit detail levels are
 * reproduced by averaging within fixed windows client-side ('1sec'
 * passes the native cadence through unchanged).
 */
export async function getHeartRateIntraday(
  client: GoogleHealthClient,
  date: string,
  detailLevel: IntradayDetailLevelT,
): Promise<HeartRateIntraday> {
  const [samples, restingBuckets] = await Promise.all([
    listDataPoints(client, 'heart-rate', {
      startTime: jstDayStart(date),
      endTime: jstDayEnd(date),
    }),
    dailyRollUp(client, 'daily-resting-heart-rate', date, date).catch(() => []),
  ]);

  const stepSec = DETAIL_LEVEL_SEC[detailLevel];
  const windows = new Map<number, { sum: number; n: number }>();
  for (const dp of samples) {
    const t = pickString(dp, ['startTime', 'time', 'endTime']);
    const bpm = pickNumber(dp, ['bpm', 'heartRate', 'beatsPerMinute']);
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

  const restingBucket = restingBuckets[0];
  return {
    date,
    detailLevel,
    restingHeartRate: restingBucket ? pickNumber(restingBucket, RESTING_HR_KEYS) : undefined,
    points,
  };
}
