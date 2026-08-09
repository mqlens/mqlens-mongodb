import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Combobox } from '../ui/combobox';

const options = [
  { value: 'sales.orders', label: 'orders', hint: 'sales' },
  { value: 'sales.users', label: 'users', hint: 'sales' },
  { value: 'archive.orders', label: 'orders', hint: 'archive' },
];

const renderBox = (onChange = vi.fn(), value: string | null = null) => {
  render(
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder="All collections"
      searchPlaceholder="Search collections…"
      emptyMessage="No collection matches"
      emptyOptionLabel="All collections"
      data-testid="box"
    />
  );
  return onChange;
};

describe('Combobox', () => {
  it('shows the placeholder until something is chosen', () => {
    renderBox();
    expect(screen.getByTestId('box')).toHaveTextContent('All collections');
  });

  it('shows the chosen option, not the placeholder', () => {
    renderBox(vi.fn(), 'sales.users');
    expect(screen.getByTestId('box')).toHaveTextContent('users');
  });

  it('filters as you type', async () => {
    renderBox();
    fireEvent.click(screen.getByTestId('box'));

    fireEvent.change(await screen.findByPlaceholderText('Search collections…'), {
      target: { value: 'users' },
    });

    expect(await screen.findByText('users')).toBeInTheDocument();
    // The two `orders` entries are filtered out — this is the whole reason a
    // native select was not good enough.
    expect(screen.queryAllByText('orders')).toHaveLength(0);
  });

  it('searches the hint too, so same-named collections can be told apart', async () => {
    renderBox();
    fireEvent.click(screen.getByTestId('box'));

    fireEvent.change(await screen.findByPlaceholderText('Search collections…'), {
      target: { value: 'archive' },
    });

    expect(await screen.findByText('archive')).toBeInTheDocument();
    expect(screen.queryByText('sales')).toBeNull();
  });

  it('reports the chosen value', async () => {
    const onChange = renderBox();
    fireEvent.click(screen.getByTestId('box'));
    fireEvent.click(await screen.findByText('users'));

    expect(onChange).toHaveBeenCalledWith('sales.users');
  });

  it('clears the selection through the empty option', async () => {
    const onChange = renderBox(vi.fn(), 'sales.users');
    fireEvent.click(screen.getByTestId('box'));
    // The trigger also renders the label, so pick the one inside the list.
    const items = await screen.findAllByText('All collections');
    fireEvent.click(items[items.length - 1]);

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('says so when nothing matches', async () => {
    renderBox();
    fireEvent.click(screen.getByTestId('box'));
    fireEvent.change(await screen.findByPlaceholderText('Search collections…'), {
      target: { value: 'zzz' },
    });

    expect(await screen.findByText('No collection matches')).toBeInTheDocument();
  });
});
