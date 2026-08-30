import {
  useRef,
  useState,
  type ElementType,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export type BounceProps<T extends ElementType = 'div'> = {
  as?: T;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'children'>;

function mergeClass(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/**
 * 交互控件选择器：作为 Bounce 直接子级时，若触发按压缩放会把控件位移到指针外
 * （pointerup/click 丢失 → 控件点不动）。自身包裹独立 Bounce（如 PrimaryButton）的
 * 控件不在此列——其缩放以自身中心为原点，点位停留控件内，点击不受影响。
 */
const INTERACTIVE_SELECTOR =
  'input, select, textarea, label, button, a[href], summary, [role="button"], [contenteditable="true"]';

/**
 * 按压态用 JS 类而非 CSS :active 管理：:active 会沿祖先链激活嵌套的全部 Bounce，
 * 父级缩放使内部按钮位移，mouseup 落在按钮外导致 click 丢失。仅当命中链上最内层的
 * Bounce 是自身时才按压（卡片空白按下→卡片反馈；卡片内按钮按下→仅按钮反馈）。
 * 直接子级的交互控件（checkbox/label 等）同样会因父级缩放位移导致 click 丢失，
 * 因此这类目标也不触发按压，控件保持原位、点击正常。
 */
function usePress() {
  const ref = useRef<HTMLElement | null>(null);
  const [pressed, setPressed] = useState(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    const el = ref.current;
    if (!el || !el.contains(e.target as Node)) return;
    const target = e.target as Element;
    const hit = target.closest?.('.zh-bounce');
    if (!hit || hit !== el) return;
    const control = target.closest?.(INTERACTIVE_SELECTOR);
    if (control && control !== el) return;
    setPressed(true);
  };
  const release = () => setPressed(false);

  return { ref, pressed, onPointerDown, onPointerUp: release, onPointerCancel: release, onPointerLeave: release };
}

function BounceImpl<T extends ElementType = 'div'>({ baseClass, as, className, children, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, ...rest }: BounceProps<T> & { baseClass: string }) {
  const Tag: ElementType = as ?? 'div';
  const { ref, pressed, onPointerDown: down, onPointerUp: up, onPointerCancel: cancel, onPointerLeave: leave } = usePress();
  return (
    <Tag
      ref={ref}
      className={mergeClass(mergeClass(baseClass, className), pressed ? 'zh-bounce-pressed' : undefined)}
      onPointerDown={(e: ReactPointerEvent) => { down(e); onPointerDown?.(e); }}
      onPointerUp={(e: ReactPointerEvent) => { up(); onPointerUp?.(e); }}
      onPointerCancel={(e: ReactPointerEvent) => { cancel(); onPointerCancel?.(e); }}
      onPointerLeave={(e: ReactPointerEvent) => { leave(); onPointerLeave?.(e); }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** 弹跳容器：挂载入场弹跳 + 按压弹跳（zh-bounce）。as 支持 div/section/button 等 */
export function Bounce<T extends ElementType = 'div'>(props: BounceProps<T>) {
  return <BounceImpl baseClass="zh-bounce" {...props} />;
}

/** 品牌绿边框卡片外观（无弹跳），与 Bounce 组合等价 BounceCard */
export function Card<T extends ElementType = 'div'>({ as, className, children, ...rest }: BounceProps<T>) {
  const Tag: ElementType = as ?? 'div';
  return (
    <Tag className={mergeClass('border border-brand/50', className)} {...rest}>
      {children}
    </Tag>
  );
}

/** 绿色边框卡片 + 弹跳，页面卡片的统一入口 */
export function BounceCard<T extends ElementType = 'div'>(props: BounceProps<T>) {
  return <BounceImpl baseClass="zh-bounce border border-brand/50" {...props} />;
}
