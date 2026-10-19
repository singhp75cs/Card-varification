import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AgGridModule } from 'ag-grid-angular';
import { GridApi, GridReadyEvent, RowClickedEvent } from 'ag-grid-community';
import { CASE_COLUMNS, CASE_DEFAULT_COL_DEF } from '../../config/case-columns';
import { DASHBOARD_GRID_THEME } from '../../config/grid-theme';
import { Case, CaseService, CaseStats } from '../../services/case.service';
import { PMRChartComponent } from '../../pmr-chart/pmr-chart.component';

/** Front office KPI overview with the status chart and a cases grid. */
@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, AgGridModule, PMRChartComponent],
  templateUrl: './overview.component.html',
  styleUrls: ['./overview.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OverviewComponent implements OnInit {
  stats: CaseStats = {
    total: 0,
    draft: 0,
    submitted: 0,
    needsCorrection: 0,
    rejected: 0,
    completed: 0,
  };

  columnDefs = CASE_COLUMNS;
  defaultColDef = CASE_DEFAULT_COL_DEF;
  theme = DASHBOARD_GRID_THEME;
  rowData: Case[] = [];
  private gridApi?: GridApi;
  loading = true;
  error = '';

  constructor(private cases: CaseService, private router: Router) {}

  ngOnInit(): void {
    this.cases.getStats().subscribe({
      next: (s) => (this.stats = s),
      error: (err) => (this.error = err?.error?.detail || 'Failed to load stats'),
    });

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
      this.router.navigate(['/office/review', row.caseRef]);
    }
  }
}
