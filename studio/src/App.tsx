import { useEffect, useState } from 'react';
import { BookOpenText, WarningCircle } from '@phosphor-icons/react';
import canvasShot from './assets/studio-canvas.png';
import { ApiError, get, post, setUnauthorizedHandler } from './api';
import { Console } from './Console';
import { ConfirmProvider, Loading, Spinner, ToastProvider } from './components/ui';
import type { Instance } from './types';

export function App() {
  // Whether this browser has a Studio session (an HttpOnly cookie, so ask the server); null while checking.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSignedIn(false);
      setInstance(null);
    });
    get('/api/session')
      .then(() => setSignedIn(true))
      .catch((e: ApiError) => {
        if (e.status === 401) setSignedIn(false);
        else setError(e.message);
      });
  }, []);

  const loadInstance = () =>
    get<Instance>('/api/instance')
      .then((i) => {
        setInstance(i);
        setError(null);
      })
      .catch((e: ApiError) => {
        if (e.status !== 401) setError(e.message);
      });

  useEffect(() => {
    if (!signedIn) return;
    void loadInstance();
  }, [signedIn]);

  const signOut = () => {
    // Ends the session on the server, which also clears the cookie.
    void post('/api/logout').catch(() => {});
    setSignedIn(false);
    setInstance(null);
  };

  return (
    <ToastProvider>
      <ConfirmProvider>
        {error ? (
          <div className="login">
            <div className="card" style={{ padding: 24, maxWidth: 420 }}>
              <div className="logo" style={{ marginBottom: 12 }}>
                keel<span>.</span>
              </div>
              <p className="notice err" style={{ margin: 0 }}>
                <WarningCircle size={15} /> {error}
              </p>
              <button className="pill md" style={{ marginTop: 14 }} onClick={() => window.location.reload()}>
                Retry
              </button>
            </div>
          </div>
        ) : signedIn === false ? (
          <Login onDone={() => setSignedIn(true)} />
        ) : !instance ? (
          <div className="login">
            <Loading label="Opening Studio…" />
          </div>
        ) : (
          <Console instance={instance} onSignOut={signOut} onInstanceChange={loadInstance} />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/login', { username, password, ...(needCode ? { code } : {}) });
      onDone();
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'mfa_required') {
        setNeedCode(true);
      } else {
        if (e.code === 'invalid_code') setCode('');
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login login-split">
      <section className="login-brand" aria-label="About Keel">
        <div className="logo" translate="no">
          keel<span>.</span>
        </div>
        <div className="login-pitch">
          <h2>Your backend, on your own server.</h2>
          <p>Postgres, auth, storage, realtime and edge functions for your apps. Studio is where you run it all.</p>
        </div>
        <figure className="login-shot">
          <img src={canvasShot} width={1600} height={1000} alt="Keel Studio showing a project's tables on the schema canvas" />
        </figure>
        <a className="login-docs" href="/docs/" target="_blank" rel="noopener">
          <BookOpenText size={15} /> Documentation
        </a>
      </section>

      <section className="login-main">
        <form className="login-card" onSubmit={submit} noValidate={false}>
          <div className="logo login-card-logo" translate="no">
            keel<span>.</span>
          </div>
          <div>
            <h1>{needCode ? 'Two-factor authentication' : 'Sign in to Studio'}</h1>
            <div className="muted">{needCode ? 'Enter the 6-digit code from your authenticator app.' : 'Use your Studio account.'}</div>
          </div>
          {!needCode ? (
            <>
              <label className="field">
                <span>Username</span>
                <input
                  className="input"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  className="input"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  required
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Code</span>
              <input
                className="input mono"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
                required
              />
            </label>
          )}
          {error && (
            <div className="notice err" role="alert">
              <WarningCircle size={15} />
              {error}
            </div>
          )}
          <button className="btn-dark lg" type="submit" disabled={busy || (needCode && code.length !== 6)}>
            {busy && <Spinner size={15} />}
            {needCode ? 'Verify' : 'Sign in'}
          </button>
          {needCode ? (
            <button
              type="button"
              className="pill md"
              onClick={() => {
                setNeedCode(false);
                setCode('');
                setError(null);
              }}
            >
              Back
            </button>
          ) : (
            <p className="login-help">
              Forgot your password? Set <code translate="no">KEEL_DASHBOARD_PASSWORD</code> in .env and restart Studio.{' '}
              <a href="/docs/studio/accounts#locked-out" target="_blank" rel="noopener">
                More help
              </a>
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
