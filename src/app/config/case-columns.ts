import { ColDef } from 'ag-grid-community';
import { StatusButtonRendererComponent } from '../shared/status-button-renderer/status-button-renderer.component';

/** Shared default column behavior for every case grid. */
export const CASE_DEFAULT_COL_DEF: ColDef = {
  sortable: true,
  resizable: true,
  filter: true,
};

export const CASE_COLUMNS: ColDef[] = [
  { field: 'caseRef', headerName: 'Case Ref', filter: 'agTextColumnFilter' },
  { field: 'customerName', headerName: 'Applicant', flex: 1 },
  { field: 'verificationType', headerName: 'Card Type', flex: 1 },
  { field: 'siteId', headerName: 'Card / Ref No.', flex: 1 },
  {
    field: 'status',
    headerName: 'Status',
    flex: 1,
    filter: 'agTextColumnFilter',
    cellRenderer: StatusButtonRendererComponent,
  },
  { field: 'assignedOfficer', headerName: 'Officer', flex: 1 },
  { field: 'capturedAt', headerName: 'Submitted At', flex: 1 },
];
