# Northstar Phase 3A1 — Tenant Isolation and Authorization Foundation

Phase 3A1 establishes the ownership and authorization boundary required before real authentication or public multi-user exposure. It does **not** authenticate a person. The only human-like access available in this phase is an explicit local/test bootstrap mode; every production-shaped environment defaults to deny-all.

## Domain model

- **User** — an immutable internal human identity anchor in `identity_users`. It has lifecycle and future external-linkage state, but no email, password, provider token, or session.
- **Profile/tenant** — the existing `investment_profiles` row and ownership key for portfolio, forecast, evaluation, notification, email, and operational evidence.
- **Membership** — a role-bearing user/profile relationship in `profile_memberships`, with append-only history in `profile_membership_events`.
- **Principal** — the authenticated actor for one operation, constructed only within its trust boundary and never accepted as browser input.
- **Resource scope** — the exact profile and, where relevant, resource/capability/provider-event identity evaluated by policy.

The bootstrap identity has no email field and is not linked to `forecast_email_recipients`. A verified notification recipient is delivery configuration, not user identity or proof of account ownership.

## Trust boundaries and principals

| Principal | Construction boundary | Scope and authority |
| --- | --- | --- |
| `human` | Request resolver, only in explicit local/test bootstrap mode | One active membership/profile; central role matrix |
| `anonymous` | Deny-all resolver | No protected actions |
| `system_scheduler` | Trusted Worker `scheduled` callback | Configured profile; scheduler coordination only |
| `system_operator` | Local CLI with trusted environment/profile configuration | Configured profile; exactly one declared command action |
| `provider_resend` | After bounded raw-body Resend/Svix verification | Verified webhook event; reconciliation only; tenant comes from stored delivery identity |
| `capability_email_verification` | After stored lookup and cryptographic purpose/expiry validation | Exact profile, recipient, and verification capability |
| `capability_email_unsubscribe` | After stored lookup and cryptographic purpose validation | Exact profile, recipient, capability, and consent revision |

Browser headers, cookies, query parameters, payload profile fields, recipient addresses, webhook tags, and serialized principals are not identity inputs. `X-User-ID`, `X-Profile-ID`, and `X-Role` are deliberately ignored.

## Central policy and role matrix

`app/lib/server/auth/policy.ts` is pure, deterministic, and deny-by-default. Unknown actions and missing profile scopes are denied. Internal decisions retain bounded reason codes; public responses expose only generic `401`, safe `403`, non-enumerating `404`, validation, conflict, or availability responses.

| Action family | Owner | Editor | Viewer |
| --- | :---: | :---: | :---: |
| Profile/workspace/market read | Yes | Yes | Yes |
| Forecast/evaluation/review/notification read | Yes | Yes | Yes |
| Analysis and forecast create/edit/delete/lifecycle/evaluation | Yes | Yes | No |
| Review acknowledgement and in-app read-state mutation | Yes | Yes | No |
| Portfolio/profile mutation | Yes | No | No |
| Recipient/consent or membership administration | Yes | No | No |
| Scheduler/provider/capability/operator actions | No | No | No |

Only the bootstrap owner exists in Phase 3A1. Invitations, ownership transfer, membership UI, and profile switching are not implemented.

## Request resolver and UI behavior

```text
NORTHSTAR_AUTH_MODE=deny_all | local_bootstrap
NORTHSTAR_ENVIRONMENT=local | test | preview | staging | production
NORTHSTAR_SYSTEM_PROFILE_ID=<trusted positive integer for system commands>
```

Missing configuration means `production` plus `deny_all`. Unknown values are rejected. `local_bootstrap` is valid only for `local` or `test`; hostname alone never enables it. Production builds force the application binding to `production` plus `deny_all` even if a developer shell exports local-bootstrap values. `scripts/run-northstar-local.sh` explicitly selects local bootstrap for the development server only.

