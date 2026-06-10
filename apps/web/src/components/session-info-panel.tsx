'use client';

import type { SessionInfoDTO } from '@piplus/shared';
import { useMemo, useRef, useState } from 'react';
import { ScrollArea } from './ui/scroll-area';

type Props = {
  info?: SessionInfoDTO;
  onTitleChanged?: (sessionId: string, newTitle: string) => Promise<void>;
};

export function SessionInfoPanel({ info, onTitleChanged }: Props) {
  const [showCompiledPrompt, setShowCompiledPrompt] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const session = info?.session ?? {
    id: 'session_stub',
    title: 'Planner',
    project_id: 'project_stub',
    parent_session_id: null,
    root_session_id: 'session_stub',
    created_by: 'user_seed',
    created_at: new Date().toISOString(),
    archived_at: null,
    pi_session_id: 'pi_session_stub',
    status: 'active',
    runtime_status: 'idle',
  };

  const project = info?.project ?? { id: 'project_stub', name: 'Demo Project' };
  const lineage = info?.lineage ?? { parent_session: null, root_session: null, depth: 0 };
  const roleTemplate = info?.role_template ?? { key: 'planner', version: '1', name: 'Planner' };
  const sync = info?.sync ?? {
    sync_status: 'idle',
    last_synced_at: null,
    last_pi_message_id: null,
    last_error: null,
    retry_count: 0,
  };
  const recentEvents = useMemo(() => (info?.recent_events ?? []).slice(0, 12), [info?.recent_events]);

  function startEditingTitle() {
    setTitleDraft(session.title);
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }

  async function commitTitle() {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (trimmed && trimmed !== session.title && session.id && onTitleChanged) {
      await onTitleChanged(session.id, trimmed).catch(() => undefined);
    }
  }

  function cancelEditingTitle() {
    setEditingTitle(false);
  }

  return (
    <ScrollArea className="h-full" viewportClassName="px-4 py-4 md:px-5 md:py-5">
      <div className="mx-auto flex max-w-[980px] flex-col gap-4">
        <div>
          <p className="workspace-eyebrow">Read-only inspector</p>
          <h3 className="mt-2 text-xl font-semibold tracking-[-0.04em] text-[var(--text)]">Session Info</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
            这是当前 session 的只读解释视图，只在切换到本 tab 时加载，不与 chat 主视图抢空间。
          </p>
        </div>

        <InfoSection title="Overview" subtitle="Session snapshot">
          <InfoGrid>
            {editingTitle ? (
              <div className="rounded-[16px] border border-[var(--accent)]/40 bg-black/10 p-2">
                <input
                  ref={titleInputRef}
                  className="w-full bg-transparent text-sm font-medium text-[var(--text)] outline-none"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value.slice(0, 200))}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTitle();
                    if (e.key === 'Escape') cancelEditingTitle();
                  }}
                />
              </div>
            ) : (
              <button className="metric-clickable" onClick={startEditingTitle} type="button" title="点击编辑标题">
                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-dim)]">Title</span>
                <span className="text-sm font-medium text-[var(--text)]">{session.title}</span>
              </button>
            )}
            <Metric label="Project" value={project.name} />
            <Metric label="Role name" value={roleTemplate.name} />
            <Metric label="Role key" value={roleTemplate.key} />
            <Metric label="Role version" value={roleTemplate.version} />
            <Metric label="Parent" value={lineage.parent_session?.title ?? 'none'} />
            <Metric label="Root" value={lineage.root_session?.title ?? 'self'} />
            <Metric label="Depth" value={String(lineage.depth)} />
            <Metric label="Created by" value={session.created_by} />
            <Metric label="Created at" value={session.created_at} />
            <Metric label="PI session ID" value={session.pi_session_id} mono />
            <Metric label="Runtime" value={session.runtime_status} />
            <Metric label="Archived" value={session.archived_at ? 'yes' : 'no'} />
          </InfoGrid>
        </InfoSection>

        <InfoSection title="Prompts" subtitle="Prompt snapshots">
          <PromptBlock label="role_base_prompt_snapshot" value={info?.prompts.role_base_prompt_snapshot ?? '—'} />
          <PromptBlock label="user_supplied_prompt" value={info?.prompts.user_supplied_prompt ?? '—'} />
          <PromptBlock label="parent_supplied_prompt" value={info?.prompts.parent_supplied_prompt ?? '—'} />
          <div className="rounded-[22px] border border-white/8 bg-black/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--text)]">compiled_prompt</p>
              <button className="ghost-button ghost-button-sm" onClick={() => setShowCompiledPrompt((value) => !value)} type="button">
                {showCompiledPrompt ? '收起' : '展开'}
              </button>
            </div>
            {showCompiledPrompt ? (
              <div className="prompt-box mt-3">{info?.prompts.compiled_prompt ?? '—'}</div>
            ) : (
              <p className="mt-3 text-sm text-[var(--text-dim)]">默认折叠，避免页面过长。</p>
            )}
          </div>
        </InfoSection>

        <InfoSection title="Sync" subtitle="Control-plane state">
          <InfoGrid>
            <Metric label="sync_status" value={sync.sync_status} />
            <Metric label="last_synced_at" value={sync.last_synced_at ?? 'never'} />
            <Metric label="last_pi_message_id" value={sync.last_pi_message_id ?? '—'} mono />
            <Metric label="retry_count" value={String(sync.retry_count)} />
            <Metric label="last_error" value={sync.last_error ?? 'none'} />
          </InfoGrid>
        </InfoSection>

        <InfoSection title="Recent Events" subtitle="Latest session events">
          <div className="space-y-3">
            {recentEvents.length === 0 ? (
              <div className="rounded-[22px] border border-white/8 bg-black/10 p-4 text-sm text-[var(--text-dim)]">暂无 recent events。</div>
            ) : (
              recentEvents.map((event) => (
                <article key={event.id} className="rounded-[22px] border border-white/8 bg-black/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[var(--text)]">{event.type}</p>
                      <p className="mt-1 text-xs text-[var(--text-dim)]">{event.created_at}</p>
                    </div>
                    <span className="chip chip-inline">{event.id}</span>
                  </div>
                  <div className="prompt-box mt-3">{event.payload}</div>
                </article>
              ))
            )}
          </div>
        </InfoSection>
      </div>
    </ScrollArea>
  );
}

function InfoSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[26px] border border-white/8 bg-[var(--surface-soft)] p-4 md:p-5">
      <p className="workspace-eyebrow">{subtitle}</p>
      <h4 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[var(--text)]">{title}</h4>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function InfoGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-[20px] border border-white/8 bg-black/10 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-dim)]">{label}</p>
      <p className={`mt-3 text-sm leading-6 text-[var(--text)] ${mono ? 'font-mono text-[12px]' : 'font-medium'}`}>{value}</p>
    </div>
  );
}

function PromptBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-white/8 bg-black/10 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-dim)]">{label}</p>
      <div className="prompt-box mt-3">{value}</div>
    </div>
  );
}
