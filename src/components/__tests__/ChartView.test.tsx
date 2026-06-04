import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChartView } from '../ChartView';

const docs = [
  { region: 'NA', seats: 3, spend: 100 },
  { region: 'EU', seats: 4, spend: 200 },
  { region: 'NA', seats: 5, spend: 50 },
];
const columns = ['region', 'seats', 'spend'];

describe('ChartView', () => {
  it('renders the control bar with mode and type controls', () => {
    render(<ChartView documents={docs} columns={columns} />);
    expect(screen.getByLabelText('Aggregate')).toBeTruthy();
    expect(screen.getByLabelText('Raw')).toBeTruthy();
    expect(screen.getByLabelText('Chart type')).toBeTruthy();
  });

  it('populates the X-axis picker with all fields', () => {
    render(<ChartView documents={docs} columns={columns} />);
    const x = screen.getByLabelText('X axis') as HTMLSelectElement;
    const opts = Array.from(x.options).map((o) => o.value);
    expect(opts).toEqual(expect.arrayContaining(['region', 'seats', 'spend']));
  });

  it('shows the caveat with the loaded document count', () => {
    render(<ChartView documents={docs} columns={columns} />);
    expect(screen.getByText(/Charting 3 loaded/i)).toBeTruthy();
  });

  it('shows an empty message when there are no documents', () => {
    render(<ChartView documents={[]} columns={[]} />);
    expect(screen.getByText(/Run a query to chart/i)).toBeTruthy();
  });

  it('in Raw mode with no numeric field selected, prompts for a numeric field', () => {
    render(<ChartView documents={[{ name: 'a' }]} columns={['name']} />);
    fireEvent.click(screen.getByLabelText('Raw'));
    expect(screen.getByText(/no numeric field/i)).toBeTruthy();
  });
});
