import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * 应用骨架屏：在后台校验登录态期间占位。
 * 让用户立刻看到页面结构，替代整屏「加载中…」的空窗等待（跨机房一次往返约 0.7s）。
 */
const AppSkeleton: React.FC = () => (
  <div className="min-h-screen flex bg-gray-50 dark:bg-gray-900">
    {/* 左侧栏占位 */}
    <aside className="hidden md:flex w-64 shrink-0 flex-col gap-3 border-r border-gray-200 dark:border-gray-800 p-4">
      <div className="h-8 w-32 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
      <div className="h-9 w-full rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-6 w-full rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
      ))}
    </aside>

    {/* 主区域占位 */}
    <main className="flex-1 flex flex-col min-w-0">
      <div className="h-14 shrink-0 flex items-center gap-3 border-b border-gray-200 dark:border-gray-800 px-4">
        <div className="h-6 w-24 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
        <div className="ml-auto h-8 w-28 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
      </div>
      <div className="flex-1 p-6 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 w-full rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
        ))}
      </div>
    </main>
  </div>
);

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isLoading } = useAuth();
  if (isLoading) return <AppSkeleton />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

export default ProtectedRoute;