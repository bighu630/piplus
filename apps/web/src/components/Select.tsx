import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { fuzzyScore } from '../lib/fuzzy';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  placeholder?: string;
  searchable?: boolean;
  /** Custom max-height for the dropdown list (default: 15rem / 240px) */
  dropdownMaxHeight?: string;
  /** Minimum width for the dropdown panel. Defaults to the trigger button width. */
  dropdownMinWidth?: string;
}

export default function Select({
  value,
  onChange,
  options,
  className = '',
  placeholder,
  searchable = false,
  dropdownMaxHeight = 'max-h-60',
  dropdownMinWidth,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [dropdownAbove, setDropdownAbove] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selectedOption = options.find((o) => o.value === value);

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const q = search.trim();
    if (!q) return options;
    return options
      .map((option, index) => {
        const labelScore = fuzzyScore(q, option.label);
        const valueScore = fuzzyScore(q, option.value);
        return {
          option,
          index,
          score: Math.max(labelScore, valueScore),
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.option);
  }, [options, search, searchable]);

  // Reset search when dropdown closes
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setSearch(''), 150);
      return () => clearTimeout(t);
    }
    if (searchable) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open, searchable]);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const above = spaceBelow < 280 && spaceAbove > spaceBelow;

    setDropdownAbove(above);
    setDropdownStyle({
      position: 'fixed',
      left: `${rect.left}px`,
      width: 'max-content',
      minWidth: `${rect.width}px`,
      maxWidth: 'min(calc(100vw - 20px), 300px)',
      top: above ? undefined : `${rect.bottom}px`,
      bottom: above ? `${window.innerHeight - rect.top}px` : undefined,
    });
  }, []);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) {
        // Compute position synchronously BEFORE rendering the dropdown
        computePosition();
        return true;
      }
      return false;
    });
  }, [computePosition]);

  // Recalculate position on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const updatePosition = () => computePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, computePosition]);

  const handleSelect = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 cursor-pointer"
      >
        <span className={`truncate ${selectedOption ? '' : 'text-slate-400'}`}>
          {selectedOption ? selectedOption.label : placeholder ?? '请选择...'}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-500 shrink-0 ml-1 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          className="z-[200] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg flex flex-col"
          style={{
            ...dropdownStyle,
            ...(dropdownMinWidth ? { minWidth: dropdownMinWidth } : {}),
          }}
        >
          {searchable && (
            <div className="relative border-b border-slate-200 dark:border-slate-700">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索..."
                className="w-full pl-7 pr-3 py-2 text-xs bg-transparent text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filteredOptions.length > 0) {
                    handleSelect(filteredOptions[0].value);
                  }
                  if (e.key === 'Escape') {
                    setOpen(false);
                  }
                }}
              />
            </div>
          )}

          <div className={`overflow-y-auto ${dropdownMaxHeight}`}>
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-6 text-xs text-slate-400 text-center">
                {search ? '无匹配结果' : '暂无数据'}
              </div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  className={`w-full text-left px-3 py-2 text-xs transition cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 truncate ${
                    option.value === value
                      ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 font-semibold'
                      : 'text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {option.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
