import React from 'react';

/**
 * 文件路径标签：过长时**省略前面的目录**，保证文件名（与尽可能多的尾部目录）完整可见。
 *
 * 实现：把路径拆成「目录前缀」与「文件名」两段：
 * - 目录前缀：允许收缩，块方向设为 `direction: rtl` —— `text-overflow: ellipsis` 的省略端跟随块方向，
 *   因此省略号落在**左侧**（省略开头、保留靠近文件名的尾部目录，如 `…/code/test/test_folder/`）。
 *   内容再用 `<span dir="ltr">` 做**行内隔离**：RTL 块方向不会重排路径中的 `/`、`.` 等中性字符。
 *   （注意：不能用 `unicode-bidi: plaintext` —— 它会把元素的段落方向按首强字符（路径 → LTR）重算，
 *   省略端随之回到右侧，效果与需求相反；这点已在 Chromium/Firefox 实测确认。）
 * - 文件名：优先完整显示（`shrink-0 max-w-full`），仅在自身超过可用宽度时才从尾部省略。
 *
 * 完整路径通过 `title` 提供（鼠标悬停可见；传 `null` 可显式关闭）。
 */
export interface FilePathLabelProps {
  path: string;
  className?: string;
  /** 目录前缀最大宽度（Tailwind 尺寸类，默认 `max-w-[240px]`） */
  dirMaxWidthClass?: string;
  /** 覆盖 title：`null` 表示不显示 tooltip，`undefined` 表示用 path */
  title?: string | null;
}

function FilePathLabel({ path, className = '', dirMaxWidthClass = 'max-w-[240px]', title }: FilePathLabelProps) {
  // 兼容 Windows 反斜杠路径：按最后一个 `/` 或 `\` 切分（保留原始字符展示）
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = lastSeparator >= 0 ? path.slice(0, lastSeparator + 1) : '';
  const base = lastSeparator >= 0 ? path.slice(lastSeparator + 1) : path;
  const tooltip = title === undefined ? path : title ?? undefined;

  return (
    <span
      data-testid="file-path-label"
      className={`flex min-w-0 items-center ${className}`}
      title={tooltip}
    >
      {dir !== '' && (
        <span
          data-testid="file-path-dir"
          className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] text-left ${dirMaxWidthClass}`}
        >
          <span dir="ltr">{dir}</span>
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
