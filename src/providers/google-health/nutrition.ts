import type {
  FoodLog,
  FoodLogEntry,
  LogFoodInput,
  LogMealInput,
  LogWaterInput,
  MealTypeT,
  NutritionalValues,
  WaterLogEntry,
} from '../types';
import type { GoogleHealthClient } from './client';
import {
  batchDeleteDataPoints,
  createAndResolveDataPoint,
  dataPointLogId,
  jstDayEnd,
  jstDayStart,
  jstInstantInterval,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  payloadOf,
  pickArray,
  pickNumber,
  pickString,
  stripUndefined,
  subRecord,
} from './datapoints';

// The v4 NutritionLog.mealType enum only offers BREAKFAST/LUNCH/DINNER/
// SNACK/ANYTIME (plus BEFORE_*/AFTER_* variants) — there is no
// MORNING_SNACK/AFTERNOON_SNACK, so both snack slots collapse to SNACK.
const MEAL_TYPE_GOOGLE: Record<MealTypeT, string> = {
  Breakfast: 'BREAKFAST',
  MorningSnack: 'SNACK',
  Lunch: 'LUNCH',
  AfternoonSnack: 'SNACK',
  Dinner: 'DINNER',
  Anytime: 'ANYTIME',
};

// Fitbit numeric meal-type ids, kept so FoodLogEntry.loggedFood.mealTypeId
// stays comparable across providers (1=B/2=MS/3=L/4=AS/5=D/7=Anytime).
const MEAL_TYPE_ID: Record<MealTypeT, number> = {
  Breakfast: 1,
  MorningSnack: 2,
  Lunch: 3,
  AfternoonSnack: 4,
  Dinner: 5,
  Anytime: 7,
};

const GOOGLE_MEAL_TO_ID: Record<string, number> = {
  BREAKFAST: 1,
  MORNING_SNACK: 2,
  LUNCH: 3,
  AFTERNOON_SNACK: 4,
  // The v4 enum only has a single SNACK; the morning/afternoon distinction is
  // lost on write, so reads render it as the afternoon-snack id.
  SNACK: 4,
  DINNER: 5,
  ANYTIME: 7,
};

/**
 * Nutrition data points are timestamped, not date+meal-slot keyed like
 * Fitbit's food log — these JST clock times anchor each meal slot so
 * entries land in the right day and sort naturally.
 */
const MEAL_TIME: Record<MealTypeT, string> = {
  Breakfast: '08:00:00',
  MorningSnack: '10:30:00',
  Lunch: '12:30:00',
  AfternoonSnack: '15:30:00',
  Dinner: '19:00:00',
  Anytime: '12:00:00',
};

// hydration-log nests the volume under `hydrationLog.amountConsumed.milliliters`
// (a string); keep the flatter candidates for older/echoed shapes.
const WATER_KEYS = ['milliliters', 'volumeMl', 'amountMl', 'ml', 'volume', 'amount'] as const;

// NutrientQuantity.nutrient enum names for the per-nutrient rows carried in
// `nutritionLog.nutrients[]` (each `{ nutrient, quantity: { grams } }`).
const NUTRIENT_PROTEIN = 'PROTEIN';
const NUTRIENT_FIBER = 'DIETARY_FIBER';
const NUTRIENT_SODIUM = 'SODIUM';
const NUTRIENT_SUGAR = 'SUGAR';

/** grams for a NutrientQuantity row whose `nutrient` enum matches `name`. */
function nutrientGrams(payload: LooseRecord, name: string): number | undefined {
  for (const row of pickArray(payload, ['nutrients']) ?? []) {
    if (pickString(row, ['nutrient']) === name) {
      return pickNumber(subRecord(row, 'quantity'), ['grams']);
    }
  }
  return undefined;
}

/**
 * Nutrition payload nests under `dp.nutritionLog`. Energy is `energy.kcal`,
 * carbs/fat are `{total*}.grams`, and protein/fiber/sodium/sugar live as
 * enum-keyed rows in `nutrients[]`. Flat candidates are kept as a fallback for
 * echoed/legacy shapes.
 */
