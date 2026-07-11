import { z } from 'zod';
import { toJstDateString } from '../../lib/date';
import type { GoogleHealthClient } from './client';

/**
 * Google Health API v4 exposes every metric through one uniform resource:
 *
 *   /v4/users/me/dataTypes/{dataType}/dataPoints
 *
 * Reads/writes use the STANDARD methods (verified against the live v4
 * discovery document, 2026-07-10):
 *   - `list`   GET  on the collection with a `filter` query expression.
 *   - `create` POST on the collection; the body IS a single DataPoint whose
 *              payload nests under the camelCase dataType key (e.g. `weight`).
 *   - `patch`  PATCH on an INDIVIDUAL `/dataPoints/{id}` — needs an id.
 *   - `batchDelete` POST custom method `:batchDelete`.
 * PATCHing the id-less collection is not a route and hard-404s, so writes go
 * through `create` (POST), never PATCH.
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

const CreateResponseSchema = LooseRecordSchema;

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
// the {dataType} path segment is kebab-case. The member and its literal format
// vary by category (all verified against live v4 data 2026-07-02):
//   - Session / interval / log types (sleep, exercise, nutrition-log,
//     hydration-log, and the aggregate steps/distance/energy types) filter on
//     `interval.*`. `civil_start_time` takes a quoted date-only literal
//     ("2026-07-01"); sleep's `end_time` takes a quoted RFC3339 instant.
//   - Instantaneous sample types (heart-rate, weight, body-fat) filter on
//     `sample_time.physical_time` with a quoted RFC3339 instant.
//   - Pre-aggregated daily metrics (daily-*) filter on `date` with a BARE
//     (unquoted) civil-date literal — quoting or RFC3339 is rejected.
const LIST_TIME_FIELD: Record<string, string> = {
  sleep: 'sleep.interval.end_time',
  exercise: 'exercise.interval.civil_start_time',
  steps: 'steps.interval.civil_start_time',
  distance: 'distance.interval.civil_start_time',
  'active-energy-burned': 'active_energy_burned.interval.civil_start_time',
  'total-calories': 'total_calories.interval.civil_start_time',
  'nutrition-log': 'nutrition_log.interval.civil_start_time',
  'hydration-log': 'hydration_log.interval.civil_start_time',
  weight: 'weight.sample_time.physical_time',
  'body-fat': 'body_fat.sample_time.physical_time',
  'heart-rate': 'heart_rate.sample_time.physical_time',
  'daily-resting-heart-rate': 'daily_resting_heart_rate.date',
  'daily-oxygen-saturation': 'daily_oxygen_saturation.date',
  'daily-respiratory-rate': 'daily_respiratory_rate.date',
  'daily-heart-rate-variability': 'daily_heart_rate_variability.date',
  'daily-sleep-temperature-derivations': 'daily_sleep_temperature_derivations.date',
};

function listTimeField(dataType: string): string {
  const known = LIST_TIME_FIELD[dataType];
  if (known) return known;
  const guess = `${dataType.replace(/-/g, '_')}.sample_time.physical_time`;
  console.log(`[google-health] no list() filter field mapped for "${dataType}"; guessing ${guess}`);
  return guess;
}

/**
 * Render a filter bound in the literal form the target member expects:
 *   - `.date` daily metrics take a BARE civil date (YYYY-MM-DD, no quotes).
 *   - `.civil_start_time` interval members take a QUOTED civil date.
 *   - everything else (physical_time, end_time) takes a QUOTED RFC3339 instant.
 * Callers hand us RFC3339 bounds; date-only members just use the date head.
 */
function filterLiteral(field: string, value: string): string {
  const dateHead = value.length > 10 ? value.slice(0, 10) : value;
  if (field.endsWith('.date')) return dateHead;
  if (field.endsWith('.civil_start_time')) return `"${dateHead}"`;
  return `"${value}"`;
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
  const lo = filterLiteral(field, range.startTime);
  const hi = filterLiteral(field, range.endTime);
  const filter = `${field} >= ${lo} AND ${field} < ${hi}`;
  // Sessions (sleep/exercise) cap at 25; the high-volume aggregate interval
  // types (steps/distance/energy) and samples allow up to 10k.
  const isSession = dataType === 'sleep' || dataType === 'exercise';
  const pageSize = isSession ? LIST_PAGE_SIZE_SESSION : LIST_PAGE_SIZE_SAMPLE;
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
 * Create one data point via the standard `create` method: POST to the
 * collection with the DataPoint as the request body. `payload` is nested by
 * the caller under the camelCase dataType key (e.g. `{ weight: {...} }`), so
 * this just forwards it. Returns the server's echoed DataPoint (the created
 * resource), wrapped in a one-element array so callers stay uniform.
 */
