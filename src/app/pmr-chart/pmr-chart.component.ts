import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartData, ChartOptions } from 'chart.js';
import { StatusChartService } from '../services/status-chart.service';

// Canonical verification case statuses (database.py CASE_STATUSES, minus the
// transient `Approved`/`Submitted-review` nuances — these are the visible states).
type CaseStatus = 'Draft' | 'Submitted' | 'Needs Correction' | 'Rejected' | 'Completed';

@Component({
  selector: 'app-pmr-chart',
  standalone: true,
  imports: [CommonModule, BaseChartDirective],
  templateUrl: './pmr-chart.component.html',
  styleUrls: ['./pmr-chart.component.scss'],
  // Chart data mutated after HTTP response — keep Eager
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PMRChartComponent implements OnInit {
  barChartType: 'bar' = 'bar';
  pieChartType: 'doughnut' = 'doughnut';

  // ── Theme palette (matches the dashboard dark navy UI) ────────────────────
  private static readonly COLORS: Record<CaseStatus, string> = {
    Draft:              '#94a3b8', // slate / secondary
    Submitted:          '#3b82f6', // blue / primary
    'Needs Correction': '#f59e0b', // amber / warning
    Completed:          '#22c55e', // green / success
    Rejected:           '#ef4444', // red / danger
  };
  private static readonly STATUS_ORDER: CaseStatus[] =
    ['Draft', 'Submitted', 'Needs Correction', 'Completed', 'Rejected'];

  private readonly textMuted = '#94a3b8';
  private readonly gridLine  = 'rgba(148, 163, 184, 0.12)';

  /** opacity fill derived from a hex color (for bar fills). */
  private fade(hex: string, alpha = 0.85): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private emptyBuckets(): Record<CaseStatus, number> {
    return {
      Draft: 0,
      Submitted: 0,
      'Needs Correction': 0,
      Completed: 0,
      Rejected: 0,
    };
  }

  barChartData: ChartData<'bar'> = { labels: [], datasets: [] };

  barChartOptions: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: { top: 4 } },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: this.textMuted,
          usePointStyle: true,
          pointStyle: 'rectRounded',
          boxWidth: 10,
          boxHeight: 10,
          padding: 16,
          font: { size: 12, weight: 500 },
        },
      },
      tooltip: {
        backgroundColor: '#0f1c30',
        borderColor: 'rgba(99, 179, 237, 0.25)',
        borderWidth: 1,
        titleColor: '#e2e8f0',
        bodyColor: '#cbd5e1',
        padding: 12,
        cornerRadius: 8,
        boxPadding: 6,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        stacked: false,
        grid: { color: 'transparent' },
        border: { display: false },
        ticks: { color: this.textMuted, font: { size: 12, weight: 600 } },
      },
      y: {
        beginAtZero: true,
        grid: { color: this.gridLine },
        border: { display: false },
        ticks: {
          color: this.textMuted,
          font: { size: 11 },
          precision: 0,
          padding: 6,
        },
      },
    },
  };

  pieChartData: ChartData<'doughnut'> = {
    labels: [...PMRChartComponent.STATUS_ORDER],
    datasets: [
      {
        label: 'Cases',
        data: [0, 0, 0, 0, 0],
        backgroundColor: PMRChartComponent.STATUS_ORDER.map(
          s => PMRChartComponent.COLORS[s]
        ),
        borderColor: '#111e35',
        borderWidth: 3,
        hoverOffset: 8,
      },
    ],
  };

  pieChartOptions: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '62%',
    layout: { padding: 6 },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: this.textMuted,
          usePointStyle: true,
          pointStyle: 'circle',
          boxWidth: 9,
          boxHeight: 9,
          padding: 14,
          font: { size: 12, weight: 500 },
        },
      },
      tooltip: {
        backgroundColor: '#0f1c30',
        borderColor: 'rgba(99, 179, 237, 0.25)',
        borderWidth: 1,
        titleColor: '#e2e8f0',
        bodyColor: '#cbd5e1',
        padding: 12,
        cornerRadius: 8,
        usePointStyle: true,
        callbacks: {
          label: (ctx) => {
            const value = ctx.parsed as number;
            const data = ctx.dataset.data as number[];
            const total = data.reduce((a, b) => a + (b || 0), 0);
            const pct = total ? Math.round((value / total) * 100) : 0;
            return ` ${ctx.label}: ${value} (${pct}%)`;
          },
        },
      },
    },
  };

  constructor(private chartService: StatusChartService) {}

  ngOnInit(): void {
    this.chartService.getCases().subscribe((cases) => {
      const monthMap: Record<string, Record<CaseStatus, number>> = {};
      const totalStatus: Record<CaseStatus, number> = this.emptyBuckets();

      const today = new Date();
      const monthsToShow = 4;

      for (const c of cases) {
        const caseDate = new Date(c.date);
        if (isNaN(caseDate.getTime())) continue;

        const diffInMonths =
          (today.getFullYear() - caseDate.getFullYear()) * 12 +
          (today.getMonth() - caseDate.getMonth());

        if (diffInMonths >= monthsToShow) continue;

        const month = caseDate.toLocaleString('default', { month: 'short', year: 'numeric' });

        if (!monthMap[month]) {
          monthMap[month] = this.emptyBuckets();
        }

        const status = c.status as CaseStatus;
        if (!(status in totalStatus)) continue;
        monthMap[month][status]++;
        totalStatus[status]++;
      }

      const months = Object.keys(monthMap).sort(
        (a, b) => new Date(a).getTime() - new Date(b).getTime()
      );

      const C = PMRChartComponent.COLORS;

      const barDataset = (status: CaseStatus) => ({
        label: status,
        data: months.map(m => monthMap[m][status]),
        backgroundColor: this.fade(C[status], 0.85),
        hoverBackgroundColor: C[status],
        borderRadius: 6,
        borderSkipped: false as const,
        maxBarThickness: 26,
      });

      this.barChartData = {
        labels: months,
        datasets: PMRChartComponent.STATUS_ORDER.map(barDataset),
      };

      this.pieChartData = {
        labels: [...PMRChartComponent.STATUS_ORDER],
        datasets: [
          {
            label: 'Cases',
            data: PMRChartComponent.STATUS_ORDER.map(s => totalStatus[s]),
            backgroundColor: PMRChartComponent.STATUS_ORDER.map(s => C[s]),
            borderColor: '#111e35',
            borderWidth: 3,
            hoverOffset: 8,
          },
        ],
      };
    });
  }
}
