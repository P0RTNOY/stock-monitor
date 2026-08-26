import NotificationEvidenceDetail from '../../components/NotificationEvidenceDetail';
import NotificationShell from '../../components/NotificationShell';

type Props = { params: Promise<{ id: string }> | { id: string } };

export default async function NotificationDetailPage({ params }: Props) {
  return <NotificationShell detail><NotificationEvidenceDetail id={(await params).id} /></NotificationShell>;
}
