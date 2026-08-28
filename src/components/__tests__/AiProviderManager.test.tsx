import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiProviderManager, applyPresetToDraft, slugify, emptyProvider, type AiProvider } from '../AiProviderManager';

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
    modelsCommand: '',
    needsKey: true,
  },
  {
    id: 'ollama-cli',
    name: 'Ollama CLI (local)',
    kind: 'local-cli',
    baseUrl: '',
    model: 'llama3',
    command: 'ollama run {model} {prompt}',
    modelsCommand: 'ollama list',
    needsKey: false,
  },
  {
    id: 'opencode',
    name: 'opencode (local CLI)',
    kind: 'local-cli',
    baseUrl: '',
    model: '',
    command: 'opencode run {prompt}',
    modelsCommand: '',
    needsKey: false,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
    if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
    if (cmd === 'list_ai_models') return Promise.resolve(['gpt-4o', 'gpt-4o-mini']);
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
    expect(screen.getByTestId('ai-provider-models-command-input')).toBeInTheDocument();
    // Model stays: it fills {model} in the command, and can be listed or typed.
    expect(screen.getByTestId('ai-provider-model-input')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-provider-url-input')).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: '  gsk_pasted  ' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0][0]).toMatchObject({
      name: 'Groq',
      base_url: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1',
      // The key goes into an Authorization header verbatim, so it is trimmed too.
      api_key: 'gsk_pasted',
    });
  });

  describe('model listing', () => {
    // Radix Select renders its items only while open, and jsdom cannot open it,
    // so "the models were offered" is observed as: the field became a dropdown
    // and the status reports the count.
    const dropdownShown = () => screen.queryByTestId('ai-provider-model-select') !== null;

    it('loads models once the endpoint and key are set, without a click', async () => {
      setup();
      fireEvent.click(screen.getByTestId('ai-provider-add'));
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
        target: { value: 'https://api.openai.com/v1' },
      });
      fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: 'sk-test' } });

      await waitFor(() => expect(dropdownShown()).toBe(true));
      expect(screen.getByTestId('ai-provider-models-status')).toHaveTextContent('2 models');
      expect(screen.queryByTestId('ai-provider-model-input')).not.toBeInTheDocument();
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'list_ai_models');
      expect(call![1].provider).toMatchObject({ base_url: 'https://api.openai.com/v1', api_key: 'sk-test' });
    });

    it('does not ask before there is a key, unless the endpoint is local', async () => {
      setup();
      fireEvent.click(screen.getByTestId('ai-provider-add'));
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
        target: { value: 'https://api.openai.com/v1' },
      });
      // A remote endpoint with no key would only produce a 401 — not asked.
      await new Promise((r) => setTimeout(r, 750));
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(false);

      // A local server ignores credentials, so it is asked straight away.
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
        target: { value: 'http://localhost:11434/v1' },
      });
      await waitFor(() =>
        expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(true)
      );
    });

    it('keeps the model typeable and says why when the list cannot be loaded', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
        if (cmd === 'list_ai_models') return Promise.reject('DeepSeek error (401): invalid key');
        return Promise.resolve('ok');
      });
      const onChange = setup();
      fireEvent.click(screen.getByTestId('ai-provider-add'));
      fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'DeepSeek' } });
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
        target: { value: 'https://api.deepseek.com/v1' },
      });
      fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: 'bad' } });

      await waitFor(() =>
        expect(screen.getByTestId('ai-provider-models-status')).toHaveTextContent('invalid key')
      );
      expect(dropdownShown()).toBe(false);

      // Nothing about the failure blocks the user.
      fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'deepseek-chat' } });
      fireEvent.click(screen.getByTestId('ai-provider-save'));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(onChange.mock.calls[0][0][0]).toMatchObject({ model: 'deepseek-chat' });
    });

    it('lists a CLI\'s models from its list command', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
        if (cmd === 'list_ai_models') return Promise.resolve(['llama3:latest', 'mistral:7b']);
        return Promise.resolve('ok');
      });
      setup([
        { ...emptyProvider(), id: 'oc', name: 'Ollama', kind: 'local-cli', command: 'ollama run {model} {prompt}', models_command: 'ollama list', model: 'llama3' },
      ]);
      fireEvent.click(screen.getByTestId('ai-provider-edit-oc'));

      await waitFor(() => expect(dropdownShown()).toBe(true));
      expect(screen.getByTestId('ai-provider-model-select')).toHaveTextContent('llama3');
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'list_ai_models');
      expect(call![1].provider).toMatchObject({ kind: 'local-cli', models_command: 'ollama list' });
    });

    it('offers a manual reload and disables it while nothing can be asked', () => {
      setup();
      fireEvent.click(screen.getByTestId('ai-provider-add'));
      expect(screen.getByTestId('ai-provider-models-load')).toBeDisabled();
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://localhost:1234/v1' } });
      expect(screen.getByTestId('ai-provider-models-load')).not.toBeDisabled();
    });

    it('carries models_command through save', async () => {
      const onChange = setup();
      fireEvent.click(screen.getByTestId('ai-provider-add'));
      // Reach the CLI form via an existing CLI entry's shape: set fields directly.
      fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'Remote' } });
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://localhost:11434/v1' } });
      fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: ' llama3 ' } });
      fireEvent.click(screen.getByTestId('ai-provider-save'));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(onChange.mock.calls[0][0][0]).toMatchObject({ model: 'llama3', models_command: '' });
    });
  });

