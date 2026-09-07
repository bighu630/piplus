import React, { useState } from 'react';
import type { AskQuestionPendingItem, AskQuestionPendingPayload } from '@piplus/shared';
import { Check, ChevronLeft, ChevronRight, CircleHelp, X } from 'lucide-react';

/**
 * ask_question 卡片：待回答时渲染表单（单选/多选/自己输入/问卷），
 * 已回答时渲染结果卡片（✓ 答案 / ✓ 自己输入 / 多选逐行 / 取消 warning / 问卷逐题）。
 *
 * 样式与现有工具卡片一致：表单用蓝/靛强调的浅色卡片，结果用 emerald（正常）与
 * amber warning（取消）。details 缺失时降级为 content text。
 */

/** 提交给后端 /api/v1/sessions/:sessionId/ask-answer 的 body。 */
export type AskQuestionAnswerPayload = {
  questionId: string;
  /** 单题：单选为 string，多选为 string[]；取消为 null。 */
  answer?: string | string[] | null;
  /** 问卷：逐题答案（string | string[] | { answers, wasCustom, customAnswers }）。 */
  answers?: Array<
    | string
    | string[]
    | { answers: string[]; wasCustom?: boolean; customAnswers?: string[] }
  >;
  wasCustom?: boolean;
  customAnswers?: string[];
  cancelled?: boolean;
};

/** 已回答 details（兼容后端 AskQuestionDetails / QuestionnaireDetails 形状，宽松解析）。 */
export type AskQuestionResultItem = {
  question?: string;
  options?: string[];
  answer?: string | string[] | null;
  multiSelect?: boolean;
  label?: string;
  wasCustom?: boolean;
  customAnswers?: string[];
};

export type AskQuestionResultDetails = ({ cancelled?: boolean } & AskQuestionResultItem) & {
  questions?: AskQuestionResultItem[];
};

type PendingProps = {
  mode: 'pending';
  sessionId: string;
  pending: AskQuestionPendingPayload;
  /** 提交请求进行中：禁用输入与按钮。 */
  disabled?: boolean;
  /** 已提交（等待工具结果）：展示"已提交"占位。 */
  submitted?: boolean;
  onSubmit: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
  onCancel: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
};

type ResultProps = {
  mode: 'result';
  sessionId: string;
  details?: AskQuestionResultDetails | null;
  /** details 缺失/非法时的降级文本。 */
  content?: string;
};

export type AskQuestionCardProps = PendingProps | ResultProps;

const CUSTOM_LABEL = '自己输入';

/** 单选表单：radio 选择 + 底部"自己输入"文本框。 */
function SingleQuestionForm({
  question,
  options,
  disabled,
  value,
  custom,
  onChange,
  onCustomChange,
}: {
  question: string;
  options: string[];
  disabled: boolean;
  value: string | null;
  custom: string;
  onChange: (v: string | null) => void;
  onCustomChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-200 break-words">{question}</div>
      <div className="space-y-1">
        {options.map((option) => (
          <label
            key={option}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer select-none transition-colors ${
              value === option
                ? 'border-indigo-400 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-100'
                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'
            } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
          >
            <input
              type="radio"
              name="ask-question-single"
              className="mt-0.5 accent-indigo-500 shrink-0"
              checked={value === option}
              disabled={disabled}
              onChange={() => {
                onChange(option);
                onCustomChange('');
              }}
            />
            <span className="break-words">{option}</span>
          </label>
        ))}
      </div>
      <CustomInput
        disabled={disabled}
        value={custom}
        onChange={(v) => {
          onCustomChange(v);
          if (v.trim()) onChange(null);
        }}
        active={!value && Boolean(custom.trim())}
      />
    </div>
  );
}

/** 多选表单：checkbox 多选 + 底部"自己输入"文本框（追加一项）。 */
function MultiQuestionForm({
  question,
  options,
  disabled,
  checked,
  custom,
  onToggle,
  onCustomChange,
}: {
  question: string;
  options: string[];
  disabled: boolean;
  checked: Set<string>;
  custom: string;
  onToggle: (option: string) => void;
  onCustomChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-200 break-words">{question}</div>
      <div className="space-y-1">
        {options.map((option) => {
          const selected = checked.has(option);
          return (
            <label
              key={option}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer select-none transition-colors ${
                selected
                  ? 'border-indigo-400 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-100'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'
              } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-indigo-500 shrink-0"
                checked={selected}
                disabled={disabled}
                onChange={() => onToggle(option)}
              />
              <span className="break-words">{option}</span>
            </label>
          );
        })}
      </div>
      <CustomInput disabled={disabled} value={custom} onChange={onCustomChange} active={Boolean(custom.trim())} />
    </div>
  );
}