Local bootstrap reads the deterministic bootstrap identity and its active owner membership. Every protected page shows a banner stating that authentication is inactive, local bootstrap ownership is in use, and the mode must not be deployed.

In deny-all mode, protected APIs return `401` before database initialization, request-body handling, or provider work. Protected pages truthfully render “Authentication is not configured.” Provider-signed and capability routes retain independent authentication. There is no fake login form.

## Route classification

The executable method-level inventory is `app/lib/server/auth/route-manifest.ts`. The route audit compares discovered routes and the manifest in both directions.

| Boundary | Current surface |
| --- | --- |
| Human protected | `/`; `/notifications`; `/notifications/:id`; workspace; market/search; analysis; forecast CRUD/lifecycle/evaluation; review list/acknowledgement; notification list/count/detail/read/unread/mark-all |
| Provider signed | `POST /api/webhooks/resend` |
| Capability authorized | `POST /email/verify`; `POST /email/unsubscribe` |
| Public read-only | Scanner-safe `GET /email/verify` and `GET /email/unsubscribe`; neither reads storage nor mutates state |
| System only | Worker scheduled callback and local operator commands; neither is an application route |
| Build/static | Framework routing/assets and explicitly inventoried `public/og.png` |

Development and production both use the same `/api/analysis` route and exact `analysis_run` authorization boundary; there is no Vite-only proxy with weaker authority. Protected results use `no-store`; tenant data is never placed in a shared public cache.

## Service and repository enforcement

Human request contexts create branded authorized scopes before initialization. Forecast, evaluation, and in-app HTTP paths receive action-bound service facades; each verifies its exact action again before deriving the numeric profile. Workspace, market/search, and analysis authorize before profile-owned queries or provider access. Scheduler, coordinator, notification projectors, recipient/consent administration, verification delivery, and email dispatch likewise receive action-bound system-service adapters. The local operator command-to-action map is frozen; a caller cannot ask a status command to mint dispatch authority. No protected fixed-profile fallback remains.

Repositories use query-level ownership (`WHERE id = ? AND profile_id = ?`) and profile-bound conditional mutations. Revision, attempt, event-existence, and provider-attempt subqueries were hardened with the same profile. Foreign IDs retain non-enumerating not-found/no-change semantics. Existing coordinator, projection, review, and in-app cursors remain profile/filter bound. Operators have no `--profile-id`; scope comes only from trusted configuration, and ordinary human/JSON output omits internal profile IDs.

## Complete ownership model

The machine-enforced 41-table inventory is `app/lib/server/auth/ownership-manifest.ts`.

| Ownership | Tables and access |
| --- | --- |
| Global operational | `app_metadata`; system/operator only |
| Global identity | `identity_users`; no recipient/email linkage |
| Tenant root | `investment_profiles` |
| Membership | `profile_memberships`, `profile_membership_events`; owner/future identity administration, append-only history |
| Workspace/forecast | positions, watchlist, journal, alerts, forecasts, events, snapshots, evaluations, reviews; role-scoped |
| Coordinator/scheduler | runs, items, attempts, claims, invocations, pages; system-written profile evidence |
| Notification/in-app | preferences, checkpoints, intents, decisions, outbox, attempts, entries, projection items, state events |
| Email | recipients, consent, capabilities, pre-send decisions, deliveries, attempts, suppression |
| Provider hybrid | `forecast_email_provider_events`; nullable profile only until a signed event resolves through stored delivery identity |

Legacy forecast event/evaluation/snapshot/review relationships now have SQLite insert/update tenant guards; forecast ownership is immutable. Membership events reject updates/deletes, membership identity fields are immutable, and membership deletion is prohibited in favor of revocation. Role, status, and revision changes require a matching next-revision event with the exact resulting state; the tenant audit verifies current membership state, creation and transition semantics, and canonical bootstrap provenance against the event history. Preflight rejects authorization-trigger name collisions before schema creation, and runtime initialization verifies every required trigger's normalized definition before serving requests.

