import {
  BOOTSTRAP_MEMBERSHIP_ID,
  BOOTSTRAP_USER_ID,
} from '@/db/authorization-initialization.ts';
import type { HumanPrincipal, MembershipRole } from './types.ts';

export interface HumanPrincipalRepository {
  loadLocalBootstrapPrincipal(): Promise<HumanPrincipal | null>;
}

export class D1HumanPrincipalRepository implements HumanPrincipalRepository {
  constructor(private readonly d1: D1Database) {}

  async loadLocalBootstrapPrincipal(): Promise<HumanPrincipal | null> {
    const rows = await this.d1.prepare(`SELECT
        u.id AS userId,
        u.status AS userStatus,
        u.external_identity_state AS externalIdentityState,
        m.id AS membershipId,
        m.profile_id AS profileId,
        m.role,
        m.status AS membershipStatus
      FROM identity_users u
      JOIN profile_memberships m ON m.user_id = u.id
      WHERE u.id = ? AND m.id = ?
      LIMIT 2`)
      .bind(BOOTSTRAP_USER_ID, BOOTSTRAP_MEMBERSHIP_ID)
      .all<{
        userId: string;
        userStatus: 'active' | 'disabled';
        externalIdentityState: string;
        membershipId: string;
        profileId: number;
        role: MembershipRole;
        membershipStatus: 'active' | 'revoked';
      }>();
    if (rows.results.length !== 1) return null;
    const row = rows.results[0];
    if (row.externalIdentityState !== 'bootstrap_pending') return null;
    return {
      kind: 'human',
      userId: row.userId,
      userStatus: row.userStatus,
      membershipId: row.membershipId,
      profileId: row.profileId,
      role: row.role,
      membershipStatus: row.membershipStatus,
      assurance: { mechanism: 'local_bootstrap', externalIdentityLinked: false },
    };
  }
}
