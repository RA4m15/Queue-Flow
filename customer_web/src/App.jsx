import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';

import { LandingPage } from './pages/LandingPage';
import { CentersPage } from './pages/CentersPage';
import { CenterServicesPage } from './pages/CenterServicesPage';
import { QueuePreviewPage } from './pages/QueuePreviewPage';
import { TokenDetailPage } from './pages/TokenDetailPage';
import { MyTokensPage } from './pages/MyTokensPage';
import { JoinQrPage } from './pages/JoinQrPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { QueueDisplayPage } from './pages/QueueDisplayPage';

function App() {
  return (
    <AuthProvider>
      <div className="app-container">
        <Navbar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/centers" element={<CentersPage />} />
            <Route path="/center/:id" element={<CenterServicesPage />} />
            <Route path="/queue/preview" element={<QueuePreviewPage />} />
            <Route path="/token/:id" element={<TokenDetailPage />} />
            <Route path="/my-tokens" element={<MyTokensPage />} />
            <Route path="/my-token" element={<Navigate to="/my-tokens" replace />} />
            <Route path="/join" element={<JoinQrPage />} />
            <Route path="/display" element={<QueueDisplayPage />} />
            <Route path="/display/:centerId" element={<QueueDisplayPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </AuthProvider>
  );
}

export default App;
