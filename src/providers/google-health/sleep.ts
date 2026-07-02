import { toJstDateString } from '../../lib/date';
import type { LogSleepInput, SleepLog } from '../types';
import type { GoogleHealthClient } from './client';
import {
  addDays,
  batchDeleteDataPoints,
  dataPointLogId,
  epochToJstRfc3339,
  jstDayEnd,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  patchDataPoints,
  pickArray,
  pickBoolean,
  pickNumber,
  pickString,
  subRecord,
  toJstLocalIso,
} from './datapoints';

type Stage = { dateTime: string; level: string; seconds: number };

// Normalize Google's SCREAMING_CASE stage enums to the Fitbit lowercase
// levels the tool descriptions promise (deep/light/rem/wake).
const STAGE_LEVELS: Record<string, string> = {
  DEEP: 'deep',
  LIGHT: 'light',
  REM: 'rem',
  AWAKE: 'wake',
  WAKE: 'wake',
  ASLEEP: 'asleep',
  RESTLESS: 'restless',
};

function normalizeStage(raw: string): string {
  return STAGE_LEVELS[raw.toUpperCase()] ?? raw.toLowerCase();
}

function stageSegments(sleep: LooseRecord): Stage[] {
  const segments = pickArray(sleep, ['stages', 'sleepStages', 'segments']) ?? [];
  return segments.flatMap((seg) => {
    const start = pickString(seg, ['startTime']);
    const level = pickString(seg, ['type', 'stage', 'level']);
    if (!start || !level) return [];
    const end = pickString(seg, ['endTime']);
    const seconds =
      pickNumber(seg, ['seconds', 'durationSeconds']) ??
      (end ? Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000) : 0);
    return [{ dateTime: toJstLocalIso(start), level: normalizeStage(level), seconds }];
  });
}

/**
 * Map a live data point. The payload nests under `dp.sleep`, with the window
 * in `dp.sleep.interval.{startTime,endTime}` (UTC, paired `*UtcOffset`) and
 * aggregates in `dp.sleep.summary` (minutes as *strings* → pickNumber coerces).
 * `dp.sleep.stages[].type` carries SCREAMING_CASE levels. Verified against
 * Fitbit-sourced Inspire 3 data, 2026-07-02.
 */
function sleepFromDataPoint(dp: LooseRecord): SleepLog | undefined {
  const sleep = subRecord(dp, 'sleep');
  const interval = subRecord(sleep, 'interval');
  const start = pickString(interval, ['startTime']);
  const end = pickString(interval, ['endTime']);
  if (!start || !end) return undefined;
  const durationMs = new Date(end).getTime() - new Date(start).getTime();

  const stages = stageSegments(sleep);
  const awakeSec = stages
    .filter((s) => s.level === 'wake' || s.level === 'restless')
    .reduce((acc, s) => acc + s.seconds, 0);
  const totalStageSec = stages.reduce((acc, s) => acc + s.seconds, 0);
  const asleepSec = stages.length ? totalStageSec - awakeSec : undefined;

  // Prefer the server's own stagesSummary (level → minutes/count, values as
  // strings); fall back to counting the stage segments ourselves.
  const apiSummary =
    pickArray(sleep, ['stagesSummary']) ?? subArray(sleep, 'summary', 'stagesSummary');
  const summary: Record<string, Record<string, number>> = {};
  if (apiSummary.length) {
    for (const row of apiSummary) {
      const level = pickString(row, ['type', 'level', 'stage']);
      if (!level) continue;
      summary[normalizeStage(level)] = {
        count: pickNumber(row, ['count']) ?? 0,
        minutes: pickNumber(row, ['minutes']) ?? 0,
      };
    }
  } else {
    const totals = new Map<string, { count: number; minutes: number }>();
    for (const s of stages) {
      const cur = totals.get(s.level) ?? { count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += s.seconds / 60;
      totals.set(s.level, cur);
    }
    for (const [level, { count, minutes }] of totals) {
      summary[level] = { count, minutes: Math.round(minutes) };
    }
  }

  const summaryRec = subRecord(sleep, 'summary');
  const minutesAsleep =
    pickNumber(summaryRec, ['minutesAsleep']) ??
    pickNumber(sleep, ['minutesAsleep']) ??
    (asleepSec !== undefined ? Math.round(asleepSec / 60) : Math.round(durationMs / 60000));
  const minutesAwake =
    pickNumber(summaryRec, ['minutesAwake']) ??
    pickNumber(sleep, ['minutesAwake']) ??
    (stages.length ? Math.round(awakeSec / 60) : undefined);

  return {
    logId: dataPointLogId(dp),
    dateOfSleep: toJstDateString(end),
    startTime: toJstLocalIso(start),
    endTime: toJstLocalIso(end),
    duration: durationMs,
    minutesAsleep,
    minutesAwake,
    minutesToFallAsleep: pickNumber(summaryRec, ['minutesToFallAsleep']),
    efficiency: pickNumber(summaryRec, ['efficiency']) ?? pickNumber(sleep, ['efficiency']),
    isMainSleep: pickBoolean(sleep, ['isMainSleep', 'mainSleep']),
    type: pickString(sleep, ['type', 'sleepType']) ?? (stages.length ? 'stages' : 'classic'),
    levels: Object.keys(summary).length ? { summary, data: stages } : undefined,
  };
}

/** `record[key][innerKey]` as a LooseRecord[] when both hops land on arrays. */
function subArray(record: LooseRecord, key: string, innerKey: string): LooseRecord[] {
  return pickArray(subRecord(record, key), [innerKey]) ?? [];
}

export async function getSleep(client: GoogleHealthClient, date: string): Promise<SleepLog[]> {
  return getSleepRange(client, date, date);
}

export async function getSleepRange(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SleepLog[]> {
  // Fitbit keys sleep by the wake-up date; a night ending on `start`
  // typically began the prior evening, so the fetch window opens at noon
  // the day before and results are re-filtered by dateOfSleep.
  const dps = await listDataPoints(client, 'sleep', {
    startTime: jstRfc3339(addDays(start, -1), '12:00:00'),
    endTime: jstDayEnd(end),
  });
  return dps
    .flatMap((dp) => {
      const log = sleepFromDataPoint(dp);
      return log ? [log] : [];
    })
    .filter((log) => log.dateOfSleep >= start && log.dateOfSleep <= end)
    .sort((a, b) => b.startTime.localeCompare(a.startTime));
}

export async function logSleep(
  client: GoogleHealthClient,
  input: LogSleepInput,
): Promise<SleepLog> {
  // The tool contract says `date` is the morning after the sleep; evening
  // start times therefore belong to the previous calendar day.
  const startDate = input.startTime >= '18:00' ? addDays(input.date, -1) : input.date;
  const startMs = new Date(jstRfc3339(startDate, input.startTime)).getTime();
  const endMs = startMs + input.durationMs;

  const echoed = await patchDataPoints(client, 'sleep', [
    { startTime: epochToJstRfc3339(startMs), endTime: epochToJstRfc3339(endMs) },
  ]);
  const dp = echoed[0];
  const mapped = dp ? sleepFromDataPoint(dp) : undefined;
  return (
    mapped ?? {
      logId: dp ? dataPointLogId(dp) : 0,
      dateOfSleep: toJstDateString(endMs),
      startTime: toJstLocalIso(startMs),
      endTime: toJstLocalIso(endMs),
      duration: input.durationMs,
      minutesAsleep: Math.round(input.durationMs / 60000),
      type: 'classic',
    }
  );
}

export async function deleteSleepLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'sleep', [logId]);
}
