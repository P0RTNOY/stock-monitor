# Forecast Email Delivery — Phase 2C2B

This document is the normative Northstar Phase 2C2B contract. Phase 2C2B adds a verified-recipient email delivery foundation downstream of the durable Phase 2C2A notification outbox. It uses Resend as the only provider, is manually operator-invoked, defaults to dry-run and disabled dispatch, and does not add a dispatcher Cron.

No live email, remote D1 migration, Cloudflare deployment, Resend domain or DNS change, or Cron activation was performed as part of this phase.

## Trust and responsibility boundaries

The complete authority chain remains:

```text
trusted Phase 2A evaluation evidence
  -> Phase 2C2A projection and channel-neutral outbox
  -> verified profile-owned email recipient
  -> current notification consent and separate email consent
  -> final pre-send policy recheck under a valid outbox claim
  -> bounded repository-local template
  -> fixed Resend Email API adapter
  -> provider acceptance evidence
  -> verified Resend webhook reconciliation
```

Email is downstream evidence delivery. It cannot reevaluate a forecast, create an outcome or notification intent, read market data, rewrite evaluation evidence, or make forecast resolution depend on provider availability. The Phase 2C1 forecast scheduler never sends email and does not invoke the email dispatcher.

The fixed local profile resolver remains an operational seam, not authentication or tenant isolation. Recipient registration, verification initiation, consent changes, and dispatch remain trusted operator actions. Verification proves control of one mailbox; it does not authenticate a Northstar user and does not grant forecast-email consent.

The only public provider-facing boundary is the Resend webhook. Verification and unsubscribe links expose narrowly scoped capability confirmation flows. There is no public recipient-registration, consent, dispatch, arbitrary-template, or arbitrary-destination API.

## Frozen versions and supported scope

| Contract | Version |
| --- | --- |
| Email channel | `forecast-email-channel-1.0.0` |
| Email consent | `forecast-email-consent-1.0.0` |
| Capability | `forecast-email-capability-1.0.0` |
| Dispatcher | `forecast-email-dispatcher-1.0.0` |
| Resend adapter | `northstar-resend-adapter-1.0.0` |
| Resend idempotency identity | `northstar-email-v1` |
| Template locale | `en-US` |

Supported forecast categories are exactly `target_hit`, `invalidated`, `expired`, and `needs_review`. `no_change`, coordinator failures, scheduler failures, provider failures without a persisted evaluation, and other operational conditions do not become email intents. Verification email is a separate delivery source and cannot be confused with a forecast notification.

## Recipient lifecycle and address handling

One profile may have one current `pending` or `verified` recipient. Historical recipients are retained as `replaced` or `revoked`; replacement invalidates the previous verification and consent binding. A recipient also carries an independent suppression state for hard bounce, complaint, provider suppression, or an operator action.

Phase 2C2B applies deliberately small normalization rules:

- trim outer whitespace;
- accept a conservative ASCII dot-atom mailbox only;
- preserve the local part exactly, including casing, dots, and plus tags;
- lowercase only the domain;
- reject control characters, non-ASCII addresses, invalid labels, repeated dots, and oversized values;
- never apply Gmail-style or other provider-specific alias rules.

The raw address is stored only in the profile-owned recipient record and used only to construct the provider request. Ordinary operator output uses a deterministic masked form. Outbox payloads, policy decisions, delivery attempts, provider-event rows, logs, and JSON reports do not duplicate or expose the address.

A recipient is eligible only when it is current, verified, not revoked or replaced, and not suppressed. Verification alone never enables email.

## Verification capabilities

Recipient registration or replacement is operator-controlled and creates only a pending recipient with deny-by-default consent. A separate explicit verification request creates the verification capability and records its request time. Verification tokens are cryptographically random, versioned, purpose-bound, recipient-bound, expiring, single-use, and integrity-protected. D1 stores a SHA-256 token hash and capability metadata, never the plaintext token. Tokens contain no plaintext profile ID or email address and are omitted from status output and logs.

