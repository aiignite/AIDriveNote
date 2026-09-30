/**
 * 应用入口。
 * 同时负责注册 Service Worker，为应用壳提供离线缓存能力。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { registerServiceWorker } from './services/offline/swRegister';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 离线能力：注册 Service Worker 缓存应用壳。
// 非 HTTPS、浏览器禁用或开发模式下会自动跳过，不影响在线使用。
void registerServiceWorker();
