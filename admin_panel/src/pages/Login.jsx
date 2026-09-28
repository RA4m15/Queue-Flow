import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, Mail, AlertCircle, ArrowRight, Eye, EyeOff, ShieldCheck, Activity, Cpu, Layers } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const queryParams = new URLSearchParams(location.search);
  const isExpired = queryParams.get('expired') === '1';
  const isUnauthorized = queryParams.get('unauthorized') === '1';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    if (!email || !password) {
      setLocalError('Please enter both email and password');
      return;
    }

    setSubmitting(true);
    try {
      const userData = await login(email, password);
      if (userData?.role === 'STAFF') {
        navigate('/operator');
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      setLocalError(err.message || 'Login failed. Please verify credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0A0B05',
        backgroundImage: 'radial-gradient(circle at 10% 20%, #1A1D0B 0%, #0A0B05 60%, #040502 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background radial ambient lights */}
      <div
        style={{
          position: 'absolute',
          top: '-15%',
          left: '-10%',
          width: '600px',
          height: '600px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255, 230, 0, 0.14) 0%, rgba(10, 11, 5, 0) 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-15%',
          right: '-10%',
          width: '650px',
          height: '650px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255, 241, 118, 0.08) 0%, rgba(10, 11, 5, 0) 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Main Container */}
      <div
        style={{
          width: '100%',
          maxWidth: '1080px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '40px',
          alignItems: 'center',
          position: 'relative',
          zIndex: 10,
        }}
      >
        {/* Left Side: Brand & Visual Statement */}
        <div style={{ padding: '20px' }}>
          {/* Logo Badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '10px',
              padding: '6px 14px',
              borderRadius: '9999px',
              background: 'rgba(255, 230, 0, 0.12)',
              border: '1px solid rgba(255, 230, 0, 0.3)',
              marginBottom: '24px',
            }}
          >
            <span className="pulsing-dot">
              <span className="pulsing-dot-ping" style={{ backgroundColor: '#FFE600' }} />
              <span className="pulsing-dot-core" style={{ backgroundColor: '#FFE600' }} />
            </span>
            <span
              className="mono"
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: '#FFE600',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Command Console v1.0
            </span>
          </div>

          <h1
            style={{
              fontSize: 'clamp(32px, 4.5vw, 48px)',
              fontWeight: 800,
              color: '#FEFCE8',
              letterSpacing: '-0.03em',
              lineHeight: 1.15,
              marginBottom: '16px',
            }}
          >
            Intelligent Queue <br />
            <span
              style={{
                background: 'linear-gradient(135deg, #FFE600 0%, #FFB300 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              Operations & Telemetry
            </span>
          </h1>

          <p
            style={{
              fontSize: '15px',
              color: '#D4D4D8',
              lineHeight: 1.6,
              maxWidth: '440px',
              marginBottom: '32px',
            }}
          >
            Real-time multi-counter management, IoT footfall crowd tracking, and smart token routing in a centralized operational command center.
          </p>

          {/* Feature Highlights Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: '14px',
                background: 'rgba(22, 25, 12, 0.75)',
                border: '1px solid var(--border-subtle)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#FFE600', marginBottom: '6px' }}>
                <Activity size={16} />
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700 }}>Real-Time Synchronization</span>
              </div>
              <p style={{ fontSize: '11px', color: '#A1A1AA', lineHeight: 1.4 }}>
                Sub-millisecond token lifecycle updates via Redis Socket.IO adapter.
              </p>
            </div>

            <div
              style={{
                padding: '14px 16px',
                borderRadius: '14px',
                background: 'rgba(22, 25, 12, 0.75)',
                border: '1px solid var(--border-subtle)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#FFF176', marginBottom: '6px' }}>
                <Cpu size={16} />
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700 }}>IoT Crowd Sensors</span>
              </div>
              <p style={{ fontSize: '11px', color: '#A1A1AA', lineHeight: 1.4 }}>
                Automated optical turnstile and sensor telemetry integration.
              </p>
            </div>
          </div>
        </div>

        {/* Right Side: Login Card */}
        <div>
          <div
            className="q-card-glow"
            style={{
              padding: '40px 36px',
              borderRadius: '24px',
              boxShadow: 'var(--shadow-lg), var(--shadow-glow-lemon)',
              position: 'relative',
            }}
          >
            {/* Header */}
            <div style={{ marginBottom: '28px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <div
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #FFE600 0%, #FFB300 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0A0B05',
                  }}
                >
                  <ShieldCheck size={18} />
                </div>
                <div>
                  <h2 style={{ fontSize: '20px', fontWeight: 800, color: '#FEFCE8', letterSpacing: '-0.02em' }}>
                    Operator Sign In
                  </h2>
                  <p style={{ fontSize: '12px', color: '#64748B' }}>
                    Staff and Administrator credentials required
                  </p>
                </div>
              </div>
            </div>

            {/* Notices */}
            {isExpired && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  borderRadius: '12px',
                  marginBottom: '18px',
                  fontSize: '12px',
                  color: '#FBBF24',
                }}
              >
                Your session has expired. Please authenticate again.
              </div>
            )}

            {isUnauthorized && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  marginBottom: '18px',
                  fontSize: '12px',
                  color: '#F87171',
                }}
              >
                Access denied. Customer accounts cannot access the admin console.
              </div>
            )}

            {localError && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 14px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  marginBottom: '18px',
                  fontSize: '12px',
                  color: '#F87171',
                }}
              >
                <AlertCircle size={16} style={{ flexShrink: 0 }} />
                <span>{localError}</span>
              </div>
            )}

            {/* Login Form */}
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '18px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#94A3B8',
                    marginBottom: '6px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Operator Email
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <Mail size={16} style={{ position: 'absolute', left: '14px', color: '#64748B' }} />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter email address"
                    style={{
                      width: '100%',
                      padding: '12px 14px 12px 42px',
                      borderRadius: '12px',
                      fontSize: '14px',
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '26px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#94A3B8',
                    marginBottom: '6px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Secure Password
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <Lock size={16} style={{ position: 'absolute', left: '14px', color: '#64748B' }} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    style={{
                      width: '100%',
                      padding: '12px 42px 12px 42px',
                      borderRadius: '12px',
                      fontSize: '14px',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    style={{
                      position: 'absolute',
                      right: '12px',
                      background: 'none',
                      border: 'none',
                      color: '#64748B',
                      cursor: 'pointer',
                      padding: '4px',
                    }}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="btn-primary"
                style={{
                  width: '100%',
                  padding: '14px',
                  fontSize: '14px',
                  borderRadius: '12px',
                }}
              >
                {submitting ? 'Authenticating...' : 'Sign In to Command Console'}
                {!submitting && <ArrowRight size={16} />}
              </button>
            </form>

            <div style={{ marginTop: '22px', textAlign: 'center' }}>
              <p style={{ fontSize: '11px', color: '#475569' }}>
                Protected by QueueFlow Zero-Trust Session Architecture
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
