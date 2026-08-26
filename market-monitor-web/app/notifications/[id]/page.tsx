import NotificationEvidenceDetail from '../../components/NotificationEvidenceDetail';
import NotificationShell from '../../components/NotificationShell';
import ProtectedPage from '../../components/ProtectedPage';

type Props = { params: Promise<{ id: string }> | { id: string } };

export default async function NotificationDetailPage({ params }: Props) {
  return (
    <ProtectedPage action="in_app_notification_read">
      <NotificationShell detail><NotificationEvidenceDetail id={(await params).id} /></NotificationShell>
    </ProtectedPage>
  );
}
