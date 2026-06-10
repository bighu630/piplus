import type { ButtonHTMLAttributes } from 'react';

export function TabButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  const { active, className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={`rounded-full px-4 py-2 text-sm transition ${active ? 'bg-accent text-black' : 'text-white/70 hover:text-white'} ${className}`}
    />
  );
}
