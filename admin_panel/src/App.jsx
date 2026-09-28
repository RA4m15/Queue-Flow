import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import ProtectedRoute from './components/common/ProtectedRoute';
import Navbar from './components/layout/Navbar';
import Sidebar from './components/layout/Sidebar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Analytics from './pages/Analytics';
import Alerts from './pages/Alerts';
import CounterDisplay from './pages/CounterDisplay';
import Services from './pages/Services';
import OperatorPortal from './pages/OperatorPortal';
import ResourceHub from './pages/ResourceHub';
import { useAuth } from './context/AuthContext';

function RootRedirect() {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated || !user) return <Navigate to="/login" replace />;
  return user.role === 'STAFF' ? <Navigate to="/operator" replace /> : <Navigate to="/dashboard" replace />;
}

function AdminLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    // Sidebar is position:fixed (overlay) — it does NOT occupy layout space.
    // Content wrapper is always full-width; sidebar slides over it.
    <div style={{ minHeight: '100vh', width: '100%', background: 'var(--bg-app)' }}>
      {/* Sidebar Navigation — fixed overlay, out of normal flow */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main Content Area — always 100% wide */}
      <div
        style={{
          width: '100%',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Navbar onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
        <main style={{ flex: 1, paddingBottom: '32px' }}>{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <Routes>
            {/* Public Auth Route */}
            <Route path="/login" element={<Login />} />

            {/* Standalone Fullscreen Counter Display Board (for TV / monitors) */}
            <Route path="/counter/:id" element={<CounterDisplay />} />

            {/* Protected Admin Routes */}
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <Dashboard />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            <Route
              path="/analytics"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <Analytics />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            <Route
              path="/alerts"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <Alerts />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            <Route
              path="/services"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <Services />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            <Route
              path="/resource-hub"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <ResourceHub />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            <Route
              path="/operator"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <OperatorPortal />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />

            {/* Default Catch-all */}
            <Route path="/" element={<RootRedirect />} />
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
