import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// A masked text input with a show/hide toggle. Forwards all standard input props
// (value, onChange, placeholder, className, data-testid, …) to the inner input.
export const PasswordInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...rest }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="mql-password-field">
      <input {...rest} type={show ? 'text' : 'password'} className={className} />
      <button
        type="button"
        className="mql-password-toggle"
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide' : 'Show'}
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
      >
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
};
