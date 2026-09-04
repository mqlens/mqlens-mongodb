import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { useTabScopedOpen } from '@/workspace/tabVisibility';

/** Radix's root; the popover closes when the tab it belongs to is hidden (#240). */
const Popover: React.FC<React.ComponentProps<typeof PopoverPrimitive.Root>> = ({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}) => <PopoverPrimitive.Root {...props} {...useTabScopedOpen({ open, defaultOpen, onOpenChange })} />;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
