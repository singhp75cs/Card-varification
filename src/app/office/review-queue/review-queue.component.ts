import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AgGridModule } from 'ag-grid-angular';
import { GridApi, GridReadyEvent, RowClickedEvent } from 'ag-grid-community';
import { CASE_COLUMNS, CASE_DEFAULT_COL_DEF } from '../../config/case-columns';
import { DASHBOARD_GRID_THEME } from '../../config/grid-theme';
import { Case, CaseService } from '../../services/case.service';

/** Front office queue of Submitted cases awaiting review. */
@Component({
  selector: 'app-review-queue',
  standalone: true,
  imports: [CommonModule, AgGridModule],
  templateUrl: './review-queue.component.html',
  styleUrls: ['./review-queue.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ReviewQueueComponent implements OnInit {
  columnDefs = CASE_COLUMNS;
  defaultColDef = CASE_DEFAULT_COL_DEF;
  theme = DASHBOARD_GRID_THEME;
  rowData: Case[] = [];
  private gridApi?: GridApi;
  loading = true;
  error = '';

  constructor(private cases: CaseService, private router: Router) {}

  ngOnInit(): void {
    this.cases.list({ status: 'Submitted' }).subscribe({
      next: (data) => {
        this.rowData = data;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to load review queue';
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