function nutritionalValuesFrom(payload: LooseRecord): NutritionalValues {
  return {
    calories:
      pickNumber(subRecord(payload, 'energy'), ['kcal']) ?? pickNumber(payload, ['calories']),
    carbs:
      pickNumber(subRecord(payload, 'totalCarbohydrate'), ['grams']) ??
      pickNumber(payload, ['totalCarbohydrate', 'carbs']),
    fat:
      pickNumber(subRecord(payload, 'totalFat'), ['grams']) ??
      pickNumber(payload, ['totalFat', 'fat']),
    fiber: nutrientGrams(payload, NUTRIENT_FIBER) ?? pickNumber(payload, ['dietaryFiber', 'fiber']),
    protein: nutrientGrams(payload, NUTRIENT_PROTEIN) ?? pickNumber(payload, ['protein']),
    sodium: nutrientGrams(payload, NUTRIENT_SODIUM) ?? pickNumber(payload, ['sodium']),
    sugar: nutrientGrams(payload, NUTRIENT_SUGAR) ?? pickNumber(payload, ['sugars', 'sugar']),
  };
}

function foodFromDataPoint(dp: LooseRecord, logDate: string): FoodLogEntry {
  const payload = payloadOf(dp, 'nutrition-log');
  const nutritionalValues = nutritionalValuesFrom(payload);
  const mealType = pickString(payload, ['mealType']);
  return {
    logId: dataPointLogId(dp),
    loggedFood: {
      name: pickString(payload, ['foodDisplayName', 'foodName', 'foodItem', 'name']),
      brand: pickString(payload, ['brandName', 'brand']),
      mealTypeId: mealType ? GOOGLE_MEAL_TO_ID[mealType.toUpperCase()] : undefined,
      amount:
        pickNumber(subRecord(payload, 'serving'), ['amount']) ??
        pickNumber(payload, ['amount', 'servings']),
      calories: nutritionalValues.calories,
    },
    nutritionalValues,
    logDate,
  };
}

/** Milliliters from a hydration-log point: `hydrationLog.amountConsumed.milliliters`. */
function waterMlFrom(dp: LooseRecord): number {
  const payload = payloadOf(dp, 'hydration-log');
  const amountConsumed = subRecord(payload, 'amountConsumed');
  return pickNumber(amountConsumed, WATER_KEYS) ?? pickNumber(payload, WATER_KEYS) ?? 0;
}

function sumField(foods: FoodLogEntry[], field: keyof NutritionalValues): number | undefined {
  let total = 0;
  let seen = false;
  for (const food of foods) {
    const v = food.nutritionalValues?.[field];
    if (typeof v === 'number') {
      total += v;
      seen = true;
    }
  }
  return seen ? Math.round(total * 10) / 10 : undefined;
}

