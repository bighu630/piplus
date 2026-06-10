import type { ButtonHTMLAttributes } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/15 ${props.className ?? ''}`}
    />
  );
}
