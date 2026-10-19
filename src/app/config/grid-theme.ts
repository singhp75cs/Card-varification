import { themeQuartz } from 'ag-grid-community';

/**
 * Shared AG Grid theme (v33 Theming API).
 *
 * AG Grid 33+ dropped the legacy CSS-file themes (`ag-theme-quartz.css` no
 * longer ships). Theming is now done with a JS theme object passed to the grid
 * via [theme]. We build an explicit dark theme from Quartz using SOLID colors
 * (no transparent row backgrounds over a light default — that is what produced
 * washed-out light rows) so every surface matches the navy dashboard palette.
 */
export const DASHBOARD_GRID_THEME = themeQuartz.withParams({
  // Surfaces — all solid, all dark navy
  backgroundColor: '#111e35',
  chromeBackgroundColor: '#0f1c30',
  headerBackgroundColor: '#0f1c30',
  oddRowBackgroundColor: '#15243f',
  // Text
  foregroundColor: '#e2e8f0',
  headerTextColor: '#94a3b8',
  // Interaction
  rowHoverColor: 'rgba(59, 130, 246, 0.18)',
  selectedRowBackgroundColor: 'rgba(59, 130, 246, 0.28)',
  accentColor: '#3b82f6',
  // Borders
  borderColor: 'rgba(99, 179, 237, 0.18)',
  rowBorder: { style: 'solid', width: 1, color: 'rgba(99, 179, 237, 0.1)' },
  headerColumnBorder: false,
  wrapperBorder: false,
  // Inputs / popups inside the grid (filters, menus) stay dark
  inputBackgroundColor: '#0f1c30',
  menuBackgroundColor: '#111e35',
  // Typography & sizing
  fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 700,
  cellTextColor: '#e2e8f0',
  rowHeight: 52,
  headerHeight: 48,
  cellHorizontalPadding: 20,
  spacing: 8,
  borderRadius: 10,
  wrapperBorderRadius: 12,
});
