import { KeyRound } from 'lucide-react';
import { useState } from 'react';

type Props = {
  busy?: boolean;
  error?: string | null;
  modelStatus?: { ok: boolean; count: number } | null;
  onSubmit: (password: string) => void;
};

export function LoginScreen({ busy = false, error = null, modelStatus = null, onSubmit }: Props) {
  const [password, setPassword] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-5">
        <div>
          <div className="bg-blue-600 text-white font-black px-2 py-1 rounded text-sm tracking-widest inline-block">
            Pi
          </div>
          <h1 className="mt-3 text-xl font-bold text-slate-800 dark:text-slate-100">
            Piplus
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            输入本地密码进入工作台
          </p>
        </div>

        <label className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            <KeyRound className="w-3.5 h-3.5" />
            密码
          </span>
          <input
            className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit(password);
            }}
            type="password"
            value={password}
            placeholder="输入本地密码"
            autoFocus
          />
        </label>

        {error ? (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
            {error}
          </div>
        ) : null}

        {modelStatus && !modelStatus.ok ? (
          <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2 leading-relaxed">
            当前未检测到可用模型，登录后可能无法正常使用 Agent。请先检查 PI SDK 的模型配置 / API key，登录后可直接添加模型。
          </div>
        ) : null}

        {modelStatus && modelStatus.ok ? (
          <div className="text-[11px] text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2">
            已检测到 {modelStatus.count} 个可用模型。
          </div>
        ) : null}

        <button
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
          disabled={busy || !password}
          onClick={() => onSubmit(password)}
          type="button"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </div>
    </div>
  );
}
