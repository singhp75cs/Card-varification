import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-custom-filter',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './custom-filter.component.html',
  styleUrls: ['./custom-filter.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomFilterComponent implements OnInit {
  ngOnInit(): void {}
}
