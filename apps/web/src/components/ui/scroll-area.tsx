import type { ReactNode, RefObject } from 'react';

type ScrollAreaProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: RefObject<HTMLDivElement | null>;
};

export function ScrollArea({ children, className, viewportClassName, viewportRef }: ScrollAreaProps) {
  return (
    <div className={`scroll-area ${className ?? ''}`.trim()}>
      <div ref={viewportRef} className={`scroll-area-viewport ${viewportClassName ?? ''}`.trim()}>{children}</div>
    </div>
  );
}
