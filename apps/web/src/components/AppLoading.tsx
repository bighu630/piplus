/**
 * 认证状态查询期间的首屏占位。
 *
 * 与 index.html 的静态 #boot-splash 保持同一视觉（品牌块 + spinner + 文案），
 * 让「JS 加载中 → React 挂载 → auth 就绪」整个过程视觉连续，不出现白屏或割裂感。
 */
export default function AppLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 flex flex-col items-center justify-center gap-3.5 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 text-[13px] tracking-[0.02em]"
    >
      <div className="w-[52px] h-[52px] rounded-[14px] bg-blue-600 text-white flex items-center justify-center font-black text-2xl select-none">
        Pi
      </div>
      <div
        aria-hidden="true"
        className="w-[18px] h-[18px] rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none"
      />
      <div>正在加载…</div>
    </div>
  );
}