Verification delivery uses the same bounded template, Resend adapter, delivery identity, and attempt evidence as other email; it is not a hidden one-off sender. The explicit verification request authorizes only preparation of that verification capability. A provider call still requires the separate verification-send command and all live-send configuration gates, and never grants forecast-notification consent.

The verification link opens a generic confirmation page. A `GET` does not mutate recipient state, protecting against email-security link scanners. The actual transition requires an explicit `POST`. Invalid, expired, consumed, replaced, revoked, or unknown tokens receive the same generic response and disclose no profile or recipient information. Attempts are bounded and the token is consumed exactly once after successful confirmation.

## Notification consent versus email consent

Phase 2C2B adds a separate, append-preserved email-channel consent revision bound to the current recipient. Delivery requires both layers:

1. the Phase 2C2A notification master/category preference; and
2. the Phase 2C2B email master/category consent for the same recipient.

Each layer supports `target_hit`, `invalidated`, `expired`, and `needs_review`. Missing, malformed, stale, wrong-profile, disabled, or recipient-mismatched state fails closed. Enabling a category cannot bypass its master switch. Verification does not imply either consent layer.

Recipient replacement requires a new verification and a new email-consent decision. Revocation, unsubscribe, complaint, or recipient replacement appends a new consent revision; historical revisions and notification evidence remain intact. Later opt-in never releases an old suppressed decision or an outbox item created before the current recipient was verified and consented. Revocation is effective at the next final pre-send check, including after an item has already been claimed.

## Deterministic templates

Templates are rendered locally from the exact persisted Phase 2C2A payload. Provider-hosted mutable templates are not used.

| Template | Version | Purpose |
| --- | --- | --- |
| Verification | `northstar-email-verification-1.0.0` | Confirm mailbox control without granting consent. |
| Target hit | `northstar-forecast-target-hit-1.0.0` | Report that a journaled forecast reached its recorded target. |
| Invalidated | `northstar-forecast-invalidated-1.0.0` | Report the recorded invalidation result. |
| Expired | `northstar-forecast-expired-1.0.0` | Report completed-horizon expiry. |
| Needs review | `northstar-forecast-needs-review-1.0.0` | Direct the operator to persisted evidence requiring review. |

Every template produces a deterministic subject, plain text, escaped HTML, version, `en-US` locale, and SHA-256 content hash. Forecast templates include a safe journal link, visible unsubscribe link, `List-Unsubscribe`, and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. They use only bounded result facts such as symbol, saved boundary, market date, currency, and persisted occurrence time. They exclude thesis text, raw OHLC arrays, provider evidence dumps, profile and claim identifiers, fingerprints, secrets, and arbitrary HTML.

All dynamic HTML is escaped and header values reject control characters. Links are constructed only from a strictly validated origin. Production-shaped environments require an HTTPS domain with no credentials, path, query, or fragment; local HTTP is restricted to loopback. Templates are informational, contain the frozen disclaimer that the message reflects a journaled forecast and is not investment advice, and do not prescribe buying or selling. A subject, structure, semantic-field, or locale change requires a new template version.

## Final pre-send authorization

Projection-time eligibility is not sufficient permission to email. After claiming an outbox row and immediately before rendering a provider request, the dispatcher records a fresh policy decision and verifies:

- the profile, outbox state, owner token, and lease remain valid;
- `available_at` has arrived under the explicit cutoff;
- the category and template version are supported;
- the current recipient still matches the prepared recipient and remains verified and unsuppressed;
- notification master/category consent remains enabled;
- recipient-bound email master/category consent remains enabled;
- neither verification nor email consent postdates the outbox item;
- preference revisions and quiet-hours configuration remain valid;
- quiet hours currently permit delivery;
- sender and public application configuration are valid; and
- the immutable delivery has not already been accepted by Resend.

Revocation, replacement, suppression, missing consent, invalid configuration, unsupported content, or an already accepted delivery produces an explainable terminal suppression without calling Resend. Quiet hours produce a deterministic deferred time using the existing Phase 2C2A Temporal policy. A lost claim or not-yet-available row fails the attempt rather than being treated as consent.

## Resend adapter

