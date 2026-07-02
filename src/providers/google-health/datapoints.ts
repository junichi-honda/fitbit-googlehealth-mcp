import { z } from 'zod';
import { toJstDateString } from '../../lib/date';
import type { GoogleHealthClient } from './client';

/**
 * Google Health API v4 exposes every metric through one uniform resource:
 *
 *   /v4/users/me/dataTypes/{dataType}/dataPoints
 *
 * with custom methods `:list`, `:rollUp`, `:dailyRollUp`, `:batchDelete`
 * (POST) plus PATCH on the collection for writes
 * (https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints).
 *
 * The per-dataType field names inside `value` are not pinned down here on
 * purpose: the API is documented as "actively evolving" (breaking change as
 * recently as 2026-05-26), so response schemas accept any object and the
 * formatters probe candidate keys via pickNumber/pickString. A wrong guess
 * degrades one field to `undefined` instead of failing the whole tool call.
 */

export const LooseRecordSchema = z.record(z.string(), z.unknown());
export type LooseRecord = z.infer<typeof LooseRecordSchema>;

const DataPointsPageSchema = z.object({
  dataPoints: z.array(LooseRecordSchema).optional(),
  nextPageToken: z.string().optional(),
});

const RollUpResponseSchema = z.object({
  buckets: z.array(LooseRecordSchema).optional(),
});

const PatchResponseSchema = z.object({
  dataPoints: z.array(LooseRecordSchema).optional(),
});

function dataPointsPath(dataType: string, method?: string): string {
  const base = `/v4/users/me/dataTypes/${dataType}/dataPoints`;
  return method ? `${base}:${method}` : base;
}

// list() page-size ceilings: the API caps sessions (sleep/exercise) at 25 and
// allows up to 10k for instantaneous samples. Request 1000 for samples to
// bound per-page payloads; the page walk below covers multi-page days.
const LIST_PAGE_SIZE_SAMPLE = 1000;
const LIST_PAGE_SIZE_SESSION = 25;
// Native heart-rate samples arrive every ~5s (≈17k points/day), so a
// full-day list can span several pages; cap the walk to bound Worker time.
const LIST_MAX_PAGES = 20;

// list() filters by a data-type-specific time field — snake_case even though
// the {dataType} path segment is kebab-case. Sessions filter on the session
// `interval`; instantaneous samples filter on `sample_time`. Verified against
// the v4 docs for sleep/exercise/weight; the rest follow the documented
// `sample_time.physical_time` pattern and want real-data confirmation.
const LIST_TIME_FIELD: Record<string, string> = {
  sleep: 'sleep.interval.end_time',
  exercise: 'exercise.interval.start_time',
  weight: 'weight.sample_time.physical_time',
  'body-fat': 'body_fat.sample_time.physical_time',
  'heart-rate': 'heart_rate.sample_time.physical_time',
  'nutrition-log': 'nutrition_log.sample_time.physical_time',
  hydration: 'hydration.sample_time.physical_time',
};

function listTimeField(dataType: string): string {
  const known = LIST_TIME_FIELD[dataType];
  if (known) return known;
  const guess = `${dataType.replace(/-/g, '_')}.sample_time.physical_time`;
  console.log(`[google-health] no list() filter field mapped for "${dataType}"; guessing ${guess}`);
  return guess;
}

/**
 * Raw device/manual data points within [startTime, endTime) — RFC 3339 bounds.
 *
 * `list` is a standard method: GET on the collection with a `filter` query
 * expression (NOT a POST `:list` custom method — that path 404s). The time
 * bounds map to a data-type-specific filter field via {@link listTimeField}.
 */
