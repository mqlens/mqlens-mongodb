import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// A masked text input with a show/hide toggle. Forwards all standard input props
// (value, onChange, placeholder, className, data-testid, …) to the inner input.
export const PasswordInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
  className,
  ...rest
}) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        {...rest}
        type={show ? 'text' : 'password'}
        className={cn('pr-9', className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0 top-0 h-full rounded-l-none px-2 text-muted-foreground hover:text-foreground"
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide' : 'Show'}
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
      >
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </Button>
    </div>
  );
};
