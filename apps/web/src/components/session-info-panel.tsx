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
    pi_session_locator_json: '{}',
    current_model: null,
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
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-[-0.04em] text-[var(--text)]">Session Info</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">当前 session 的信息列表。</p>
        </div>

        <section className="rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.024))] p-4 shadow-[var(--glass-highlight)]">
          <div className="space-y-2">
            {editingTitle ? (
              <div className="rounded-[16px] border border-[var(--accent)]/40 bg-black/10 p-2">
                <input
                  ref={titleInputRef}
                  className="w-full bg-transparent text-base font-medium text-[var(--text)] outline-none"
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
              <button className="w-full text-left" onClick={startEditingTitle} type="button" title="点击编辑标题">
                <InfoRow label="Title" value={session.title} valueClassName="text-base font-medium text-[var(--text)]" />
              </button>
            )}
            <InfoRow label="Project" value={project.name} />
            <InfoRow label="Role name" value={roleTemplate.name} />
            <InfoRow label="Role key" value={roleTemplate.key} />
            <InfoRow label="Role version" value={roleTemplate.version} />
            <InfoRow label="Parent" value={lineage.parent_session?.title ?? 'none'} />
            <InfoRow label="Root" value={lineage.root_session?.title ?? 'self'} />
            <InfoRow label="Depth" value={String(lineage.depth)} />
            <InfoRow label="Created by" value={session.created_by} />
            <InfoRow label="Created at" value={session.created_at} />
            <InfoRow label="PI session ID" value={session.pi_session_id} mono />
            <InfoRow label="Current model" value={session.current_model?.label ?? 'none'} />
            <InfoRow label="Runtime" value={session.runtime_status} />
            <InfoRow label="Archived" value={session.archived_at ? 'yes' : 'no'} />
            <InfoRow label="sync_status" value={sync.sync_status} />
            <InfoRow label="last_synced_at" value={sync.last_synced_at ?? 'never'} />
            <InfoRow label="last_pi_message_id" value={sync.last_pi_message_id ?? '—'} mono />
            <InfoRow label="retry_count" value={String(sync.retry_count)} />
            <InfoRow label="last_error" value={sync.last_error ?? 'none'} />
          </div>
        </section>

        <section className="rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.024))] p-4 shadow-[var(--glass-highlight)]">
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
        </section>

        <section className="rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.024))] p-4 shadow-[var(--glass-highlight)]">
          <p className="text-sm font-medium text-[var(--text)]">Recent Events</p>
          <div className="mt-3 space-y-3">
            {recentEvents.length === 0 ? (
              <div className="rounded-[18px] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.03)] p-3.5 text-sm text-[var(--text-dim)]">暂无 recent events。</div>
            ) : (
              recentEvents.map((event) => (
                <article key={event.id} className="rounded-[18px] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.03)] p-3.5">
                  <InfoRow label={event.type} value={event.created_at} />
                  <div className="mt-2 text-sm text-[var(--text-dim)]">{event.id}</div>
                  <div className="prompt-box mt-3">{event.payload}</div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}

function InfoRow({ label, value, mono = false, valueClassName = '' }: { label: string; value: string; mono?: boolean; valueClassName?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-[14px] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5">
      <span className="shrink-0 text-sm font-semibold text-[var(--text)]">{label}</span>
      <span className={`min-w-0 text-right text-sm leading-6 text-[var(--text-muted)] ${mono ? 'font-mono text-[12px]' : ''} ${valueClassName}`}>{value}</span>
    </div>
  );
}