## Migration `0009`

`drizzle/0009_mysterious_maginty.sql` is additive; `0000` through `0008` are unchanged. A migration guard first requires:

- zero or one legacy profile;
- a clean `PRAGMA foreign_key_check`;
- no cross-profile forecast events, evaluation runs, snapshots, or review records.

Any blocker aborts before authorization state survives. With one profile—regardless of numeric ID—the migration preserves it and all related rows, adds the deterministic bootstrap user, adds one active owner membership, and appends its creation event. With zero profiles it creates authorization schema but no identity/membership; explicit local runtime bootstrap may create the fresh empty local profile later. Unexpected multiple profiles are never resolved by `MIN(id)`, ID `1`, or another silent choice.

Runtime bootstrap is idempotent. It tolerates a deliberately disabled user, revoked membership, and later legitimate additional profiles without reactivation. Partial bootstrap state is an integrity error, not silently repaired.

Phase 3A2 must claim/link the pending identity through an authenticated, explicitly authorized process. Matching an email recipient must never claim it automatically.

## Read-only audit commands

Run from `market-monitor-web`:

```bash
npm run auth:bootstrap:status
npm run auth:bootstrap:status -- --json
npm run auth:tenant-audit
npm run auth:tenant-audit -- --json
npm run auth:route-audit
npm run auth:route-audit -- --json
```

These commands do not initialize, repair, or select remote data. Output omits profile/user IDs, names, email addresses, provider IDs, hashes, claims, leases, and tokens. JSON is stable and aggregate-only. Invalid CLI input exits `2`; system or release blockers exit nonzero.

- `auth:bootstrap:status` is pre-mutation: a clean one-profile Phase 2C2C database reports `migration_required` and `migrationReady: true`.
- `auth:tenant-audit` is post-migration and requires complete authorization schema, a usable bootstrap owner, membership/event parity, the full required integrity-trigger set with matching normalized definitions, clean ownership/FK/cross-profile checks, and a complete ownership inventory.
- `auth:route-audit` opens no D1 binding and fails on missing/stale/duplicate route or non-route classification, a declared action missing from its enforcement source, a fixed-profile resolver reference, or an unexpected global-ID SQL lookup. Its narrow allowlist covers only deterministic bootstrap identity lookup, purpose-bound capability lookup, and verified provider evidence reconciliation.

## Security properties and verification scope

Tests cover the role/action matrix, unknown-action denial, disabled users, revoked memberships, wrong/missing profile scope, system action isolation, provider event binding, capability purpose/recipient/revision/expiry binding, forged-header indifference, deny-all defaults, unsafe production bootstrap configuration, route/ownership completeness, empty/populated migration, ambiguous-profile rollback, row preservation, foreign keys, and append-only evidence. Executable two-profile suites cover workspace/market/analysis SQL paths; forecast list/read/update/delete/activate/cancel/note paths against real D1; evaluation, review, coordinator, and notification IDs; cursor and mark-all-token binding; conflicting notification preferences; recipient/consent separation; atomic scoped mutation; and unread-count isolation.

The dependency audit remains a release blocker: three pre-existing high-severity groups in the Next.js/PostCSS/sharp tree and zero critical findings. Phase 3A1 adds no dependency and does not upgrade them.

No remote D1 migration, Cloudflare deployment, live Resend request, Cron activation, browser automation, assistive-technology run, authentication provider, session validation, or production multi-tenant verification is claimed.

## Exact Phase 3A2 boundary

Phase 3A2 should add a real authentication provider, secure sessions, login/logout, authenticated bootstrap-owner claiming, account recovery, protected navigation, and removal of local bootstrap from every non-local environment. It must preserve the principal/action model, profile-scoped services/repositories, system/provider/capability separation, non-enumerating errors, audit commands, migration history, and the recipient-is-not-identity rule.
