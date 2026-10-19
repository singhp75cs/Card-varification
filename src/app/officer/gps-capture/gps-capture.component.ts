import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CaseService } from '../../services/case.service';

/** Capture GPS via the browser Geolocation API, with manual fallback. */
@Component({
  selector: 'app-gps-capture',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './gps-capture.component.html',
  styleUrls: ['./gps-capture.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GpsCaptureComponent {
  @Input() caseRef = '';
  @Input() latitude: number | null = null;
  @Input() longitude: number | null = null;
  @Input() gpsStatus = 'unavailable';
  @Input() editable = true;
  @Output() gpsChange = new EventEmitter<{ latitude: number | null; longitude: number | null; gpsStatus: string }>();

  manualEntry = false;
  busy = false;
  error = '';
  info = '';

  constructor(private cases: CaseService) {}

  captureLocation(): void {
    this.error = '';
    this.info = '';
    if (!('geolocation' in navigator)) {
      this.manualEntry = true;
      this.error = 'Geolocation is not supported. Enter coordinates manually.';
      return;
    }
    this.busy = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.latitude = pos.coords.latitude;
        this.longitude = pos.coords.longitude;
        this.gpsStatus = 'captured';
        this.busy = false;
        this.save();
      },
      () => {
        this.busy = false;
        this.manualEntry = true;
        this.error = 'Location denied or unavailable. Enter coordinates manually.';
      }
    );
  }

  saveManual(): void {
    if (this.latitude == null || this.longitude == null) {
      this.gpsStatus = 'unavailable';
      this.latitude = null;
      this.longitude = null;
    } else {
      this.gpsStatus = 'manual';
    }
    this.save();
  }

  markUnavailable(): void {
    this.latitude = null;
    this.longitude = null;
    this.gpsStatus = 'unavailable';
    this.save();
  }

  private save(): void {
    if (!this.caseRef) {
      this.gpsChange.emit({ latitude: this.latitude, longitude: this.longitude, gpsStatus: this.gpsStatus });
      return;
    }
    this.busy = true;
    this.cases
      .setGps(this.caseRef, { latitude: this.latitude, longitude: this.longitude, gpsStatus: this.gpsStatus })
      .subscribe({
        next: (c) => {
          this.latitude = c.latitude;
          this.longitude = c.longitude;
          this.gpsStatus = c.gpsStatus;
          this.info = `Location saved (${this.gpsStatus}).`;
          this.busy = false;
          this.gpsChange.emit({ latitude: this.latitude, longitude: this.longitude, gpsStatus: this.gpsStatus });
        },
        error: (err) => {
          this.error = err?.error?.detail || 'Failed to save location';
          this.busy = false;
        },
      });
  }
}
