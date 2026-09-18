import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfoDTO } from '@piplus/shared';
import { useUpdateSessionTitleMutation } from './hooks';

interface UseTitleEditingArgs {
  selectedSessionId: string | null;
  sessionInfo: SessionInfoDTO | undefined;
}

/**
 * 会话标题行内编辑：编辑态、草稿值、输入框 ref、保存去重标志与快捷键。
 * planner 根会话不允许改标题（与原行为一致）。
 */
export function useTitleEditing({ selectedSessionId, sessionInfo }: UseTitleEditingArgs) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleSavedRef = useRef(false);
  const updateTitleMut = useUpdateSessionTitleMutation();

  // 切换会话时退出编辑态
  useEffect(() => {
    setEditingTitle(false);
    setEditTitleValue('');
  }, [selectedSessionId]);

  const handleStartEditTitle = useCallback(() => {
    if (sessionInfo?.role_template.key === 'planner' && sessionInfo.lineage.depth === 0) return;
    titleSavedRef.current = false;
    setEditTitleValue(sessionInfo?.session.title ?? '');
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [sessionInfo]);

  const handleSaveTitle = useCallback(() => {
    if (titleSavedRef.current) return;
    if (!selectedSessionId) return;
    if (!editTitleValue.trim()) {
      setEditingTitle(false);
      return;
    }
    titleSavedRef.current = true;
    updateTitleMut.mutate({ sessionId: selectedSessionId, title: editTitleValue.trim() });
    setEditingTitle(false);
  }, [selectedSessionId, editTitleValue, updateTitleMut]);

  const handleCancelEditTitle = useCallback(() => {
    titleSavedRef.current = true;
    setEditingTitle(false);
    setEditTitleValue('');
  }, []);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSaveTitle();
    else if (e.key === 'Escape') handleCancelEditTitle();
  }, [handleSaveTitle, handleCancelEditTitle]);

  return {
    editingTitle,
    editTitleValue,
    setEditTitleValue,
    titleInputRef,
    handleStartEditTitle,
    handleSaveTitle,
    handleCancelEditTitle,
    handleTitleKeyDown,
  };
}
