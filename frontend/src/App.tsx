import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppProvider } from './contexts/AppContext';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import PageLoader from './components/PageLoader';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const AIModelsPage = lazy(() => import('./pages/settings/AIModelsPage'));
const AIAssistantsPage = lazy(() => import('./pages/settings/AIAssistantsPage'));
const AISkillsPage = lazy(() => import('./pages/settings/AISkillsPage'));
const ASRSettingsPage = lazy(() => import('./pages/settings/ASRSettingsPage'));
const CommonTermsPage = lazy(() => import('./pages/settings/CommonTermsPage'));
const UsersPage = lazy(() => import('./pages/settings/UsersPage'));
const GuestEventsPage = lazy(() => import('./pages/settings/GuestEventsPage'));
const SyncSettingsPage = lazy(() => import('./pages/settings/SyncSettingsPage'));
const OfflineSettingsPage = lazy(() => import('./pages/settings/OfflineSettingsPage'));
const ApiTokensPage = lazy(() => import('./pages/settings/ApiTokensPage'));
const McpSettingsPage = lazy(() => import('./pages/settings/McpSettingsPage'));
const PublicNotePage = lazy(() => import('./pages/PublicNotePage'));
const ShareTargetPage = lazy(() => import('./pages/ShareTargetPage'));

/** 动态 import 的模块类型 */
type LazyModule<P> = () => Promise<{ default: React.ComponentType<P> }>;

/**
 * 将「布局 + 页面」合并为单个懒加载边界。
 * 嵌套 React.lazy 时，React 必须先拿到布局 chunk 才能渲染其子节点，导致两个 chunk 串行下载；
 * 这里用 Promise.all 并行拉取，减少一次串行网络往返（跨机房约 0.7s）。
 * @param layout 外层布局组件（需接受 children）
 * @param page 内层页面组件
 */
const lazyComposed = (
  layout: LazyModule<{ children: React.ReactNode }>,
  page: LazyModule<Record<string, never>>,
) =>
  lazy(() =>
    Promise.all([layout(), page()]).then(([layoutModule, pageModule]) => {
      const Layout = layoutModule.default;
      const Page = pageModule.default;
      const Composed: React.FC = () => (
        <Layout>
          <Page />
        </Layout>
      );
      return { default: Composed };
    }),
  );

// 布局与页面并行下载，避免嵌套懒加载造成的 chunk 串行
const NotesRoute = lazyComposed(
  () => import('./components/AppLayout'),
  () => import('./pages/NotesPage'),
);
const SettingsRoute = lazyComposed(
  () => import('./components/AppLayout'),
  () => import('./pages/settings/SettingsLayout'),
);

const withSuspense = (node: React.ReactNode) => (
  <Suspense fallback={<PageLoader />}>{node}</Suspense>
);

/**
 * 设置首页重定向：默认进「模型」。
 * 匿名账号同样可用 AI 模型（只能用自己创建的），无需特殊处理。
 */
const SettingsIndexRedirect: React.FC = () => <Navigate to="models" replace />;

/**
 * 匿名账号禁用的设置子路由守卫：直连 URL 时统一退回「模型」。
 * 覆盖本地同步 / 访问令牌 / 语音转写 / 常用词库——与后端 require_not_guest 呼应，
 * 避免前端先渲染再报 403。
 */
const GuestDisabledRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isGuest, isLoading } = useAuth();
  if (isLoading) return null;
  if (isGuest) return <Navigate to="/settings/models" replace />;
  return <>{children}</>;
};

const basename = (import.meta.env.VITE_BASE_PATH || '/').replace(/\/$/, '') || undefined;

const App: React.FC = () => (
  <BrowserRouter basename={basename}>
    <AuthProvider>
      <AppProvider>
        <Toaster position="top-center" />
        <Routes>
          <Route path="/login" element={withSuspense(<LoginPage />)} />
          <Route path="/register" element={withSuspense(<RegisterPage />)} />
          <Route path="/p/:token" element={withSuspense(<PublicNotePage />)} />
          <Route
            path="/"
            element={<ProtectedRoute>{withSuspense(<NotesRoute />)}</ProtectedRoute>}
          />
          <Route
            path="/note/:noteId"
            element={<ProtectedRoute>{withSuspense(<NotesRoute />)}</ProtectedRoute>}
          />
          <Route
            path="/share"
            element={<ProtectedRoute>{withSuspense(<ShareTargetPage />)}</ProtectedRoute>}
          />
          <Route
            path="/settings"
            element={<ProtectedRoute>{withSuspense(<SettingsRoute />)}</ProtectedRoute>}
          >
            <Route index element={<SettingsIndexRedirect />} />
            {/* 模型 / 助手 / 技能：匿名可用（后端按归属只返回自己创建的行） */}
            <Route path="models" element={withSuspense(<AIModelsPage />)} />
            <Route path="assistants" element={withSuspense(<AIAssistantsPage />)} />
            <Route path="skills" element={withSuspense(<AISkillsPage />)} />
            {/* 以下四项匿名禁用：全局配置或会把数据带出系统 */}
            <Route path="asr" element={<GuestDisabledRoute>{withSuspense(<ASRSettingsPage />)}</GuestDisabledRoute>} />
            <Route path="common-terms" element={<GuestDisabledRoute>{withSuspense(<CommonTermsPage />)}</GuestDisabledRoute>} />
            <Route path="sync" element={<GuestDisabledRoute>{withSuspense(<SyncSettingsPage />)}</GuestDisabledRoute>} />
            <Route path="offline" element={withSuspense(<OfflineSettingsPage />)} />
            <Route path="tokens" element={<GuestDisabledRoute>{withSuspense(<ApiTokensPage />)}</GuestDisabledRoute>} />
            <Route path="mcp" element={<GuestDisabledRoute>{withSuspense(<McpSettingsPage />)}</GuestDisabledRoute>} />
            <Route
              path="users"
              element={
                <AdminRoute redirectTo="/settings/models">
                  {withSuspense(<UsersPage />)}
                </AdminRoute>
              }
            />
            <Route
              path="guest-events"
              element={
                <AdminRoute redirectTo="/settings/models">
                  {withSuspense(<GuestEventsPage />)}
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