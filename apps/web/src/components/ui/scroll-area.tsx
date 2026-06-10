import type { ReactNode } from 'react';

type ScrollAreaProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
};

export function ScrollArea({ children, className, viewportClassName }: ScrollAreaProps) {
  return (
    <div className={`scroll-area ${className ?? ''}`.trim()}>
      <div className={`scroll-area-viewport ${viewportClassName ?? ''}`.trim()}>{children}</div>
    </div>
  );
}
