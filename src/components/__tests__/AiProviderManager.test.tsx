import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiProviderManager, slugify, emptyProvider, type AiProvider } from '../AiProviderManager';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    command: '',
    needsKey: true,
  },
  {
    id: 'opencode',
    name: 'opencode (local CLI)',
    kind: 'local-cli',
    baseUrl: '',
    model: '',
    command: 'opencode run {prompt}',
    needsKey: false,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
    if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
    return Promise.resolve(null);
  });
});

function setup(providers: AiProvider[] = []) {
  const onChange = vi.fn();
  render(
    <AiProviderManager providers={providers} onChange={onChange} reservedIds={['openai', 'anthropic']} />
  );
  return onChange;
}

describe('slugify', () => {
  it('derives a safe id from the display name', () => {
    expect(slugify('DeepSeek', [])).toBe('deepseek');
    expect(slugify('My Local Ollama!', [])).toBe('my-local-ollama');
    expect(slugify('  ', [])).toBe('provider');
  });

  it('never collides with an id already in use', () => {
    // The id is what `ai_provider` stores, so a collision would silently
    // repoint the active provider at somebody else's endpoint and key.
    expect(slugify('OpenAI', ['openai'])).toBe('openai-2');
    expect(slugify('OpenAI', ['openai', 'openai-2'])).toBe('openai-3');
  });
});

describe('AiProviderManager', () => {
  it('lists configured providers with their format and target', () => {
    setup([
      { ...emptyProvider(), id: 'ds', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { ...emptyProvider(), id: 'oc', name: 'opencode', kind: 'local-cli', command: 'opencode run {prompt}' },
    ]);
    expect(screen.getByTestId('ai-provider-row-ds')).toHaveTextContent('DeepSeek');
    expect(screen.getByTestId('ai-provider-row-ds')).toHaveTextContent('deepseek-chat');
    expect(screen.getByTestId('ai-provider-row-oc')).toHaveTextContent('opencode run {prompt}');
  });

  it('adds a provider, generating its id from the name', async () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'DeepSeek' } });
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
      target: { value: 'https://api.deepseek.com/v1' },
    });
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'deepseek-chat' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'openai-compatible',
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      }),
    ]);
  });

  it('validates through the backend rather than duplicating the rules', async () => {
    // The request path enforces these; checking here too would let the two drift.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
      return Promise.reject('Test provider needs a model name.');
    });
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'Broken' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() =>
      expect(screen.getByTestId('ai-provider-error')).toHaveTextContent('needs a model name')
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-provider-form')).toBeInTheDocument();
  });

  it('shows a command field instead of an endpoint for a local CLI', () => {
    // Editing an existing CLI provider reaches the same form state the kind
    // selector produces, without needing to drive Radix Select in jsdom.
    setup([{ ...emptyProvider(), id: 'oc', name: 'opencode', kind: 'local-cli', command: 'opencode run {prompt}' }]);
    fireEvent.click(screen.getByTestId('ai-provider-edit-oc'));

    expect(screen.getByTestId('ai-provider-command-input')).toHaveValue('opencode run {prompt}');
    expect(screen.queryByTestId('ai-provider-url-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-provider-model-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-provider-key-input')).not.toBeInTheDocument();
  });

  it('offers an endpoint rather than a command for an HTTP provider', () => {
    setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    expect(screen.getByTestId('ai-provider-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('ai-provider-model-input')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-provider-command-input')).not.toBeInTheDocument();
  });

  it('removes a provider', () => {
    const onChange = setup([
      { ...emptyProvider(), id: 'ds', name: 'DeepSeek', base_url: 'https://x/v1', model: 'm' },
      { ...emptyProvider(), id: 'oc', name: 'opencode', kind: 'local-cli', command: 'x {prompt}' },
    ]);
    fireEvent.click(screen.getByTestId('ai-provider-remove-ds'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'oc' })]);
  });

  it('edits in place without creating a second entry', async () => {
    const onChange = setup([
      { ...emptyProvider(), id: 'ds', name: 'DeepSeek', base_url: 'https://x/v1', model: 'old-model' },
    ]);
    fireEvent.click(screen.getByTestId('ai-provider-edit-ds'));
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'new-model' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'ds', model: 'new-model' });
  });

  it('still lets a provider be added when presets cannot be loaded', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'ai_provider_presets') return Promise.reject('offline');
      return Promise.resolve('ok');
    });
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    await waitFor(() =>
      expect(screen.queryByTestId('ai-provider-preset-select')).not.toBeInTheDocument()
    );
    fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'Manual' } });
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'llama3' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('trims whitespace so a pasted key or URL still works', async () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: ' Groq ' } });
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
      target: { value: '  https://api.groq.com/openai/v1  ' },
    });
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: ' llama-3.1 ' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0][0]).toMatchObject({
      name: 'Groq',
      base_url: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1',
    });
  });
});
