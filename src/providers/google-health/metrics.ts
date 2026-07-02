import type { CardioFitness, HrvDay, RespiratoryRateDay, SkinTempDay, SpO2Day } from '../types';
import type { GoogleHealthClient } from './client';
import { bucketDate, dailyRollUp, type LooseRecord, pickNumber } from './datapoints';

function perDay<T>(buckets: LooseRecord[], map: (bucket: LooseRecord, dateTime: string) => T): T[] {
  return buckets.flatMap((bucket) => {
    const dateTime = bucketDate(bucket);
    return dateTime ? [map(bucket, dateTime)] : [];
  });
}

export async function getSpO2(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SpO2Day[]> {
  const buckets = await dailyRollUp(client, 'daily-oxygen-saturation', start, end);
  return perDay(buckets, (bucket, dateTime) => ({
    dateTime,
    value: {
      avg: pickNumber(bucket, ['avg', 'average', 'mean', 'percent']),
      min: pickNumber(bucket, ['min', 'minimum']),
      max: pickNumber(bucket, ['max', 'maximum']),
    },
  }));
}

export async function getRespiratoryRate(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<RespiratoryRateDay[]> {
  const buckets = await dailyRollUp(client, 'respiratory-rate', start, end);
  return perDay(buckets, (bucket, dateTime) => ({
    dateTime,
    value: {
      breathingRate: pickNumber(bucket, ['breathingRate', 'breathsPerMinute', 'avg', 'average']),
    },
  }));
}

export async function getSkinTemperature(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SkinTempDay[]> {
  const buckets = await dailyRollUp(client, 'daily-sleep-temperature-derivations', start, end);
  // Google reports an absolute °C where Fitbit reported a nightly relative
  // deviation — both fields are surfaced so consumers can tell them apart.
  return perDay(buckets, (bucket, dateTime) => ({
    dateTime,
    value: {
      nightlyRelative: pickNumber(bucket, [
        'nightlyRelative',
        'relativeDeviation',
        'deviation',
        'delta',
      ]),
      absolute: pickNumber(bucket, ['absolute', 'temperatureCelsius', 'celsius', 'avg', 'average']),
    },
  }));
}

export async function getHRV(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HrvDay[]> {
  const buckets = await dailyRollUp(client, 'daily-heart-rate-variability', start, end);
  return perDay(buckets, (bucket, dateTime) => ({
    dateTime,
    value: {
      dailyRmssd: pickNumber(bucket, ['dailyRmssd', 'rmssd', 'avg', 'average']),
      deepRmssd: pickNumber(bucket, ['deepRmssd', 'deepSleepRmssd']),
    },
  }));
}

export async function getCardioFitness(
  client: GoogleHealthClient,
  date: string,
): Promise<CardioFitness> {
  let buckets = await dailyRollUp(client, 'vo2-max', date, date);
  if (buckets.length === 0) {
    // Running-derived estimates live under a separate data type.
    buckets = await dailyRollUp(client, 'run-vo2-max', date, date).catch(() => []);
  }
  const bucket = buckets[0];
  return {
    dateTime: date,
    value: {
      vo2Max: bucket ? pickNumber(bucket, ['vo2Max', 'vo2max', 'avg', 'average']) : undefined,
    },
  };
}