The adapter uses a narrow HTTPS request to the fixed `https://api.resend.com/emails` endpoint. There is no configurable provider URL and therefore no provider-URL SSRF surface. The request permits one validated recipient, one validated sender, optional validated reply-to, deterministic subject/text/HTML, and the two unsubscribe headers only.

The adapter contract follows Resend's official [Send Email API](https://resend.com/docs/api-reference/emails/send-email), [custom-header guidance](https://resend.com/docs/dashboard/emails/custom-headers), and [transactional unsubscribe guidance](https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails). Requests have a configured deadline and bounded body; provider responses are byte-bounded, UTF-8 decoded, and schema checked. Only a successful response containing one bounded provider email ID is accepted. Raw provider bodies and messages are neither logged nor persisted.

Sanitized outcomes distinguish acceptance, rate limiting, concurrent idempotent work, quota/validation rejection, idempotency conflict, timeout, network failure, provider unavailability, oversized response, and malformed response. A started request or ambiguous response is never reported as success.

## Provider idempotency and ambiguity

Before any provider call, Northstar persists:

- an immutable local delivery ID;
- template version and content hash;
- deterministic Resend idempotency key;
- SHA-256 hash of the exact canonical provider request; and
- append-preserved provider-attempt state.

The key is `northstar-email-v1-<sha256>` over the idempotency version, environment, immutable delivery ID, and template version. It contains no address, secret, token, raw profile ID, or content. Retries of the same logical delivery reuse the exact key. The same key may proceed only when the canonical request hash still matches; drift is a terminal integrity failure. D1 uniqueness is the long-term duplicate-send authority.

