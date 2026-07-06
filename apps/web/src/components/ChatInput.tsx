import React, { useState, useRef, useEffect } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import type { ChatImageContentBlockDTO, ChatMessageContentBlockDTO } from '@piplus/shared';
import type { SessionMessageImageAttachment } from '../lib/api';
import { useSessionCommands } from '../lib/hooks';
import { loadSessionDraft, saveSessionDraft } from '../lib/session-drafts';
import { fuzzyScore } from '../lib/fuzzy';
import {
  ImagePlus,
  X,
  ArrowUp,
  OctagonX,
} from 'lucide-react';

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function fileToAttachment(file: File): Promise<SessionMessageImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      if (!base64) {
        reject(new Error(`读取图片失败：${file.name}`));
        return;
      }
      resolve({
        type: 'image',
        mime_type: file.type,
        data_base64: base64,
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
  });
}

interface ChatInputProps {
  onSend: (content: string, attachments: SessionMessageImageAttachment[]) => Promise<void>;
  onStop: () => void;
  sending: boolean;
  isRunning: boolean;
  sendShortcutMode?: 'enter' | 'mod_enter';
  currentModelSupportsImages?: boolean | null;
  wsConnected?: boolean;
  selectedSessionId: string | null;
  isMobile?: boolean;
  onPreviewImage?: (block: ChatImageContentBlockDTO) => void;
}

