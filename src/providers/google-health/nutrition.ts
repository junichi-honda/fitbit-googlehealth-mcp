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
  dataPointLogId,
  jstDayEnd,
  jstDayStart,
  jstRfc3339,
  type LooseRecord,
  listDataPoints,
  patchDataPoints,
  pickNumber,
  pickString,
  stripUndefined,
} from './datapoints';

const MEAL_TYPE_GOOGLE: Record<MealTypeT, string> = {
  Breakfast: 'BREAKFAST',
  MorningSnack: 'MORNING_SNACK',
  Lunch: 'LUNCH',
  AfternoonSnack: 'AFTERNOON_SNACK',
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

const WATER_KEYS = ['volumeMl', 'amountMl', 'ml', 'volume', 'amount'] as const;

function nutritionalValuesFrom(dp: LooseRecord): NutritionalValues {
  return {
    calories: pickNumber(dp, ['calories', 'energyKcal']),
    carbs: pickNumber(dp, ['totalCarbohydrate', 'carbs', 'carbohydrateGrams']),
    fat: pickNumber(dp, ['totalFat', 'fat']),
    fiber: pickNumber(dp, ['dietaryFiber', 'fiber']),
    protein: pickNumber(dp, ['protein']),
    sodium: pickNumber(dp, ['sodium']),
    sugar: pickNumber(dp, ['sugars', 'sugar']),
  };
}

function foodFromDataPoint(dp: LooseRecord, logDate: string): FoodLogEntry {
  const nutritionalValues = nutritionalValuesFrom(dp);
  const mealType = pickString(dp, ['mealType']);
  return {
    logId: dataPointLogId(dp),
    loggedFood: {
      name: pickString(dp, ['foodName', 'foodItem']),
      brand: pickString(dp, ['brandName', 'brand']),
      mealTypeId: mealType ? GOOGLE_MEAL_TO_ID[mealType.toUpperCase()] : undefined,
      amount: pickNumber(dp, ['amount', 'servings']),
      calories: nutritionalValues.calories,
    },
    nutritionalValues,
    logDate,
  };
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
    listDataPoints(client, 'hydration', range).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[google-health] hydration list failed (skipping water): ${reason}`);
      return [] as LooseRecord[];
    }),
  ]);

  const foods = foodPoints.map((dp) => foodFromDataPoint(dp, date));
  const water: WaterLogEntry[] = waterPoints.map((dp) => ({
    logId: dataPointLogId(dp),
    amount: pickNumber(dp, WATER_KEYS) ?? 0,
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
  const echoed = await patchDataPoints(client, 'nutrition-log', [
    {
      startTime: t,
      endTime: t,
      value: stripUndefined({
        foodName: input.foodName,
        brandName: input.brand,
        mealType: MEAL_TYPE_GOOGLE[input.mealType],
        amount: input.amount ?? 1,
        calories: input.calories,
        protein: n?.protein,
        totalCarbohydrate: n?.carbs,
        totalFat: n?.fat,
        dietaryFiber: n?.fiber,
        sodium: n?.sodium,
        sugars: n?.sugar,
      }),
    },
  ]);
  const dp = echoed[0];
  if (dp) return foodFromDataPoint(dp, input.date);
  return {
    logId: 0,
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
  const echoed = await patchDataPoints(client, 'hydration', [
    { startTime: t, endTime: t, value: { volumeMl: input.amountMl } },
  ]);
  const dp = echoed[0];
  return {
    logId: dp ? dataPointLogId(dp) : 0,
    amount: dp ? (pickNumber(dp, WATER_KEYS) ?? input.amountMl) : input.amountMl,
  };
}

export async function deleteFoodLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'nutrition-log', [logId]);
}

export async function deleteWaterLog(client: GoogleHealthClient, logId: number): Promise<void> {
  await batchDeleteDataPoints(client, 'hydration', [logId]);
}
