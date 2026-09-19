import { AlertTriangle } from 'lucide-react';

/**
 * 会话原先关联的 worktree 目录已不存在时的提示条。
 *
 * 后端已自愈：把工作目录回落到项目根并清除会话上的 worktree 关联
 * （否则会在已消失的 cwd 上做 git / 文件操作，Bun 还会报出误导性的
 * `posix_spawn '/bin/sh'` ENOENT，让人误以为是缺少 shell）。
 * 这里只负责把「发生过回退」这件事实和恢复路径告诉用户。
 */
export default function MissingWorktreeNotice({ worktreePath }: { worktreePath?: string | null }) {
  if (!worktreePath) return null;

  return (
    <div
      role="status"
      className="shrink-0 flex items-start gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-[11px] leading-5 text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span className="min-w-0">
        会话原先关联的 worktree 已不存在，已自动回退到项目根目录：
        <code className="font-mono break-all">{worktreePath}</code>
        。如需恢复，可在 Git 标签重新切换分支。
      </span>
    </div>
  );
}
