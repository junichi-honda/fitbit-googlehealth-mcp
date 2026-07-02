import type { CardioFitness, HrvDay, RespiratoryRateDay, SkinTempDay, SpO2Day } from '../types';
import type { GoogleHealthClient } from './client';
import {
  dataPointDate,
  jstDayEnd,
  jstDayStart,
  type LooseRecord,
  listDataPoints,
  payloadOf,
  pickNumber,
} from './datapoints';

/**
 * List a daily-metric dataType over [start, end] (inclusive) and map each
 * point's nested payload to a dated value. Daily metrics filter on `.date`
 * and carry a CivilDate object, both handled by listDataPoints/dataPointDate.
 */
async function perDay<T>(
  client: GoogleHealthClient,
  dataType: string,
  start: string,
  end: string,
  map: (payload: LooseRecord, dateTime: string) => T,
): Promise<T[]> {
  const dps = await listDataPoints(client, dataType, {
    startTime: jstDayStart(start),
    endTime: jstDayEnd(end),
  });
  return dps
    .flatMap((dp) => {
      const payload = payloadOf(dp, dataType);
      const dateTime = dataPointDate(payload) ?? dataPointDate(dp);
      return dateTime ? [{ dateTime, mapped: map(payload, dateTime) }] : [];
    })
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime))
    .map((x) => x.mapped);
}

export async function getSpO2(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SpO2Day[]> {
  return perDay(client, 'daily-oxygen-saturation', start, end, (payload, dateTime) => ({
    dateTime,
    value: {
      avg: pickNumber(payload, ['averagePercentage', 'avg', 'average', 'mean', 'percent']),
      min: pickNumber(payload, ['lowerBoundPercentage', 'min', 'minimum']),
      max: pickNumber(payload, ['upperBoundPercentage', 'max', 'maximum']),
    },
  }));
}

export async function getRespiratoryRate(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<RespiratoryRateDay[]> {
  return perDay(client, 'daily-respiratory-rate', start, end, (payload, dateTime) => ({
    dateTime,
    value: {
      breathingRate: pickNumber(payload, ['breathsPerMinute', 'breathingRate', 'avg', 'average']),
    },
  }));
}

export async function getSkinTemperature(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SkinTempDay[]> {
  // Google reports an absolute °C where Fitbit reported a nightly relative
  // deviation — both fields are surfaced so consumers can tell them apart.
  return perDay(client, 'daily-sleep-temperature-derivations', start, end, (payload, dateTime) => ({
    dateTime,
    value: {
      nightlyRelative: pickNumber(payload, [
        'relativeNightlyStddev30dCelsius',
        'nightlyRelative',
        'relativeDeviation',
        'deviation',
        'delta',
      ]),
      absolute: pickNumber(payload, [
        'nightlyTemperatureCelsius',
        'baselineTemperatureCelsius',
        'absolute',
        'temperatureCelsius',
        'celsius',
      ]),
    },
  }));
}

export async function getHRV(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HrvDay[]> {
  return perDay(client, 'daily-heart-rate-variability', start, end, (payload, dateTime) => ({
    dateTime,
    value: {
      dailyRmssd: pickNumber(payload, [
        'averageHeartRateVariabilityMilliseconds',
        'dailyRmssd',
        'rmssd',
        'avg',
        'average',
      ]),
      deepRmssd: pickNumber(payload, [
        'deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds',
        'deepRmssd',
        'deepSleepRmssd',
      ]),
    },
  }));
}

export async function getCardioFitness(
  client: GoogleHealthClient,
  date: string,
): Promise<CardioFitness> {
  // No live data for this user, so the value field name is a best guess;
  // vo2-max is a sample type filtered on sample_time.physical_time.
  const vo2 = async (dataType: string): Promise<number | undefined> => {
    try {
      const dps = await listDataPoints(client, dataType, {
        startTime: jstDayStart(date),
        endTime: jstDayEnd(date),
      });
      for (const dp of dps) {
        const v = pickNumber(payloadOf(dp, dataType), [
          'maxOxygenConsumption',
          'vo2Max',
          'vo2max',
          'value',
        ]);
        if (v !== undefined) return v;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[google-health] ${dataType} list failed (skipping): ${reason}`);
    }
    return undefined;
  };

  const value = (await vo2('vo2-max')) ?? (await vo2('run-vo2-max'));
  return { dateTime: date, value: { vo2Max: value } };
}
