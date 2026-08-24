/**
 * Temporary single-profile request boundary.
 *
 * Northstar does not have authentication yet. Keeping the fixed profile in one
 * resolver makes every repository call explicit about ownership and gives a
 * future authentication layer one replacement point. This is not a multi-user
 * security boundary.
 */
const LOCAL_PROFILE_ID = 1;

export type ProfileContext = {
  profileId: number;
};

export async function resolveCurrentProfile(request?: Request): Promise<ProfileContext> {
  void request;
  return { profileId: LOCAL_PROFILE_ID };
}
