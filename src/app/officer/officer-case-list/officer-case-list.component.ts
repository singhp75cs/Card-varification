import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AgGridModule } from 'ag-grid-angular';
import { GridApi, GridReadyEvent, RowClickedEvent } from 'ag-grid-community';
import { CASE_COLUMNS, CASE_DEFAULT_COL_DEF } from '../../config/case-columns';
import { DASHBOARD_GRID_THEME } from '../../config/grid-theme';
import { Case, CaseService } from '../../services/case.service';

/** Grid of the field officer's own verification cases. */
@Component({
  selector: 'app-officer-case-list',
  standalone: true,
  imports: [CommonModule, FormsModule, AgGridModule],
  templateUrl: './officer-case-list.component.html',
  styleUrls: ['./officer-case-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OfficerCaseListComponent implements OnInit {
  columnDefs = CASE_COLUMNS;
  defaultColDef = CASE_DEFAULT_COL_DEF;
  theme = DASHBOARD_GRID_THEME;
  rowData: Case[] = [];
  private gridApi?: GridApi;
  loading = true;
  error = '';

  constructor(private cases: CaseService, private router: Router) {}

  ngOnInit(): void {
    this.cases.list().subscribe({
      next: (data) => {
        this.rowData = data;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to load cases';
        this.loading = false;
      },
    });
  }

  onGridReady(params: GridReadyEvent): void {
    this.gridApi = params.api;
    this.gridApi.sizeColumnsToFit();
  }

  onRowClicked(event: RowClickedEvent<Case>): void {
    const row = event.data;
    if (row) {
      this.router.navigate(['/officer/cases', row.caseRef]);
    }
  }

  onQuickFilterChanged(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.gridApi?.setGridOption('quickFilterText', value);
  }

  newCase(): void {
    this.router.navigate(['/officer/cases/new']);
  }
}
