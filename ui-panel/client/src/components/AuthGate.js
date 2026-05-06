import React, { useState, useEffect } from 'react';
import { Input, Button, Card, Layout, message } from 'antd';
import { CloudServerOutlined, LockOutlined } from '@ant-design/icons';

const { Header, Content } = Layout;
const AUTH_TOKEN_KEY = 'hyperpod_auth_token';

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

export default function AuthGate({ children }) {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState('');

  const verify = async (t) => {
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      const data = await res.json();
      if (data.valid) {
        if (!data.authDisabled) localStorage.setItem(AUTH_TOKEN_KEY, t);
        setAuthed(true);
      }
      return data.valid;
    } catch { return false; }
  };

  useEffect(() => {
    const saved = localStorage.getItem(AUTH_TOKEN_KEY);
    const initial = saved || '';
    verify(initial).finally(() => setLoading(false));
  }, []);

  const handleSubmit = async () => {
    if (!token.trim() || submitting) return;
    setSubmitting(true);
    const ok = await verify(token.trim());
    setSubmitting(false);
    if (!ok) message.error('Invalid access key');
  };

  if (loading) return null;
  if (authed) return children;

  return (
    <Layout className="app-layout">
      <Header
        className="theme-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
        }}
      >
        <h1 className="theme-header-title">
          <CloudServerOutlined style={{ marginRight: '8px' }} />
          HyperPod InstantStart
          <span className="theme-header-subtitle">Unified Platform</span>
        </h1>
      </Header>
      <Content
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: 'calc(100vh - 64px)',
          background: 'var(--theme-gray50)',
          padding: '16px',
        }}
      >
        <Card
          className="theme-card"
          style={{ width: 400, textAlign: 'center' }}
          bodyStyle={{ padding: '32px 28px' }}
        >
          <LockOutlined
            style={{
              fontSize: 40,
              color: 'var(--theme-primary)',
              marginBottom: 16,
            }}
          />
          <h2
            style={{
              marginBottom: 8,
              color: 'var(--theme-gray900)',
              fontWeight: 600,
            }}
          >
            Sign In
          </h2>
          <div
            style={{
              marginBottom: 24,
              color: 'var(--theme-gray600)',
              fontSize: 13,
            }}
          >
            Enter your access key to continue
          </div>
          <Input.Password
            size="large"
            placeholder="Access key"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onPressEnter={handleSubmit}
            style={{ marginBottom: 16 }}
            autoFocus
          />
          <Button
            type="primary"
            size="large"
            block
            loading={submitting}
            onClick={handleSubmit}
          >
            Sign In
          </Button>
        </Card>
      </Content>
    </Layout>
  );
}
