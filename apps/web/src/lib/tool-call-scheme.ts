/** 工具卡片状态配色（错误红 / 结果未回琥珀 / 成功绿）—— 供 ToolCallCard 与 MergedToolCallsCard 共用 */
export const TOOL_CALL_SCHEMES = {
  error: {
    card: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',
    cardHover: 'hover:bg-rose-100/40 dark:hover:bg-rose-900/20',
    accent: 'text-rose-600 dark:text-rose-400',
    key: 'text-rose-700 dark:text-rose-300',
    title: 'text-rose-800 dark:text-rose-300',
    content: 'text-rose-900 dark:text-rose-200',
    borderT: 'border-rose-200 dark:border-rose-800',
    borderSoft: 'border-rose-100 dark:border-rose-800/50',
    hover: 'hover:bg-rose-100/60 dark:hover:bg-rose-900/30',
    badge: 'bg-rose-100/70 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
  },
  pending: {
    card: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
    cardHover: 'hover:bg-amber-100/40 dark:hover:bg-amber-900/20',
    accent: 'text-amber-600 dark:text-amber-400',
    key: 'text-amber-700 dark:text-amber-300',
    title: 'text-amber-800 dark:text-amber-300',
    content: 'text-amber-900 dark:text-amber-200',
    borderT: 'border-amber-200 dark:border-amber-800',
    borderSoft: 'border-amber-100 dark:border-amber-800/50',
    hover: 'hover:bg-amber-100/60 dark:hover:bg-amber-900/30',
    badge: 'bg-amber-100/70 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  },
  ok: {
    card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
    cardHover: 'hover:bg-emerald-100/40 dark:hover:bg-emerald-900/20',
    accent: 'text-emerald-600 dark:text-emerald-400',
    key: 'text-emerald-700 dark:text-emerald-300',
    title: 'text-emerald-800 dark:text-emerald-300',
    content: 'text-emerald-900 dark:text-emerald-200',
    borderT: 'border-emerald-200 dark:border-emerald-800',
    borderSoft: 'border-emerald-100 dark:border-emerald-800/50',
    hover: 'hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30',
    badge: 'bg-emerald-100/70 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  },
} as const;

export type ToolCallStatus = keyof typeof TOOL_CALL_SCHEMES;
export type ToolCallScheme = (typeof TOOL_CALL_SCHEMES)[ToolCallStatus];
