import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test/render-with-providers';
import { screen, fireEvent } from '@testing-library/react';
import { ChartView } from '../ChartView';

const docs = [
  { region: 'NA', seats: 3, spend: 100 },
  { region: 'EU', seats: 4, spend: 200 },
  { region: 'NA', seats: 5, spend: 50 },
];
const columns = ['region', 'seats', 'spend'];

describe('ChartView', () => {
  it('renders the control bar with mode and type controls', () => {
    renderWithProviders(<ChartView documents={docs} columns={columns} />);
    expect(screen.getByRole('tab', { name: 'Aggregate' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Raw' })).toBeTruthy();
    expect(screen.getByLabelText('Chart type')).toBeTruthy();
  });

  it('populates the X-axis picker with all fields', () => {
    renderWithProviders(<ChartView documents={docs} columns={columns} />);
    fireEvent.click(screen.getByLabelText('X axis'));
    expect(screen.getByRole('option', { name: 'region' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'seats' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'spend' })).toBeTruthy();
  });

  it('shows the caveat with the loaded document count', () => {
    renderWithProviders(<ChartView documents={docs} columns={columns} />);
    expect(screen.getByText(/Charting 3 loaded/i)).toBeTruthy();
  });

  it('shows an empty message when there are no documents', () => {
    renderWithProviders(<ChartView documents={[]} columns={[]} />);
    expect(screen.getByText(/Run a query to chart/i)).toBeTruthy();
  });

  it('in Raw mode with no numeric field selected, prompts for a numeric field', () => {
    renderWithProviders(<ChartView documents={[{ name: 'a' }]} columns={['name']} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(screen.getByText(/no numeric field/i)).toBeTruthy();
  });
});
