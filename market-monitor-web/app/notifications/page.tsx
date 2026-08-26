import NotificationCenter from '../components/NotificationCenter';
import NotificationShell from '../components/NotificationShell';
import ProtectedPage from '../components/ProtectedPage';

export default function NotificationsPage() {
  return (
    <ProtectedPage action="in_app_notification_list">
      <NotificationShell><NotificationCenter /></NotificationShell>
    </ProtectedPage>
  );
}