export async function getFoodLog(client: GoogleHealthClient, date: string): Promise<FoodLog> {
  const range = { startTime: jstDayStart(date), endTime: jstDayEnd(date) };
  const [foodPoints, waterPoints] = await Promise.all([
    listDataPoints(client, 'nutrition-log', range),
    listDataPoints(client, 'hydration-log', range).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[google-health] hydration-log list failed (skipping water): ${reason}`);
      return [] as LooseRecord[];
    }),
  ]);

  const foods = foodPoints.map((dp) => foodFromDataPoint(dp, date));
  const water: WaterLogEntry[] = waterPoints.map((dp) => ({
    logId: dataPointLogId(dp),
    amount: waterMlFrom(dp),
  }));
  const totalWater = Math.round(water.reduce((acc, w) => acc + w.amount, 0));

  // No `goals`: the Google Health app dropped calorie-goal food plans.
  return {
    foods,
    summary: {
      calories: sumField(foods, 'calories'),
      carbs: sumField(foods, 'carbs'),
      fat: sumField(foods, 'fat'),
      fiber: sumField(foods, 'fiber'),
      protein: sumField(foods, 'protein'),
      sodium: sumField(foods, 'sodium'),
      sugar: sumField(foods, 'sugar'),
      water: totalWater || undefined,
    },
    water: {
      summary: { water: totalWater },
      water,
    },
  };
}

export async function logFood(
  client: GoogleHealthClient,
  input: LogFoodInput,
): Promise<FoodLogEntry> {
  const t = jstRfc3339(input.date, MEAL_TIME[input.mealType]);
  const n = input.nutritionalValues;
  // Per-nutrient rows for the enum-keyed `nutrients[]` array; carbs/fat are
  // top-level *.grams members and energy is `energy.kcal`.
  const nutrients = [
    { nutrient: NUTRIENT_PROTEIN, grams: n?.protein },
    { nutrient: NUTRIENT_FIBER, grams: n?.fiber },
    { nutrient: NUTRIENT_SODIUM, grams: n?.sodium },
    { nutrient: NUTRIENT_SUGAR, grams: n?.sugar },
  ].flatMap(({ nutrient, grams }) =>
    grams !== undefined ? [{ nutrient, quantity: { grams } }] : [],
  );
  const range = { startTime: jstDayStart(input.date), endTime: jstDayEnd(input.date) };
  const echoed = await createAndResolveDataPoint(
    client,
    'nutrition-log',
    {
      nutritionLog: stripUndefined({
        interval: jstInstantInterval(t),
        foodDisplayName: input.foodName,
        mealType: MEAL_TYPE_GOOGLE[input.mealType],
        serving: { amount: input.amount ?? 1 },
        energy: input.calories !== undefined ? { kcal: input.calories } : undefined,
        totalCarbohydrate: n?.carbs !== undefined ? { grams: n.carbs } : undefined,
        totalFat: n?.fat !== undefined ? { grams: n.fat } : undefined,
        nutrients: nutrients.length ? nutrients : undefined,
      }),
    },
    range,
  );
  const dp = echoed[0];
  if (dp) return foodFromDataPoint(dp, input.date);
  return {
    logId: '0',
    loggedFood: {
      name: input.foodName,
      brand: input.brand,
      mealTypeId: MEAL_TYPE_ID[input.mealType],
      amount: input.amount ?? 1,
      calories: input.calories,
    },
    nutritionalValues: { calories: input.calories, ...n },
    logDate: input.date,
  };
}

export async function logMeal(
  client: GoogleHealthClient,
  input: LogMealInput,
): Promise<FoodLogEntry[]> {
  const results: FoodLogEntry[] = [];
  // Sequential (not Promise.all) so a partial failure surfaces with the
  // last successful item still recorded server-side.
  for (const item of input.items) {
    const entry = await logFood(client, {
      date: input.date,
      mealType: input.mealType,
      // Keep the estimated portion in the name so it stays visible in the
      // Google Health app UI, matching the Fitbit-provider convention.
      foodName: item.estimatedGrams ? `${item.name} (${item.estimatedGrams}g)` : item.name,
      calories: item.calories,
      amount: 1,
      nutritionalValues: {
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
      },
    });
    results.push(entry);
  }
  return results;
}

export async function logWater(
  client: GoogleHealthClient,
  input: LogWaterInput,
): Promise<WaterLogEntry> {
  const t = jstRfc3339(input.date, '12:00:00');
  const range = { startTime: jstDayStart(input.date), endTime: jstDayEnd(input.date) };
  const echoed = await createAndResolveDataPoint(
    client,
    'hydration-log',
    {
      hydrationLog: {
        interval: jstInstantInterval(t),
        amountConsumed: { milliliters: input.amountMl },
      },
    },
    range,
  );
  const dp = echoed[0];
  return {
    logId: dp ? dataPointLogId(dp) : '0',
    amount: dp ? waterMlFrom(dp) || input.amountMl : input.amountMl,
  };
}

export async function deleteFoodLog(client: GoogleHealthClient, logId: string): Promise<void> {
  await batchDeleteDataPoints(client, 'nutrition-log', [logId]);
}

export async function deleteWaterLog(client: GoogleHealthClient, logId: string): Promise<void> {
  await batchDeleteDataPoints(client, 'hydration-log', [logId]);
}