function CustomInput({
  disabled,
  value,
  onChange,
  active,
}: {
  disabled: boolean;
  value: string;
  onChange: (v: string) => void;
  active: boolean;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 flex items-center gap-2 transition-colors ${active ? 'border-indigo-400 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-700 bg-transparent'}`}>
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">{CUSTOM_LABEL}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="输入自定义答案…"
        className="w-full bg-transparent text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none disabled:opacity-60"
      />
    </div>
  );
}

/** 单题待回答表单（单选/多选）。 */
function PendingSingle({
  pending,
  disabled,
  submitted,
  onSubmit,
  onCancel,
}: {
  pending: AskQuestionPendingPayload;
  disabled: boolean;
  submitted: boolean;
  onSubmit: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
  onCancel: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
}) {
  const options = pending.options ?? [];
  const multiSelect = pending.multiSelect === true;
  const [value, setValue] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState('');

  const canSubmit = multiSelect
    ? checked.size > 0 || Boolean(custom.trim())
    : value !== null || Boolean(custom.trim());

  const handleSubmit = () => {
    if (!canSubmit || submitted || disabled) return;
    const trimmed = custom.trim();
    if (multiSelect) {
      const answers = [...checked];
      if (trimmed) answers.push(trimmed);
      onSubmit({
        questionId: pending.questionId,
        answer: answers,
        wasCustom: Boolean(trimmed),
        customAnswers: trimmed ? [trimmed] : undefined,
      });
    } else if (trimmed) {
      onSubmit({
        questionId: pending.questionId,
        answer: trimmed,
        wasCustom: true,
        customAnswers: [trimmed],
      });
    } else if (value !== null) {
      onSubmit({
        questionId: pending.questionId,
        answer: value,
        wasCustom: false,
      });
    }
  };

  if (submitted) {
    return <SubmittedPlaceholder label={multiSelect ? '正在等待多选结果…' : '正在等待选择结果…'} />;
  }

  return (
    <div className="space-y-3">
      {multiSelect ? (
        <MultiQuestionForm
          question={pending.question ?? ''}
          options={options}
          disabled={disabled}
          checked={checked}
          custom={custom}
          onToggle={(option) =>
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(option)) next.delete(option);
              else next.add(option);
              return next;
            })
          }
          onCustomChange={setCustom}
        />
      ) : (
        <SingleQuestionForm
          question={pending.question ?? ''}
          options={options}
          disabled={disabled}
          value={value}
          custom={custom}
          onChange={setValue}
          onCustomChange={setCustom}
        />
      )}
      <FormActions
        disabled={disabled}
        primaryLabel="提交"
        primaryDisabled={!canSubmit}
        onPrimary={handleSubmit}
        onCancel={() => onCancel({ questionId: pending.questionId, answer: null, cancelled: true })}
      />
    </div>
  );
}

/** 问卷待回答表单：标签页导航 + 最终统一提交。 */
function PendingQuestionnaire({
  pending,
  disabled,
  submitted,
  onSubmit,
  onCancel,
}: {
  pending: AskQuestionPendingPayload;
  disabled: boolean;
  submitted: boolean;
  onSubmit: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
  onCancel: (payload: AskQuestionAnswerPayload) => void | Promise<void>;
}) {
  const questions = pending.questions ?? [];
  const [active, setActive] = useState(0);
  // 每题的答案状态：单选选中值 / 多选选中集合 / 自定义文本
  const [values, setValues] = useState<Array<string | null>>(() => questions.map(() => null));
  const [multiChecked, setMultiChecked] = useState<Array<Set<string>>>(() => questions.map(() => new Set<string>()));
  const [customs, setCustoms] = useState<string[]>(() => questions.map(() => ''));

  const allAnswered = questions.every((q, i) => {
    if (q.multiSelect === true) return multiChecked[i]!.size > 0 || Boolean(customs[i]!.trim());
    return values[i] !== null || Boolean(customs[i]!.trim());
  });

  const label = (q: AskQuestionPendingItem, i: number) => q.label || `问题 ${i + 1}`;

  const handleSubmit = () => {
    if (!allAnswered || submitted || disabled || questions.length === 0) return;
    const answers = questions.map((q, i) => {
      const trimmed = customs[i]!.trim();
      if (q.multiSelect === true) {
        const picked = [...multiChecked[i]!];
        if (trimmed) picked.push(trimmed);
        return trimmed
          ? { answers: picked, wasCustom: true, customAnswers: [trimmed] }
          : picked;
      }
      if (trimmed) return { answers: [trimmed], wasCustom: true, customAnswers: [trimmed] };
      return values[i]!;
    });
    onSubmit({ questionId: pending.questionId, answers });
  };

  if (submitted) {
    return <SubmittedPlaceholder label="正在等待问卷结果…" />;
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-slate-600 dark:text-slate-300">
        以下 {questions.length} 个问题，请逐题作答后统一提交
      </div>
      {/* 标签页导航 */}
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q, i) => {
          const answered = q.multiSelect === true
            ? multiChecked[i]!.size > 0 || Boolean(customs[i]!.trim())
            : values[i] !== null || Boolean(customs[i]!.trim());
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => setActive(i)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 ${
                i === active
                  ? 'border-indigo-400 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200'
                  : answered
                    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
              }`}
            >
              {answered && <Check className="w-3 h-3 shrink-0" />}
              {label(q, i)}
            </button>
          );
        })}
      </div>

      {/* 当前题 */}
      <div key={active} className="pt-1">
        {questions[active]!.multiSelect === true ? (
          <MultiQuestionForm
            question={questions[active]!.question}
            options={questions[active]!.options}
            disabled={disabled}
            checked={multiChecked[active]!}
            custom={customs[active]!}
            onToggle={(option) =>
              setMultiChecked((prev) => {
                const next = [...prev];
                const set = new Set(next[active]);
                if (set.has(option)) set.delete(option);
                else set.add(option);
                next[active] = set;
                return next;
              })
            }
            onCustomChange={(v) => setCustoms((prev) => prev.map((c, i) => (i === active ? v : c)))}
          />
        ) : (
          <SingleQuestionForm
            question={questions[active]!.question}
            options={questions[active]!.options}
            disabled={disabled}
            value={values[active]!}
            custom={customs[active]!}
            onChange={(v) => {
              setValues((prev) => prev.map((p, i) => (i === active ? v : p)));
              // 单选完成自动跳到下一题
              if (v !== null && active < questions.length - 1) {
                setTimeout(() => setActive((a) => (a === active ? a + 1 : a)), 220);
              }
            }}
            onCustomChange={(v) => setCustoms((prev) => prev.map((c, i) => (i === active ? v : c)))}
          />
        )}
      </div>

      {/* 上一步 / 下一步 / 提交 / 取消 */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={disabled || active === 0}
          onClick={() => setActive((a) => Math.max(0, a - 1))}
          className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-40"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          上一步
        </button>
        <button
          type="button"
          disabled={disabled || active === questions.length - 1}
          onClick={() => setActive((a) => Math.min(questions.length - 1, a + 1))}
          className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-40"
        >
          下一步
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCancel({ questionId: pending.questionId, answer: null, cancelled: true })}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          disabled={disabled || !allAnswered}
          onClick={handleSubmit}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 ${allAnswered ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500'}`}
        >
          提交全部
        </button>
      </div>
      {!allAnswered && (
        <div className="text-[11px] text-slate-400 dark:text-slate-500">还有题目未作答</div>
      )}
    </div>
  );
}

