/**
 * Card — Atlas `ui-generated/card.tsx`: the card surface (panel radius, hairline, `--ds-surface`, ink)
 * with its parts. CardHeader lays out a title and description with an optional CardAction beside them;
 * CardTitle is a real heading (h3 by default; pick the level the page needs with `as`).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { RADIUS_PANEL } from './recipes';

export const CARD = `flex min-w-0 flex-col gap-6 ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)] transition-[border-color,box-shadow,background-color] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)]`;
/** The body face, semibold (bridge D2: Atlas CardTitle sets no display face). */
export const CARD_TITLE = 'm-0 text-[length:var(--ds-text-lg)] font-semibold leading-6 tracking-[-0.01em]';
export const CARD_DESCRIPTION = 'm-0 text-pretty text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card({ className, ...rest }, ref) {
  return <div {...rest} ref={ref} data-slot="card" className={cn(CARD, className)} />;
});

export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      data-slot="card-header"
      className={cn('grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 pt-6 has-[[data-slot=card-action]]:grid-cols-[1fr_auto]', className)}
    />
  );
}

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  as?: 'h2' | 'h3' | 'h4';
}

export function CardTitle({ as: Heading = 'h3', className, ...rest }: CardTitleProps) {
  return <Heading {...rest} data-slot="card-title" className={cn(CARD_TITLE, className)} />;
}

export function CardDescription({ className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} data-slot="card-description" className={cn(CARD_DESCRIPTION, className)} />;
}

export function CardAction({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} data-slot="card-action" className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)} />;
}

export function CardContent({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} data-slot="card-content" className={cn('px-6 [&:last-child]:pb-6', className)} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} data-slot="card-footer" className={cn('flex items-center px-6 pb-6', className)} />;
}
