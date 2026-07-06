import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import { AppProvider } from './contexts/AppContext';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import PageLoader from './components/PageLoader';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const AppLayout = lazy(() => import('./components/AppLayout'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const SettingsLayout = lazy(() => import('./pages/settings/SettingsLayout'));
const AIModelsPage = lazy(() => import('./pages/settings/AIModelsPage'));
const AIAssistantsPage = lazy(() => import('./pages/settings/AIAssistantsPage'));
const AISkillsPage = lazy(() => import('./pages/settings/AISkillsPage'));
const UsersPage = lazy(() => import('./pages/settings/UsersPage'));

const withSuspense = (node: React.ReactNode) => (
  <Suspense fallback={<PageLoader />}>{node}</Suspense>
);

const basename = (import.meta.env.VITE_BASE_PATH || '/').replace(/\/$/, '') || undefined;

const App: React.FC = () => (
  <BrowserRouter basename={basename}>
    <AuthProvider>
      <AppProvider>
        <Toaster position="top-center" />
        <Routes>
          <Route path="/login" element={withSuspense(<LoginPage />)} />
          <Route path="/register" element={withSuspense(<RegisterPage />)} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                {withSuspense(
                  <AppLayout>
                    <NotesPage />
                  </AppLayout>,
                )}
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                {withSuspense(
                  <AppLayout>
                    <SettingsLayout />
                  </AppLayout>,
                )}
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="models" replace />} />
            <Route path="models" element={withSuspense(<AIModelsPage />)} />
            <Route path="assistants" element={withSuspense(<AIAssistantsPage />)} />
            <Route path="skills" element={withSuspense(<AISkillsPage />)} />
            <Route
              path="users"
              element={
                <AdminRoute redirectTo="/settings/models">
                  {withSuspense(<UsersPage />)}
                </AdminRoute>
              }
            />
          </Route>
          {/* 兼容旧路径 */}
          <Route path="/settings/ai/models" element={<Navigate to="/settings/models" replace />} />
          <Route path="/settings/ai/assistants" element={<Navigate to="/settings/assistants" replace />} />
          <Route path="/settings/ai/skills" element={<Navigate to="/settings/skills" replace />} />
          <Route path="/settings/ai" element={<Navigate to="/settings/models" replace />} />
          <Route path="/admin/users" element={<Navigate to="/settings/users" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
