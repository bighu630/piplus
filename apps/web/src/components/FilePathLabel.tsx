import React from 'react';

/**
 * 文件路径标签：过长时**省略前面的目录**，保证文件名（与尽可能多的尾部目录）完整可见。
 *
 * 实现：把路径拆成「目录前缀」与「文件名」两段：
 * - 目录前缀：允许收缩，配合 `direction: rtl` + `text-overflow: ellipsis` 让省略号出现在**左侧**
 *   （即省略开头、保留靠近文件名的尾部目录，如 `…/code/test/test_folder/`）
 *   同时设置 `unicode-bidi: plaintext`：让内容按自身方向（路径为 LTR）排版，
 *   避免 RTL 行方向把 `/`、`.` 等中性字符重排
 * - 文件名：优先完整显示（`shrink-0`），仅当自身超过容器宽度时才从尾部省略
 *
 * 完整路径始终通过 `title` 提供（鼠标悬停可见）。
 */
export interface FilePathLabelProps {
  path: string;
  className?: string;
  /** 目录前缀最大宽度（Tailwind 尺寸类，默认 `max-w-[240px]`） */
  dirMaxWidthClass?: string;
}

function FilePathLabel({ path, className = '', dirMaxWidthClass = 'max-w-[240px]' }: FilePathLabelProps) {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  return (
    <span
      data-testid="file-path-label"
      className={`flex min-w-0 items-center ${className}`}
      title={path}
    >
      {dir !== '' && (
        <span
          data-testid="file-path-dir"
          className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] [unicode-bidi:plaintext] text-left ${dirMaxWidthClass}`}
        >
          {dir}
        </span>
      )}
      <span
        data-testid="file-path-base"
        className="shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {base}
      </span>
    </span>
  );
}

export default React.memo(FilePathLabel);
