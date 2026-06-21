'use client';
import { AnimatedContainer } from './ui/animated';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

type Props = {
  busy?: boolean;
  error?: string | null;
  onSubmit: (password: string) => void | Promise<void>;
};

export function LoginScreen({ busy = false, error = null, onSubmit }: Props) {
  const [password, setPassword] = useState('');

  async function handleSubmit() {
    if (!password) return;
    await onSubmit(password);
  }

  return (
    <main className="workspace-shell min-h-screen">
      <AnimatedContainer delay={0.1}>
      <div className="mx-auto flex min-h-screen max-w-[1280px] items-center justify-center px-4 py-6">
        <section className="w-full max-w-[480px] rounded-[30px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(24,31,42,0.82),rgba(16,20,27,0.8))] p-6 shadow-[var(--shadow-panel)] backdrop-blur-xl">
          <p className="workspace-eyebrow">piplus</p>
          <h1 className="mt-3 text-[2rem] font-semibold tracking-[-0.05em] text-[var(--text)]">Local Login</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">输入本地密码进入工作台。</p>

          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-2 text-[var(--text-dim)]">
                <KeyRound size={14} strokeWidth={2} />
                Password
              </span>
              <input className="shell-input" disabled={busy} onChange={(event) => setPassword(event.target.value)} type="password" value={password}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleSubmit(); }} />
            </label>
          </div>

          {error ? <div className="mt-4 rounded-[18px] border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div> : null}

          <div className="mt-6 flex justify-end">
            <button className="primary-button primary-button-icon" disabled={busy} onClick={() => void handleSubmit()} type="button">
              <span>{busy ? '登录中…' : '登录'}</span>
            </button>
          </div>
        </section>
      </div>
    </AnimatedContainer>
    </main>
  );
}