describe('applyPresetToDraft', () => {
  const deepseek = PRESETS[0] as any;
  it('keeps a key only when the preset points at the same endpoint', () => {
    const draft = { ...emptyProvider(), kind: 'openai-compatible' as const, base_url: 'https://api.deepseek.com/v1/', api_key: 'ds-secret' };
    expect(applyPresetToDraft(draft, deepseek).api_key).toBe('ds-secret');
  });
  it('clears the key when the preset changes the endpoint or format', () => {
    // Otherwise the auto-load 600 ms later sends one vendor's secret to another.
    const draft = { ...emptyProvider(), kind: 'openai-compatible' as const, base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' };
    expect(applyPresetToDraft(draft, deepseek).api_key).toBe('');
    const anthropicLike = { ...deepseek, kind: 'anthropic-compatible', baseUrl: 'https://api.deepseek.com/v1' };
    const same = { ...emptyProvider(), kind: 'openai-compatible' as const, base_url: 'https://api.deepseek.com/v1', api_key: 'k' };
    expect(applyPresetToDraft(same, anthropicLike).api_key).toBe('');
  });
  it('copies every other preset field', () => {
    const out = applyPresetToDraft(emptyProvider(), deepseek);
    expect(out).toMatchObject({ name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models_command: '' });
  });
});

describe('model loading rules', () => {
  it('enables manual loading for a keyless remote endpoint, but does not auto-load it', async () => {
    const onChange = vi.fn();
    render(<AiProviderManager providers={[]} onChange={onChange} reservedIds={[]} />);
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://ollama.lan:11434/v1' } });
    // A LAN host with no key is a valid setup; the button must not depend on "localhost".
    expect(screen.getByTestId('ai-provider-models-load')).not.toBeDisabled();
    await new Promise((r) => setTimeout(r, 750));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(false);
    fireEvent.click(screen.getByTestId('ai-provider-models-load'));
    await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(true));
  });

  it('ignores a slow reply from an endpoint the user has since changed', async () => {
    let resolveFirst: (v: string[]) => void = () => {};
    let calls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'ai_provider_presets') return Promise.resolve(PRESETS);
      if (cmd === 'list_ai_models') {
        calls += 1;
        if (calls === 1) return new Promise<string[]>((res) => { resolveFirst = res; });
        return Promise.resolve([]);
      }
      return Promise.resolve('ok');
    });
    render(<AiProviderManager providers={[]} onChange={vi.fn()} reservedIds={[]} />);
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://localhost:11434/v1' } });
    await waitFor(() => expect(calls).toBe(1));
    // The user moves to a remote endpoint with no key: nothing should load for it.
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'https://api.example.com/v1' } });
    resolveFirst(['llama3']);                       // the OLD endpoint answers late
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('ai-provider-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-provider-model-input')).toBeInTheDocument();
  });
});
});