export async function createDataPoint(
  client: GoogleHealthClient,
  dataType: string,
  dataPoint: LooseRecord,
): Promise<LooseRecord[]> {
  const res = await client.requestJson(CreateResponseSchema, {
    path: dataPointsPath(dataType),
    method: 'POST',
    json: dataPoint,
  });
  return [res];
}

/**
 * Create a data point, then resolve it to the server-stored point whose full
 * resource `name` delete_* actually needs.
 *
 * `create` returns a long-running `Operation`, not the DataPoint — so it never
 * carries the `users/{realUserId}/.../dataPoints/{id}` name that batchDelete's
 * `names` field validates against (the `me` alias is rejected there). Without
 * this, writes hand back a synthetic `logId: "0"` that cannot be deleted, and
 * users must re-fetch via get_* to find the real id before deleting.
 *
 * So snapshot the window's existing ids, create, then re-list and return the
 * newly-appeared point. Diffing against the pre-create snapshot (rather than
 * time-matching) stays correct even when several entries share a mealType and
 * thus the same civil_start_time. Falls back to the raw create echo when the
 * new point can't be pinpointed (e.g. list lag), so callers still get a body.
 */
export async function createAndResolveDataPoint(
  client: GoogleHealthClient,
  dataType: string,
  dataPoint: LooseRecord,
  range: { startTime: string; endTime: string },
): Promise<LooseRecord[]> {
  const before = new Set(
    (await listDataPoints(client, dataType, range)).map((dp) => dataPointLogId(dp)),
  );
  const echoed = await createDataPoint(client, dataType, dataPoint);
  const after = await listDataPoints(client, dataType, range);
  const created = after.filter((dp) => !before.has(dataPointLogId(dp)));
  // Exactly one new point is the norm; if the diff is empty (list lag) fall
  // back to the create echo, and if it's >1 (a concurrent write raced in)
  // prefer the last, which is the most-recently appended.
  const newest = created[created.length - 1];
  return newest ? [newest] : echoed;
}

