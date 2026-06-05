import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco" data-value={value} />,
}));

import { QueryEditor } from '../QueryEditor';

describe('QueryEditor', () => {
  it('renders a Monaco editor with the given value', () => {
    const { getByTestId } = render(
      <QueryEditor surface="aggStage" value='{ "$match": {} }' onChange={() => {}} fields={['region']} schema={undefined} />,
    );
    expect(getByTestId('monaco').getAttribute('data-value')).toBe('{ "$match": {} }');
  });
});