Resend documents a [24-hour idempotency retention window](https://resend.com/docs/dashboard/emails/idempotency-keys). That is a provider window, not an exactly-once guarantee. Northstar never creates a new key after a timeout, retains ambiguous attempts, and retries only with the original key inside the persisted safe-retry window. `invalid_idempotent_request` is terminal; concurrent idempotent requests may retry later with the same identity. Once safe reconciliation cannot be established before the window expires, automatic retry stops and the delivery moves to review/dead-letter handling.

## Acceptance, delivery, and reconciliation

Northstar preserves separate facts for:

1. local outbox claim;
2. provider request start;
3. Resend API acceptance and provider email ID;
4. delivery delayed;
5. delivered to the recipient's mail server;
6. provider failure or bounce; and
7. recipient complaint or provider suppression.

When a Phase 2C2A outbox row reaches `succeeded`, it means only that Resend accepted the immutable request and the acceptance evidence was recorded. It does not mean the person received, opened, read, or acted on the email. Opens and clicks are not tracked.

A crash after provider acceptance but before local finalization is an explicit ambiguous state. Recovery retains the original idempotency identity, checks durable local/provider evidence, and never assumes delivery merely because a call began. Webhook evidence may reconcile an accepted delivery; otherwise the operator must review or dead-letter it when safe automatic retry is no longer possible. Phase 2C2B does not claim exactly-once external delivery.

## Bounded manual dispatcher

Dispatch remains a local operator action and dry-run is the default. Version 1 processes eligible outbox rows sequentially in stable `(available_at, id)` keyset order under an explicit UTC cutoff. The default configured batch limit is 10, with a strict configurable maximum of 50. Runtime and lease bounds prevent an infinite loop.

Dry-run resolves candidates and policy explanations without acquiring blocking claims, rendering secret capabilities for delivery, or calling Resend. Live execution requires all of:

1. valid server-side configuration;
2. `FORECAST_EMAIL_DISPATCH_ENABLED=true`;
3. explicit operator `--send-live` authorization;
4. a current verified recipient;
5. current notification and email consent;
6. a supported due outbox row;
7. a valid unexpired fenced claim; and
8. a passing final pre-send check.

An explicit local commit mode, when available, must not fabricate provider acceptance. Item errors are isolated. Claim conflicts, quiet-hour deferral, consent suppression, provider outcomes, replay, retry, dead-letter, and unexpected sanitized errors remain separately classified. Human and JSON reports derive from the same result and contain safe correlation IDs, masked recipient display only, bounded counts, and no message bodies or credentials.

Claims and attempts continue the Phase 2C2A fencing model. Expired claims may be recovered; stale owners cannot complete newer work. Progress is recorded per item. A crash before the provider call is safely retryable, while a crash after the call uses the persisted request identity and ambiguity policy above.

No email dispatcher callback is registered in the Phase 2C1 Worker and no new Cron trigger is active.

## Verified Resend webhook reconciliation

The dedicated Resend webhook accepts `POST` only. It reads a strictly byte-bounded raw body, validates `svix-id`, `svix-timestamp`, and `svix-signature`, enforces a five-minute timestamp tolerance, and verifies the exact raw bytes with `standardwebhooks` before JSON parsing or mutation. This follows Resend's official [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests) and [retry/replay](https://resend.com/docs/webhooks/retries-and-replays) guidance.

Verified events are strictly parsed and deduplicated by provider plus event ID. The stored provider email ID—not tags, forecast IDs, or unsigned local identifiers—links an event to a delivery. Unknown delivery IDs receive a generic acknowledgement and an `unknown_delivery` record. Unknown but correctly signed types are acknowledged as unsupported without changing delivery state. Duplicate and replayed events cannot apply twice.

The explicit allowlist follows the relevant Resend [event types](https://resend.com/docs/webhooks/event-types): `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, `email.complained`, and `email.suppressed`. Deterministic precedence prevents older or weaker evidence from downgrading stronger state:

- complaint is the strongest terminal recipient evidence;
- hard bounce and provider suppression are terminal suppression evidence and cannot be downgraded by delivery or delay;
- delivered and failed events are ordered by provider occurrence time, with adverse failure winning an exact timestamp tie;
- delayed is nonterminal and cannot overwrite delivered, failed, bounced, suppressed, or complained; and
- duplicate event IDs and older events do not create another transition.

Hard bounce, complaint, and provider suppression prevent future sends. A complaint also appends an email-consent revocation. A failure after provider acceptance is recorded for reconciliation; it does not automatically resend the accepted logical email.

Webhook records retain provider/event identities, event type, occurrence/receipt timestamps, a payload hash, disposition, and linked delivery when known. They do not retain the raw signed payload, address, arbitrary headers, or secret.

## Unsubscribe

Every forecast email contains a visible unsubscribe link plus the one-click headers described above. The capability is opaque, purpose-bound, recipient/channel-bound, versioned, integrity-protected, and stored hash-only. It contains no plaintext address or profile ID and is excluded from logs and operator output.

A browser `GET` presents a generic confirmation and performs no mutation. An explicit browser `POST`, or a conforming one-click `POST` carrying `List-Unsubscribe=One-Click`, appends an email-consent revocation and prevents future provider calls. Repeated, invalid, consumed, revoked, or unknown tokens return a generic idempotent result without recipient enumeration.

Unsubscribe does not delete evaluation, notification, outbox, attempt, delivery, webhook, or consent history and does not affect forecasts or non-email behavior. Any already claimed but unsent row is stopped by the final pre-send consent check.

## Persistence

Additive migration `market-monitor-web/drizzle/0007_late_amphibian.sql` extends the Phase 2C2A outbox with terminal suppression evidence and adds:

- `forecast_email_recipients`;
- `forecast_email_consent_revisions` and current `forecast_email_consents` pointers;
- `forecast_email_capabilities` for verification and unsubscribe;
- `forecast_email_pre_send_decisions`;
- `forecast_email_deliveries`;
- append-preserved `forecast_email_provider_attempts`;
- deduplicated `forecast_email_provider_events`; and
- append-preserved `forecast_email_suppression_events`.

Foreign keys remain profile-scoped. Constraints and unique indexes enforce current-recipient uniqueness, recipient-bound consent revisions, token hashes, one delivery per outbox/capability, idempotency keys, provider email IDs, provider event IDs, legal delivery/attempt states, and attempt numbering. Provider credentials and webhook/capability secrets are environment bindings and never enter D1.

Runtime initialization, Drizzle schema, generated migration, and SQLite test adapters must remain structurally consistent. Migration `0006_late_wasp.sql` is not rewritten.

## Operator boundary

The local operator command family is:

```bash
cd market-monitor-web

npm run forecast:email:recipient -- --help
npm run forecast:email:recipient -- --status
npm run forecast:email:verification:send -- --help
npm run forecast:email:consent -- --status
npm run forecast:email:dispatch -- --help
npm run forecast:email:status -- --limit 20
```

Recipient registration/replacement/revocation, verification-capability request, verification send, and consent enable/disable are distinct explicit actions. Verification send and forecast dispatch each require an explicit cutoff and default to dry-run; forecast dispatch also accepts a bounded limit. Real provider work additionally requires `--send-live` and the environment kill switch. API keys and secrets are never CLI arguments. Human output masks addresses. JSON omits raw addresses, capability tokens, claim tokens, provider secrets, message bodies, raw provider errors, preference fingerprints, and internal profile data.

Verification links and unsubscribe links are the only flows that carry opaque capability tokens. The operator may receive a token only at its controlled issuance boundary when needed to send the corresponding audited message; status and replay output never reproduce it.

## Configuration and secrets

Email configuration is strict and dispatch-disabled by default:

| Binding | Purpose |
| --- | --- |
| `FORECAST_EMAIL_ENVIRONMENT` | `local`, `preview`, `staging`, or `production`. |
| `FORECAST_EMAIL_DISPATCH_ENABLED` | Kill switch; defaults to `false`. |
| `RESEND_API_KEY` | Server-side Email API credential. |
| `RESEND_WEBHOOK_SECRET` | Server-side webhook verification secret. |
| `FORECAST_EMAIL_CAPABILITY_SECRET` | At least 32 bytes, base64url encoded, for capability integrity. |
| `FORECAST_EMAIL_FROM` | Verified, validated sender mailbox or narrow display-name form. |
| `FORECAST_EMAIL_REPLY_TO` | Optional validated reply-to mailbox. |
| `PUBLIC_APP_URL` | Strict application origin for journal and capability links. |
| `FORECAST_EMAIL_PROVIDER_TIMEOUT_MS` | Bounded provider request deadline; default 10 seconds. |
| `FORECAST_EMAIL_RESPONSE_MAX_BYTES` | Bounded provider response; default 16 KiB. |
| `FORECAST_EMAIL_DISPATCH_LIMIT` | Default manual batch bound; default 10, maximum 50. |
| `FORECAST_EMAIL_WEBHOOK_MAX_BYTES` | Raw webhook body bound; default 64 KiB. |

Live dispatch requires API key, sender, public application URL, capability secret, and the kill switch. Webhook processing separately requires its secret. Secrets belong in approved Worker secret/configuration mechanisms, not committed files, D1, logs, command lines, or browser bundles.

Resend sender-domain verification and DNS configuration are external prerequisites. This phase does not create a Resend domain or modify DNS. The provider documents safe [test addresses](https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing), but no test address or real address may be sent to without explicit authorization.

## Privacy and security posture

- Header values are single-line and bounded; dynamic HTML is escaped.
- Capability tokens are opaque, purpose/recipient bound, hash-only at rest, bounded, and excluded from diagnostics.
- Verification `GET` and unsubscribe confirmation `GET` do not mutate state.
- Provider URL and application paths are fixed, preventing arbitrary redirects and provider SSRF.
- Webhooks are authenticated over exact raw bytes before parsing and are replay-deduplicated.
- Consent, recipient, claim, and configuration are rechecked immediately before provider access.
- Raw provider responses, signed webhook bodies, message content, recipient addresses, credentials, and exception text do not enter ordinary logs or operator JSON.
- Provider response and webhook bodies, batch size, runtime, leases, retry count, and safe-retry time are bounded.
- Tests inject HTTP, clocks, tokens, and crypto fixtures and cannot make an accidental live Resend call.

The fixed-profile operator bridge is not safe public multi-user administration. Recipient verification is not authentication. Phase 2C2B does not add marketing, broadcasts, arbitrary HTML, multiple providers, open/click tracking, or arbitrary webhook destinations.

## Local verification, staging, and rollback

Automated tests use D1-compatible in-memory SQLite, deterministic clocks and capabilities, mocked Resend responses, and official-shaped signed webhook fixtures. They cover address normalization, verification/capability integrity, separate consent and revocation races, bounded templates, request identity, provider classifications, dry-run/live gates, claims and recovery, webhook signature/replay/precedence, suppression, unsubscribe, migration parity, and output redaction. Automated tests never call live Resend, Yahoo, OpenAI, or a remote scheduler.

The repository verification commands remain:

```bash
source .venv312/bin/activate
python --version
python -m unittest discover -v
python -m compileall -q app.py ai.py analysis db.py finance.py indicators.py journal.py models.py news.py tests

cd market-monitor-web
npm test
npm run lint
npx tsc --noEmit
npm run db:generate
npm run build
npm audit --omit=dev --audit-level=high
```

Before staging, keep `FORECAST_EMAIL_DISPATCH_ENABLED=false`, configure a verified staging sender/domain and HTTPS `PUBLIC_APP_URL`, store secrets through the approved environment mechanism, and inspect remote migration state. Applying migration `0007`, deploying the Worker, registering the webhook URL, or changing secrets/DNS are separate authorized writes. Only after remote D1, signed webhook reconciliation, masked operator output, replay, unsubscribe, complaint suppression, kill-switch, and rollback behavior are verified should a separately authorized Resend test-address send be considered.

The first rollback action is to set `FORECAST_EMAIL_DISPATCH_ENABLED=false` and deploy that configuration through an authorized release. This stops new provider calls without deleting evidence. Revoke the recipient or email consent if destination control is in doubt, and rotate the API, webhook, or capability secret if compromise is suspected. Do not delete outbox, consent, delivery, attempt, or webhook history as rollback. Migration `0007` is additive and may remain while dispatch is disabled.

The dependency audit has an existing high-severity framework/image/CSS toolchain blocker. At verification time npm proposed changing the repository's exact Next.js `16.2.6` pin to `16.3.3`; that dependency-hardening change is intentionally outside this phase. Phase 2C2B must report the exact final audit rather than call the tree clean, and any new signature dependency must not add a high or critical finding. Dependency hardening remains a separate release gate.

## Known limitations

- No live email was sent, including to a Resend test address.
- Migration `0007` was not applied to remote Cloudflare D1.
- No Worker was deployed and no webhook was registered with Resend.
- No Resend domain, sender identity, DNS record, API key, webhook secret, or capability secret was created or changed.
- No email dispatcher Cron was registered or activated; dispatch is manual and dry-run by default.
- Remote D1 concurrency, remote lease recovery, provider ambiguity, and operating-system process-kill behavior remain unverified.
- Provider acceptance is not proof of mailbox delivery, inbox placement, reading, or human action.
- Resend's 24-hour idempotency retention is relied on only within the documented provider window; local D1 is the longer-lived authority.
- The application still lacks general authentication, multi-user tenancy, browser-based recipient settings, and a production Notification Center.
- Open and click tracking, additional providers and channels, marketing/broadcast features, and arbitrary templates remain out of scope.

## Exact Phase 2C2C boundary

Phase 2C2C has not started. Its recommended scope is a durable in-app Notification Center built from the existing trusted notification intents and evidence:

1. profile-scoped notification-center records with explicit read/unread timestamps;
2. deep links to immutable forecast, review, and evaluation evidence;
3. bounded list pagination and honest unresolved/suppressed/delivery states;
4. authenticated channel-preference and recipient-management UI only after authentication/tenant isolation exists;
5. carefully authorized, separately scheduled email-dispatch invocation after remote D1, provider, webhook, consent, observability, and rollback verification; and
6. no reevaluation, no evidence rewriting, no advice generation, and no coupling of forecast success to notification delivery.

Phase 2C2C must not begin by enabling email Cron or public recipient controls. Those actions require separate authorization and production verification.
