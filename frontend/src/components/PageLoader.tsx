import React from 'react';

const PageLoader: React.FC = () => (
  <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
    <div className="animate-spin rounded-full h-9 w-9 border-2 border-orange-500 border-t-transparent" />
    <span className="text-sm">加载中…</span>
  </div>
);

export default PageLoader;
