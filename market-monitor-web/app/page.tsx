import MarketWorkspace from './components/MarketWorkspace';
import ProtectedPage from './components/ProtectedPage';

export default function Home() {
  return <ProtectedPage action="workspace_read"><MarketWorkspace /></ProtectedPage>;
}
