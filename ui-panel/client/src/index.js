import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './index.css';

// 把 REACT_APP_UI_ZOOM (user.env) 注入成 CSS 变量 --zoom-factor。
// index.css 的 body { zoom: var(--zoom-factor) } 会据此缩放；组件里的
// calc(X / var(--zoom-factor)) 也用这个值把 vh/vw 校正回物理视口。
(function applyUiZoom() {
  const zoom = (process.env.REACT_APP_UI_ZOOM || '').trim();
  if (zoom && !Number.isNaN(Number(zoom))) {
    document.documentElement.style.setProperty('--zoom-factor', zoom);
  }
})();

// Ant Design 主题配置
const theme = {
  token: {
    colorPrimary: '#1890ff',
    borderRadius: 6,
    fontSize: 14,
  },
  components: {
    Card: {
      headerBg: '#fafafa',
    },
    Table: {
      headerBg: '#fafafa',
    },
  },
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfigProvider theme={theme}>
        <App />
      </ConfigProvider>
    </Provider>
  </React.StrictMode>
);