export async function batchDeleteDataPoints(
  client: GoogleHealthClient,
  dataType: string,
  logIds: string[],
): Promise<void> {
  // batchDelete takes `names` — full DataPoint resource names, NOT bare ids
  // under a `dataPointIds` field (that shape 400s "Unknown name dataPointIds").
  // dataPointLogId hands back the server's own `name` verbatim (already a
  // `users/{realId}/...` path — detectable by the embedded slash), so pass it
  // through untouched: the `me` alias is REJECTED inside `names`. Only a bare
  // id (no slash) needs a name built, best-effort under the `me` alias.
  const names = logIds.map((id) =>
    id.includes('/') ? id : `users/me/dataTypes/${dataType}/dataPoints/${id}`,
  );
  await client.requestText({
    path: dataPointsPath(dataType, 'batchDelete'),
    method: 'POST',
    json: { names },
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
 * A data point nests its payload under a key named after the dataType, e.g.
 * `dp.sleep.interval.startTime` (verified against live Fitbit-sourced data,
 * 2026-07-02). Pull that sub-object out so the pickers can probe inside it;
 * returns `{}` when the key is absent so callers stay branch-free.
 */
export function subRecord(record: LooseRecord, key: string): LooseRecord {
  const v = record[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as LooseRecord) : {};
}

/** kebab-case dataType id → the camelCase key its payload nests under. */
export function dataTypeKey(dataType: string): string {
  return dataType.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A data point's payload nests under a camelCase key named after the dataType
 * (e.g. `dp.dailyRestingHeartRate.*`, `dp.steps.*`). Pull that sub-object out;
 * returns `{}` when absent so callers stay branch-free.
 */
export function payloadOf(dp: LooseRecord, dataType: string): LooseRecord {
  return subRecord(dp, dataTypeKey(dataType));
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

/**
 * The YYYY-MM-DD a daily-metric data point describes. Its `date` is a
 * CivilDate object `{year, month, day}` (verified live 2026-07-02); fall back
 * to a string date or the interval/sample start for non-daily shapes.
 */
export function dataPointDate(payload: LooseRecord): string | undefined {
  const civ = payload.date;
  if (civ && typeof civ === 'object' && !Array.isArray(civ)) {
    const rec = civ as LooseRecord;
    const y = asNumber(rec.year);
    const m = asNumber(rec.month);
    const d = asNumber(rec.day);
    if (y !== undefined && m !== undefined && d !== undefined) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const dateStr = pickString(payload, ['date', 'startDate']);
  if (dateStr) return dateStr.slice(0, 10);
  const interval = subRecord(payload, 'interval');
  const start =
    pickString(interval, ['startTime', 'civilStartTime']) ?? pickString(payload, ['startTime']);
  return start ? toJstDateString(start) : undefined;
}

// ---------- data point identity ----------

/**
 * The opaque id delete_* sends back to batchDelete. PREFERS the server's full
 * resource `name` (`users/{userId}/dataTypes/{dataType}/dataPoints/{id}`) and
 * returns it verbatim, because that is exactly what batchDelete's `names`
 * field validates against — the `me` user alias that works in request URLs is
 * REJECTED inside the `names` payload ("Invalid argument: name"), and only the
 * real user id the server minted is accepted. Falls back to the bare
 * `dataPointId`/`id` (batchDelete reconstructs a `users/me/...` name from it,
 * best-effort) or the epoch-ms start time when no id is present.
 *
 * Always a STRING, never coerced to number: Google ids are 18-19 digit
 * integers beyond JS's safe-integer range (2^53), so `Number(id)` would
 * silently round them and address a non-existent resource.
 */
export function dataPointLogId(dp: LooseRecord): string {
  const name = typeof dp.name === 'string' && dp.name !== '' ? dp.name : undefined;
  if (name) return name;
  const raw = pickString(dp, ['dataPointId', 'id']);
  if (raw !== undefined) return raw;
  const startTime = pickString(dp, ['startTime']);
  return startTime ? String(new Date(startTime).getTime()) : '0';
}

// ---------- JST time plumbing ----------
// The API takes/returns RFC 3339 timestamps; the tool layer speaks
// Fitbit-style local (JST) dates and naive timestamps.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// The API's `utcOffset` members are google-duration strings, not RFC3339
// zone suffixes. JST is +09:00 → 32400 seconds.
const JST_UTC_OFFSET = '32400s';

/**
 * An `ObservationSampleTime` for a sample-type write (weight, body-fat).
 * Both `physicalTime` (google-datetime) and `utcOffset` (google-duration)
 * are required by the v4 schema.
 */
export function jstSampleTime(rfc3339: string): LooseRecord {
  return { physicalTime: rfc3339, utcOffset: JST_UTC_OFFSET };
}

/**
 * A time interval for session/interval writes. The v4 schema marks
 * `startTime`/`endTime` and both `*UtcOffset` members required; the field
 * names differ between `ObservationTimeInterval` (interval types) and
 * `SessionTimeInterval` (sessions), but the required members are identical.
 */
export function jstInterval(startRfc3339: string, endRfc3339: string): LooseRecord {
  return {
    startTime: startRfc3339,
    endTime: endRfc3339,
    startUtcOffset: JST_UTC_OFFSET,
    endUtcOffset: JST_UTC_OFFSET,
  };
}

/**
 * An interval for point-in-time logs (food, water) that have no real
 * duration. The v4 API rejects any interval where `endTime <= startTime`
 * ("start time must be strictly earlier than end time"), so nudge the end
 * one second past the start. Second precision is deliberate: the list()
 * civil_start_time filter keys off the date head, so sub-second offsets
 * would round away and reintroduce the equal-bounds 400.
 */
export function jstInstantInterval(startRfc3339: string): LooseRecord {
  const endMs = new Date(startRfc3339).getTime() + 1000;
  return jstInterval(startRfc3339, epochToJstRfc3339(endMs));
}

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