export default function ChatInput({
  onSend,
  onStop,
  sending,
  isRunning,
  sendShortcutMode,
  currentModelSupportsImages,
  wsConnected,
  selectedSessionId,
  isMobile,
  onPreviewImage,
}: ChatInputProps) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<SessionMessageImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const prevSessionIdRef = useRef<string | null>(null);

  // Slash command state
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [selectedCommandIdx, setSelectedCommandIdx] = useState(0);
  const commandsQuery = useSessionCommands(selectedSessionId ?? null);
  const availableCommands = commandsQuery.data ?? [];
  const commandJustSelectedRef = useRef(false);

  const canSendImages = currentModelSupportsImages !== false;

  const filteredCommands = (() => {
    if (!commandFilter) return availableCommands;
    const q = commandFilter.toLowerCase();
    return availableCommands
      .map((cmd) => ({ cmd, score: fuzzyScore(q, cmd.name) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.cmd);
  })();

  const closeCommands = () => {
    setShowCommands(false);
    setCommandFilter('');
    setSelectedCommandIdx(0);
  };

  const addImageFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    if (!canSendImages) {
      setAttachmentError('当前模型不支持图片输入，请先切换到支持图片的模型。');
      return;
    }
    const imageFiles = files.filter((file) => ALLOWED_IMAGE_MIME_TYPES.has(file.type));
    if (imageFiles.length !== files.length) {
      setAttachmentError('仅支持 PNG、JPEG、WebP、GIF 图片。');
      return;
    }
    if (attachments.length + imageFiles.length > 4) {
      setAttachmentError('最多只能添加 4 张图片。');
      return;
    }
    try {
      const nextAttachments = await Promise.all(imageFiles.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...nextAttachments]);
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '读取图片失败');
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setAttachmentError(null);
  };

  const handleSubmit = async () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || sending) return;
    try {
      await onSend(content, attachments);
      setDraft('');
      setAttachments([]);
      setAttachmentError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/does not support image input/i.test(message)) {
        setAttachmentError('当前模型不支持图片输入，请切换到支持图片的模型。');
        return;
      }
      if (/unsupported image mime type/i.test(message)) {
        setAttachmentError('仅支持 PNG、JPEG、WebP、GIF 图片。');
        return;
      }
      if (/at most 4 images are allowed/i.test(message)) {
        setAttachmentError('最多只能添加 4 张图片。');
        return;
      }
      setAttachmentError(message || '发送失败，请重试。');
    }
  };

  // Keep draftRef in sync
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Session switch: save old draft, load new one, clear attachments
  useEffect(() => {
    if (prevSessionIdRef.current && prevSessionIdRef.current !== selectedSessionId) {
      saveSessionDraft(prevSessionIdRef.current, draftRef.current);
    }
    if (selectedSessionId) {
      const savedDraft = loadSessionDraft(selectedSessionId);
      setDraft(savedDraft);
      draftRef.current = savedDraft;
    }
    prevSessionIdRef.current = selectedSessionId;
    setAttachments([]);
    setAttachmentError(null);
    closeCommands();
  }, [selectedSessionId]);

  // Debounce-save draft to localStorage
  useEffect(() => {
    if (!selectedSessionId) return;
    const timer = setTimeout(() => {
      saveSessionDraft(selectedSessionId, draft);
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, selectedSessionId]);

  // Save draft on unmount
  useEffect(() => {
    return () => {
      const sid = prevSessionIdRef.current;
      if (sid) {
        saveSessionDraft(sid, draftRef.current);
      }
    };
  }, []);

  return (
    <div className="shrink-0 px-4 py-2 md:px-5 bg-slate-50 dark:bg-slate-900">
      <div className="mx-auto max-w-[900px]">
        <div className="flex flex-col gap-2">
          {/* Attachments preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-2">
              {attachments.map((attachment, index) => (
                <div key={`${attachment.filename ?? 'attachment'}-${index}`} className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (onPreviewImage) {
                        onPreviewImage({
                          type: 'image',
                          mime_type: attachment.mime_type,
                          media_type: attachment.mime_type,
                          filename: attachment.filename ?? null,
                          uri: null,
                          data_base64: attachment.data_base64,
                        });
                      }
                    }}
                    className="block overflow-hidden rounded-lg border border-slate-300 dark:border-slate-600"
                  >
                    <img
                      src={`data:${attachment.mime_type};base64,${attachment.data_base64}`}
                      alt={attachment.filename ?? `attachment-${index + 1}`}
                      className="h-16 w-16 object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900/80 p-1 text-white hover:bg-slate-900 cursor-pointer"
                    title="移除图片"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Slash command dropdown */}
          {showCommands && (
            <div className="relative">
              <div className="absolute bottom-full left-0 right-0 mb-1 z-50 max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
                {commandsQuery.isLoading ? (
                  <div className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">加载命令…</div>
                ) : commandsQuery.isError ? (
                  <div className="px-3 py-2 text-sm text-red-500">命令加载失败</div>
                ) : filteredCommands.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">无匹配命令</div>
                ) : (
                  filteredCommands.map((cmd, idx) => (
                    <button
                      key={cmd.name}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                        idx === selectedCommandIdx
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commandJustSelectedRef.current = true;
                        setDraft(`/${cmd.name} `);
                        closeCommands();
                        requestAnimationFrame(() => {
                          const ta = textareaRef.current;
                          if (ta) {
                            ta.focus();
                            ta.selectionStart = ta.selectionEnd = ta.value.length;
                          }
                        });
                      }}
                    >
                      <span className="font-mono font-semibold text-blue-600 dark:text-blue-400 shrink-0">/{cmd.name}</span>
                      {cmd.description && (
                        <span className="truncate text-xs text-slate-400 dark:text-slate-500">{cmd.description}</span>
                      )}
                      <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        cmd.source === 'extension' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400' :
                        cmd.source === 'prompt' ? 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400' :
                        'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400'
                      }`}>
                        {cmd.source}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            className="w-full min-h-[68px] resize-none px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 transition"
            disabled={isRunning || sending}
            ref={textareaRef}
            onChange={(e) => {
              const value = e.target.value;
              setDraft(value);
              if (commandJustSelectedRef.current) {
                commandJustSelectedRef.current = false;
                return;
              }
              const textarea = e.target;
              const cursorPos = textarea.selectionStart;
              const textBeforeCursor = value.slice(0, cursorPos);
              if (textBeforeCursor.startsWith('/') && !/\n/.test(textBeforeCursor)) {
                setCommandFilter(textBeforeCursor.slice(1));
                setShowCommands(true);
                setSelectedCommandIdx(0);
              } else {
                closeCommands();
              }
            }}
            onPaste={async (e: ClipboardEvent<HTMLTextAreaElement>) => {
              const files = Array.from(e.clipboardData.files ?? []);
              if (!files.some((file) => ALLOWED_IMAGE_MIME_TYPES.has(file.type))) return;
              e.preventDefault();
              await addImageFiles(files.filter((file) => ALLOWED_IMAGE_MIME_TYPES.has(file.type)));
            }}
            onKeyDown={(e) => {
              // Command dropdown keyboard navigation
              if (showCommands && filteredCommands.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedCommandIdx((prev) => Math.min(prev + 1, filteredCommands.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedCommandIdx((prev) => Math.max(prev - 1, 0));
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeCommands();
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  const cmd = filteredCommands[selectedCommandIdx];
                  if (cmd) {
                    commandJustSelectedRef.current = true;
                    setDraft(`/${cmd.name} `);
                    closeCommands();
                    requestAnimationFrame(() => {
                      const ta = textareaRef.current;
                      if (ta) {
                        ta.focus();
                        ta.selectionStart = ta.selectionEnd = ta.value.length;
                      }
                    });
                  }
                  return;
                }
              }

              if (e.key !== 'Enter') return;

              if (sendShortcutMode === 'mod_enter') {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  void handleSubmit();
                  return;
                }
              } else {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  void handleSubmit();
                  return;
                }
              }

              // Insert newline at cursor
              e.preventDefault();
              const textarea = e.target as HTMLTextAreaElement;
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              setDraft((prev) => prev.slice(0, start) + '\n' + prev.slice(end));
              requestAnimationFrame(() => {
                textarea.selectionStart = textarea.selectionEnd = start + 1;
              });
            }}
            placeholder="向当前会话发送消息…"
            value={draft}
          />

          {/* Bottom controls row */}
          <div className="flex items-center gap-2.5 px-1 flex-wrap">
            {/* WS connection indicator */}
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-red-400'}`} />
              <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                {wsConnected ? 'WS' : 'WS 离线'}
              </span>
            </div>

            {/* Image upload */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                const files = e.target.files;
                if (files) await addImageFiles(files);
                e.target.value = '';
              }}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRunning || !canSendImages || attachments.length >= 4}
                className="flex items-center space-x-1.5 px-3 py-1.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-xs font-semibold text-slate-500 dark:text-slate-400 transition cursor-pointer disabled:opacity-50"
                title={isRunning ? '对话进行中，暂时不能添加图片' : canSendImages ? '添加图片' : '当前模型不支持图片输入'}
              >
                <ImagePlus className="w-3.5 h-3.5" />
                <span>图片</span>
              </button>
              {(attachmentError || currentModelSupportsImages === false) && (
                <span className="text-[10px] text-red-500 dark:text-red-400 font-medium whitespace-nowrap">
                  {attachmentError ?? '当前模型不支持图片输入'}
                </span>
              )}
            </div>

            {/* Shortcut hint */}
            {!isRunning && (
              <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-auto">
                {isMobile
                  ? '支持粘贴图片，最多 4 张'
                  : sendShortcutMode === 'mod_enter'
                    ? 'Ctrl/Cmd+Enter 发送 · 支持粘贴图片，最多 4 张'
                    : 'Enter 发送 · Ctrl/Cmd+Enter 换行 · 支持粘贴图片，最多 4 张'}
              </span>
            )}

            {/* Stop button */}
            {isRunning && (
              <button
                className="flex items-center space-x-1.5 px-3 py-1.5 ml-auto bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl text-red-600 dark:text-red-400 font-semibold hover:bg-red-100 dark:hover:bg-red-900/50 text-xs transition cursor-pointer"
                onClick={onStop}
              >
                <OctagonX className="w-3.5 h-3.5" />
                <span>停止</span>
              </button>
            )}

            {/* Send button */}
            <button
              className="flex items-center space-x-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
              disabled={isRunning || sending || (draft.trim().length === 0 && attachments.length === 0)}
              onClick={() => { void handleSubmit(); }}
            >
              <span>{sending ? '发送中…' : '发送'}</span>
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
