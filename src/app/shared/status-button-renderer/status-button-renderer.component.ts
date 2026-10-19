import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ICellRendererAngularComp } from 'ag-grid-angular';
import { ICellRendererParams } from 'ag-grid-community';

@Component({
  selector: 'app-status-button-renderer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-button-renderer.component.html',
  styleUrls: ['./status-button-renderer.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class StatusButtonRendererComponent implements ICellRendererAngularComp {
  value!: string;
  buttonClass!: string;

  agInit(params: ICellRendererParams): void {
    this.value = params.value;
    this.buttonClass =
      this.value === 'Draft'            ? 'btn-secondary' :
      this.value === 'Submitted'        ? 'btn-primary'   :
      this.value === 'Needs Correction' ? 'btn-warning'   :
      this.value === 'Completed'        ? 'btn-success'   : 'btn-danger';
  }

  refresh(params: ICellRendererParams): boolean {
    this.agInit(params);
    return true;
  }
}