function FormActions({
  disabled,
  primaryLabel,
  primaryDisabled,
  onPrimary,
  onCancel,
}: {
  disabled: boolean;
  primaryLabel: string;
  primaryDisabled: boolean;
  onPrimary: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <button
        type="button"
        disabled={disabled}
        onClick={onCancel}
        className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
      >
        取消
      </button>
      <button
        type="button"
        disabled={disabled || primaryDisabled}
        onClick={onPrimary}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 ${primaryDisabled ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
      >
        {primaryLabel}
      </button>
    </div>
  );
}

function SubmittedPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
      <LoaderPulse />
      <span>{label}</span>
    </div>
  );
}

function LoaderPulse() {
  return (
    <span className="w-3 h-3 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin shrink-0" />
  );
}

/** 已回答结果：单选 ✓ 答案 / 自定义 ✓ 自己输入 / 多选逐行 / 取消 warning / 问卷逐题。 */
function ResultView({
  details,
  content,
}: {
  details?: AskQuestionResultDetails | null;
  content?: string;
}) {
  if (!details) {
    // 降级：details 缺失时展示 content text
    return content ? (
      <div className="text-[12px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed break-words">
        {content}
      </div>
    ) : (
      <div className="text-[12px] text-slate-400 dark:text-slate-500">（工具已返回结果）</div>
    );
  }

  // 取消：warning 色
  if (details.cancelled === true) {
    return (
      <div className="space-y-1.5">
        {details.questions?.map((q, i) => (
          <div key={i} className="text-[12px] text-amber-700 dark:text-amber-300 break-words">
            <span className="font-medium">{q.label || `问题 ${i + 1}`}：</span>
            未回答
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
          <X className="w-3.5 h-3.5" />
          用户取消{details.questions?.length ? '了问卷' : ''}
        </div>
      </div>
    );
  }

  // 问卷：逐题
  if (details.questions && details.questions.length > 0) {
    return (
      <div className="space-y-1.5">
        {details.questions.map((q, i) => (
          <ResultLine key={i} item={q} label={q.label || `问题 ${i + 1}`} />
        ))}
      </div>
    );
  }

  // 单题
  return <ResultLine item={details} />;
}

function ResultLine({ item, label }: { item: AskQuestionResultItem; label?: string }) {
  const answer = item.answer;
  const isMulti = item.multiSelect === true || Array.isArray(answer);

  const renderValue = () => {
    const values: string[] = Array.isArray(answer) ? answer.map(String) : answer != null && answer !== '' ? [String(answer)] : [];
    if (values.length === 0) {
      return <span className="text-slate-400 dark:text-slate-500">未回答</span>;
    }
    if (isMulti) {
      return (
        <div className="flex flex-col gap-0.5">
          {values.map((v, i) => (
            <div key={i} className="flex items-start gap-1.5 break-words">
              <Check className={`w-3.5 h-3.5 ${item.wasCustom ? 'text-sky-500' : 'text-emerald-500'} shrink-0 mt-0.5`} />
              <span>{v}</span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="flex items-start gap-1.5 break-words">
        <Check className={`w-3.5 h-3.5 ${item.wasCustom ? 'text-sky-500' : 'text-emerald-500'} shrink-0 mt-0.5`} />
        <span>
          {item.wasCustom === true && <span className="text-sky-600 dark:text-sky-400 font-medium">{'自己输入：'}</span>}
          {values[0]}
        </span>
      </div>
    );
  };

  return (
    <div className="text-[12px] text-slate-700 dark:text-slate-300">
      {label && <span className="font-medium text-slate-600 dark:text-slate-400">{label}：</span>}
      {renderValue()}
    </div>
  );
}

/** 卡片外壳：与现有工具卡片一致的浅色圆角卡片。 */
function CardShell({
  children,
  header,
  tone = 'form',
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  tone?: 'form' | 'result' | 'cancelled';
}) {
  const border =
    tone === 'cancelled'
      ? 'border-amber-200 dark:border-amber-800'
      : tone === 'result'
        ? 'border-emerald-200 dark:border-emerald-800'
        : 'border-indigo-200 dark:border-indigo-800';
  return (
    <div className={`bg-white dark:bg-slate-800/70 border ${border} rounded-xl overflow-hidden`}>
      <div className="px-3 py-2 flex items-center gap-2 border-b border-slate-100 dark:border-slate-700/60 bg-slate-50/80 dark:bg-slate-900/40">
        {header}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function PendingHeader({ multiSelect, questionnaire }: { multiSelect?: boolean; questionnaire?: boolean }) {
  return (
    <>
      <CircleHelp className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
      <span className="text-xs font-semibold text-indigo-800 dark:text-indigo-300 font-mono">
        {questionnaire ? 'ask_question（问卷）' : multiSelect ? 'ask_question（多选）' : 'ask_question'}
      </span>
      <span className="text-[10px] text-indigo-500/70 dark:text-indigo-400/60 ml-auto shrink-0">等待回答</span>
    </>
  );
}

function ResultHeader({ cancelled, questionnaire }: { cancelled?: boolean; questionnaire?: boolean }) {
  if (cancelled) {
    return (
      <>
        <X className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 font-mono">ask_question</span>
        <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70 ml-auto shrink-0">已取消</span>
      </>
    );
  }
  return (
    <>
      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 font-mono">ask_question</span>
      <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 ml-auto shrink-0">
        {questionnaire ? '问卷已回答' : '已回答'}
      </span>
    </>
  );
}

export default function AskQuestionCard(props: AskQuestionCardProps) {
  if (props.mode === 'pending') {
    const isQuestionnaire = Array.isArray(props.pending.questions) && props.pending.questions.length > 0;
    return (
      <CardShell
        tone="form"
        header={
          <PendingHeader
            multiSelect={props.pending.multiSelect === true}
            questionnaire={isQuestionnaire}
          />
        }
      >
        {isQuestionnaire ? (
          <PendingQuestionnaire
            pending={props.pending}
            disabled={props.disabled}
            submitted={props.submitted}
            onSubmit={props.onSubmit}
            onCancel={props.onCancel}
          />
        ) : (
          <PendingSingle
            pending={props.pending}
            disabled={props.disabled}
            submitted={props.submitted}
            onSubmit={props.onSubmit}
            onCancel={props.onCancel}
          />
        )}
      </CardShell>
    );
  }

  // result mode
  return (
    <CardShell tone={props.details?.cancelled ? 'cancelled' : 'result'} header={<ResultHeader cancelled={props.details?.cancelled} questionnaire={!!(props.details?.questions?.length)} />}>
      <ResultView details={props.details ?? null} content={props.content} />
    </CardShell>
  );
}
