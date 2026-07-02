import type { Profile } from '../types';
import type { GoogleHealthClient } from './client';
import { type LooseRecord, LooseRecordSchema, pickNumber, pickString } from './datapoints';

async function getOptional(client: GoogleHealthClient, path: string): Promise<LooseRecord> {
  try {
    return await client.requestJson(LooseRecordSchema, { path });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[google-health] GET ${path} failed (continuing without it): ${reason}`);
    return {};
  }
}

/**
 * users.getProfile is the canonical call; users.getSettings (unit system,
 * timezone — settings.readonly scope) and users.getIdentity (legacy Fitbit
 * user id) fill Fitbit-shaped fields the profile itself no longer carries.
 * Both extras are optional so a missing scope degrades gracefully.
 */
export async function getProfile(client: GoogleHealthClient): Promise<Profile> {
  const [profile, settings, identity] = await Promise.all([
    client.requestJson(LooseRecordSchema, { path: '/v4/users/me/profile' }),
    getOptional(client, '/v4/users/me/settings'),
    getOptional(client, '/v4/users/me/identity'),
  ]);

  return {
    user: {
      encodedId:
        pickString(identity, ['fitbitUserId', 'legacyFitbitUserId', 'googleUserId', 'userId']) ??
        'me',
      displayName: pickString(profile, ['displayName']),
      fullName: pickString(profile, ['fullName', 'name']),
      firstName: pickString(profile, ['firstName', 'givenName']),
      lastName: pickString(profile, ['lastName', 'familyName']),
      dateOfBirth: pickString(profile, ['dateOfBirth', 'birthDate']),
      gender: pickString(profile, ['gender']),
      height: pickNumber(profile, ['heightCm', 'height']),
      heightUnit: pickString(settings, ['heightUnit', 'unitSystem']),
      weight: pickNumber(profile, ['weightKg', 'weight']),
      weightUnit: pickString(settings, ['weightUnit', 'unitSystem']),
      timezone:
        pickString(settings, ['timezone', 'timeZone']) ??
        pickString(profile, ['timezone', 'timeZone']),
      locale: pickString(settings, ['locale']) ?? pickString(profile, ['locale']),
      memberSince: pickString(profile, ['memberSince', 'createTime']),
      averageDailySteps: pickNumber(profile, ['averageDailySteps']),
    },
  };
}
