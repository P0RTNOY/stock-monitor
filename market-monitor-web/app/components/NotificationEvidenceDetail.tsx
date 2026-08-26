'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { IN_APP_CATEGORY_LABELS, isClientNotification, notificationTimestamp, type ClientNotification } from '../lib/in-app-notifications';

type Evidence = {
  forecast: { direction: string; confidence: number; targetKind: string; targetPrice: number | null; targetLower: number | null; targetUpper: number | null; invalidationPrice: number | null; activatedAt: string | null; activationPrice: number | null; activationCurrency: string | null; currentStatus: string };
  evaluation: { resultKind: string; reasonCode: string; evaluatedThrough: string | null; evaluationCutoff: string; evaluatorVersion: string; rulesetVersion: string };
  review: { kind: string; acknowledgedAt: string | null };
};

export default function NotificationEvidenceDetail({ id }: { id: string }) {
  const [entry, setEntry] = useState<ClientNotification | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evidenceAvailable, setEvidenceAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/notifications/${id}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => ({ response, value: await response.json() as unknown }))
      .then(({ response, value }) => {
        const payload = value && typeof value === 'object'
          ? value as { entry?: unknown; evidence?: unknown; evidenceAvailable?: unknown } : null;
        const candidate = payload?.entry;
        if (!response.ok || !isClientNotification(candidate)) throw new Error('unavailable');
        setEntry(candidate);
        setEvidenceAvailable(payload?.evidenceAvailable === true);
        setEvidence(payload?.evidence && typeof payload.evidence === 'object' ? payload.evidence as Evidence : null);
      }).catch((reason) => {
        if ((reason as { name?: string }).name !== 'AbortError') setError('This notification or its frozen evidence is unavailable.');
      });
    return () => controller.abort();
  }, [id]);

  if (error) return <div className="notification-message error" role="alert"><p>{error}</p><Link href="/notifications">Return to the Notification Center</Link></div>;
  if (!entry) return <div className="notification-message" role="status">Loading notification evidence…</div>;

  return <article className="notification-evidence">
    <section><p className="section-label">Forecast outcome</p><div className="notification-evidence-heading"><div><span>{entry.symbol}</span><h2>{entry.presentation.title}</h2></div><b>{IN_APP_CATEGORY_LABELS[entry.category]}</b></div>
      <p>{entry.presentation.summary}</p><time dateTime={entry.occurredAt}>{notificationTimestamp(entry.occurredAt)}</time></section>
    <section><p className="section-label">Frozen evaluation evidence</p><h2>Evidence captured from the trusted intent</h2>
      <ul>{entry.presentation.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
      <dl><div><dt>Forecast</dt><dd>#{entry.presentation.evidence.forecastId}</dd></div>
        <div><dt>Evaluation run</dt><dd>#{entry.presentation.evidence.evaluationRunId}</dd></div>
        <div><dt>Review item</dt><dd>#{entry.presentation.evidence.reviewItemId}</dd></div>
        <div><dt>Analysis snapshot</dt><dd>{entry.presentation.evidence.analysisSnapshotId ? `#${entry.presentation.evidence.analysisSnapshotId}` : 'Not linked'}</dd></div></dl>
      <p className="notification-evidence-note">Opening evidence does not change notification read state or review acknowledgement.</p></section>
    <section><p className="section-label">Exact linked records</p><h2>Forecast, evaluation, and review state</h2>
      {!evidenceAvailable || !evidence ? <p>Linked evidence is unavailable. Northstar will not substitute a newer evaluation.</p> : <>
        <dl><div><dt>Forecast direction</dt><dd>{evidence.forecast.direction}</dd></div>
          <div><dt>Confidence</dt><dd>{evidence.forecast.confidence}%</dd></div>
          <div><dt>Evaluation result</dt><dd>{evidence.evaluation.resultKind}</dd></div>
          <div><dt>Review</dt><dd>{evidence.review.acknowledgedAt ? 'Acknowledged' : evidence.review.kind === 'needs_review' ? 'Required' : 'Open'}</dd></div></dl>
        <ul><li>Evaluation cutoff: {evidence.evaluation.evaluationCutoff}</li>
          <li>Evaluated through: {evidence.evaluation.evaluatedThrough ?? 'Not available'}</li>
          <li>Evaluator: {evidence.evaluation.evaluatorVersion}</li><li>Ruleset: {evidence.evaluation.rulesetVersion}</li></ul>
        <p className="notification-evidence-note">Current forecast status: {evidence.forecast.currentStatus}. This live status is shown separately from the frozen notification snapshot.</p>
      </>}
    </section>
    <section><p className="section-label">Channel state</p><h2>Email delivery is separate</h2><p className={`email-evidence ${entry.email.tone}`}>{entry.email.label}</p>
      <p className="notification-evidence-note">Provider acceptance or mail-server delivery is not evidence that a person read an email. Email status never controls in-app visibility.</p></section>
  </article>;
}
