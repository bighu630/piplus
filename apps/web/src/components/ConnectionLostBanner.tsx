/** WebSocket 断开时的顶部提示条。 */
export default function ConnectionLostBanner() {
  return (
    <div className="shrink-0 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 px-4 py-1.5 text-center text-[11px] font-medium text-amber-700 dark:text-amber-300">
      连接已断开，正在重连…
    </div>
  );
}
