import { AlertTriangle } from 'lucide-react';

/** 未配置可用模型时的顶部告警条。 */
export default function ModelsNotConfiguredBanner({ onAddModel }: { onAddModel: () => void }) {
  return (
    <div className="px-6 py-4 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 flex items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-bold text-amber-800 dark:text-amber-200">尚未配置可用模型</div>
          <div className="text-xs text-amber-700 dark:text-amber-300">请先添加 Pi 原生平台密钥或自定义模型提供商，配置完成后即可创建项目和使用 Agent。</div>
        </div>
      </div>
      <button
        onClick={onAddModel}
        className="px-4 py-2 text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 rounded-lg shadow-2xs transition cursor-pointer shrink-0 whitespace-nowrap"
      >
        添加模型
      </button>
    </div>
  );
}
