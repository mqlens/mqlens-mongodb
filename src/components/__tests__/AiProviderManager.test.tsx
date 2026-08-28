import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AiProviderManager, applyPresetToDraft, keyRequiredFor, withEndpoint, originOf, slugify, emptyProvider, type AiProvider } from '../AiProviderManager';

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

describe('presets arriving after the draft is open', () => {
  it('still requires a key for a preset endpoint', async () => {
    // `commit` reads `presets` for `keyRequiredFor`, and the list is fetched. With
    // `presets` missing from the callback's deps it kept the initial empty array
    // whenever the list arrived after the last edit, so the check passed silently.
    let releasePresets: (v: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'ai_provider_presets') return new Promise((res) => { releasePresets = res; });
      if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
      return Promise.resolve(null);
    });
    const onChange = setup([]);

    // Fill in DeepSeek's endpoint with no key. Every keystroke changes `draft`,
    // so `commit` is rebuilt — the presets have to land *after* the last one.
    fireEvent.click(await screen.findByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'DeepSeek' } });
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'https://api.deepseek.com/v1' } });
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'deepseek-chat' } });

    await act(async () => {
      releasePresets(PRESETS);
    });

    fireEvent.click(screen.getByTestId('ai-provider-save'));

    // Named and refused here, rather than falling through to the backend.
    await screen.findByTestId('ai-provider-error');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('editing a provider that is removed underneath it', () => {
  it('closes the form instead of re-adding the provider on Save', async () => {
    // The draft still pointed at the removed provider, so Save found no match in
    // the list and pushed it back — silently undoing the removal.
    const deepseek: AiProvider = {
      id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible',
      base_url: 'https://api.deepseek.com/v1', api_key: 'sk-k', model: 'deepseek-chat',
      command: '', models_command: '',
    };
    const onChange = setup([deepseek]);

    fireEvent.click(await screen.findByTestId('ai-provider-edit-deepseek'));
    await screen.findByTestId('ai-provider-name-input');
    fireEvent.click(screen.getByTestId('ai-provider-remove-deepseek'));

    // The form is gone, so there is no Save left to undo the removal with.
    expect(screen.queryByTestId('ai-provider-name-input')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

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

  it('refuses to save a key-requiring preset with no key', async () => {
    // Rust deliberately allows a keyless provider for local servers, so it
    // cannot catch this — a DeepSeek entry with no key saved fine and then sent
    // the schema and prompt unauthenticated.
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    await waitFor(() => expect(screen.getByTestId('ai-provider-preset-select')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId('ai-provider-preset-select'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'DeepSeek' }));

    fireEvent.click(screen.getByTestId('ai-provider-save'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-provider-error')).toHaveTextContent(/needs an API key/)
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'validate_ai_provider')).toBe(false);

    // With a key it saves.
    fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: 'ds-key' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('stops demanding a key once the endpoint is pointed elsewhere', async () => {
    // DeepSeek as a starting point, then a keyless LAN server: previously this
    // could not be saved without inventing a key.
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    await waitFor(() => expect(screen.getByTestId('ai-provider-preset-select')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId('ai-provider-preset-select'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'DeepSeek' }));

    fireEvent.change(screen.getByTestId('ai-provider-url-input'), {
      target: { value: 'http://ollama.lan:11434/v1' },
    });
    fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'llama3' } });
    fireEvent.click(screen.getByTestId('ai-provider-save'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('does not demand a key for a keyless local preset', async () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    await waitFor(() => expect(screen.getByTestId('ai-provider-preset-select')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId('ai-provider-preset-select'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Ollama CLI (local)' }));
    fireEvent.click(screen.getByTestId('ai-provider-save'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
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
      // A CLI's command is never run automatically, so the list comes from the
      // explicit click.
      fireEvent.click(screen.getByTestId('ai-provider-models-load'));

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

  it('never runs a local command on its own', async () => {
    // A CLI entry is an arbitrary shell command; a debounce would run it while
    // it was still being typed, and a half-finished `touch …` has already
    // happened by then. Opening an existing CLI provider must not run it either.
    render(
      <AiProviderManager
        providers={[{ ...emptyProvider(), id: 'oc', name: 'Ollama', kind: 'local-cli', command: 'ollama run {model} {prompt}', models_command: 'ollama list', model: 'llama3' }]}
        onChange={vi.fn()}
        reservedIds={[]}
      />
    );
    fireEvent.click(screen.getByTestId('ai-provider-edit-oc'));
    await new Promise((r) => setTimeout(r, 750));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(false);

    // Editing the command does not run it either.
    fireEvent.change(screen.getByTestId('ai-provider-models-command-input'), { target: { value: 'ollama lis' } });
    await new Promise((r) => setTimeout(r, 750));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(false);

    // Only the explicit click does.
    fireEvent.click(screen.getByTestId('ai-provider-models-load'));
    await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'list_ai_models')).toBe(true));
  });

  it('drops an already-loaded list when the endpoint changes', async () => {
    // Dropping only the in-flight request left a loaded dropdown offering the
    // previous provider's models, and one could be saved against the new one.
    render(<AiProviderManager providers={[]} onChange={vi.fn()} reservedIds={[]} />);
    fireEvent.click(screen.getByTestId('ai-provider-add'));
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'http://localhost:11434/v1' } });
    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());

    // A remote endpoint whose key is unknown cannot auto-load: the stale list
    // must go, leaving a plain text box.
    fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'https://api.example.com/v1' } });
    await waitFor(() => {
      expect(screen.queryByTestId('ai-provider-model-select')).not.toBeInTheDocument();
      expect(screen.getByTestId('ai-provider-model-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-provider-models-status')).not.toHaveTextContent(/models available/);
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

describe('withEndpoint', () => {
  const keyed = { ...emptyProvider(), base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' };
  // The origin the key was entered for, tracked by the component — so "clear the
  // field, then paste another host" is still recognised as a host change.
  const ORIGIN = 'https://api.openai.com';
  it('clears the key when the host changes, so the auto-load cannot leak it', () => {
    expect(withEndpoint(keyed, 'https://api.deepseek.com/v1', ORIGIN).api_key).toBe('');
    // The scheme and the port are part of the origin: each is a different recipient.
    expect(withEndpoint(keyed, 'http://api.openai.com/v1', ORIGIN).api_key).toBe('');
    expect(withEndpoint(keyed, 'https://api.openai.com:8443/v1', ORIGIN).api_key).toBe('');
  });
  it('keeps the key for a path edit on the same host', () => {
    expect(withEndpoint(keyed, 'https://api.openai.com/v1/', ORIGIN).api_key).toBe('sk-openai');
    expect(withEndpoint(keyed, 'https://API.openai.com/v1/chat/completions', ORIGIN).api_key).toBe('sk-openai');
  });
  it('keeps the key while the new URL has no host yet', () => {
    // Clearing mid-keystroke protects nothing — nothing loads without a host.
    expect(withEndpoint(keyed, 'https://', ORIGIN).api_key).toBe('sk-openai');
    expect(withEndpoint(keyed, '', ORIGIN).api_key).toBe('sk-openai');
    expect(originOf('https://')).toBeNull();
  });

  it('clears the key for a host reqwest reaches but a regex pattern would miss', () => {
    // `https:evil.example/v1` and `https:/evil.example/v1` are request-valid:
    // WHATWG parsing — reqwest's and `URL`'s alike — normalizes both to
    // `https://evil.example`. Matching `https?://host` instead read them as
    // "no host yet", kept the key, and the model load 600 ms later sent it there.
    for (const sneaky of ['https:evil.example/v1', 'https:/evil.example/v1']) {
      expect(originOf(sneaky)).toBe('https://evil.example');
      expect(withEndpoint(keyed, sneaky, ORIGIN).api_key).toBe('');
    }
    // The same form pointing back at the key's own host is not a change.
    expect(withEndpoint(keyed, 'https:api.openai.com/v2', ORIGIN).api_key).toBe('sk-openai');
    // Schemes this app never requests over have no origin to compare.
    expect(originOf('file:///etc/passwd')).toBeNull();
  });

  it('still clears the key when a new host arrives after an emptied field', () => {
    // The reported hole: comparing against the previous *field value* kept the
    // key through "clear, then paste elsewhere", because one side was null each
    // time. Comparing against the key's own origin closes it.
    const emptied = withEndpoint(keyed, '', ORIGIN);
    expect(emptied.api_key).toBe('sk-openai');
    expect(withEndpoint(emptied, 'https://api.deepseek.com/v1', ORIGIN).api_key).toBe('');
  });

  it('keeps the key when no origin is recorded for it', () => {
    // A keyless draft, or a key whose origin is not known: nothing to compare.
    expect(withEndpoint(keyed, 'https://api.deepseek.com/v1', null).api_key).toBe('sk-openai');
  });
});

describe('keyRequiredFor', () => {
  const presets = [
    { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com/v1', model: '', command: '', modelsCommand: '', needsKey: true },
    { id: 'ollama', name: 'Ollama', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:11434/v1', model: '', command: '', modelsCommand: '', needsKey: false },
  ];
  it('is judged by the endpoint, not by which preset was clicked', () => {
    // Reopening a saved DeepSeek must still require its key: forgetting that let
    // the key be cleared and the schema sent out unauthenticated.
    expect(keyRequiredFor('https://api.deepseek.com/v1', presets)).toBe(true);
    expect(keyRequiredFor('https://API.DeepSeek.com/v1/chat/completions', presets)).toBe(true);
    // A different host is a different service, whatever it started from.
    expect(keyRequiredFor('http://ollama.lan:11434/v1', presets)).toBe(false);
    expect(keyRequiredFor('http://localhost:11434/v1', presets)).toBe(false);
    expect(keyRequiredFor('', presets)).toBe(false);
    expect(keyRequiredFor('https://api.deepseek.com/v1', [])).toBe(false);
  });
});
});
