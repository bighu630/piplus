/** 未选择任何会话时的占位区。 */
export default function EmptySessionPlaceholder() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-50 dark:bg-slate-900/40">
      <div className="text-center space-y-2">
        <h2 className="text-base font-bold text-slate-700 dark:text-slate-300">未选择会话</h2>
        <p className="text-xs text-slate-400 dark:text-slate-500">在侧边栏选择或新建一个会话以开始工作。</p>
      </div>
    </div>
  );
}
