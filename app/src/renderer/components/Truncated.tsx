/**
 * Text that explains itself when it does not fit.
 *
 * Hand-written `title` attributes go stale: the next narrow pane, or the next label someone adds,
 * quietly loses the tooltip again. This measures instead — when the text is actually cut off, the
 * element carries its full content as a tooltip, and when it fits, no tooltip appears to nag.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export interface TruncatedProps {
  children: ReactNode;
  /** Extra information, always shown on hover — a path behind a name, say. */
  title?: string;
  className?: string;
  /** `div` by default; a `span` where the surrounding layout expects inline. */
  as?: "div" | "span";
}

export function Truncated({ children, title, className = "", as = "div" }: TruncatedProps) {
  const ref = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // Set on the element rather than through state: the tooltip has to be there in the same frame
    // the text is cut, not one render later, or a reader hovering straight away finds nothing.
    //
    // One pixel of slack — sub-pixel layout makes scrollWidth exceed clientWidth by a hair on text
    // that is not actually cut. The text comes from the DOM, so a child that is not a plain string
    // is covered too.
    const clipped = element.scrollWidth > element.clientWidth + 1;
    const tooltip = title ?? (clipped ? element.textContent?.trim() ?? "" : "");
    if (tooltip) element.setAttribute("title", tooltip);
    else element.removeAttribute("title");
  }, [title]);

  useLayoutEffect(measure);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const Tag = as;
  return (
    <Tag ref={ref as never} className={`truncate ${className}`}>
      {children}
    </Tag>
  );
}