export async function listDataPoints(
  client: GoogleHealthClient,
  dataType: string,
  range: { startTime: string; endTime: string },
): Promise<LooseRecord[]> {
  const field = listTimeField(dataType);
  const filter = `${field} >= "${range.startTime}" AND ${field} < "${range.endTime}"`;
  const pageSize = field.includes('.interval.') ? LIST_PAGE_SIZE_SESSION : LIST_PAGE_SIZE_SAMPLE;
  const points: LooseRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const res = await client.requestJson(DataPointsPageSchema, {
      path: dataPointsPath(dataType),
      method: 'GET',
      query: {
        filter,
        pageSize,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    points.push(...(res.dataPoints ?? []));
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return points;
}

/**
 * One-bucket-per-day aggregation over [startDate, endDate] (YYYY-MM-DD, inclusive).
 *
 * dailyRollUp is a POST custom method whose body is a closed-open `range` of
 * CivilDateTime values (start inclusive, end exclusive) plus `windowSizeDays`
 * (https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/dailyRollUp).
 * Callers pass an inclusive endDate, so the exclusive upper bound is the day
 * after. The CivilDateTime {year, month, day} shape is inferred from the
 * "civil"/"daily" naming — the standalone type page is unreachable, so this is
 * a candidate awaiting real-data confirmation (see docs/journal.md checklist).
 */
export async function dailyRollUp(
  client: GoogleHealthClient,
  dataType: string,
  startDate: string,
  endDate: string,
): Promise<LooseRecord[]> {
  const res = await client.requestJson(RollUpResponseSchema, {
    path: dataPointsPath(dataType, 'dailyRollUp'),
    method: 'POST',
    json: {
      range: { start: civilDate(startDate), end: civilDate(addDays(endDate, 1)) },
      windowSizeDays: 1,
    },
  });
  return res.buckets ?? [];
}

/** YYYY-MM-DD → CivilDateTime `{year, month, day}` for rollUp ranges. */
function civilDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-');
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** Create/update data points. Returns the server's echo (may be empty). */
export async function patchDataPoints(
  client: GoogleHealthClient,
  dataType: string,
  dataPoints: LooseRecord[],
): Promise<LooseRecord[]> {
  const res = await client.requestJson(PatchResponseSchema, {
    path: dataPointsPath(dataType),
    method: 'PATCH',
    json: { dataPoints },
  });
  return res.dataPoints ?? [];
}

export async function batchDeleteDataPoints(
  client: GoogleHealthClient,
  dataType: string,
  logIds: Array<number | string>,
): Promise<void> {
  await client.requestText({
    path: dataPointsPath(dataType, 'batchDelete'),
    method: 'POST',
    json: { dataPointIds: logIds.map(String) },
  });
}

// ---------- lenient value extraction ----------

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function valueRecord(record: LooseRecord): LooseRecord {
  const v = record.value;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as LooseRecord) : {};
}

/**
 * First numeric hit for `keys`, probing `record.value.<key>` then
 * `record.<key>`, finally a bare numeric `record.value`.
 */
export function pickNumber(record: LooseRecord, keys: readonly string[]): number | undefined {
  const value = valueRecord(record);
  for (const key of keys) {
    const hit = asNumber(value[key]) ?? asNumber(record[key]);
    if (hit !== undefined) return hit;
  }
  return asNumber(record.value);
}

export function pickString(record: LooseRecord, keys: readonly string[]): string | undefined {
  const value = valueRecord(record);
  for (const key of keys) {
    for (const v of [value[key], record[key]]) {
      if (typeof v === 'string' && v !== '') return v;
    }
  }
  return undefined;
}

export function pickBoolean(record: LooseRecord, keys: readonly string[]): boolean | undefined {
  const value = valueRecord(record);
  for (const key of keys) {
    for (const v of [value[key], record[key]]) {
      if (typeof v === 'boolean') return v;
    }
  }
  return undefined;
}

export function pickArray(record: LooseRecord, keys: readonly string[]): LooseRecord[] | undefined {
  const value = valueRecord(record);
  for (const key of keys) {
    for (const v of [value[key], record[key]]) {
      if (Array.isArray(v)) {
        return v.filter((x): x is LooseRecord => !!x && typeof x === 'object' && !Array.isArray(x));
      }
    }
  }
  return undefined;
}

/** Drop undefined entries so PATCH bodies stay minimal. */
export function stripUndefined(record: LooseRecord): LooseRecord {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/** YYYY-MM-DD (JST) that a roll-up bucket describes. */
export function bucketDate(bucket: LooseRecord): string | undefined {
  const date = pickString(bucket, ['date', 'startDate']);
  if (date) return date.slice(0, 10);
  const startTime = pickString(bucket, ['startTime']);
  return startTime ? toJstDateString(startTime) : undefined;
}

// ---------- data point identity ----------

/**
 * The tool layer addresses entries by Fitbit-style numeric logId, so the
 * Google data point id (`dataPointId`, or the tail of the `name` resource
 * path) must stay numeric to round-trip through delete_* unchanged. Falls
 * back to the point's epoch-ms start time — or an FNV-1a hash for
 * non-numeric ids — so reads keep rendering; a fallback id cannot be
 * deleted through batchDelete and is logged for diagnosis.
 */
export function dataPointLogId(dp: LooseRecord): number {
  const raw = pickString(dp, ['dataPointId', 'id']) ?? nameTail(dp);
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.log(
      `[google-health] non-numeric data point id "${raw}" — substituting a hash; delete_* cannot resolve it`,
    );
    return fnv1a(raw);
  }
  const startTime = pickString(dp, ['startTime']);
  return startTime ? new Date(startTime).getTime() : 0;
}

function nameTail(dp: LooseRecord): string | undefined {
  const name = typeof dp.name === 'string' ? dp.name : undefined;
  const tail = name?.split('/').pop();
  return tail === '' ? undefined : tail;
}

function fnv1a(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------- JST time plumbing ----------
// The API takes/returns RFC 3339 timestamps; the tool layer speaks
// Fitbit-style local (JST) dates and naive timestamps.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function jstDayStart(date: string): string {
  return `${date}T00:00:00+09:00`;
}

/** Exclusive upper bound: start of the following JST day. */
export function jstDayEnd(date: string): string {
  return `${addDays(date, 1)}T00:00:00+09:00`;
}

/** `HH:mm` or `HH:mm:ss` on a JST date → RFC 3339 with the +09:00 offset. */
export function jstRfc3339(date: string, time: string): string {
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return `${date}T${hhmmss}+09:00`;
}

export function epochToJstRfc3339(epochMs: number): string {
  const local = new Date(epochMs + JST_OFFSET_MS).toISOString().slice(0, 19);
  return `${local}+09:00`;
}

/** Fitbit-style naive local timestamp, e.g. `2026-07-02T08:15:00` (JST). */
export function toJstLocalIso(input: string | number): string {
  const epochMs = typeof input === 'number' ? input : new Date(input).getTime();
  return new Date(epochMs + JST_OFFSET_MS).toISOString().slice(0, 19);
}

export function toJstClockTime(input: string | number): string {
  return toJstLocalIso(input).slice(11);
}
