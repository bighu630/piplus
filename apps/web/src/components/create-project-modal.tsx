'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (params: { name: string; path: string; repoUrl: string }) => Promise<unknown>;
  busy?: boolean;
  error?: string | null;
};

export function CreateProjectModal({ open, onClose, onSubmit, busy, error }: Props) {
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const isGitClone = Boolean(repoUrl.trim());
  const defaultName = isGitClone ? (repoUrl.split('/').pop()?.replace('.git', '') ?? '') : '';

  async function handleSubmit() {
    const finalName = name.trim() || defaultName || 'untitled';
    await onSubmit({ name: finalName, path: path.trim(), repoUrl: repoUrl.trim() });
    setName('');
    setPath('');
    setRepoUrl('');
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999]">
      <button
        aria-label="关闭弹窗"
        className="absolute inset-0 border-none bg-[rgba(8,9,10,0.52)] backdrop-blur-[14px] backdrop-saturate-125"
        onMouseDown={onClose}
        type="button"
      />
      <div className="pointer-events-none relative z-[10000] flex h-full w-full items-center justify-center p-4">
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="relative w-full max-w-[440px] rounded-[30px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(24,31,42,0.9),rgba(16,20,27,0.84))] p-6 shadow-[var(--shadow-panel)] backdrop-blur-xl"
          style={{ pointerEvents: 'auto' }}
        >
          <button className="absolute right-4 top-4 text-[var(--text-dim)] transition-colors hover:text-[var(--text)]" onClick={onClose} type="button">
            <X size={18} />
          </button>
          <h2 className="text-lg font-semibold text-[var(--text)]">新建项目</h2>
          <p className="mt-1 text-sm text-[var(--text-dim)]">创建后会自动生成 Planner 会话</p>

          <div className="mt-5 space-y-4">
            <div>
              <label className="text-xs text-[var(--text-dim)]">项目名称（可选）</label>
              <input
                className="shell-input mt-1"
                placeholder={defaultName || '我的项目'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-dim)]">项目目录路径（必填）</label>
              <input
                className="shell-input mt-1"
                placeholder="/path/to/project"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-dim)]">GitHub 地址（可选）</label>
              <input
                className="shell-input mt-1"
                placeholder="https://github.com/user/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              />
              {isGitClone ? <p className="mt-1 text-[10px] text-[var(--text-dim)] pl-1">将自动 clone 到 ~/projects/{defaultName}</p> : null}
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-[18px] border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
          ) : null}

          <div className="mt-6 flex justify-end">
            <button
              className="primary-button primary-button-icon"
              disabled={busy || !path.trim()}
              onClick={() => void handleSubmit()}
              type="button"
            >
              <Plus size={15} />
              <span>{busy ? '创建中…' : '创建项目'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
