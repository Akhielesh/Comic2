/**
 * Menu — Atlas `ui-generated/dropdown-menu.tsx` on Radix (`@radix-ui/react-dropdown-menu`) and the `--ds-*` tokens: the
 * app's one action menu (⋯ menus, "More" buttons), replacing the hand-rolled ones as their surfaces move.
 *
 * Radix supplies the behaviour: the trigger opens it on a press, Enter, Space or ↓ (↑ opens at the last item); the
 * arrow keys move between items with roving focus (Home / End jump, disabled items are skipped); typing a letter
 * jumps to the next item that starts with it (typeahead); Enter or Space chooses; Esc, a press outside or Tab closes
 * it and focus goes back to the trigger; → / ← open and close a submenu. It is portalled, flips to stay on screen and
 * never grows past the space left (it scrolls inside).
 *
 * Mapped onto the recipes: the panel is OVERLAY on the Z.popover layer; a highlighted row (pointer or keyboard) takes
 * `--ds-overlay-hover` (Atlas's menu highlight, white 8 % in dark), keyboard focus also draws the inset ring; a
 * destructive row reads the danger text ink (always with its words). Every row is 44 px tall under a coarse pointer
 * (DENSITY.coarse). The panel enters with `ds-scale-in` from the trigger's side (none under reduced motion).
 */
import React from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import { cn } from '../../lib/utils';
// Not in components/ds/recipes.ts yet (a wave note adds it); from the single source.
import { OVERLAY } from '../chat/studioDesign';
import { DENSITY, TONE_TEXT, Z } from './recipes';
import { useReducedMotion } from './useReducedMotion';

export type MenuItemVariant = 'default' | 'destructive';

/** The floating panel (also the submenu's). */
export const MENU_PANEL = `${OVERLAY} ${Z.popover} min-w-[8rem] max-w-[calc(100vw-1rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overflow-x-hidden p-1 origin-[var(--radix-dropdown-menu-content-transform-origin)]`;
/** A row: Atlas's item on the tokens; 44 px under a coarse pointer; its ink is chosen per variant (MENU_ROW_INK). */
export const MENU_ROW = `relative flex w-full min-w-0 cursor-default select-none items-center gap-2 rounded-[var(--ds-radius-control,8px)] px-2 py-2 text-left text-[length:var(--ds-text-base)] leading-5 outline-none transition-colors duration-[var(--ds-motion-fast,120ms)] ease-[var(--ds-ease,ease)] motion-reduce:transition-none data-[highlighted]:bg-[var(--ds-overlay-hover)] data-[state=open]:bg-[var(--ds-overlay-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-ring)] ${DENSITY.coarse} [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`;
export const MENU_ROW_INK: Record<MenuItemVariant, string> = {
  default: 'text-[var(--ds-ink)]',
  destructive: TONE_TEXT.danger
};
/** Checkbox and radio rows keep room for their mark at the start. */
export const MENU_ROW_CHOICE = 'pl-8';
export const MENU_ROW_MARK = 'pointer-events-none absolute left-2 flex size-4 items-center justify-center';
export const MENU_GROUP_LABEL = 'px-2 py-1.5 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] data-[inset]:pl-8';
export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-[var(--ds-hairline)]';
export const MENU_SHORTCUT = 'ml-auto pl-4 text-[length:var(--ds-text-xs)] tracking-widest text-[var(--ds-muted)]';

const inset = (on: boolean | undefined) => (on ? '' : undefined);
const entrance = (reduce: boolean) => (reduce ? '' : 'ds-scale-in');

export const Menu = MenuPrimitive.Root;
export type MenuProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Root>;
export const MenuGroup = MenuPrimitive.Group;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;
export const MenuSub = MenuPrimitive.Sub;

export const MenuTrigger = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Trigger>
>(function MenuTrigger(props, ref) {
  return <MenuPrimitive.Trigger ref={ref} data-slot="menu-trigger" {...props} />;
});

export const MenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContent({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) {
  const reduce = useReducedMotion();
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        data-slot="menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(MENU_PANEL, entrance(reduce), className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
});

export interface MenuItemProps extends React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> {
  /** Lines the label up with checkbox and radio rows. */
  inset?: boolean;
  /** `destructive` for a step that removes something: the danger text ink (the words still say what happens). */
  variant?: MenuItemVariant;
}

export const MenuItem = React.forwardRef<React.ElementRef<typeof MenuPrimitive.Item>, MenuItemProps>(function MenuItem(
  { className, inset: isInset, variant = 'default', ...props },
  ref
) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      data-slot="menu-item"
      data-variant={variant}
      data-inset={inset(isInset)}
      className={cn(MENU_ROW, MENU_ROW_INK[variant], className)}
      {...props}
    />
  );
});

export const MenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem>
>(function MenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <MenuPrimitive.CheckboxItem ref={ref} data-slot="menu-checkbox-item" className={cn(MENU_ROW, MENU_ROW_INK.default, MENU_ROW_CHOICE, className)} {...props}>
      <span className={MENU_ROW_MARK} aria-hidden="true">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
});

export const MenuRadioItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(function MenuRadioItem({ className, children, ...props }, ref) {
  return (
    <MenuPrimitive.RadioItem ref={ref} data-slot="menu-radio-item" className={cn(MENU_ROW, MENU_ROW_INK.default, MENU_ROW_CHOICE, className)} {...props}>
      <span className={MENU_ROW_MARK} aria-hidden="true">
        <MenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-current" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
});

export const MenuLabel = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label> & { inset?: boolean }
>(function MenuLabel({ className, inset: isInset, ...props }, ref) {
  return <MenuPrimitive.Label ref={ref} data-slot="menu-label" data-inset={inset(isInset)} className={cn(MENU_GROUP_LABEL, className)} {...props} />;
});

export const MenuSeparator = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(function MenuSeparator({ className, ...props }, ref) {
  return <MenuPrimitive.Separator ref={ref} data-slot="menu-separator" className={cn(MENU_SEPARATOR, className)} {...props} />;
});

/** A keyboard shortcut hint at the row's end (decoration: the row's name is its label). */
export function MenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="menu-shortcut" aria-hidden="true" className={cn(MENU_SHORTCUT, className)} {...props} />;
}

export const MenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger> & { inset?: boolean }
>(function MenuSubTrigger({ className, inset: isInset, children, ...props }, ref) {
  return (
    <MenuPrimitive.SubTrigger ref={ref} data-slot="menu-sub-trigger" data-inset={inset(isInset)} className={cn(MENU_ROW, MENU_ROW_INK.default, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-4 rtl:rotate-180" aria-hidden="true" />
    </MenuPrimitive.SubTrigger>
  );
});

export const MenuSubContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(function MenuSubContent({ className, collisionPadding = 8, ...props }, ref) {
  const reduce = useReducedMotion();
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent ref={ref} data-slot="menu-sub-content" collisionPadding={collisionPadding} className={cn(MENU_PANEL, entrance(reduce), className)} {...props} />
    </MenuPrimitive.Portal>
  );
});
